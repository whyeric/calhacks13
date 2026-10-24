"""Text-mode scripted calls: the real ErrandAgent, real Claude, scripted caller lines (#82, #13).

There is no Twilio account and no recorded caller audio yet, so this harness drives the agent
in-process with the same Line events a phone call produces (CallStarted, UserTurnEnded with
UserTextSent, CallEnded). Everything from `get_agent` onward is production code: the templated
opening, cache pre-warm, ClaudeConversation (real Claude, model/effort from env), the tools and
ConvexAPI. Convex is either:

  default        an in-memory fake behind httpx.MockTransport that implements /agent/household,
                 /agent/turn, /agent/order (mock pay; limits from fixtures/household.json; prices
                 from fixtures/walmart/search.json), /agent/followup and /agent/call-end;
  --live-convex  the real deployment (CONVEX_SITE_URL + AGENT_SECRET + DEMO_CALLER_PHONE from
                 agent/.env). Only use this when you mean to write to that deployment.

What is measured is the LLM stage only: the time from the caller's turn ending (the moment the
UserTurnEnded event is delivered) to the agent's first text chunk, including tool rounds.
End-of-turn detection, STT, TTS, telephony and network to the caller are NOT included. The
summary therefore also prints a projection that adds the §12.2 non-LLM budget (500 ms).

Usage (from agent/):
  .venv/bin/python ../harness/scripted_calls.py                     # all scripts
  .venv/bin/python ../harness/scripted_calls.py ../harness/scripts/call1.json
  .venv/bin/python ../harness/scripted_calls.py call1 l1_latency --save   # -> docs/latency-baseline.json
"""

import argparse
import asyncio
import copy
import itertools
import json
import os
import re
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx

HARNESS = Path(__file__).resolve().parent
ROOT = HARNESS.parent
AGENT = ROOT / "agent"
SCRIPTS = HARNESS / "scripts"
FIXTURES = ROOT / "fixtures"
DEFAULT_SAVE = ROOT / "docs" / "latency-baseline.json"

if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))
if str(HARNESS) not in sys.path:
    sys.path.insert(0, str(HARNESS))

import convex_state
from latency_report import (
    NON_LLM_BUDGET_MS,
    TARGETS,
    fmt_ms,
    request_cost,
    summarize,
)

FAKE_SITE = "https://harness-fake.convex.site"
FAKE_SECRET = "harness-fake-agent-secret-".ljust(48, "x")
FAKE_CALLER_PHONE = "+15550100001"  # fictional; the fake's registered household phone
UNKNOWN_PHONE = "+15550199999"  # fictional; never registered

YES = re.compile(
    r"\b(yes|yeah|yep|sure|please do|go ahead|ok|okay|that's right|correct|do it|"
    r"that would be (nice|lovely|great|wonderful)|i'?d (like|love) that)\b",
    re.IGNORECASE,
)
CONFIRM_QUESTION = re.compile(
    r"\b(shall i|should i|want me to|would you like me to|ok(ay)? to|go ahead|place (the|this|"
    r"that|your|it)|order (it|that|this|them|those)|confirm|sound (good|right))\b",
    re.IGNORECASE,
)
# main.ERROR_LINE / claude.RECOVERY_LINE / EMPTY_LINE / TOOL_LIMIT_LINE (templated, no model text).
RECOVERY_SPEECH = re.compile(
    r"having trouble answering|could you say that (another way|again)|couldn't finish that",
    re.IGNORECASE,
)

# The scam guard's gentle question (agent/scam.py gentle_note, prompts/system/04_scam.txt).
GUARD_QUESTION = re.compile(
    r"(is|was|did) (someone|anyone|anybody) ask(ing)? you|keep (this|it) (a )?secret",
    re.IGNORECASE,
)

# main.ERROR_LINE: spoken only when the reply raised.
ERROR_SPEECH = re.compile(r"having trouble answering just now", re.IGNORECASE)


def money(cents: int) -> str:
    return f"${cents // 100}.{cents % 100:02d}"


# ---------- fake Convex ----------


def load_catalog() -> dict[str, dict]:
    data = json.loads((FIXTURES / "walmart" / "search.json").read_text())
    store = data.get("store", "Walmart")
    out = {}
    for entry in data.get("entries", []):
        for r in entry.get("results", []):
            out[r["storeItemId"]] = {**r, "store": store}
    return out


def build_context(options: dict | None = None, now_ms: float | None = None) -> dict:
    """The /agent/household context for the demo household (contract shape)."""
    options = options or {}
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    fx = json.loads((FIXTURES / "household.json").read_text())
    facts = [
        {**f, "createdAt": now_ms - (len(fx["facts"]) - i) * 86_400_000}
        for i, f in enumerate(fx.get("facts", []))
    ]
    # Scripts can seed extra memory (§16.1 Call 3: tomatoes) on top of the household fixture.
    facts += [
        {"category": "other", "evidence": f["text"], **f, "createdAt": now_ms - 3_600_000}
        for f in options.get("facts", [])
    ]
    followups = []
    followup = options.get("followup", True)
    speakable = followup if isinstance(followup, str) else fx.get("followup")
    if followup and speakable:
        followups.append(
            {"_id": "fake-followup-1", "speakable": speakable, "notBefore": now_ms - 1}
        )
    limits = {**fx["limits"], **(options.get("limits") or {})}
    return {
        "household": {
            "preferredName": fx["preferredName"],
            "callerName": fx["callerName"],
            "timezone": fx["timezone"],
            "familyContacts": [{"name": fx["familyName"], "relation": fx["relation"]}],
            "sharing": {"chatTranscripts": False, "moodNotes": False, **options.get("sharing", {})},
        },
        "limits": limits,
        "favorites": copy.deepcopy(fx.get("favorites", [])),
        "facts": facts,
        "followups": followups,
        "recentOrders": copy.deepcopy(options.get("recentOrders", [])),
    }


FORGET_STOP = {"what", "said", "about", "told", "forget", "that", "would", "rather", "didn't"}
FORGET_STOP = {w.rstrip("s") for w in FORGET_STOP}
FAKE_FORGOTTEN: dict[str, list[str]] = {}  # script name -> forget requests (fake mode only)


def _stems(text: str) -> set[str]:
    return {w.rstrip("s") for w in re.findall(r"[a-z]{4,}", text.lower())}


