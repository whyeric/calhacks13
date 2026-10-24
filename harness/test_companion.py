"""Phase 3 memory/companion/wellbeing on the agent side (#47 #58 #59 #63 #69 #73 #76)."""

import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

import wellbeing
from arrival import expected_arrival
from context import STATIC_PROMPT, call_context, due_followup, greeting, memory_block
from convex_api import ConvexAPI
from tools import ToolContext, dispatch

LA = ZoneInfo("America/Los_Angeles")
HOUSEHOLD = {
    "household": {
        "preferredName": "Margaret",
        "timezone": "America/Los_Angeles",
        "sharing": {"chatTranscripts": False, "moodNotes": False},
        "introduced": True,
        "familyContacts": [{"name": "Dana", "relation": "daughter"}],
    },
    "followups": [{"_id": "f1", "speakable": "How did Lily's recital go?", "notBefore": 0}],
}


def api_with(handler):
    return ConvexAPI(
        "https://example.convex.site",
        "test-agent-".ljust(40, "a"),
        transport=httpx.MockTransport(handler),
    )


def ctx_for(api, context=HOUSEHOLD):
    return ToolContext(
        api=api, call_id=f"call-{uuid.uuid4().hex[:8]}", context=context, tool_use_id="toolu_1"
    )


# ---- tools ---------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_family_flushes_turns_first_and_shows_only_status_to_the_model():
    seen = []

    def handler(request: httpx.Request):
        seen.append((request.url.path, json.loads(request.content)))
        if request.url.path == "/agent/connect":
            return httpx.Response(
                200,
                json={
                    "status": "sent",
                    "contact": "Dana",
                    "delivery": "ringing",
                    "message": "Dana will get the message.",
                },
            )
        return httpx.Response(200, json={"turnId": "t"})

    api = api_with(handler)
    ctx = ctx_for(api)
    api.log_turn({"callId": ctx.call_id, "idx": 3, "speaker": "user", "text": "Yes please."})
    result = await dispatch("connect_family", {"contact": "Dana", "message": "Call me"}, ctx)
    # The caller's yes reached Convex before the consent check.
    assert [path for path, _ in seen] == ["/agent/turn", "/agent/connect"]
    assert seen[1][1] == {"callId": ctx.call_id, "contact": "Dana", "message": "Call me"}
    assert result == {"status": "sent", "contact": "Dana", "message": "Dana will get the message."}
    await api.close()


@pytest.mark.asyncio
async def test_connect_without_consent_is_reported_honestly():
    api = api_with(
        lambda r: httpx.Response(
            200, json={"status": "needs_consent", "message": "Nothing was sent. Ask first."}
        )
    )
    result = await dispatch("connect_family", {"contact": "Dana", "message": ""}, ctx_for(api))
    assert result["status"] == "needs_consent" and "Nothing was sent" in result["message"]
    await api.close()


@pytest.mark.asyncio
async def test_forget_fact_confirms_without_repeating_and_errors_point_to_the_dashboard():
    api = api_with(
        lambda r: httpx.Response(
            200,
            json={
                "status": "forgotten",
                "forgotten": ["Margaret planted tomatoes."],
                "redactedTurns": 0,
            },
        )
    )
    result = await dispatch("forget_fact", {"description": "my tomatoes"}, ctx_for(api))
    assert result["status"] == "forgotten" and result["count"] == 1
    assert "tomatoes" not in json.dumps(result)
    await api.close()

    broken = api_with(lambda r: httpx.Response(500, json={"error": "x"}))
    result = await dispatch("forget_fact", {"description": "my tomatoes"}, ctx_for(broken))
    assert "dashboard" in result["error"]
    await broken.close()


@pytest.mark.asyncio
async def test_raise_wellbeing_alert_validates_level_and_never_claims_on_failure():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "sent", "contact": "Dana", "message": "ok"})

    api = api_with(handler)
    assert "error" in await dispatch(
        "raise_wellbeing_alert", {"level": "panic", "summary": "x"}, ctx_for(api)
    )
    result = await dispatch(
        "raise_wellbeing_alert", {"level": "emergency", "summary": "Fell."}, ctx_for(api)
    )
    assert result["status"] == "sent"
    assert bodies[-1]["source"] == "model" and bodies[-1]["level"] == "emergency"
    await api.close()
    broken = api_with(lambda r: httpx.Response(503))
    result = await dispatch(
        "raise_wellbeing_alert", {"level": "crisis", "summary": "x"}, ctx_for(broken)
    )
    assert "Don't say the family was told" in result["error"] and "988" in result["error"]
    await broken.close()


# ---- wellbeing classifier and templates (WB-1, WB-2, WB-5) ------------------------------------


