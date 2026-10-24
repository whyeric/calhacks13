"""Model-called tools (§10.3): fixed definitions plus a dispatcher that never raises."""

import logging
import os
from dataclasses import dataclass
from typing import Any

from . import memory_tools, stretch
from .catalog import DEFAULT_STORE
from .definitions import TOOL_NAMES, TOOLS
from .favorites import match_favorite
from .order import HOLD_WINDOW_S, UNCONFIRMED, ApprovalHold, confirmation_line, place_order
from .search import close_client, search_items
from .state import call_state, forget_call, remember_items

__all__ = [
    "TOOLS",
    "TOOL_NAMES",
    "ToolContext",
    "close_client",
    "dispatch",
    "forget_call",
    "tool_outcome",
]

log = logging.getLogger(__name__)

NEEDS_HOUSEHOLD = (
    "This phone number isn't registered with a household, so ordering isn't available. "
    "A family member can set it up."
)
# VO-3 / #51: tools that shop or order for a household. An unknown caller gets a polite
# refusal without any lookup, search or Convex request.
HOUSEHOLD_TOOLS = frozenset(
    {"match_favorite", "search_items", "place_order", "order_status", "compare_prices"}
)
UNKNOWN_CALLER_RESULT = {
    "error": (
        "This phone number isn't registered with a household, so nothing can be looked up "
        "or ordered on this call. Tell the caller kindly that a family member can set the "
        "line up for them; don't offer to search or order."
    ),
}


@dataclass
class ToolContext:
    api: Any  # ConvexAPI
    call_id: str | None
    context: dict | None  # the /agent/household context; None for unknown callers
    tool_use_id: str


def _not_available(what: str, extra: str) -> dict:
    return {
        "status": "not_available",
        "message": f"{what} isn't available yet. Tell the caller honestly. {extra}",
    }


async def _match_favorite(tool_input: dict, ctx: ToolContext) -> dict:
    result = match_favorite(str(tool_input.get("utterance") or ""), ctx.context.get("favorites"))
    shown = [result["favorite"]] if "favorite" in result else result.get("candidates", [])
    remember_items(ctx.call_id, shown, DEFAULT_STORE)
    return result


async def _search_items(tool_input: dict, ctx: ToolContext) -> dict:
    result = await search_items(str(tool_input.get("query") or ""))
    remember_items(ctx.call_id, result.get("options", []), result.get("store", DEFAULT_STORE))
    return result


def _remember_order_history(ctx: ToolContext):
    """M2: items from recent orders ("the same coffee as last time") are orderable by id.

    Never overrides an item shown on this call: a fresh search or favorite price wins.
    """
    known = call_state(ctx.call_id)["items"]
    for order in (ctx.context or {}).get("recentOrders") or []:
        earlier = [
            {
                "name": i.get("name"),
                "storeItemId": i.get("storeItemId"),
                "priceCents": i.get("priceCents"),
            }
            for i in order.get("items") or []
            if isinstance(i, dict) and i.get("name") and i.get("storeItemId") not in known
        ]
        remember_items(ctx.call_id, earlier, order.get("store") or DEFAULT_STORE)


async def _place_order(tool_input: dict, ctx: ToolContext) -> dict:
    if not ctx.context or not ctx.call_id:
        return {"error": NEEDS_HOUSEHOLD}
    _remember_order_history(ctx)
    result = await place_order(ctx.api, ctx.call_id, ctx.tool_use_id, tool_input)
    say = confirmation_line(result, ctx.context)
    hold = _approval_hold(result, ctx)
    if hold:
        say = hold.opening_line(result.get("reason") or "")
    # "say" is spoken at once by ClaudeConversation and "_hold" runs the approval hold (#92);
    # neither reaches the tool_result the model sees.
    extra = {"say": say} if say else {}
    if hold:
        extra["_hold"] = hold
    return {**result, **extra}


def _approval_hold(result: dict, ctx: ToolContext) -> ApprovalHold | None:
    """Hold the caller on the line for a needs_approval order (APPROVAL_HOLD_S=0 turns it off)."""
    window = float(os.getenv("APPROVAL_HOLD_S") or HOLD_WINDOW_S)
    if window <= 0 or result.get("status") != "needs_approval" or not result.get("orderId"):
        return None
    if not hasattr(ctx.api, "order_status"):
        return None
    return ApprovalHold(ctx.api, ctx.call_id, result["orderId"], ctx.context, window_s=window)


async def _forget_fact(tool_input: dict, ctx: ToolContext) -> dict:
    return await memory_tools.forget_fact(tool_input, ctx)


async def _connect_family(tool_input: dict, ctx: ToolContext) -> dict:
    return await memory_tools.connect_family(tool_input, ctx)


async def _raise_wellbeing_alert(tool_input: dict, ctx: ToolContext) -> dict:
    return await memory_tools.raise_wellbeing_alert(tool_input, ctx)


_HANDLERS = {
    "match_favorite": _match_favorite,
    "search_items": _search_items,
    "place_order": _place_order,
    "forget_fact": _forget_fact,
    "connect_family": _connect_family,
    "raise_wellbeing_alert": _raise_wellbeing_alert,
    # Milestone 7 stretch (#55 #66 #60), in the same order as definitions.TOOLS.
    "order_status": stretch.order_status,
    "compare_prices": stretch.compare_prices,
    "stop_checkins": stretch.stop_checkins,
}
assert tuple(_HANDLERS) == TOOL_NAMES


async def dispatch(name: str, tool_input: dict, ctx: ToolContext) -> dict:
    """Run one tool_use block. Never raises; problems come back as {"error": ...}."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"error": f"Unknown tool {name!r}."}
    if not isinstance(tool_input, dict):
        return {"error": "Tool input must be an object."}
    if name in HOUSEHOLD_TOOLS and not ctx.context:
        return dict(UNKNOWN_CALLER_RESULT)
    try:
        return await handler(tool_input, ctx)
    except Exception as exc:  # noqa: BLE001 -- tool boundary: errors become results
        log.warning("Tool %s failed (%s)", name, type(exc).__name__)
        if name == "place_order":
            return dict(UNCONFIRMED)  # it may have reached the payment step: never say "failed"
        return {
            "error": "Something went wrong with that. Apologize briefly and offer to try again."
        }


def tool_outcome(result) -> str:
    """Short, argument-free outcome for the turn log (#80): a status word, never details.

    Fits Convex's turn tool limit (64 characters) and carries no payment identifiers.
    """
    if not isinstance(result, dict):
        return "ok"
    if "error" in result:
        return "error"
    status = result.get("status")
    return str(status)[:64] if status else "ok"