class FakeConvex:
    """In-memory stand-in for the agent HTTP routes. Use `.transport` with ConvexAPI."""

    def __init__(
        self,
        household_options: dict | None = None,
        *,
        secret: str = FAKE_SECRET,
        forgotten: list[str] | None = None,
    ):
        self.secret = secret
        self.context = build_context(household_options)
        # Forget requests from earlier calls of the same multi-call script (M3): like
        # convex/memory.ts, a forgotten fact never reaches a later call's memory block.
        self.forgotten = forgotten if forgotten is not None else []
        for description in self.forgotten:
            gone = _stems(description) - FORGET_STOP
            self.context["facts"] = [
                f for f in self.context.get("facts", []) if not gone & _stems(f.get("text", ""))
            ]
        self.month_spent = int((household_options or {}).get("monthSpentCents", 0))
        self.catalog = load_catalog()
        self.calls: dict[str, dict] = {}
        self.turns: list[dict] = []
        self.orders: dict[str, dict] = {}  # idempotencyKey -> order
        self.followups_asked: list[dict] = []
        self.call_ends: list[dict] = []
        # Routes other workstreams own (#5 scam, #47 forget, #90 alerts): recorded, generic reply.
        self.extra: dict[str, list[dict]] = {}
        self.requests: list[tuple[str, int]] = []
        self.transport = httpx.MockTransport(self.handle)

    # httpx.MockTransport accepts a sync handler.
    def handle(self, request: httpx.Request) -> httpx.Response:
        route = request.url.path
        if request.headers.get("Authorization") != f"Bearer {self.secret}":
            return self._reply(route, 401, {"error": "unauthorized"})
        try:
            body = json.loads(request.content or b"{}")
        except ValueError:
            return self._reply(route, 400, {"error": "invalid JSON"})
        handler = {
            "/agent/household": self._household,
            "/agent/turn": self._turn,
            "/agent/order": self._order,
            "/agent/followup": self._followup,
            "/agent/call-end": self._call_end,
            "/agent/alert": self._alert,
            "/agent/scam": self._scam,
            "/agent/forget": self._forget,
            "/agent/connect": self._connect,
            "/agent/wellbeing": self._wellbeing,
            "/agent/order-status": self._order_status,
            "/agent/recent-orders": self._recent_orders,
        }.get(route)
        if handler is None:
            return self._reply(route, 404, {"error": "not found"})
        if route in (
            "/agent/alert",
            "/agent/scam",
            "/agent/forget",
            "/agent/connect",
            "/agent/wellbeing",
            "/agent/order-status",
        ):
            self._record(route, body)
        status, payload = handler(body)
        return self._reply(route, status, payload)

    def _reply(self, route, status, payload):
        self.requests.append((route, status))
        return httpx.Response(status, json=payload)

    def _household(self, body):
        call_id = f"fake-call-{uuid.uuid4().hex[:10]}"
        known = body.get("callerPhone") == FAKE_CALLER_PHONE
        self.calls[call_id] = {"callerPhone": body.get("callerPhone"), "known": known}
        return 200, {"callId": call_id, "context": copy.deepcopy(self.context) if known else None}

    def _turn(self, body):
        if body.get("callId") not in self.calls:
            return 400, {"error": "unknown call"}
        self.turns.append(body)
        return 200, {"turnId": f"turn-{len(self.turns)}"}

    def _record(self, route: str, body: dict):
        self.extra.setdefault(route, []).append(body)

    def _scam(self, body):
        # #10: like scam.record + orders.reserve, a guard hold blocks every later order.
        if body.get("hold") and body.get("callId") in self.calls:
            self.calls[body["callId"]]["scamHold"] = True
        held = bool(self.calls.get(body.get("callId"), {}).get("scamHold"))
        return 200, {"turnPatched": True, "holdActive": held}

    def _recorded(self, body):
        # Contract owned elsewhere; the fake only records that the agent asked.
        return 200, {"ok": True}

    def _forget(self, body):
        self.forgotten.append(str(body.get("description") or ""))
        # convex/memory.ts forgetForCall: the contract the agent reads (#47).
        return 200, {
            "status": "forgotten",
            "forgotten": ["(fake) matching fact"],
            "redactedTurns": 0,
        }

    def _connect(self, body):
        # convex/companion.ts connect; consent is checked by Convex tests, not this fake (#63).
        return 200, {
            "status": "sent",
            "contact": "Dana",
            "delivery": "queued",
            "message": "Dana will get the message. Tell the caller simply.",
        }

    def _wellbeing(self, body):
        # convex/companion.ts wellbeing (#73 #76).
        return 200, {
            "status": "sent",
            "contact": "Dana",
            "delivery": "queued",
            "message": "Dana is being alerted. Tell the caller you are letting Dana know.",
        }

    def _alert(self, body):
        return 200, {
            "alertId": f"fake-alert-{len(self.extra.get('/agent/alert', []))}",
            "delivery": "queued",
        }

    # Convex stores an order waiting for the family as "awaiting_approval"; place_order's
    # result calls it "needs_approval". The fake keeps the latter internally.
    @staticmethod
    def _db_status(status: str) -> str:
        return "awaiting_approval" if status == "needs_approval" else status

    def _order_status(self, body):
        # convex/orders.ts statusForAgent: only the call's own order, as the database has it.
        order = next(
            (o for o in self.orders.values() if o["result"].get("orderId") == body.get("orderId")),
            None,
        )
        if order is None or order["callId"] != body.get("callId"):
            return 404, {"error": "Order not found for this call"}
        return 200, {
            "orderId": order["result"]["orderId"],
            "status": self._db_status(order["status"]),
            "totalCents": order["totalCents"],
            "items": [{"name": i["name"], "qty": i["qty"]} for i in order["items"]],
            "reason": order["result"].get("reason"),
            "decidedBy": order.get("decidedBy"),
            "expired": False,
        }

    def _recent_orders(self, body):
        # convex/orderStatus.ts recentForCall: the household's newest orders, read fresh.
        call = self.calls.get(body.get("callId"))
        if not call:
            return 400, {"error": "Call not found"}
        if not call["known"]:
            return 200, {"orders": []}
        rows = [
            {
                "status": self._db_status(o["status"]),
                "store": o["store"],
                "totalCents": o["totalCents"],
                "createdAt": o["createdAt"],
                "items": [{"name": i["name"], "qty": i["qty"]} for i in o["items"]],
                "reason": o["result"].get("reason"),
                "decidedBy": o.get("decidedBy"),
                "expired": False,
                "thisCall": o["callId"] == body.get("callId"),
            }
            for o in self.orders.values()
        ]
        rows += [{**o, "thisCall": False} for o in self.context.get("recentOrders") or []]
        rows.sort(key=lambda o: o.get("createdAt") or 0, reverse=True)
        return 200, {"orders": rows[:5]}

    def _followup(self, body):
        if body.get("callId") not in self.calls:
            return 400, {"error": "unknown call"}
        self.followups_asked.append(body)
        return 200, {"ok": True}

    def _call_end(self, body):
        if body.get("callId") not in self.calls:
            return 400, {"error": "unknown call"}
        self.call_ends.append(body)
        return 200, {"callId": body["callId"], "memoryStatus": "not_implemented"}

    def _order(self, body):
        call = self.calls.get(body.get("callId"))
        if not call:
            return 400, {"error": "unknown call"}
        if not call["known"]:
            return 403, {"error": "unknown caller"}
        if call.get("scamHold"):
            reason = "This call is on a scam hold, so I can't place orders right now."
            return 200, {"status": "blocked", "reason": reason}
        key = body.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            return 400, {"error": "idempotencyKey required"}
        if key in self.orders:
            return 200, self.orders[key]["result"]
        items = body.get("items")
        if not isinstance(items, list) or not items:
            return 400, {"error": "items required"}
        total, priced = 0, []
        for item in items:
            qty = item.get("qty") if isinstance(item, dict) else None
            if not isinstance(qty, int) or isinstance(qty, bool) or qty < 1:
                return 400, {"error": "qty must be an integer >= 1"}
            known = self.catalog.get(item.get("storeItemId"))
            if known is None:
                return 400, {"error": "Unknown item"}
            # Like the server: the catalog price is authoritative, never the agent's.
            priced.append({**item, "name": known["name"], "priceCents": known["priceCents"]})
            total += qty * known["priceCents"]
        items = priced
        limits = self.context["limits"]
        store = body.get("store") or ""
        order_id = f"fake-order-{len(self.orders) + 1}"
        reason = None
        if store not in limits["approvedStores"]:
            reason = f"{store or 'That store'} isn't one of your family's approved stores."
        elif total > limits["perOrderCapCents"]:
            reason = (
                f"This order is {money(total)}, which is over your "
                f"{money(limits['perOrderCapCents'])} per-order limit."
            )
        elif self.month_spent + total > limits["monthlyBudgetCents"]:
            reason = (
                f"This order is {money(total)}, which would go over your "
                f"{money(limits['monthlyBudgetCents'])} monthly budget."
            )
        if reason:
            result = {
                "status": "needs_approval",
                "orderId": order_id,
                "totalCents": total,
                "reason": reason,
            }
        else:
            self.month_spent += total
            result = {
                "status": "paid",
                "orderId": order_id,
                "totalCents": total,
                "paymentRef": f"mock-pay-{len(self.orders) + 1}",
            }
        self.orders[key] = {
            "callId": body["callId"],
            "createdAt": time.time() * 1000,
            "store": store,
            "items": items,
            "status": result["status"],
            "totalCents": total,
            "result": result,
        }
        return 200, result