@pytest.mark.parametrize(
    "text,level",
    [
        ("I fell and I can't get up.", "emergency"),
        ("I've fallen in the kitchen", "emergency"),
        ("My chest hurts and I can't breathe", "emergency"),
        ("Sometimes I just want to die.", "crisis"),
        ("I've been thinking about killing myself", "crisis"),
        ("I don't want to live anymore", "crisis"),
        ("I would never hurt myself, don't worry.", None),
        ("Lily fell asleep during the movie", None),
        ("I need paper towels", None),
    ],
)
def test_detect(text, level):
    assert wellbeing.detect(text) == level


def test_safety_lines_are_templated_and_name_family():
    assert wellbeing.emergency_line("Dana") == (
        "If you're hurt, please hang up and call 911 now. I'm letting Dana know right away. "
        "Are you safe right now?"
    )
    crisis = wellbeing.crisis_line("Dana")
    assert "call or text 988" in crisis and "911" in crisis and "letting Dana know" in crisis
    assert "letting" not in wellbeing.crisis_line(None)


class FakeAPI:
    def __init__(self):
        self.fired = []

    def fire(self, route, payload):
        self.fired.append((route, payload))


def test_guard_alerts_family_once_per_level_and_unknown_callers_get_the_line_only():
    api = FakeAPI()
    guard = wellbeing.WellbeingGuard(api, "call-1", HOUSEHOLD)
    line = guard.check("I fell and I can't get up")
    assert line.startswith("If you're hurt") and "Dana" in line
    assert guard.check("I still can't get up") is not None
    assert [p["level"] for _, p in api.fired] == ["emergency"]
    assert api.fired[0][0] == "/agent/wellbeing" and api.fired[0][1]["source"] == "classifier"
    assert guard.check("hello") is None

    unknown = wellbeing.WellbeingGuard(api, "call-2", None)
    line = unknown.check("I want to die")
    assert "988" in line and "letting" not in line
    assert len(api.fired) == 1

    guard.after_refusal("I'm going to overdose")
    assert api.fired[-1][1]["source"] == "refusal"


def test_add_to_history_keeps_the_conversation_append_only_and_alternating():
    class Conv:
        def __init__(self):
            self.messages = [
                {"role": "user", "content": "<call_context>"},
                {"role": "assistant", "content": "Hi"},
            ]

    conv = Conv()
    wellbeing.add_to_history(conv, "I fell", "Call 911.")
    assert [m["role"] for m in conv.messages] == ["user", "assistant", "user", "assistant"]
    assert conv.messages[-1]["content"][0]["text"] == "Call 911."


# ---- #59 arrival -------------------------------------------------------------------------------


def test_arrival_is_tomorrow_in_the_callers_timezone(monkeypatch):
    for name in ["ORDER_ARRIVAL_PHRASE", "ORDER_ARRIVAL_DAYS", "ORDER_CUTOFF_HOUR"]:
        monkeypatch.delenv(name, raising=False)
    # 11:30 pm Friday in Los Angeles is already Saturday in UTC; tomorrow is still Saturday.
    now = datetime(2026, 10, 23, 23, 30, tzinfo=LA)
    assert expected_arrival(now) == "tomorrow, Saturday, October 24"
    monkeypatch.setenv("ORDER_CUTOFF_HOUR", "20")
    assert expected_arrival(now) == "the day after tomorrow, Sunday, October 25"
    monkeypatch.setenv("ORDER_ARRIVAL_PHRASE", "Monday")
    assert expected_arrival(now) == "Monday"
    text = call_context(
        HOUSEHOLD, asked_followup=False, now=datetime(2026, 10, 24, 10, 0, tzinfo=LA)
    )
    assert "Expected arrival to quote in order read-backs: Monday." in text


# ---- #69 first call ----------------------------------------------------------------------------


def test_first_call_introduces_asks_name_and_skips_the_followup():
    first = json.loads(json.dumps(HOUSEHOLD))
    first["household"]["introduced"] = False
    assert due_followup(first, now_ms=10**13) is None
    opening = greeting(first, None)
    assert "AI assistant that Dana set up" in opening and opening.endswith(
        "What would you like me to call you?"
    )
    text = call_context(first, asked_followup=False)
    assert "First call" in text and "full transcripts" in text and "Dana" in text
    # Later calls skip both.
    assert due_followup(HOUSEHOLD, now_ms=10**13)["_id"] == "f1"
    assert "First call" not in call_context(HOUSEHOLD, asked_followup=True)
    assert greeting(HOUSEHOLD, None).startswith("Hi Margaret")


def test_memory_block_states_what_the_family_sees():
    block = memory_block(HOUSEHOLD)
    assert "full transcripts of chat-only calls: no (private)" in block
    assert "mood notes: no (private)" in block


def test_companion_and_wellbeing_prompt_sections():
    assert "# Companion conversation" in STATIC_PROMPT
    assert "I'm glad you called" in STATIC_PROMPT
    assert "988" in STATIC_PROMPT and "911" in STATIC_PROMPT
    assert "Margaret" not in STATIC_PROMPT and "Dana" not in STATIC_PROMPT
