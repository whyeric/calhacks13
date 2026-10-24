"""Milestone 7 stretch features: #55 order_status, #66 compare_prices, #60 check-ins
(stop_checkins and the outbound opener), #65 spoken PIN gate and #67 Spanish handoff.
No network: Convex is faked and the Anthropic client is scripted."""

import copy
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from line.events import (
    AgentEndCall,
    AgentSendText,
    AgentUpdateCall,
    CallEnded,
    CallStarted,
    UserTextSent,
    UserTurnEnded,
)
from test_agent import (
    MARGARET,
    THINKING,
    FakeClient,
    FakeStream,
    collect,
    fake_api,
    final,
    order_start_event,
    text_event,
    tool_start_event,
)

import checkin
import pin
import spanish
import tools
from claude import ClaudeConversation
from context import call_context, greeting, system_blocks
from main import ErrandAgent
from tools import ToolContext, dispatch
from tools.stretch import compare_prices_result, order_status_result, spoken_items, status_line

DAY = 86_400_000
NOW = 1_761_300_000_000  # Friday, October 24, 2025, about 3 a.m. Pacific
CONTEXT = {
    "household": {
        "preferredName": "Margaret",
        "timezone": "America/Los_Angeles",
        "familyContacts": [{"name": "Dana", "relation": "daughter"}],
    },
    "limits": {
        "perOrderCapCents": 5000,
        "monthlyBudgetCents": 20000,
        "approvedStores": ["Walmart"],
    },
    "favorites": [],
    "recentOrders": [],
}


def user(text):
    return UserTurnEnded(content=[UserTextSent(content=text)])


def ctx_for(api, context=CONTEXT, tool_use_id="toolu_1"):
    return ToolContext(
        api=api, call_id=f"call-{uuid.uuid4().hex[:8]}", context=context, tool_use_id=tool_use_id
    )


# ---------------------------------------------------------------- #55 order_status


def order(status, days_ago=0, **extra):
    return {
        "status": status,
        "store": "Walmart",
        "totalCents": 2145,
        "createdAt": NOW - days_ago * DAY,
        "items": [
            {"name": "Paper towels, 6-roll pack", "qty": 1},
            {"name": "Medium-roast coffee, big can", "qty": 1},
        ],
        **extra,
    }


def test_order_status_lines_are_plain_and_honest_about_approval():
    paid = status_line(order("paid"), CONTEXT, NOW)
    assert paid == (
        "Your order today of paper towels and medium-roast coffee went through, and twenty-one "
        "dollars and forty-five cents was paid."
    )
    waiting = status_line(order("awaiting_approval", 1), CONTEXT, NOW)
    assert waiting == (
        "Your order yesterday of paper towels and medium-roast coffee is still waiting for Dana "
        "to okay it, so nothing has been charged yet."
    )
    assert "paid" not in waiting and "ordered" not in waiting
    declined = status_line(order("declined", 3, decidedBy="Dana"), CONTEXT, NOW)
    assert declined.startswith("Dana decided not to go ahead") and "nothing was charged" in declined
    expired = status_line(order("declined", 9, expired=True), CONTEXT, NOW)
    assert "on October 15" in expired and "wasn't okayed in time" in expired
    assert "didn't go through" in status_line(order("failed"), CONTEXT, NOW)
    assert spoken_items([{"name": "A, x"}, {"name": "B"}, {"name": "C"}, {"name": "D"}]) == (
        "a, b and 2 more items"
    )


def test_order_status_speaks_at_most_two_sentences():
    result = order_status_result([order("paid"), order("paid", 5)], CONTEXT, fresh=True, now_ms=NOW)
    assert result["status"] == "ok"
    assert result["speak"].count(".") == 2
    assert "1 earlier order" in result["speak"]
    empty = order_status_result([], CONTEXT, fresh=True)
    assert empty["status"] == "no_orders" and "don't see any" in empty["speak"]