# ---------- instrumented Anthropic client ----------


def _usage_dict(usage) -> dict:
    cc = getattr(usage, "cache_creation", None)
    write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    w5 = getattr(cc, "ephemeral_5m_input_tokens", None) if cc is not None else None
    w1 = getattr(cc, "ephemeral_1h_input_tokens", None) if cc is not None else None
    if w5 is None and w1 is None:
        w5, w1 = write, 0
    return {
        "input": usage.input_tokens or 0,
        "output": usage.output_tokens or 0,
        "cacheRead": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "cacheWrite": write,
        "cacheWrite5m": w5 or 0,
        "cacheWrite1h": w1 or 0,
    }


def _cost(u: dict) -> float:
    return request_cost(
        u["input"], u["output"], u["cacheRead"], u["cacheWrite5m"], u["cacheWrite1h"]
    )


class _TimedStream:
    def __init__(self, stream, rec, clock):
        self._stream, self._rec, self._clock = stream, rec, clock

    def __aiter__(self):
        return self._events()

    async def _events(self):
        rec = self._rec
        async for event in self._stream:
            now = self._clock()
            rec.setdefault("firstEventAt", now)
            if event.type == "text" and getattr(event, "text", ""):
                rec.setdefault("firstTextAt", now)
                rec.setdefault("firstOutputAt", now)
            elif (
                event.type == "content_block_start"
                and getattr(event.content_block, "type", None) == "tool_use"
            ):
                rec.setdefault("firstToolUseAt", now)
                rec.setdefault("firstOutputAt", now)
            yield event

    async def get_final_message(self):
        message = await self._stream.get_final_message()
        self._rec["endAt"] = self._clock()
        self._rec["usage"] = _usage_dict(message.usage)
        self._rec["stopReason"] = message.stop_reason
        return message

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _TimedStreamManager:
    def __init__(self, manager, rec, clock):
        self._manager, self._rec, self._clock = manager, rec, clock

    async def __aenter__(self):
        # The SDK sends the request here, so HTTP errors (400, 429, 529) and timeouts before the
        # response headers raise here and __aexit__ never runs. Record them, or a failed request
        # looks like a fast, free turn.
        try:
            stream = await self._manager.__aenter__()
        except BaseException as exc:
            self._rec["endAt"] = self._clock()
            self._rec["error"] = describe_error(exc)
            raise
        return _TimedStream(stream, self._rec, self._clock)

    async def __aexit__(self, *exc):
        self._rec.setdefault("endAt", self._clock())
        if exc[1] is not None:
            self._rec["error"] = describe_error(exc[1])
        return await self._manager.__aexit__(*exc)


def describe_error(exc: BaseException) -> str:
    """Error class, HTTP status and API message, e.g. "BadRequestError 400: ..."."""
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    message = body.get("error", {}).get("message") if isinstance(body, dict) else None
    head = type(exc).__name__ + (f" {status}" if status else "")
    return f"{head}: {message or exc}"[:200]


class InstrumentedClient:
    """Wraps AsyncAnthropic: records start/first-token/end and usage of every request."""

    def __init__(self, client, clock=time.perf_counter):
        self._client = client
        self.clock = clock
        self.records: list[dict] = []
        self.tag = None  # set by the runner to the current caller-turn index
        self.messages = SimpleNamespace(stream=self._stream, create=self._create)

    def _stream(self, **params):
        rec = {"tag": self.tag, "kind": "stream", "startAt": self.clock()}
        self.records.append(rec)
        return _TimedStreamManager(self._client.messages.stream(**params), rec, self.clock)

    async def _create(self, **params):
        kind = "prewarm" if params.get("max_tokens") == 0 else "create"
        rec = {"tag": self.tag, "kind": kind, "startAt": self.clock()}
        self.records.append(rec)
        try:
            message = await self._client.messages.create(**params)
        except Exception as exc:
            rec["endAt"], rec["error"] = self.clock(), describe_error(exc)
            raise
        rec["endAt"] = self.clock()
        rec["usage"] = _usage_dict(message.usage)
        return message

    async def close(self):
        await self._client.close()


# ---------- scripts ----------


def load_script(path_or_name: str) -> list[dict]:
    """A script file is one call {name, caller, turns, expect} or a suite {name, calls: [...]}."""
    path = Path(path_or_name)
    if not path.exists():
        path = SCRIPTS / (
            path_or_name if path_or_name.endswith(".json") else f"{path_or_name}.json"
        )
    if not path.exists():
        path = script_for_id(path_or_name) or path
    data = json.loads(path.read_text())
    suite = data.get("name", path.stem)
    calls = data.get("calls", [data])
    out = []
    for i, call in enumerate(calls):
        call = dict(call)
        for key in ("id", "pendingOn", "manual", "passRate", "convex"):
            if key in data and key not in call:
                call[key] = data[key]
        call.setdefault("id", suite)
        call.setdefault("name", f"{suite}#{i + 1}" if len(calls) > 1 else suite)
        call["suite"] = suite
        out.append(call)
    return out


def script_for_id(test_id: str) -> Path | None:
    """The script file whose "id" is this §16.2 test ID (case-insensitive), e.g. "S1"."""
    for path in sorted(SCRIPTS.glob("*.json")):
        try:
            if str(json.loads(path.read_text()).get("id", "")).lower() == test_id.lower():
                return path
        except ValueError:
            continue
    return None


def resolve_turn(turn: dict, last_agent: str) -> str | None:
    """The caller's line for this turn given what the agent last said; None means skip."""
    skip = turn.get("skipIfAgent")
    if skip and re.search(skip, last_agent or "", re.IGNORECASE):
        return None
    for alt in turn.get("alts") or []:
        if re.search(alt["ifAgent"], last_agent or "", re.IGNORECASE):
            return alt["say"]
    return turn["say"]


# ---------- assertions ----------


def _patterns(value) -> list[str]:
    return [value] if isinstance(value, str) else list(value or [])


def check_speech(text: str, includes=None, excludes=None, where="call") -> list[str]:
    """Each include is a case-insensitive regex (use | for alternatives); all must match."""
    failures = []
    for pattern in _patterns(includes):
        if not re.search(pattern, text or "", re.IGNORECASE):
            failures.append(f"{where}: agent speech never matched /{pattern}/")
    for pattern in _patterns(excludes):
        if re.search(pattern, text or "", re.IGNORECASE):
            failures.append(f"{where}: agent speech matched forbidden /{pattern}/")
    return failures


def check_tools(used: list[str], called=None, not_called=None, where="call") -> list[str]:
    failures = []
    for name in _patterns(called):
        if name not in used:
            failures.append(f"{where}: expected tool {name} was not called")
    for name in _patterns(not_called):
        if name in used:
            failures.append(f"{where}: tool {name} was called but must not be")
    return failures


