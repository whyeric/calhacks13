"""place_order: the agent side of /agent/order, the only path that moves money.

Names and prices come from items this call's tools returned (search_items / match_favorite) or the
fixture catalog, never from the model. The idempotency key is "<callId>:<toolUseId>"; if the model
re-sends an order for the same items after an unconfirmed or still-processing attempt, the original
key is reused so Convex returns the existing order instead of paying twice.

Results the model sees: paid | needs_approval | blocked | failed (from Convex), processing (still
being paid after polling), unconfirmed (transport outcome unknown), or {"error": ...} when the
order was definitely not placed (bad input or a 4xx refusal).

confirmation_line() turns a paid / needs_approval / blocked result into the sentence the agent
speaks straight away, so the caller hears the outcome without waiting for another model request.
"""

import asyncio
import logging
import re

import httpx

from .catalog import DEFAULT_STORE, catalog_item
from .state import call_state

log = logging.getLogger(__name__)

MAX_QTY = 20
MAX_LINES = 20
_PASS_THROUGH = {"paid", "needs_approval", "blocked", "failed"}
_KNOWN = _PASS_THROUGH | {"processing"}
_FINAL = {"paid", "needs_approval"}
ORDER_ROUTE = "/agent/order"
# While the server answers "processing", ask again (same key) with short backoff, ~10s in all.
POLL_DELAYS_S = (0.5, 1.0, 1.5, 2.0, 2.0, 3.0)
# Upper bound for one place_order call: one slow POST (12s timeout) plus polling. The call-end
# drain in main.py waits longer than this.
ORDER_DEADLINE_S = 20
PROCESSING_MESSAGE = (
    "The payment is still going through; don't say it failed or that nothing was charged."
)
UNCONFIRMED = {
    "status": "unconfirmed",
    "message": "Couldn't confirm whether the order went through; it may still go through. "
    "Don't say it failed or that nothing was charged. Tell the caller you couldn't confirm it "
    "just now. Calling place_order again with exactly the same items is safe and never pays "
    "twice; do it only if the caller asks.",
}


def _resolve(call_id: str | None, store_item_id: str) -> dict | None:
    known = call_state(call_id)["items"].get(store_item_id)
    if known:
        return known
    return catalog_item(store_item_id)


def _parse_items(call_id, raw_items) -> tuple[list[dict], str | None]:
    if not isinstance(raw_items, list) or not raw_items:
        return [], "Include at least one item with its storeItemId and qty."
    if len(raw_items) > MAX_LINES:
        return [], f"At most {MAX_LINES} different items per order."
    merged: dict[str, dict] = {}
    for raw in raw_items:
        if not isinstance(raw, dict):
            return [], "Each item needs a storeItemId and qty."
        store_item_id = str(raw.get("storeItemId") or "").strip()
        qty = raw.get("qty", 1)
        if isinstance(qty, float) and qty.is_integer():
            qty = int(qty)
        if not store_item_id:
            return [], "Each item needs a storeItemId."
        if not isinstance(qty, int) or isinstance(qty, bool) or not 1 <= qty <= MAX_QTY:
            return [], f"Quantity for {store_item_id} must be a whole number from 1 to {MAX_QTY}."
        item = _resolve(call_id, store_item_id)
        if item is None or item.get("priceCents") is None:
            return [], (
                f"Unknown item {store_item_id}. Only order items returned by search_items or "
                "match_favorite in this call."
            )
        line = merged.get(store_item_id)
        if line:
            line["qty"] += qty
            if line["qty"] > MAX_QTY:
                return [], f"Quantity for {store_item_id} must be at most {MAX_QTY}."
        else:
            merged[store_item_id] = {
                "name": item["name"],
                "storeItemId": store_item_id,
                "qty": qty,
                "priceCents": int(item["priceCents"]),
                "_store": item.get("store"),
            }
    return list(merged.values()), None


