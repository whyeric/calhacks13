"""Milestone 7 stretch tools: order_status (#55), compare_prices (#66), stop_checkins (#60).

order_status is read-only: it reads the household's newest orders from Convex and never moves
money. compare_prices offers one product at two stores from cached fixtures (the second store
has no live source) and says which is cheaper; ordering still goes through place_order, whose
limits send a non-approved store to the family (T5). stop_checkins records that the caller wants
no more check-in calls.
"""

import json
import logging
import time
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from .catalog import DEFAULT_STORE, fixtures_dir, search_fixtures
from .order import family_name, spoken_dollars
from .state import remember_items

log = logging.getLogger(__name__)

DEFAULT_TIMEZONE = "America/Los_Angeles"
NO_HOUSEHOLD = {
    "error": "This phone number isn't registered with a household, so this isn't available. "
    "Tell the caller kindly; a family member can set the line up."
}

# ---------------------------------------------------------------- order_status (#55)


def spoken_item(name: str) -> str:
    """'Medium-roast coffee, big can' -> 'medium-roast coffee'."""
    head = " ".join(str(name or "").split(",")[0].split("(")[0].split())
    return head[:1].lower() + head[1:] if head else "your items"


def spoken_items(items: list[dict]) -> str:
    names = []
    for item in items or []:
        name = spoken_item(item.get("name", ""))
        if name not in names:
            names.append(name)
    if not names:
        return "your items"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    more = len(names) - 2
    return f"{names[0]}, {names[1]} and {more} more item{'s' if more > 1 else ''}"


def _zone(context: dict | None) -> ZoneInfo:
    name = ((context or {}).get("household") or {}).get("timezone") or DEFAULT_TIMEZONE
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 -- a bad stored timezone must not break the tool
        return ZoneInfo(DEFAULT_TIMEZONE)


def spoken_when(ms, tz: ZoneInfo, now_ms: float | None = None) -> str:
    if not ms:
        return "recently"
    now = datetime.fromtimestamp((now_ms or time.time() * 1000) / 1000, tz)
    then = datetime.fromtimestamp(ms / 1000, tz)
    days = (now.date() - then.date()).days
    if days <= 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"on {then:%A}"
    return f"on {then:%B} {then.day}"


def status_line(order: dict, context: dict | None, now_ms: float | None = None) -> str:
    """One plain sentence about one order. Honest about approvals: never says it was ordered
    or charged unless it is paid."""
    items = spoken_items(order.get("items") or [])
    when = spoken_when(order.get("createdAt"), _zone(context), now_ms)
    total = spoken_dollars(order.get("totalCents") or 0)
    who = order.get("decidedBy") or family_name(context)
    status = order.get("status")
    if status == "paid":
        return f"Your order {when} of {items} went through, and {total} was paid."
    if status == "awaiting_approval":
        return (
            f"Your order {when} of {items} is still waiting for {who} to okay it, so nothing "
            "has been charged yet."
        )
    if status == "approved":
        return f"{who} said yes to your order {when} of {items}, and the payment is going through."
    if status == "declined":
        if order.get("expired"):
            return (
                f"Your order {when} of {items} wasn't okayed in time, so it didn't go ahead and "
                "nothing was charged."
            )
        return f"{who} decided not to go ahead with your order {when} of {items}, so nothing was charged."
    if status == "failed":
        return f"The payment for your order {when} of {items} didn't go through, so nothing was charged."
    return f"Your order {when} of {items} is still being processed."


def order_status_result(orders: list[dict], context: dict | None, *, fresh: bool, now_ms=None):
    # The order placed on this call is what the caller means: lead with it, so earlier orders
    # of the same items (a retry yesterday, a declined one) never read as "mixed results".
    orders = sorted(orders, key=lambda o: not o.get("thisCall"))
    if not orders:
        return {
            "status": "no_orders",
            "speak": "I don't see any recent orders.",
            "message": "Say that in one short sentence, then ask if they'd like to order something.",
        }
    speak = status_line(orders[0], context, now_ms)
    if orders[0].get("thisCall"):
        # Only this call's orders in the details: earlier orders of the same items (a test
        # yesterday, a declined one) made the model hedge about "mixed results".
        mine = [o for o in orders if o.get("thisCall")]
        earlier, orders = len(orders) - len(mine), mine
    else:
        earlier = 0
    others = len(orders) - 1
    if others:
        speak += (
            f" There {'is' if others == 1 else 'are'} {others} earlier order"
            f"{'' if others == 1 else 's'} too, if you'd like to hear about "
            f"{'it' if others == 1 else 'them'}."
        )
    result = {
        "status": "ok",
        "speak": speak,
        # Compact, read-only details in case the caller asks about an earlier order.
        "orders": [
            {
                "thisCall": bool(o.get("thisCall")),
                "status": o.get("status"),
                "store": o.get("store"),
                "totalCents": o.get("totalCents"),
                "items": spoken_items(o.get("items") or []),
                "when": spoken_when(o.get("createdAt"), _zone(context), now_ms),
                "line": status_line(o, context, now_ms),
            }
            for o in orders[:5]
        ],
        "message": "Tell the caller the speak line in plain words: at most two short sentences.",
    }
    if earlier:
        result["earlierOrders"] = earlier
        result["message"] += (
            " This is the order placed on this call, and its status is current. The caller "
            f"also has {earlier} separate, earlier order{'s' if earlier > 1 else ''}; mention "
            "them only if asked."
        )
    if not fresh:
        result["note"] = "Statuses are as of the start of this call."
    return result