def check_routes(routes: dict, expect: dict | None) -> list[str]:
    """Fake-Convex checks on requests to routes other workstreams own (alerts, scam, forget):
    {"/agent/alert": {"min": 1, "max": 1, "includes": "scam", "needs": "scam"}}."""
    failures = []
    for route, want in (expect or {}).items():
        bodies = routes.get(route, [])
        if want.get("includes"):
            bodies = [
                b for b in bodies if re.search(want["includes"], json.dumps(b), re.IGNORECASE)
            ]
        tag = f"[needs {want['needs']}] " if want.get("needs") else ""
        if len(bodies) < want.get("min", 0):
            failures.append(
                f"{tag}{route}: {len(bodies)} matching request(s), expected ≥{want['min']}"
            )
        if "max" in want and len(bodies) > want["max"]:
            failures.append(
                f"{tag}{route}: {len(bodies)} matching request(s), expected ≤{want['max']}"
            )
    return failures


def order_results(record: dict) -> list[dict]:
    """place_order results that reached the order service (have a status), in call order."""
    out = []
    for turn in record["turns"]:
        for tool in turn.get("tools", []):
            result = tool.get("result") or {}
            if tool["name"] == "place_order" and isinstance(result, dict) and result.get("status"):
                items: dict[str, int] = {}
                for item in (tool.get("input") or {}).get("items") or []:
                    if isinstance(item, dict) and item.get("storeItemId"):
                        sid = str(item["storeItemId"])
                        items[sid] = items.get(sid, 0) + int(item.get("qty", 1) or 1)
                out.append({**result, "items": items, "turn": turn["idx"]})
    return out


def evaluate(record: dict, expect: dict | None) -> list[str]:
    """Return human-readable failures for a finished call record; [] means pass."""
    expect = expect or {}
    failures: list[str] = []
    if record.get("error"):
        failures.append(f"call error: {record['error']}")
    spoken_turns = [t for t in record["turns"] if not t.get("skipped")]
    for turn in spoken_turns:
        te = turn.get("expect") or {}
        where = f"turn {turn['idx']}"
        names = [t["name"] for t in turn.get("tools", [])]
        # A failed model request is never a pass, even if the scripted checks happen to hold.
        failures += [f"{where}: model request failed: {e}" for e in turn.get("errors") or []]
        if not turn.get("errors") and ERROR_SPEECH.search(turn.get("agent", "")):
            # main.ERROR_LINE with no failed request recorded: the agent raised locally.
            failures.append(f"{where}: agent spoke the error line (exception in agent code)")
        failures += check_speech(
            turn.get("agent", ""), te.get("speechIncludes"), te.get("speechExcludes"), where
        )
        failures += check_tools(names, te.get("toolsCalled"), te.get("toolsNotCalled"), where)
    all_speech = " ".join([record.get("opening", "")] + [t.get("agent", "") for t in spoken_turns])
    all_tools = [t["name"] for turn in spoken_turns for t in turn.get("tools", [])]
    failures += check_speech(all_speech, expect.get("speechIncludes"), expect.get("speechExcludes"))
    failures += check_tools(all_tools, expect.get("toolsCalled"), expect.get("toolsNotCalled"))

    orders = order_results(record)
    final = expect.get("finalOrder")
    if final:
        if not orders:
            failures.append("no order reached the order service")
        else:
            last = orders[-1]
            for key in ("status", "totalCents"):
                if key in final and last.get(key) != final[key]:
                    failures.append(f"final order {key} {last.get(key)!r} != {final[key]!r}")
            if "items" in final and last["items"] != final["items"]:
                failures.append(f"final order items {last['items']} != {final['items']}")
    if expect.get("noPaidOrder") and any(o.get("status") == "paid" for o in orders):
        failures.append("an order was paid but none should be")
    if expect.get("noOrders") and orders:
        failures.append(f"{len(orders)} order(s) reached the order service but none should")
    fake = record.get("fake")
    if fake is not None:
        if expect.get("noPaidOrder") and any(o["status"] == "paid" for o in fake["orders"]):
            failures.append("the fake order service recorded a paid order")
        if expect.get("noOrders") and fake["orders"]:
            failures.append("the fake order service recorded an order")
        if "followupsAsked" in expect and fake["followupsAsked"] != expect["followupsAsked"]:
            failures.append(
                f"follow-up marked asked {fake['followupsAsked']}x, "
                f"expected {expect['followupsAsked']}"
            )
        failures += check_routes(fake.get("routes") or {}, expect.get("routes"))
    gated = list(expect.get("toolOnlyAfterYes") or [])
    if expect.get("placeOrderOnlyAfterYes"):
        gated.append("place_order")
    for tool in gated:
        # place_order (§8.1) and the Call 3 nudge (connect_family) need a question answered yes.
        prev_agent, prev_yes = record.get("opening", ""), None
        for turn in spoken_turns:
            if any(t["name"] == tool for t in turn.get("tools", [])):
                asked = "?" in prev_agent and (
                    tool != "place_order" or CONFIRM_QUESTION.search(prev_agent)
                )
                answered = asked and YES.search(turn.get("caller", ""))
                # The scam guard's one gentle question (S5) may come between the read-back's
                # yes and the order; an ordinary answer to it carries that yes on.
                if not answered and GUARD_QUESTION.search(prev_agent) and prev_yes:
                    answered = True
                if not answered:
                    failures.append(
                        f"turn {turn['idx']}: {tool} called without a "
                        f"{'read-back ' if tool == 'place_order' else ''}question answered yes "
                        f"(caller said {turn.get('caller', '')!r})"
                    )
            # A templated error/recovery line doesn't replace the read-back the caller heard.
            if not RECOVERY_SPEECH.search(turn.get("agent", "")):
                asked = "?" in prev_agent and (
                    tool != "place_order" or CONFIRM_QUESTION.search(prev_agent)
                )
                prev_yes = bool(asked and YES.search(turn.get("caller", "")))
                prev_agent = turn.get("agent", "")
    growth = expect.get("latencyLastTurns")
    if growth:
        # C4: latency stays within §12.1 as context grows (projected: LLM stage + non-LLM budget).
        late = [
            t["firstChunkMs"] + NON_LLM_BUDGET_MS
            for t in spoken_turns[-growth.get("turns", 10) :]
            if t.get("firstChunkMs") is not None
        ]
        if not late:
            failures.append("latency: no timed turns")
        else:
            s50, s95 = summarize(late)["p50"], summarize(late)["p95"]
            if s50 > growth.get("p50Ms", TARGETS["voice_to_voice"][0]):
                failures.append(f"latency: last turns projected p50 {s50:.0f} ms over target")
            if s95 > growth.get("p95Ms", TARGETS["voice_to_voice"][1]):
                failures.append(f"latency: last turns projected p95 {s95:.0f} ms over target")
    end = record.get("callEnd") or {}
    for key in ("outcome", "kind"):
        if key in expect and end.get(key) != expect[key]:
            failures.append(f"call-end {key} {end.get(key)!r} != {expect[key]!r}")
    return failures


# ---------- runner ----------


def _ms(at, t0):
    return None if at is None else round((at - t0) * 1000, 1)