@pytest.mark.asyncio
async def test_order_status_reads_convex_read_only_and_falls_back_to_the_snapshot():
    api = SimpleNamespace(post=AsyncMock(return_value={"orders": [order("awaiting_approval")]}))
    ctx = ctx_for(api)
    result = await dispatch("order_status", {}, ctx)
    api.post.assert_awaited_once_with("/agent/recent-orders", {"callId": ctx.call_id})
    assert "waiting for Dana" in result["speak"] and "note" not in result

    broken = SimpleNamespace(post=AsyncMock(side_effect=RuntimeError("down")))
    snapshot = {**CONTEXT, "recentOrders": [order("failed", 2), order("paid", 0)]}
    result = await dispatch("order_status", {}, ctx_for(broken, snapshot))
    assert result["note"] == "Statuses are as of the start of this call."
    assert [o["status"] for o in result["orders"]] == ["paid", "failed"]  # newest first

    unknown = await dispatch("order_status", {}, ctx_for(api, None))
    assert "error" in unknown


def test_order_status_leads_with_the_order_placed_on_this_call():
    # Newest first, but an earlier test run's declined order is newer than nothing here: the
    # order from this call is what "has Dana answered?" means.
    other = {**order("declined", 0), "thisCall": False}
    mine = {**order("awaiting_approval", 1), "thisCall": True}
    result = order_status_result([other, mine], CONTEXT, fresh=True)
    assert "waiting for Dana" in result["speak"] and "earlier order" not in result["speak"]
    assert [o["thisCall"] for o in result["orders"]] == [True]
    assert result["earlierOrders"] == 1 and "placed on this call" in result["message"]
    plain = order_status_result([order("paid", 0)], CONTEXT, fresh=True)
    assert "placed on this call" not in plain["message"]


# ---------------------------------------------------------------- #66 compare_prices


def test_compare_prices_offers_two_stores_cheapest_first_and_flags_unapproved_store():
    result = compare_prices_result("some paper towels", CONTEXT)
    assert [(o["store"], o["priceCents"]) for o in result["options"]] == [
        ("Target", 849),
        ("Walmart", 897),
    ]
    assert result["cheaperStore"] == "Target" and result["differenceCents"] == 48
    assert "Target is cheaper by forty-eight cents" in result["speak"]
    assert "Target isn't one of the caller's approved stores" in result["approvalNote"]

    coffee = compare_prices_result("coffee", CONTEXT)
    assert coffee["cheaperStore"] == "Target" and len(coffee["options"]) == 2
    milk = compare_prices_result("milk", CONTEXT)
    assert milk["cheaperStore"] == "Walmart" and "approvalNote" in milk  # both always listed
    assert compare_prices_result("garden gnome", CONTEXT)["status"] == "no_results"


@pytest.mark.asyncio
async def test_a_compared_second_store_item_orders_at_that_store():
    posted = []

    async def post(route, payload, **kwargs):
        posted.append((route, payload))
        return {"status": "needs_approval", "orderId": "o1", "totalCents": 849, "reason": "x"}

    api = SimpleNamespace(post=post, flush=AsyncMock())
    ctx = ctx_for(api)
    await dispatch("compare_prices", {"query": "paper towels"}, ctx)
    order_ctx = ToolContext(api=api, call_id=ctx.call_id, context=CONTEXT, tool_use_id="toolu_2")
    result = await dispatch(
        "place_order",
        {"items": [{"storeItemId": "demo-target-paper-towels-6", "qty": 1}]},
        order_ctx,
    )
    assert result["status"] == "needs_approval"
    route, payload = posted[-1]
    assert route == "/agent/order"
    assert payload["store"] == "Target"
    assert payload["items"] == [
        {
            "name": "Paper towels, 6-roll pack",
            "storeItemId": "demo-target-paper-towels-6",
            "qty": 1,
            "priceCents": 849,
        }
    ]


# ---------------------------------------------------------------- #60 check-ins


@pytest.mark.asyncio
async def test_stop_checkins_posts_once_and_reports_failure_honestly():
    api = SimpleNamespace(post=AsyncMock(return_value={"status": "stopped"}))
    ctx = ctx_for(api)
    assert (await dispatch("stop_checkins", {}, ctx))["status"] == "stopped"
    api.post.assert_awaited_once_with("/agent/checkins-stop", {"callId": ctx.call_id})
    api.post.side_effect = RuntimeError("down")
    assert "error" in await dispatch("stop_checkins", {}, ctx)
    assert "error" in await dispatch("stop_checkins", {}, ctx_for(api, None))