async def place_order(api, call_id: str | None, tool_use_id: str, tool_input: dict) -> dict:
    lines, problem = _parse_items(call_id, tool_input.get("items"))
    if problem:
        return {"error": problem}
    store = str(tool_input.get("store") or lines[0]["_store"] or DEFAULT_STORE).strip()
    items = [{k: v for k, v in line.items() if k != "_store"} for line in lines]
    signature = (store, tuple(sorted((i["storeItemId"], i["qty"]) for i in items)))

    orders = call_state(call_id)["orders"]
    previous = orders.get(signature)
    if previous and (previous.get("result") or {}).get("status") in _FINAL:
        return {**previous["result"], "note": "This exact order was already placed in this call."}
    key = previous["key"] if previous else f"{call_id}:{tool_use_id}"
    orders[signature] = {"key": key, "result": None}

    payload = {"callId": call_id, "idempotencyKey": key, "store": store, "items": items}
    loop = asyncio.get_running_loop()
    deadline = loop.time() + ORDER_DEADLINE_S
    outcome = await _bounded_post(api, payload, deadline - loop.time())
    for delay in POLL_DELAYS_S:
        # "processing": an earlier request with this key is still being paid. Re-asking with the
        # same key never pays twice; it returns the order's current status.
        if not (isinstance(outcome, dict) and outcome.get("status") == "processing"):
            break
        if loop.time() + delay >= deadline:
            break
        await asyncio.sleep(delay)
        polled = await _bounded_post(api, payload, deadline - loop.time())
        if polled is None:
            break  # keep "processing": the server has the order, it just hasn't finished
        outcome = polled

    if outcome is None:
        return dict(UNCONFIRMED)  # unknown outcome: keep the key so a retry can't pay twice
    if outcome.get("_http_error"):
        orders.pop(signature, None)
        return outcome["_http_error"]
    status = outcome.get("status")
    if status == "processing":
        result = {k: v for k, v in outcome.items() if k != "message"}
        return {**result, "message": PROCESSING_MESSAGE}
    if status in _FINAL:
        orders[signature]["result"] = outcome
    else:
        orders.pop(signature, None)  # blocked/failed: a later retry gets a fresh key
    return outcome


async def _bounded_post(api, payload: dict, remaining: float) -> dict | None:
    try:
        async with asyncio.timeout(max(remaining, 0.1)):
            return await _post_order(api, payload)
    except TimeoutError:
        log.warning("Order request ran past the order deadline")
        return None


async def _post_order(api, payload: dict) -> dict | None:
    """One order request (plus one retry if the connection never opened).

    Returns the response body, {"_http_error": result} for a definite refusal, or None when the
    outcome is unknown.
    """
    for attempt in range(2):
        try:
            body = await api.post(ORDER_ROUTE, payload)
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            log.warning("Order request rejected with HTTP %s", code)
            if code < 500 and code not in (408, 429):
                return {"_http_error": _http_error(exc.response)}
            return None  # server error: outcome unknown
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # The request never reached the server, so retrying (same key) is cheap and safe.
            log.warning("Order request failed (%s), attempt %d", type(exc).__name__, attempt + 1)
            continue
        except Exception as exc:  # noqa: BLE001 -- unknown outcome; keep the key for retries
            log.warning("Order request failed (%s)", type(exc).__name__)
            return None
        if isinstance(body, dict) and body.get("status") in _KNOWN:
            return body
        log.warning("Unexpected order response shape")
        return None
    return None


def _http_error(response) -> dict:
    try:
        body = response.json()
    except ValueError:
        body = {}
    if isinstance(body, dict) and body.get("status") in _PASS_THROUGH:
        return body
    return {
        "error": "The order service refused this order, so it was not placed. Don't retry; "
        "tell the caller you couldn't place it."
    }


# ---------- spoken confirmation (templated; no model round-trip) ----------