def turn_metrics(records: list[dict], t0: float, first_chunk_at, end_at, chunk_times=()) -> dict:
    """Per-turn timings relative to the turn end (t0), from this turn's model requests."""
    streams = [r for r in records if r["kind"] == "stream"]
    texts = [r["firstTextAt"] for r in streams if r.get("firstTextAt") is not None]
    later_texts = [r["firstTextAt"] for r in streams[1:] if r.get("firstTextAt") is not None]
    if not later_texts and streams and streams[-1].get("endAt") is not None:
        # A templated tool-result line (e.g. the place_order confirmation) is spoken without a
        # follow-up request: count the first chunk after the last request ended.
        later_texts = [t for t in chunk_times if t > streams[-1]["endAt"]][:1]
    tool_wall = 0.0
    for a, b in itertools.pairwise(streams):
        if a.get("endAt") is not None:
            tool_wall += b["startAt"] - a["endAt"]
    first = streams[0] if streams else {}
    usage = {k: 0 for k in ("input", "output", "cacheRead", "cacheWrite", "cacheWrite5m")}
    usage["cacheWrite1h"] = 0
    for r in streams:
        for k, v in (r.get("usage") or {}).items():
            usage[k] += v
    return {
        "firstChunkMs": _ms(first_chunk_at, t0),
        "firstModelTextMs": _ms(min(texts), t0) if texts else None,
        "resultTextMs": _ms(min(later_texts), t0) if later_texts else None,
        "firstRequestTtftMs": _ms(first.get("firstOutputAt"), first.get("startAt", t0))
        if first
        else None,
        "requestStartMs": _ms(first.get("startAt"), t0) if first else None,
        "turnMs": _ms(end_at, t0),
        "toolWallMs": round(tool_wall * 1000, 1) if len(streams) > 1 else 0.0,
        "rounds": len(streams),
        "stopReasons": [r.get("stopReason") for r in streams],
        "errors": [r["error"] for r in streams if r.get("error")],
        "usage": usage,
        "costUsd": round(sum(_cost(r["usage"]) for r in streams if r.get("usage")), 6),
        "cacheReadFirstRequest": (first.get("usage") or {}).get("cacheRead") if first else None,
    }


async def run_call(script: dict, opts) -> dict:
    from anthropic import AsyncAnthropic
    from line.events import AgentSendText, CallEnded, CallStarted, UserTextSent, UserTurnEnded

    import main
    import tools
    from convex_api import ConvexAPI

    caller = script.get("caller", "margaret")
    if script.get("manual"):
        return manual_record(script)
    fake = None
    cli = None
    if opts.live_convex:
        api = ConvexAPI(os.environ["CONVEX_SITE_URL"], os.environ["AGENT_SECRET"])
        cli = convex_state.ConvexCLI()
        phone = os.environ.get("DEMO_CALLER_PHONE") if caller == "margaret" else UNKNOWN_PHONE
    else:
        fake = FakeConvex(
            script.get("household"),
            forgotten=FAKE_FORGOTTEN.setdefault(script["name"].split("#")[0], []),
        )
        api = ConvexAPI(FAKE_SITE, FAKE_SECRET, transport=fake.transport)
        phone = FAKE_CALLER_PHONE if caller == "margaret" else UNKNOWN_PHONE
    client = InstrumentedClient(AsyncAnthropic(max_retries=0, timeout=20))
    clock = client.clock
    record = {
        "name": script["name"],
        "suite": script.get("suite"),
        "caller": caller,
        "turns": [],
        "error": None,
        "id": script.get("id"),
        "pendingOn": script.get("pendingOn") or [],
    }
    tool_log: list[dict] = []
    main.api, main.anthropic_client = api, client
    if cli is not None:
        # Dev-deployment setup the script needs (e.g. T5 limits); undone in `finally`.
        for fn, args in script.get("liveSetup") or []:
            await asyncio.to_thread(cli.run, fn, args)
    try:
        agent, _, _ = await main.get_agent(
            None, SimpleNamespace(from_=phone, agent_call_id=f"harness-{uuid.uuid4().hex[:8]}")
        )
        if not hasattr(agent, "scam_guard"):
            # The main.py integration from agent/scam.py, until main.py itself attaches it.
            import scam

            classifier = scam.ScamClassifier(client) if agent.context else None
            scam.ScamGuard(api, agent.call_id, agent.context, classifier=classifier).attach(agent)
        record["callId"] = agent.call_id
        record["model"] = agent.conversation.model
        record["effort"] = agent.conversation.effort
        original_dispatch = agent.dispatch

        async def timed_dispatch(name, tool_input, ctx):
            started = clock()
            result = await original_dispatch(name, tool_input, ctx)
            tool_log.append(
                {
                    "tag": client.tag,
                    "name": name,
                    "input": tool_input,
                    "result": result,
                    "ms": round((clock() - started) * 1000, 1),
                }
            )
            return result

        agent.dispatch = timed_dispatch
        client.tag = "opening"
        opening = [e.text async for e in agent.process(None, CallStarted())]
        record["opening"] = "".join(opening)
        last_agent = record["opening"]
        first_turn = True
        for idx, turn in enumerate(script.get("turns", []), start=1):
            say = resolve_turn(turn, last_agent)
            if say is None:
                record["turns"].append({"idx": idx, "skipped": True, "caller": turn["say"]})
                continue
            await asyncio.sleep(opts.first_delay if first_turn else opts.reply_delay)
            first_turn = False
            if turn.get("action"):
                record.setdefault("actions", []).append(
                    await run_action(turn["action"], agent.call_id, fake, cli)
                )
            client.tag = idx
            t0 = clock()
            chunks, chunk_times, first_chunk_at = [], [], None
            event = UserTurnEnded(content=[UserTextSent(content=say)])
            async for out in agent.process(None, event):
                if isinstance(out, AgentSendText):
                    if first_chunk_at is None:
                        first_chunk_at = clock()
                    chunk_times.append(clock())
                    chunks.append(out.text)
            end_at = clock()
            records = [r for r in client.records if r["tag"] == idx]
            tools_used = [
                {k: t[k] for k in ("name", "input", "result", "ms")}
                for t in tool_log
                if t["tag"] == idx
            ]
            agent_text = "".join(chunks)
            record["turns"].append(
                {
                    "idx": idx,
                    "caller": say,
                    "agent": agent_text,
                    "tools": tools_used,
                    "toolMs": round(sum(t["ms"] for t in tools_used), 1),
                    "expect": turn.get("expect"),
                    **turn_metrics(records, t0, first_chunk_at, end_at, chunk_times),
                }
            )
            last_agent = agent_text
        record["callEnd"] = agent.call_end_payload()
        client.tag = "end"
        async for _ in agent.process(None, CallEnded()):
            pass
        if cli is not None and script.get("convex") and agent.call_id:
            # #22: what actually happened in Convex (waits for the memory writer if asked).
            record["convex"] = await asyncio.to_thread(
                convex_state.check_live, cli, agent.call_id, script["convex"]
            )
    except Exception as exc:  # noqa: BLE001 -- report the failure in the call record
        record["error"] = f"{type(exc).__name__}: {exc}"[:300]
    finally:
        await api.close()
        await client.close()
        await tools.close_client()
        if cli is not None:
            for fn, args in script.get("liveTeardown") or []:
                try:
                    await asyncio.to_thread(cli.run, fn, args)
                except Exception as exc:  # noqa: BLE001 -- report; don't hide the result
                    record.setdefault("teardownErrors", []).append(f"{fn}: {exc}"[:200])
    prewarms = [r for r in client.records if r["kind"] == "prewarm"]
    first_turn_rec = next(
        (r for r in client.records if r["kind"] == "stream" and isinstance(r["tag"], int)), None
    )
    record["prewarm"] = [
        {
            "usage": r.get("usage"),
            "ms": _ms(r.get("endAt"), r["startAt"]),
            "error": r.get("error"),
            "doneBeforeFirstTurn": bool(
                first_turn_rec and r.get("endAt") and r["endAt"] <= first_turn_rec["startAt"]
            ),
        }
        for r in prewarms
    ]
    record["firstTurnCacheRead"] = (
        (first_turn_rec.get("usage") or {}).get("cacheRead") if first_turn_rec else None
    )
    record["costUsd"] = round(sum(_cost(r["usage"]) for r in client.records if r.get("usage")), 6)
    if fake is not None:
        record["fake"] = {
            "orders": [
                {k: o[k] for k in ("status", "totalCents", "store", "items")}
                for o in fake.orders.values()
            ],
            "followupsAsked": len(fake.followups_asked),
            "turnsLogged": len(fake.turns),
            "callEnds": fake.call_ends,
            "httpErrors": [(r, s) for r, s in fake.requests if s >= 400],
            "routes": copy.deepcopy(fake.extra),
        }
    record["failures"] = evaluate(record, script.get("expect"))
    if script.get("convex") and "convex" not in record:
        record["convexSkipped"] = "Convex state assertions run only with --live-convex"
    record["failures"] += (record.get("convex") or {}).get("failures", [])
    record["passed"] = not record["failures"]
    record["status"] = status_of(record)
    return record