CHECKIN = {
    "checkinId": "chk1",
    "opener": "Hi Margaret, it's Errand Line, your AI assistant, calling to check in. Is now a "
    "good time?",
    "memoryLine": "Would you like me to order your usual medium-roast coffee this week? And how "
    "did the tomatoes do?",
    "followupId": "f-9",
}


@pytest.mark.asyncio
async def test_inbound_calls_are_never_treated_as_check_ins(monkeypatch):
    monkeypatch.delenv("CHECKIN_FROM_NUMBER", raising=False)
    api = SimpleNamespace(post=AsyncMock())
    request = SimpleNamespace(
        from_="+14155550100", to="+14155550000", agent_call_id="c1", metadata={}
    )
    assert await checkin.outbound_checkin(api, request) is None
    api.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_outbound_check_in_opens_voicemail_safe_then_says_the_memory_line(monkeypatch):
    monkeypatch.setenv("CHECKIN_FROM_NUMBER", "+14155550000")
    context = copy.deepcopy(MARGARET)
    api, _writes, _fired = fake_api()
    api.post = AsyncMock(
        return_value={"context": context, "callId": "call-out", "checkin": CHECKIN}
    )
    request = SimpleNamespace(
        from_="+14155550000", to="+14155550100", agent_call_id="out-1", metadata=None
    )
    started = await checkin.outbound_checkin(api, request)
    api.post.assert_awaited_once_with(
        "/agent/checkin-start", {"providerCallId": "out-1", "calledPhone": "+14155550100"}
    )
    agent = ErrandAgent(
        ClaudeConversation(FakeClient(), system_blocks(context), []), api, "call-out", context
    )
    checkin.attach(agent, started["checkin"])
    context_text, opening = checkin.opening(agent, greeting, call_context)
    assert opening == CHECKIN["opener"]
    assert "tomatoes" not in opening and "coffee" not in opening  # nothing private on voicemail
    assert CHECKIN["memoryLine"] in context_text
    assert "it did not ask a memory follow-up" in context_text
    assert "stop_checkins" in context_text
    # The check-in's follow-up is this call's one follow-up (MEM-2).
    assert agent.followup == {"_id": "f-9", "speakable": CHECKIN["memoryLine"]}

    # A call matched by metadata alone also counts as outbound.
    monkeypatch.delenv("CHECKIN_FROM_NUMBER")
    assert checkin.is_outbound(SimpleNamespace(from_="x", metadata={"checkinId": "chk1"}))
    api.post = AsyncMock(return_value={"context": None, "callId": None})
    with pytest.raises(checkin.CheckinNotFound):
        await checkin.outbound_checkin(
            api,
            SimpleNamespace(
                from_="x", to="+14155550100", agent_call_id="o2", metadata={"checkinId": "c"}
            ),
        )


def test_inbound_opening_is_unchanged():
    context = copy.deepcopy(MARGARET)
    agent = SimpleNamespace(context=context, followup=None, checkin=None)
    context_text, opening = checkin.opening(agent, greeting, call_context)
    assert opening == greeting(context, None)
    assert "<checkin>" not in context_text


# ---------------------------------------------------------------- #65 spoken PIN


def test_spoken_digits():
    assert pin.spoken_digits("4 8 2 1") == "4821"
    assert pin.spoken_digits("It's four eight two one.") == "4821"
    assert pin.spoken_digits("Oh, it's 4821") == "4821"
    assert pin.spoken_digits("one oh oh seven") == "1007"
    assert pin.spoken_digits("I don't know it") is None
    assert pin.spoken_digits("12") is None


class InnerAgent:
    def __init__(self, context, idx):
        self.context, self.idx, self.seen = context, idx, []

    def should_run(self, event):
        return True

    def should_cancel(self, event):
        return False

    async def process(self, env, event):
        self.seen.append(type(event).__name__)
        if isinstance(event, CallStarted):
            yield AgentSendText(text=f"Hi {self.context['household']['preferredName']}.")


