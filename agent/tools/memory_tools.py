"""Phase 2 companion tools: forget_fact (#47), connect_family (#63), raise_wellbeing_alert
(#73 #76). The checks live in Convex: consent for connect_family and non-urgent concerns is
read from the logged transcript, so pending turn writes are flushed before each request.
"""

import logging

log = logging.getLogger(__name__)

NO_HOUSEHOLD = (
    "This phone number isn't registered with a household, so this isn't available. "
    "Tell the caller kindly; a family member can set the line up."
)
FORGET_FAILED = {
    "error": "Forgetting didn't work just now. Say honestly that you couldn't remove it right "
    "now and that their family can delete it from the dashboard."
}
CONNECT_FAILED = {
    "error": "The message could not be sent just now. Don't say the family was told; offer to "
    "try again later."
}
WELLBEING_FAILED = {
    "error": "The family alert could not be sent just now. Don't say the family was told. Keep "
    "following the safety guidance: 911 for an emergency, 988 for a crisis."
}
LEVELS = ("emergency", "crisis", "concern")


def _ready(ctx) -> bool:
    return bool(ctx.context and ctx.call_id)


async def _post(ctx, route: str, payload: dict) -> dict:
    # The caller's yes (and the offer before it) must be on record before Convex checks it.
    await ctx.api.flush()
    return await ctx.api.post(route, payload)


async def forget_fact(tool_input: dict, ctx) -> dict:
    if not _ready(ctx):
        return {"error": NO_HOUSEHOLD}
    description = " ".join(str(tool_input.get("description") or "").split())[:300]
    if not description:
        return {"error": "Ask the caller what they would like you to forget."}
    try:
        result = await _post(
            ctx, "/agent/forget", {"callId": ctx.call_id, "description": description}
        )
    except Exception as exc:  # noqa: BLE001 -- tool boundary
        log.warning("forget_fact failed (%s)", type(exc).__name__)
        return dict(FORGET_FAILED)
    if result.get("status") == "forgotten":
        return {
            "status": "forgotten",
            "count": len(result.get("forgotten") or []) + int(result.get("redactedTurns") or 0),
            "message": "Removed from memory. Confirm in plain words that you won't remember it "
            "or bring it up again. Don't repeat what it was.",
        }
    return {
        "status": "nothing_matched",
        "message": "Nothing like that was in memory. Reassure the caller that you won't keep "
        "it, and that their family can also delete notes from the dashboard.",
    }


async def connect_family(tool_input: dict, ctx) -> dict:
    if not _ready(ctx):
        return {"error": NO_HOUSEHOLD}
    contact = " ".join(str(tool_input.get("contact") or "").split())[:100]
    message = " ".join(str(tool_input.get("message") or "").split())[:500]
    try:
        result = await _post(
            ctx,
            "/agent/connect",
            {"callId": ctx.call_id, "contact": contact, "message": message},
        )
    except Exception as exc:  # noqa: BLE001 -- tool boundary
        log.warning("connect_family failed (%s)", type(exc).__name__)
        return dict(CONNECT_FAILED)
    return _model_view(result)


async def raise_wellbeing_alert(tool_input: dict, ctx) -> dict:
    if not _ready(ctx):
        return {
            "error": "No family is on file for this number, so no alert was sent. Keep "
            "following the safety guidance: 911 for an emergency, 988 for a crisis."
        }
    level = str(tool_input.get("level") or "")
    if level not in LEVELS:
        return {"error": 'level must be "emergency", "crisis" or "concern".'}
    summary = " ".join(str(tool_input.get("summary") or "").split())[:600]
    try:
        result = await _post(
            ctx,
            "/agent/wellbeing",
            {"callId": ctx.call_id, "level": level, "summary": summary, "source": "model"},
        )
    except Exception as exc:  # noqa: BLE001 -- tool boundary
        log.warning("raise_wellbeing_alert failed (%s)", type(exc).__name__)
        return dict(WELLBEING_FAILED)
    return _model_view(result)


def _model_view(result: dict) -> dict:
    """Only status, the contact's first name and the instruction reach the model."""
    view = {"status": str(result.get("status") or "error")}
    if result.get("contact"):
        view["contact"] = str(result["contact"])
    if result.get("message"):
        view["message"] = str(result["message"])
    if view["status"] == "error":
        view["error"] = str(result.get("error") or "Not sent.")
    return view