async def order_status(tool_input: dict, ctx) -> dict:
    if not (ctx.context and ctx.call_id):
        return dict(NO_HOUSEHOLD)
    try:
        response = await ctx.api.post("/agent/recent-orders", {"callId": ctx.call_id})
        orders = list(response.get("orders") or [])
        return order_status_result(orders, ctx.context, fresh=True)
    except Exception as exc:  # noqa: BLE001 -- fall back to the snapshot taken at call start
        log.warning("order_status read failed (%s); using call-start snapshot", type(exc).__name__)
    snapshot = sorted(
        (ctx.context or {}).get("recentOrders") or [],
        key=lambda o: o.get("createdAt") or 0,
        reverse=True,
    )
    return order_status_result(snapshot, ctx.context, fresh=False)


# ---------------------------------------------------------------- compare_prices (#66)

SECOND_STORE_DIR = "target"


@lru_cache(maxsize=1)
def second_store() -> tuple[str, dict[str, dict]]:
    """(store name, {storeItemId: item}) from fixtures/<second store>/search.json."""
    path = fixtures_dir().parent / SECOND_STORE_DIR / "search.json"
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return "", {}
    store = str(data.get("store") or "")
    items = {}
    for entry in data.get("entries", []):
        for r in entry.get("results", []):
            items[str(r["storeItemId"])] = {
                "name": str(r["name"]),
                "size": str(r.get("size", "")),
                "priceCents": int(r["priceCents"]),
                "storeItemId": str(r["storeItemId"]),
                "store": store,
            }
    return store, items


def _same_product_id(walmart_id: str) -> str:
    # The fixtures pair products by id: demo-coffee-big <-> demo-target-coffee-big.
    return walmart_id.replace("demo-", "demo-target-", 1)


def _approved(context: dict | None) -> list[str]:
    return list(((context or {}).get("limits") or {}).get("approvedStores") or [])


def compare_prices_result(query: str, context: dict | None) -> dict:
    query = str(query or "").strip()[:100]
    if not query:
        return {"error": "Say what to compare, like 'paper towels'."}
    store, items = second_store()
    options = search_fixtures(query)
    if not options or not store:
        return {
            "status": "no_results",
            "message": "No price comparison is available for that. Offer search_items instead.",
        }
    first = {**options[0], "store": DEFAULT_STORE}
    other = items.get(_same_product_id(first["storeItemId"]))
    if not other:
        return {
            "status": "no_results",
            "message": "Only one store carries that. Offer search_items instead.",
        }
    pair = sorted([first, other], key=lambda o: (o["priceCents"], o["store"] != DEFAULT_STORE))
    cheaper, dearer = pair
    difference = dearer["priceCents"] - cheaper["priceCents"]
    approved = [s.lower() for s in _approved(context)]
    unapproved = [o["store"] for o in pair if o["store"].lower() not in approved]
    if difference:
        speak = (
            f"{spoken_item(first['name']).capitalize()} is {spoken_dollars(cheaper['priceCents'])} "
            f"at {cheaper['store']} and {spoken_dollars(dearer['priceCents'])} at "
            f"{dearer['store']}, so {cheaper['store']} is cheaper by "
            f"{spoken_dollars(difference)}."
        )
    else:
        speak = (
            f"{spoken_item(first['name']).capitalize()} is the same price at both, "
            f"{spoken_dollars(cheaper['priceCents'])}."
        )
    result = {
        "status": "ok",
        "query": query,
        "source": "cache",
        "options": pair,  # at most two, cheapest first
        "cheaperStore": cheaper["store"] if difference else None,
        "differenceCents": difference,
        "speak": speak,
        "message": "Say the speak line, then ask which store they'd like. Order from one store "
        "at a time, passing that store to place_order.",
    }
    if unapproved:
        result["approvalNote"] = (
            f"{' and '.join(unapproved)} isn't one of the caller's approved stores, so an order "
            "there goes to their family to okay first. Say so if they choose it."
        )
    return result


async def compare_prices(tool_input: dict, ctx) -> dict:
    result = compare_prices_result(str(tool_input.get("query") or ""), ctx.context)
    for option in result.get("options") or []:
        remember_items(ctx.call_id, [option], option["store"])
    return result


# ---------------------------------------------------------------- stop_checkins (#60)

STOP_FAILED = {
    "error": "That didn't save just now. Say honestly that you couldn't turn check-in calls off "
    "right now and that their family can turn them off from the dashboard."
}


async def stop_checkins(tool_input: dict, ctx) -> dict:
    if not (ctx.context and ctx.call_id):
        return dict(NO_HOUSEHOLD)
    try:
        await ctx.api.post("/agent/checkins-stop", {"callId": ctx.call_id})
    except Exception as exc:  # noqa: BLE001 -- tool boundary
        log.warning("stop_checkins failed (%s)", type(exc).__name__)
        return dict(STOP_FAILED)
    return {
        "status": "stopped",
        "message": "Check-in calls are off. Confirm warmly in one sentence that you won't call "
        "to check in again, and that they can still call any time.",
    }