@pytest.mark.asyncio
async def test_pin_gate_unlocks_with_the_spoken_pin_and_never_logs_it():
    api, writes, _ = fake_api()
    answers = [{"status": "wrong", "attemptsLeft": 2}, {"status": "ok", "context": MARGARET}]
    api.post = AsyncMock(side_effect=lambda route, payload: answers.pop(0))
    built = []

    def build(context, idx):
        built.append(InnerAgent(context, idx))
        return built[-1]

    gate = pin.PinGate(api, "call-p", build)
    assert gate.should_run(CallStarted()) and not gate.should_cancel(CallStarted())
    opening = await collect(gate.process(None, CallStarted()))
    assert opening[0].text == pin.PIN_PROMPT
    assert (await collect(gate.process(None, user("hmm"))))[0].text == pin.NO_DIGITS_LINE
    assert (await collect(gate.process(None, user("1 1 1 1"))))[0].text == pin.RETRY_LINE
    unlocked = await collect(gate.process(None, user("four eight two one")))
    assert unlocked[0].text == "Hi Margaret."
    assert [c.args for c in api.post.await_args_list] == [
        ("/agent/pin-verify", {"callId": "call-p", "pin": "1111"}),
        ("/agent/pin-verify", {"callId": "call-p", "pin": "4821"}),
    ]
    logged = json.dumps(writes)
    assert "4821" not in logged and "1111" not in logged and "four eight" not in logged
    assert [w["idx"] for w in writes] == list(range(len(writes)))
    assert built[0].idx == len(writes)  # the inner agent continues the turn numbering
    # Every later event goes to the unlocked agent.
    await collect(gate.process(None, CallEnded()))
    assert built[0].seen == ["CallStarted", "CallEnded"]


@pytest.mark.asyncio
async def test_pin_gate_locks_and_ends_the_call():
    api, _writes, _ = fake_api()
    api.post = AsyncMock(return_value={"status": "locked"})
    gate = pin.PinGate(api, "call-p", lambda c, i: None)
    await collect(gate.process(None, CallStarted()))
    out = await collect(gate.process(None, user("2 2 2 2")))
    assert out[0].text == pin.LOCKED_LINE and isinstance(out[1], AgentEndCall)

    locked = pin.PinGate(api, "call-q", lambda c, i: None, locked=True)
    out = await collect(locked.process(None, CallStarted()))
    assert out[0].text == pin.LOCKED_LINE and isinstance(out[1], AgentEndCall)
    api.post.reset_mock()
    await collect(locked.process(None, CallEnded()))
    api.post.assert_awaited_once_with(
        "/agent/call-end",
        {"callId": "call-q", "kind": "unknown_caller", "outcome": "unknown_caller"},
    )


@pytest.mark.asyncio
async def test_pin_gate_only_for_approved_numbers():
    api = SimpleNamespace(post=AsyncMock(return_value={"pinRequired": False, "locked": False}))
    assert await pin.gate_needed(api, "+14155550177") is None
    api.post.return_value = {"pinRequired": True, "locked": False}
    assert await pin.gate_needed(api, "+14155550177") == {"pinRequired": True, "locked": False}
    api.post.side_effect = RuntimeError("down")
    assert await pin.gate_needed(api, "+14155550177") is None


# ---------------------------------------------------------------- #67 Spanish handoff


def test_spanish_detection():
    assert spanish.wants_spanish("Hola, quiero toallas de papel por favor")
    assert spanish.wants_spanish("¿Habla español?")
    assert spanish.wants_spanish("Can we speak Spanish please")
    assert spanish.wants_spanish("Necesito café, gracias")
    for english in [
        "I need paper towels please",
        "Yes, that's my usual coffee",
        "My daughter Dana is visiting",
        "Hola is how you say hello",
        "",
    ]:
        assert not spanish.wants_spanish(english), english