_ONES = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
]
_TENS = ["_", "_", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_DOLLARS = re.compile(r"\$(\d[\d,]*)(?:\.(\d{2}))?")


def _words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return f"{_ONES[hundreds]} hundred" + (f" {_words(rest)}" if rest else "")
    thousands, rest = divmod(n, 1000)
    return f"{_words(thousands)} thousand" + (f" {_words(rest)}" if rest else "")


def spoken_dollars(cents: int) -> str:
    """2145 -> "twenty-one dollars and forty-five cents" (the speech rules' spoken form)."""
    dollars, rest = divmod(max(int(cents), 0), 100)
    parts = []
    if dollars:
        parts.append(f"{_words(dollars)} dollar{'s' if dollars != 1 else ''}")
    if rest or not dollars:
        parts.append(f"{_words(rest)} cent{'s' if rest != 1 else ''}")
    return " and ".join(parts)


def _speak_amounts(text: str) -> str:
    def repl(match):
        cents = int(match.group(1).replace(",", "")) * 100 + int(match.group(2) or 0)
        return spoken_dollars(cents)

    return _DOLLARS.sub(repl, text)


def family_name(context: dict | None) -> str:
    """First name of the household's family contact (as the memory block lists them)."""
    household = (context or {}).get("household") or {}
    names = sorted(str(c.get("name") or "").strip() for c in household.get("familyContacts") or [])
    names = [n for n in names if n]
    return names[0].split()[0] if names else "your family"


def _capital(text: str) -> str:
    """ "your family" -> "Your family" at the start of a sentence; names are unchanged."""
    return text[:1].upper() + text[1:]


def _sentence(text: str) -> str:
    text = " ".join(str(text or "").split())
    return text if not text or text[-1] in ".!?" else text + "."


def confirmation_line(result: dict, context: dict | None) -> str | None:
    """What the agent says the moment place_order returns, or None to let the model word it.

    Only outcomes the result fully determines are templated: paid, needs_approval, blocked.
    """
    if not isinstance(result, dict) or result.get("note"):
        return None  # e.g. "already placed in this call": let the model explain
    status = result.get("status")
    family = family_name(context)
    total = result.get("totalCents")
    if status == "paid" and isinstance(total, int):
        sees = "your family can" if family == "your family" else f"{family} can"
        return (
            f"Done. Your order is placed and paid, {spoken_dollars(total)} in all, "
            f"and {sees} see it too. Anything else?"
        )
    if status == "needs_approval":
        reason = _sentence(_speak_amounts(result.get("reason") or ""))
        says = "your family says" if family == "your family" else f"{family} says"
        return (
            f"{reason} So I've asked {family} to okay it first, and nothing has been charged. "
            f"Once {says} yes, it will go through. Is there anything else I can help with?"
        ).strip()
    if status == "blocked":
        reason = _sentence(_speak_amounts(result.get("reason") or ""))
        return f"I couldn't place that order. {reason}".strip()
    return None


# ---------- approval hold (#92): keep the caller on the line for the family's decision ----------

# docs/decisions/approval-wait.md: hold up to 90 s, poll ~2 s, reassure ~20 s.
HOLD_WINDOW_S = 90
HOLD_POLL_S = 2.0
HOLD_REASSURE_S = 20.0
HOLD_MAX_POLL_ERRORS = 3
ORDER_STATUS_ROUTE = "/agent/order-status"
# Statuses that end the hold. "approved" means the payment is still in flight: keep polling for
# paid / failed, but it already counts as a yes if the window runs out.
_DECIDED = {"paid", "failed", "declined"}


class ApprovalHold:
    """Polls /agent/order-status for one needs_approval order and words what the caller hears.

    `wait()` returns the last status body (or {"status": "timeout"} / {"status": "unknown"});
    the lines are templated so nothing waits on a model request.
    """

    def __init__(
        self,
        api,
        call_id: str,
        order_id: str,
        context: dict | None,
        *,
        window_s: float = HOLD_WINDOW_S,
        poll_s: float = HOLD_POLL_S,
    ):
        self.api, self.call_id, self.order_id = api, call_id, order_id
        self.family = family_name(context)
        self.window_s, self.poll_s = window_s, poll_s
        self.reassure_s = HOLD_REASSURE_S

    async def wait(self) -> dict:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.window_s
        last, errors = None, 0
        while True:
            try:
                body = await self.api.order_status(self.call_id, self.order_id)
                errors = 0
            except Exception as exc:  # noqa: BLE001 -- a failed poll is retried, never raised
                errors += 1
                log.warning("Order status poll failed (%s)", type(exc).__name__)
                if errors >= HOLD_MAX_POLL_ERRORS:
                    return last or {"status": "unknown"}
                body = None
            if isinstance(body, dict) and body.get("status"):
                last = body
                if body["status"] in _DECIDED:
                    return body
            if loop.time() + self.poll_s >= deadline:
                if last and last.get("status") == "approved":
                    return last
                return {**(last or {}), "status": "timeout"}
            await asyncio.sleep(self.poll_s)

    def opening_line(self, reason: str) -> str:
        reason = _sentence(_speak_amounts(reason))
        return (
            f"{reason} So I've asked {self.family} to okay it, and nothing has been charged. "
            "I'll stay on the line while I wait."
        ).strip()

    def reassurance_line(self, n: int) -> str:
        f = self.family
        lines = [
            f"I'm still here. I'm waiting to hear back from {f}.",
            f"Still waiting on {f}. Thanks for your patience.",
            f"I'm still waiting for {f}. I'll let you know as soon as I hear.",
        ]
        return lines[n % len(lines)]

    def outcome_line(self, decision: dict) -> str:
        status = decision.get("status")
        name = str(decision.get("decidedBy") or "").strip() or self.family
        who = _capital(name)  # starts a sentence (or follows "Good news.")
        total = decision.get("totalCents")
        amount = f", {spoken_dollars(total)} in all" if isinstance(total, int) else ""
        if status == "paid":
            return f"Good news. {who} said yes, and your order is placed{amount}. Anything else?"
        if status == "approved":
            return (
                f"Good news. {who} said yes, and your order is going through now{amount}. "
                "Anything else?"
            )
        if status == "failed":
            return (
                f"{who} said yes, but the payment didn't go through just now. Nothing was "
                f"charged, and {name} can see it to sort it out. Anything else?"
            )
        if status == "declined" and not decision.get("expired"):
            return (
                f"{who} would rather hold off on this one, so I haven't ordered it, and nothing "
                "was charged. Is there anything else I can help with?"
            )
        f, F = self.family, _capital(self.family)
        if status == "unknown":
            return (
                f"I can't check on it just now, but your order is saved, and nothing is charged "
                f"unless {f} says yes. Is there anything else for now?"
            )
        if status == "declined":  # expired
            return (
                "That approval wasn't answered in time, so I haven't ordered it, and nothing "
                "was charged. Is there anything else for now?"
            )
        return (
            f"I haven't been able to reach {f} yet. Your order is saved, and nothing has been "
            f"charged. {F} can still approve it, and if they do, it will go through. I'll tell "
            "you how it went next time you call. Is there anything else for now?"
        )

    def model_note(self, decision: dict) -> dict:
        """What the model learns about the hold (its own spoken lines are in the history)."""
        keep = ("status", "totalCents", "decidedBy", "expired")
        note = {k: decision[k] for k in keep if decision.get(k) is not None}
        note["meaning"] = self.meaning(decision)
        return note

    def meaning(self, decision: dict) -> str:
        """The hold's outcome in plain words, so the model never reads the earlier
        needs_approval result as the latest status."""
        status = decision.get("status")
        who = str(decision.get("decidedBy") or "").strip() or self.family
        if status == "paid":
            return f"{who} approved it and the order is placed and paid. This is final."
        if status == "approved":
            return f"{who} approved it and the payment is going through now."
        if status == "failed":
            return f"{who} approved it, but the payment failed, so nothing was charged."
        if status == "declined" and not decision.get("expired"):
            return f"{who} declined it, so it was not ordered and nothing was charged."
        if status == "declined":
            return "The approval expired, so it was not ordered and nothing was charged."
        return (
            f"No answer from {self.family} yet. The order is saved and still waiting for "
            f"{self.family}'s okay; nothing has been charged. {self.family} may answer later: "
            "if the caller asks about it, call order_status to check."
        )