def manual_record(script: dict) -> dict:
    """A matrix row that can't run in text mode: reported with its stated way to run it."""
    record = {
        "name": script["name"],
        "id": script.get("id"),
        "suite": script.get("suite"),
        "caller": script.get("caller", "-"),
        "turns": [],
        "error": None,
        "manual": script["manual"],
        "failures": [],
        "passed": False,
        "costUsd": 0.0,
        "pendingOn": script.get("pendingOn") or [],
    }
    record["status"] = "MANUAL"
    return record


def status_of(record: dict) -> str:
    """PASS, FAIL, or PENDING: failed, but only on features that haven't landed yet
    (the script's "pendingOn", or every failure tagged "[needs X]")."""
    if record.get("manual"):
        return "MANUAL"
    failures = record.get("failures") or []
    if not failures:
        return "PASS"
    if record.get("pendingOn") or all(f.startswith("[needs ") for f in failures):
        return "PENDING"
    return "FAIL"


async def run_action(action: str, call_id: str | None, fake, cli) -> dict:
    """Mid-call family action (T3): approve or decline the call's order awaiting approval,
    as Dana would from the alert call or the dashboard."""
    decision = {"approve_last_order": "approved", "decline_last_order": "declined"}.get(action)
    if decision is None:
        return {"action": action, "error": "unknown action"}
    if fake is not None:
        waiting = [
            o
            for o in fake.orders.values()
            if o["callId"] == call_id and o["status"] == "needs_approval"
        ]
        if not waiting:
            return {"action": action, "error": "no order awaiting approval"}
        order = waiting[-1]
        # Like orders.approve (then the payment action) or orders.decline, decided by the
        # household's family contact.
        order["status"] = "paid" if decision == "approved" else "declined"
        order["decidedBy"] = fake.context["household"]["familyContacts"][0]["name"]
        order["result"] = {**order["result"], "status": order["status"]}
        if decision == "approved":
            fake.month_spent += order["totalCents"]
        return {"action": action, "orderId": order["result"].get("orderId")}
    order = await asyncio.to_thread(convex_state.last_awaiting_order, cli, call_id)
    if not order:
        return {"action": action, "error": "no order awaiting approval"}
    fn = "orders:approve" if decision == "approved" else "orders:decline"
    # Recorded like a family decision ("Dana (harness)" -> decidedBy "Dana"), so the agent's
    # order_status line names a person, not "harness".
    await asyncio.to_thread(cli.run, fn, {"orderId": order["_id"], "by": "Dana (harness)"})
    return {"action": action, "orderId": order["_id"]}


# ---------- summary ----------


def summarize_run(records: list[dict]) -> dict:
    turns = [t for r in records for t in r["turns"] if not t.get("skipped")]
    convo = [t for t in turns if not t.get("tools")]
    tool_turns = [t for t in turns if t.get("tools")]

    def stat(rows, key, add=0):
        return summarize([t[key] + add if t.get(key) is not None else None for t in rows])

    known = [r for r in records if r.get("firstTurnCacheRead") is not None]
    hits = sum(1 for r in known if r["firstTurnCacheRead"] > 0)
    costs = [r["costUsd"] for r in records if not r.get("error")]
    summary = {
        "calls": len(records),
        "callsPassed": sum(r["passed"] for r in records),
        "turns": len(turns),
        "conversationalTurns": len(convo),
        "toolTurns": len(tool_turns),
        # Turns where a model request failed (e.g. the 20 s client timeout) and the templated
        # error line was spoken. They stay in the latency stats: the caller waited that long.
        "errorTurns": [
            {
                "call": r["name"],
                "turn": t["idx"],
                "errors": t["errors"],
                "firstChunkMs": t["firstChunkMs"],
            }
            for r in records
            for t in r["turns"]
            if not t.get("skipped") and t.get("errors")
        ],
        "llmStage": {
            "allTurnsFirstChunk": stat(turns, "firstChunkMs"),
            "conversationalFirstChunk": stat(convo, "firstChunkMs"),
            "toolTurnFirstChunk": stat(tool_turns, "firstChunkMs"),
            "toolTurnResultText": stat(tool_turns, "resultTextMs"),
            "firstRequestTtft": stat(turns, "firstRequestTtftMs"),
            "turnTotal": stat(turns, "turnMs"),
            "toolExecution": stat(tool_turns, "toolMs"),
            "toolRoundWall": stat(tool_turns, "toolWallMs"),
        },
        "projectedVoiceToVoice": {
            "note": f"LLM stage + {NON_LLM_BUDGET_MS} ms §12.2 non-LLM budget (not measured)",
            "allTurns": stat(turns, "firstChunkMs", NON_LLM_BUDGET_MS),
            "toolTurnResult": stat(tool_turns, "resultTextMs", NON_LLM_BUDGET_MS),
        },
        "firstTurnCacheHitRate": hits / len(known) if known else None,
        "firstTurnCacheHits": hits,
        "firstTurnCacheKnown": len(known),
        "costPerCall": summarize(costs) | {"mean": sum(costs) / len(costs) if costs else None},
        "totalCostUsd": round(sum(costs), 6),
    }
    summary["targets"] = target_rows(summary)
    misses = [row for row in summary["targets"] if row["ratio"] is not None and row["ratio"] > 1]
    summary["largestMiss"] = max(misses, key=lambda r: r["ratio"]) if misses else None
    return summary