@pytest.mark.asyncio
async def test_one_full_order_in_spanish_on_the_same_call(monkeypatch):
    monkeypatch.setenv("END_OF_TURN_HOLDOFF_MS", "0")
    monkeypatch.setenv("CARTESIA_VOICE_ID_ES", "voice-es")
    search_use = {
        "type": "tool_use",
        "id": "toolu_s",
        "name": "search_items",
        "input": {"query": "paper towels"},
    }
    order_use = {
        "type": "tool_use",
        "id": "toolu_o",
        "name": "place_order",
        "input": {"items": [{"storeItemId": "demo-paper-towels-6", "qty": 1}]},
    }
    readback = (
        "Toallas de papel de seis rollos, ocho dólares con noventa y siete centavos, llegan "
        "mañana. ¿Lo pido?"
    )
    client = FakeClient(
        FakeStream([tool_start_event()], final([THINKING, search_use], stop="tool_use")),
        FakeStream(
            [text_event("Tengo dos opciones. ¿Cuál prefiere?")],
            final([{"type": "text", "text": "Tengo dos opciones. ¿Cuál prefiere?"}]),
        ),
        FakeStream([text_event(readback)], final([{"type": "text", "text": readback}])),
        FakeStream([order_start_event()], final([THINKING, order_use], stop="tool_use")),
    )
    api, writes, _fired = fake_api()
    orders = []

    async def post(route, payload, **kwargs):
        if route == "/agent/order":
            orders.append(payload)
            return {"status": "paid", "orderId": "o1", "totalCents": 897}
        return {}

    api.post = post
    context = copy.deepcopy(MARGARET)
    tool_list = tools.TOOLS
    conversation = ClaudeConversation(client, system_blocks(context), tool_list)
    agent = spanish.wrap(ErrandAgent(conversation, api, "call-es", context))
    conversation.run_tool = agent.run_tool

    english_opening = await collect(agent.process(None, CallStarted()))
    assert "Margaret" in english_opening[0].text
    turn1 = await collect(agent.process(None, user("Hola, quiero toallas de papel, por favor")))
    assert isinstance(turn1[0], AgentUpdateCall)
    assert turn1[0].language == "es" and turn1[0].voice_id == "voice-es"
    assert "¿Cuál prefiere?" in "".join(e.text for e in turn1 if isinstance(e, AgentSendText))
    turn2 = await collect(agent.process(None, user("La de seis rollos")))
    assert not any(isinstance(e, AgentUpdateCall) for e in turn2)  # handed off once
    await collect(agent.process(None, user("Sí, por favor")))

    # Same rules: the order went through place_order on this call, priced by the tools.
    assert orders == [
        {
            "callId": "call-es",
            "idempotencyKey": "call-es:toolu_o",
            "store": "Walmart",
            "items": [
                {
                    "name": "Paper towels, 6-roll pack",
                    "storeItemId": "demo-paper-towels-6",
                    "qty": 1,
                    "priceCents": 897,
                }
            ],
        }
    ]
    # The Spanish agent's prompt reached the model once, then a short reminder; the system
    # prompt and tools are byte-identical to the English call (cache prefix unchanged).
    first = client.requests[0]["messages"][-1]["content"]
    assert first[0]["text"] == spanish.SPANISH_PROMPT
    assert "«sí»" in spanish.SPANISH_PROMPT and "scam" in spanish.SPANISH_PROMPT
    later = client.requests[2]["messages"][-1]["content"]
    assert later[0]["text"] == spanish.SPANISH_REMINDER
    for request in client.requests:
        assert request["system"] == conversation.system and request["tools"] == tool_list
    assert json.dumps(conversation.system) == json.dumps(system_blocks(copy.deepcopy(MARGARET)))
    # One call in Convex: every turn and the handoff marker carry the same call id.
    assert {w["callId"] for w in writes} == {"call-es"}
    assert any(w.get("tools") == [("spanish_handoff", "es")] for w in writes)
    assert agent.call_end_payload() == {"callId": "call-es", "kind": "order", "outcome": "ordered"}


@pytest.mark.asyncio
async def test_english_callers_are_unaffected_by_the_handoff_wrapper(monkeypatch):
    monkeypatch.setenv("END_OF_TURN_HOLDOFF_MS", "0")
    client = FakeClient(
        FakeStream([text_event("Sure.")], final([{"type": "text", "text": "Sure."}]))
    )
    api, _writes, _fired = fake_api()
    context = copy.deepcopy(MARGARET)
    conversation = ClaudeConversation(client, system_blocks(context), [])
    agent = spanish.wrap(ErrandAgent(conversation, api, "call-en", context))
    await collect(agent.process(None, CallStarted()))
    out = await collect(agent.process(None, user("I need paper towels please")))
    assert not any(isinstance(e, AgentUpdateCall) for e in out)
    sent = client.requests[0]["messages"][-1]["content"]
    assert all("<language>" not in block.get("text", "") for block in sent)
    monkeypatch.setenv("SPANISH_HANDOFF", "0")
    plain = ErrandAgent(conversation, api, "call-en", context)
    assert spanish.wrap(plain) is plain
