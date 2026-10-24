"""Per-call memory of items the tools have shown the caller, and of orders already sent.

place_order resolves names and prices from here (or the fixture catalog), never from the model.
Keyed by callId, so it works whether the caller builds one ToolContext per call or per tool use.
"""

from collections import OrderedDict

_MAX_CALLS = 256
_calls: "OrderedDict[str, dict]" = OrderedDict()


def call_state(call_id: str | None) -> dict:
    """{"items": {storeItemId: item}, "orders": {signature: {...}}} for this call."""
    key = call_id or "__no_call__"
    state = _calls.get(key)
    if state is None:
        state = {"items": {}, "orders": {}}
        _calls[key] = state
        while len(_calls) > _MAX_CALLS:
            _calls.popitem(last=False)
    else:
        _calls.move_to_end(key)
    return state


def remember_items(call_id: str | None, items: list[dict], store: str):
    known = call_state(call_id)["items"]
    for item in items:
        if item.get("storeItemId") and item.get("priceCents") is not None:
            known[item["storeItemId"]] = {**item, "store": item.get("store") or store}


def forget_call(call_id: str | None):
    """Drop a finished call's state (optional; old calls are evicted automatically)."""
    _calls.pop(call_id or "__no_call__", None)