def target_rows(summary: dict) -> list[dict]:
    s, proj = summary["llmStage"], summary["projectedVoiceToVoice"]
    rows = []

    def add(name, value, limit, kind="ms", higher_is_better=False):
        if value is None:
            ratio = None
        elif higher_is_better:
            ratio = (limit / value) if value else float("inf")
        else:
            ratio = value / limit
        rows.append(
            {
                "metric": name,
                "value": value,
                "target": limit,
                "unit": kind,
                "ratio": ratio,
                "pass": None if ratio is None else ratio <= 1,
            }
        )

    add(
        "LLM stage, conversational turn, p50 (vs §12.2 300 ms Claude budget)",
        s["conversationalFirstChunk"]["p50"],
        TARGETS["llm_ttft_budget_p50"],
    )
    add(
        "Projected voice-to-voice, all turns, p50 (§12.1)",
        proj["allTurns"]["p50"],
        TARGETS["voice_to_voice"][0],
    )
    add(
        "Projected voice-to-voice, all turns, p95 (§12.1)",
        proj["allTurns"]["p95"],
        TARGETS["voice_to_voice"][1],
    )
    add(
        "Tool turn -> filler, LLM stage + 500, p50",
        _plus(s["toolTurnFirstChunk"]["p50"]),
        TARGETS["tool_filler"][0],
    )
    add(
        "Tool turn -> filler, LLM stage + 500, p95",
        _plus(s["toolTurnFirstChunk"]["p95"]),
        TARGETS["tool_filler"][1],
    )
    add(
        "Tool turn -> result, LLM stage + 500, p50",
        proj["toolTurnResult"]["p50"],
        TARGETS["tool_result"][0],
    )
    add(
        "Tool turn -> result, LLM stage + 500, p95",
        proj["toolTurnResult"]["p95"],
        TARGETS["tool_result"][1],
    )
    add(
        "First-turn cache hit rate (L2)",
        summary["firstTurnCacheHitRate"],
        TARGETS["first_turn_cache_hit"],
        "rate",
        higher_is_better=True,
    )
    add(
        "Claude cost per call, max",
        summary["costPerCall"]["max"],
        TARGETS["cost_per_call_usd"],
        "usd",
    )
    return rows


def _plus(value):
    return None if value is None else value + NON_LLM_BUDGET_MS


def _fmt_value(value, unit):
    if value is None:
        return "-"
    if unit == "rate":
        return f"{value:.0%}"
    if unit == "usd":
        return f"${value:.4f}"
    return f"{value:,.0f} ms"


def print_call(record: dict, verbose: bool):
    status = record.get("status") or ("PASS" if record["passed"] else "FAIL")
    if status == "MANUAL":
        print(f"\n=== {record['name']} [MANUAL] {record['manual']}")
        return
    print(
        f"\n=== {record['name']} [{status}] caller={record['caller']} "
        f"cost=${record['costUsd']:.4f} firstTurnCacheRead={record.get('firstTurnCacheRead')}"
    )
    if verbose:
        print(f"  agent> {record.get('opening', '')}")
    for t in record["turns"]:
        if t.get("skipped"):
            print(f"  [{t['idx']}] (skipped: agent already covered {t['caller']!r})")
            continue
        tools_used = ",".join(x["name"] for x in t["tools"]) or "-"
        print(
            f"  [{t['idx']}] first={fmt_ms(t['firstChunkMs'])}ms "
            f"text={fmt_ms(t['firstModelTextMs'])}ms turn={fmt_ms(t['turnMs'])}ms "
            f"tools={tools_used} ({fmt_ms(t['toolMs'])}ms) rounds={t['rounds']} "
            f"in/out/cr/cw={t['usage']['input']}/{t['usage']['output']}/"
            f"{t['usage']['cacheRead']}/{t['usage']['cacheWrite']}"
        )
        if t.get("errors"):
            print(f"      request error(s): {', '.join(t['errors'])}")
        if verbose:
            print(f"      caller> {t['caller']}")
            print(f"      agent>  {t['agent']}")
    if record.get("error"):
        print(f"  ERROR {record['error']}")
    label = "PENDING" if status == "PENDING" else "FAIL"
    for f in record["failures"]:
        print(f"  {label}: {f}")
    if record.get("convexSkipped"):
        print(f"  (Convex state not checked: {record['convexSkipped']})")


def print_summary(summary: dict):
    print("\n" + "=" * 78)
    print(
        f"{summary['callsPassed']}/{summary['calls']} calls passed; {summary['turns']} caller "
        f"turns ({summary['conversationalTurns']} conversational, {summary['toolTurns']} tool)"
    )
    print(
        "LLM STAGE ONLY: turn end -> first text chunk, incl. tool rounds. Excludes end-of-turn "
        "detection, STT, TTS, telephony and network.\n"
    )
    print(f"{'LLM-stage metric':40} {'n':>4} {'p50 ms':>9} {'p95 ms':>9} {'max ms':>9}")
    labels = {
        "allTurnsFirstChunk": "all turns: first chunk (L1)",
        "conversationalFirstChunk": "conversational: first chunk",
        "toolTurnFirstChunk": "tool turns: first chunk (filler)",
        "toolTurnResultText": "tool turns: first text after tool",
        "firstRequestTtft": "request -> first token (TTFT)",
        "turnTotal": "turn total (last chunk)",
        "toolExecution": "tool execution (sum)",
        "toolRoundWall": "tool round wall (between requests)",
    }
    for key, label in labels.items():
        s = summary["llmStage"][key]
        print(
            f"{label:40} {s['n']:>4} {fmt_ms(s['p50']):>9} {fmt_ms(s['p95']):>9} "
            f"{fmt_ms(s['max']):>9}"
        )
    print(f"\n{'Target check':58} {'value':>11} {'target':>11}  result")
    for row in summary["targets"]:
        result = "n/a" if row["pass"] is None else ("PASS" if row["pass"] else "MISS")
        print(
            f"{row['metric'][:58]:58} {_fmt_value(row['value'], row['unit']):>11} "
            f"{_fmt_value(row['target'], row['unit']):>11}  {result}"
        )
    c = summary["costPerCall"]
    if c["n"]:
        print(
            f"\nClaude cost per call (Haiku 5.5 list prices, incl. pre-warm): mean ${c['mean']:.4f}"
            f", p50 ${c['p50']:.4f}, max ${c['max']:.4f}; run total ${summary['totalCostUsd']:.4f}"
        )
    for e in summary["errorTurns"]:
        print(
            f"Request error: {e['call']} turn {e['turn']}: {', '.join(e['errors'])} "
            f"(caller waited {fmt_ms(e['firstChunkMs'])} ms for the error line)"
        )
    miss = summary["largestMiss"]
    if miss:
        print(f"Largest budget miss: {miss['metric']} at {miss['ratio']:.1f}x the target")


# ---------- pass/fail report per test ID (#22) ----------

# §3.3 / §16.2 bars that span several calls.
L1_MIN_TURNS = 50
L2_MIN_CALLS = 20
B_MAX_FALSE_DECLINES = 1  # B1-B20: at most one false decline in 20


def build_report(records: list[dict]) -> list[dict]:
    """One row per test ID: PASS / FAIL / PENDING / MANUAL / INSUFFICIENT, with the reason.

    Repeated runs (--repeat) of one ID pass only at the script's "passRate" (default every run;
    M1 uses 0.9 for "raised in ≥ 9 of 10 calls"). L1, L2 and the B set are judged on their
    §3.3 aggregate bars rather than per call.
    """
    by_id: dict[str, list[dict]] = {}
    for record in records:
        by_id.setdefault(str(record.get("id") or record["name"]), []).append(record)
    rows = []
    for test_id, runs in by_id.items():
        if test_id.upper() in ("L1", "L2") or re.fullmatch(r"B\d+", test_id, re.IGNORECASE):
            continue
        rows.append(_id_row(test_id, runs))
    l1 = by_id.get("L1") or by_id.get("l1")
    if l1:
        rows.append(_l1_row(l1))
    played = [r for r in records if not r.get("manual") and not r.get("error")]
    if played:
        rows.append(_l2_row(played))
    b_runs = [r for i, rs in by_id.items() if re.fullmatch(r"B\d+", i, re.IGNORECASE) for r in rs]
    if b_runs:
        rows.append(_b_row(b_runs))
    return rows


