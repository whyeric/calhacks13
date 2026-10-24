"""Outbound check-in calls (#60): recognize a call Errand Line placed and open it from memory.

Convex places the call (convex/checkins.ts) to this same agent with the check-in id as a
dynamic variable. When Line hands the call to get_agent, `outbound_checkin` asks Convex for the
check-in (/agent/checkin-start), which opens the call record (kind "checkin", outbound) and
returns the household context plus two lines written in Convex:

- opener: voicemail-safe, said first ("Hi Margaret, it's Errand Line, ... calling to check in.
  Is now a good time?"). No private details, in case an answering machine picks up.
- memoryLine: the usual item plus at most one follow-up (MEM-2), said once a person answers.

Detection never needs a network request for inbound calls: a call is outbound only when Line's
call metadata carries a checkinId, or when CHECKIN_FROM_NUMBER (our caller ID, E.164) is the
call's "from" number.
"""

import logging
import os

log = logging.getLogger(__name__)


class CheckinNotFound(LookupError):
    """An outbound call we can't match to a check-in; the caller gets the polite apology."""


def _checkin_id(metadata) -> str | None:
    if not isinstance(metadata, dict):
        return None
    for source in (metadata, metadata.get("dynamic_variables"), metadata.get("variables")):
        if isinstance(source, dict) and isinstance(source.get("checkinId"), str):
            return source["checkinId"][:64]
    return None


def is_outbound(request) -> bool:
    if _checkin_id(getattr(request, "metadata", None)):
        return True
    ours = (os.getenv("CHECKIN_FROM_NUMBER") or "").strip()
    return bool(ours) and getattr(request, "from_", None) == ours


async def outbound_checkin(api, request) -> dict | None:
    """{"context", "callId", "checkin"} for an outbound check-in call; None for inbound calls.

    Raises CheckinNotFound when the call is outbound but no check-in matches it.
    """
    if not is_outbound(request):
        return None
    payload = {"providerCallId": request.agent_call_id, "calledPhone": request.to}
    checkin_id = _checkin_id(getattr(request, "metadata", None))
    if checkin_id:
        payload["checkinId"] = checkin_id
    result = await api.post("/agent/checkin-start", payload)
    if not result.get("callId") or not result.get("context") or not result.get("checkin"):
        raise CheckinNotFound("no matching check-in")
    return result


def attach(agent, checkin: dict | None):
    """Mark an ErrandAgent as a check-in call. Its one follow-up is the check-in's (MEM-2)."""
    agent.checkin = checkin
    if checkin:
        followup_id = checkin.get("followupId")
        agent.followup = (
            {"_id": followup_id, "speakable": checkin.get("memoryLine", "")}
            if followup_id
            else None
        )
    return agent


def _clean(text) -> str:
    return " ".join(str(text or "").split()).replace("<", "‹").replace(">", "›")


def context_note(checkin: dict) -> str:
    """Appended to the <call_context> turn on a check-in call."""
    line = _clean(checkin.get("memoryLine"))
    return (
        "<checkin>Written by the Errand Line system. This is an outbound check-in call: "
        "Errand Line called the caller; they did not call you. Your opening asked whether now "
        "is a good time. If they say yes or start chatting, say this next, in your own warm "
        f'words but keeping its meaning: "{line}" Raise no other memory follow-up on this '
        "call. If now is not a good time, say you'll let them go and say goodbye. If they say "
        "they don't want these calls, use stop_checkins. If an answering machine or voicemail "
        'picked up, say only "Sorry I missed you. Goodbye." and nothing else.</checkin>'
    )


def opening(agent, greeting, call_context) -> tuple[str, str]:
    """(call context text, spoken opening) for CallStarted; `greeting` and `call_context` are
    the context.py functions, passed in so this module never changes the inbound path."""
    checkin = getattr(agent, "checkin", None)
    if not checkin:
        return (
            call_context(agent.context, asked_followup=bool(agent.followup)),
            greeting(agent.context, agent.followup),
        )
    text = call_context(agent.context, asked_followup=False)
    return f"{text}\n{context_note(checkin)}", _clean(checkin.get("opener"))