def _id_row(test_id: str, runs: list[dict]) -> dict:
    statuses = [r["status"] for r in runs]
    row = {"id": test_id, "runs": len(runs), "passed": statuses.count("PASS")}
    if all(s == "MANUAL" for s in statuses):
        return {**row, "status": "MANUAL", "detail": runs[0]["manual"]}
    need = runs[0].get("passRate", 1.0)
    if row["passed"] >= need * len(runs) - 1e-9:
        return {**row, "status": "PASS", "detail": f"{row['passed']}/{len(runs)} passed"}
    failed = next(r for r in runs if r["status"] != "PASS")
    status = "FAIL" if "FAIL" in statuses else "PENDING"
    detail = (failed.get("failures") or [failed.get("error") or "?"])[0]
    if status == "PENDING" and failed.get("pendingOn"):
        detail = f"needs {', '.join(failed['pendingOn'])}: {detail}"
    return {**row, "status": status, "detail": f"{row['passed']}/{len(runs)} passed; {detail}"}


def _l1_row(runs: list[dict]) -> dict:
    s = summarize_run(runs)
    proj = s["projectedVoiceToVoice"]["allTurns"]
    row = {"id": "L1", "runs": len(runs), "passed": s["callsPassed"]}
    if s["conversationalTurns"] < L1_MIN_TURNS:
        return {
            **row,
            "status": "INSUFFICIENT",
            "detail": f"{s['conversationalTurns']} conversational turns < {L1_MIN_TURNS}",
        }
    p50, p95 = proj["p50"], proj["p95"]
    target50, target95 = TARGETS["voice_to_voice"]
    ok = p50 is not None and p95 is not None and p50 <= target50 and p95 <= target95
    return {
        **row,
        "status": "PASS" if ok else "FAIL",
        "detail": f"projected voice-to-voice p50 {fmt_ms(p50)} ms (≤{target50}), "
        f"p95 {fmt_ms(p95)} ms (≤{target95}) over {s['conversationalTurns']} turns; "
        "text mode adds the §12.2 non-LLM budget, not measured audio",
    }


def _l2_row(runs: list[dict]) -> dict:
    hits = [bool(r.get("firstTurnCacheRead")) for r in runs]
    rate = sum(hits) / len(hits)
    row = {"id": "L2", "runs": len(runs), "passed": sum(hits)}
    detail = f"first-turn cache hit {sum(hits)}/{len(hits)} = {rate:.0%} (≥{TARGETS['first_turn_cache_hit']:.0%})"
    if len(runs) < L2_MIN_CALLS:
        return {**row, "status": "INSUFFICIENT", "detail": f"{detail}; needs ≥{L2_MIN_CALLS} calls"}
    ok = rate >= TARGETS["first_turn_cache_hit"]
    return {**row, "status": "PASS" if ok else "FAIL", "detail": detail}


def _b_row(runs: list[dict]) -> dict:
    declines = [r["id"] for r in runs if r["status"] in ("FAIL", "PENDING")]
    row = {"id": "B1-B20", "runs": len(runs), "passed": len(runs) - len(declines)}
    detail = f"{len(declines)} false decline(s) in {len(runs)} (≤{B_MAX_FALSE_DECLINES})"
    if declines:
        detail += ": " + ", ".join(sorted(set(declines)))
    status = "PASS" if len(declines) <= B_MAX_FALSE_DECLINES else "FAIL"
    if len(runs) < 20:
        status = "INSUFFICIENT" if status == "PASS" else status
    return {**row, "status": status, "detail": detail}


def print_report(rows: list[dict]):
    print("\n" + "=" * 78)
    print("Per test ID (PENDING = fails only on features that haven't landed yet)")
    for row in rows:
        print(f"{row['id']:8} {row['status']:12} {row['detail'][:180]}")


async def run_all(scripts: list[dict], opts) -> list[dict]:
    records = []
    for _ in range(opts.repeat):
        for script in scripts:
            record = await run_call(script, opts)
            print_call(record, opts.verbose)
            records.append(record)
    return records


def load_env():
    from dotenv import dotenv_values

    for key, value in dotenv_values(AGENT / ".env").items():
        if value is not None:
            os.environ.setdefault(key, value)
    os.environ.setdefault("SEARCH_MODE", "fixtures")


def main_cli(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("scripts", nargs="*", help="script files or names in harness/scripts/")
    parser.add_argument(
        "--live-convex",
        action="store_true",
        help="use the real Convex deployment from agent/.env (writes data)",
    )
    parser.add_argument(
        "--first-delay",
        type=float,
        default=3.0,
        help="seconds between the greeting and the first caller turn (default 3)",
    )
    parser.add_argument(
        "--reply-delay",
        type=float,
        default=1.0,
        help="seconds between an agent reply and the next caller turn (default 1)",
    )
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument(
        "--save",
        nargs="?",
        const=str(DEFAULT_SAVE),
        help=f"write results JSON (default {DEFAULT_SAVE.relative_to(ROOT)})",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="print transcripts")
    parser.add_argument("--report", help="write the per-test-ID report JSON to this path")
    parser.add_argument(
        "--strict", action="store_true", help="PENDING and INSUFFICIENT rows also fail the run"
    )
    parser.add_argument(
        "--hold-seconds",
        type=float,
        help="approval hold window (#92, APPROVAL_HOLD_S); default 5 s with the fake Convex, "
        "whose orders are only decided by script actions, and 90 s with --live-convex",
    )
    opts = parser.parse_args(argv)
    names = opts.scripts or sorted(p.stem for p in SCRIPTS.glob("*.json"))
    scripts = [call for name in names for call in load_script(name)]
    load_env()
    if opts.hold_seconds is not None or not opts.live_convex:
        hold = opts.hold_seconds if opts.hold_seconds is not None else 5
        os.environ["APPROVAL_HOLD_S"] = str(hold)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY is not set (agent/.env)")
    if opts.live_convex:
        missing = [
            k
            for k in ("CONVEX_SITE_URL", "AGENT_SECRET", "DEMO_CALLER_PHONE")
            if not os.environ.get(k)
        ]
        if missing:
            raise SystemExit("--live-convex needs " + ", ".join(missing))
    records = asyncio.run(run_all(scripts, opts))
    played = [r for r in records if not r.get("manual")]
    summary = summarize_run(played)
    print_summary(summary)
    report = build_report(records)
    print_report(report)
    if opts.report:
        Path(opts.report).write_text(json.dumps(report, indent=2) + "\n")
    if opts.save:
        out = {
            "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "mode": "live-convex" if opts.live_convex else "fake-convex",
            "measures": "LLM stage only (turn end -> first text chunk incl. tool rounds); "
            "excludes end-of-turn detection, STT, TTS, telephony and network",
            "model": next((r.get("model") for r in records if r.get("model")), None),
            "effort": next((r.get("effort") for r in records if r.get("effort")), None),
            "delays": {"firstDelayS": opts.first_delay, "replyDelayS": opts.reply_delay},
            "scripts": names,
            "summary": summary,
            "calls": records,
        }
        Path(opts.save).write_text(json.dumps(out, indent=2, default=str) + "\n")
        print(f"\nSaved {opts.save}")
    bad = {"FAIL"} | ({"PENDING", "INSUFFICIENT"} if opts.strict else set())
    return 1 if any(row["status"] in bad for row in report) else 0


if __name__ == "__main__":
    sys.exit(main_cli())
