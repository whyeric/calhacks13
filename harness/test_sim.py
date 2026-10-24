"""Offline tests for the call simulator (harness/sim_call.py): no network, no Claude.

The end-to-end tests drive a stub Line agent through Line's real ConversationRunner with a fast
audio profile, so they check the simulated Cartesia side (TTS word reports, cut-offs, agent and
user state, echo, impatience, silence) in a few seconds.
"""

import asyncio
import random
from types import SimpleNamespace

import pytest
import sim_call as sim
from line.events import (
    AgentSendText,
    AgentTextSent,
    CallEnded,
    CallStarted,
    UserTextSent,
    UserTurnEnded,
    UserTurnStarted,
)
from loguru import logger as line_logger

line_logger.remove()  # Line logs every event at INFO

FAST = sim.AudioProfile(
    tts_wps=40,
    tts_state_ms=5,
    tts_first_audio_ms=10,
    caller_wps=40,
    endpoint_ms=20,
    reaction_ms=(10, 20),
    inactivity_s=0.3,
    impatience_ms=500,
    echo_delay_ms=20,
    settle_s=0.1,
    task_grace_s=0.1,
)

# ---------- pure helpers ----------


def test_stt_confusions_cover_the_real_call():
    out, note = sim.stt_confuse("I'll take the six-roll.", random.Random(1))
    assert out == "I'll take the 6th row."
    assert note == "six-roll -> 6th row"
    assert sim.stt_confuse("Yes.", random.Random(1)) == ("Yes.", None)  # never alters a yes
    out, notes = sim.apply_stt_map("The six-roll, please.", {"six-roll": "6th row"})
    assert out == "The 6th row, please." and notes == ["six-roll -> 6th row"]


def test_split_fragment_like_vad():
    assert sim.split_fragment("That's right, yes.", 1) == ("That's.", "right, yes.")
    assert sim.split_fragment("Yes.", 1) == ("Yes.", "")


def test_word_runs():
    assert sim.contains_run("order it? Yes.", "order it")
    assert not sim.contains_run("Yes.", "Yes")  # one word is never evidence of echo
    assert sim.starts_with_run("order it? Yes.", "order it?")
    assert not sim.starts_with_run("I'll try his own number", "own number")


def test_word_seconds_pauses_and_numbers():
    assert sim.word_seconds("hello", 2.5) == pytest.approx(0.4)
    assert sim.word_seconds("hello.", 2.5) == pytest.approx(0.7)
    assert sim.word_seconds("hello.", 25) == pytest.approx(0.07)  # pauses scale with rate
    assert sim.word_seconds("$21.45", 2.5) > sim.word_seconds("dollars", 2.5)


# ---------- scripted caller ----------


async def _say(caller, heard):
    action = await caller.next(sim.CallerView(heard=heard, transcript=[]))
    return action.say, action


async def test_scripted_caller_alts_skips_and_repeats():
    caller = sim.ScriptedCaller(
        [
            {"say": "I need coffee."},
            {"say": "The big can.", "skipIfAgent": "shall i order"},
            {"say": "Yes.", "ifAgent": r"\?", "repeatWhile": "shall i order", "max": 2},
            {"say": "Goodbye.", "hangup": True},
        ]
    )
    assert (await _say(caller, "Hi."))[0] == "I need coffee."
    assert (await _say(caller, "Shall I order it?"))[0] == "Yes."  # step 2 skipped
    assert (await _say(caller, "Sorry, shall I order it?"))[0] == "Yes."  # repeat 2 of 2
    assert (await _say(caller, "Shall I order it?"))[0] == "Goodbye."  # max reached
    _, action = await _say(caller, "Bye.")
    assert action.hangup and action.say is None


async def test_scripted_alt_overrides_modifiers():
    caller = sim.ScriptedCaller(
        [
            {
                "say": "Yes.",
                "fragment": {"words": 1},
                "alts": [{"ifAgent": "which", "say": "The six-roll.", "fragment": None}],
            }
        ]
    )
    say, action = await _say(caller, "Which one?")
    assert say == "The six-roll." and action.fragment is None


# ---------- end to end with a stub agent ----------


class StubAgent:
    """A Line agent with ErrandAgent's surface: process, should_run, should_cancel, _replying."""

    def __init__(self, replies, *, cancel=True, opening="Hello, how can I help?"):
        self.replies = list(replies)
        self.cancel = cancel
        self.opening = opening
        self._replying = False
        self.heard: list[str] = []  # AgentTextSent history at each caller turn
        self.user_turns: list[str] = []

    def should_run(self, event):
        if not self.cancel and self._replying and isinstance(event, UserTurnEnded):
            return False  # like ErrandAgent's held barge-in that proved to be echo
        return isinstance(event, (CallStarted, UserTurnEnded, CallEnded))

    def should_cancel(self, event):
        return self.cancel and isinstance(event, UserTurnStarted)

    async def process(self, env, event):
        if isinstance(event, CallStarted):
            yield AgentSendText(text=self.opening)
        elif isinstance(event, UserTurnEnded):
            text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
            self.user_turns.append(text)
            self.heard.append(
                "".join(e.content for e in event.history or [] if isinstance(e, AgentTextSent))
            )
            reply = self.replies.pop(0) if self.replies else None
            if reply is None:
                return
            self._replying = True
            try:
                for chunk in reply:
                    if isinstance(chunk, float):
                        await asyncio.sleep(chunk)
                    else:
                        yield chunk if not isinstance(chunk, str) else AgentSendText(text=chunk)
            finally:
                self._replying = False


def stub_factory(agent):
    async def factory(s):
        async def close():
            pass

        ctx = SimpleNamespace(
            agent=agent,
            client=SimpleNamespace(delay_next_s=0.0),
            instrumented=None,
            fake=None,
            close=close,
            family_action=None,
            call_id="stub",
            model="stub",
        )
        return (agent, agent.should_run, agent.should_cancel), ctx

    return factory


async def run_stub(agent, steps, profile=FAST, max_call_s=20):
    s = sim.SimCall(
        "stub#1",
        {"id": "stub"},
        sim.ScriptedCaller(steps),
        profile,
        random.Random(3),
        sim.SimOptions(judge=False, max_call_s=max_call_s),
        agent_factory=stub_factory(agent),
    )
    return await s.run()


async def test_agent_speech_is_reported_word_by_word_and_whole():
    agent = StubAgent([["Sure", ", I can he", "lp with that. Anything else?"]])
    record = await run_stub(agent, [{"say": "I need help."}, {"say": "Bye.", "hangup": True}])
    assert record["segments"][0]["heard"] == "Hello, how can I help?"
    assert record["segments"][1]["heard"] == "Sure, I can help with that. Anything else?"
    # Line restored whitespace from the per-word reports: the agent saw its own words heard.
    assert agent.heard[1].endswith("Sure, I can help with that. Anything else?")
    assert agent.user_turns == ["I need help.", "Bye."]
    assert record["endedBy"] == "caller"


async def test_barge_in_does_not_cut_uninterruptible_speech():
    long = " ".join(["word"] * 40) + "."
    agent = StubAgent(
        [
            [AgentSendText(text="Let me check.", interruptible=False), 0.3, " " + long],
            ["Okay."],
        ]
    )
    record = await run_stub(
        agent,
        [
            {"say": "Order coffee."},
            {"say": "Wait.", "bargeIn": 1},
            {"say": "Bye.", "hangup": True},
        ],
        sim.replace(FAST, tts_wps=10),
    )
    filler = record["segments"][1]
    assert filler["heard"] == "Let me check."  # kept playing through the barge-in
    assert "word" not in " ".join(s["heard"] for s in record["segments"])  # reply cancelled
    assert agent.user_turns[1] == "Wait."


async def test_scripted_barge_in_after_n_words_cuts_the_reply():
    long = " ".join(f"w{i}" for i in range(60)) + "."
    agent = StubAgent([[long], ["Okay, stopping."]])
    profile = sim.replace(FAST, tts_wps=20)
    record = await run_stub(
        agent,
        [
            {"say": "Tell me everything.", "bargeIn": None},
            {"say": "Wait.", "bargeIn": 5},
            {"say": "Bye.", "hangup": True},
        ],
        profile,
    )
    reply = record["segments"][1]
    assert reply["cut"] and 5 <= len(reply["heard"].split()) < 20
    assert "w59." in reply["unheard"]
    # The agent's next turn saw only the words actually heard.
    assert agent.heard[1].strip().endswith(reply["heard"].split()[-1])
    assert "w59" not in agent.heard[1]


async def test_should_cancel_false_keeps_the_reply_running():
    # The stub refuses to cancel (like ErrandAgent during a tool wait): text sent after the
    # caller's turn still plays.
    agent = StubAgent(
        [
            [
                AgentSendText(text="Let me check.", interruptible=False),
                0.4,
                " Your coffee is twelve dollars.",
            ],
            ["Bye now."],
        ],
        cancel=False,
    )
    record = await run_stub(
        agent,
        [
            {"say": "Coffee please.", "echoReply": {"start": 0, "words": 2}},
            {"say": "Bye.", "hangup": True},
        ],
    )
    echoes = [t for t in record["turns"] if t["kind"] == "echo"]
    assert echoes and echoes[0]["transcript"] == "Let me"
    heard = " ".join(s["heard"] for s in record["segments"])
    assert "Let me check." in heard and "Your coffee is twelve dollars." in heard


async def test_echo_of_interruptible_speech_holds_only_the_words_played_before_the_cut():
    agent = StubAgent([["Your coffee is twelve dollars."], ["Bye now."]])
    record = await run_stub(
        agent,
        [
            {"say": "Coffee please.", "echoReply": {"start": 0, "words": 3}},
            {"say": "Bye.", "hangup": True},
        ],
    )
    echoes = [t for t in record["turns"] if t["kind"] == "echo"]
    assert echoes and echoes[0]["transcript"] == "Your"


async def test_impatience_says_hello_when_no_audio():
    agent = StubAgent([None, ["I'm here."]])
    record = await run_stub(agent, [{"say": "Is anyone there?"}, {"say": "Bye.", "hangup": True}])
    kinds = [t["kind"] for t in record["turns"]]
    assert kinds[:2] == ["real", "hello"]
    assert agent.user_turns[1] == "Hello?"


async def test_caller_silence_then_hangup():
    agent = StubAgent([["Goodbye, take care."]])
    record = await run_stub(
        agent, [{"silent": True, "forS": 0.3}, {"say": "Goodbye.", "hangup": True}]
    )
    assert any(e["kind"] == "caller_silent" for e in record["events"])
    assert record["turns"][0]["truth"] == "Goodbye."


async def test_mixed_echo_starts_on_the_agents_last_word():
    agent = StubAgent([["Shall I order it?"], ["Done."]])
    profile = sim.replace(FAST, tts_wps=8)
    record = await run_stub(
        agent,
        [{"say": "Coffee."}, {"say": "Yes.", "echoTail": 2}, {"say": "Bye.", "hangup": True}],
        profile,
    )
    yes = next(t for t in record["turns"] if t["truth"] == "Yes.")
    assert yes["markers"] == ["echo"] and yes["transcript"] == "I order Yes."
    # The caller's VAD cut the agent's last word.
    assert record["segments"][1]["cut"] and record["segments"][1]["unheard"] == "it?"


async def test_fragment_is_two_vad_turns():
    agent = StubAgent([["Sorry?"], ["Great."], ["Bye."]])
    record = await run_stub(
        agent,
        [
            {"say": "That's right, yes.", "fragment": {"words": 1, "gapMs": 100}},
            {"say": "Bye.", "hangup": True},
        ],
    )
    assert agent.user_turns[:2] == ["That's.", "right, yes."]
    assert record["turns"][0]["transcript"] == "That's. / right, yes."


# ---------- hard checks ----------


def _record(turns, segments, tools=(), logged=(), events=(), call_end=None):
    return {
        "turns": turns,
        "segments": segments,
        "tools": list(tools),
        "logged": list(logged),
        "events": list(events),
        "callEnd": call_end or {},
        "errors": [],
    }


def _seg(start, heard, end=None, cut=False, unheard=""):
    return {
        "start": start,
        "end": end if end is not None else start + 1,
        "heard": heard,
        "cut": cut,
        "unheard": unheard,
    }


def _turn(start, end, truth, kind="real", transcript=None, **kw):
    return {
        "kind": kind,
        "start": start,
        "end": end,
        "truth": truth,
        "transcript": transcript or truth,
        "markers": kw.pop("markers", []),
        **kw,
    }


PAID = {"status": "paid", "totalCents": 2145, "say": "Done. Your order is placed and paid."}


def test_order_after_yes_and_confirmation_passes():
    record = _record(
        [_turn(2, 3, "Coffee and paper towels."), _turn(9, 10, "Yes.")],
        [
            _seg(0, "Hi Margaret."),
            _seg(4, "That's $21.45. Shall I order it?", end=8),
            _seg(11, "Placing that now. Done. Your order is placed and paid."),
        ],
        tools=[{"t": 10.8, "name": "place_order", "input": {}, "result": PAID}],
        call_end={"outcome": "ordered"},
    )
    failures, metrics = sim.hard_checks(
        record, {"outcome": "ordered", "order": {"status": "paid", "totalCents": 2145}}, 3000
    )
    assert failures == []
    assert metrics["ttfa"]["max"] == 1000 and metrics["reasksAfterYes"] == 0


def test_yes_before_the_scam_guards_gentle_question_counts():
    record = _record(
        [_turn(5, 6, "Yes, please order it."), _turn(9, 10, "No, nobody. It's for me.")],
        [
            _seg(2, "That's $95.88. Shall I order it?", end=4),
            _seg(7, "Before I do, is someone asking you to buy this?", end=8.5),
            _seg(11, "Placing that now. Your order is placed and paid."),
        ],
        tools=[{"t": 10.8, "name": "place_order", "input": {}, "result": PAID}],
    )
    failures, _ = sim.hard_checks(record, {}, 3000)
    assert not any("without a yes" in f or "no read-back" in f for f in failures)


def test_order_without_yes_fails():
    record = _record(
        [_turn(2, 3, "Coffee please."), _turn(9, 10, "Hmm, how much is it?")],
        [
            _seg(4, "That's $12.48. Shall I order it?", end=8),
            _seg(11, "Done. Your order is placed"),
        ],
        tools=[{"t": 10.8, "name": "place_order", "input": {}, "result": PAID}],
    )
    failures, _ = sim.hard_checks(record, {}, 3000)
    assert any("without a yes" in f for f in failures)


def test_reasks_after_clear_yes_are_counted():
    record = _record(
        [
            _turn(5, 6, "Yes."),
            _turn(12, 13, "Yes."),
            _turn(19, 20, "Yes."),
        ],
        [
            _seg(0, "Shall I order it?", end=4),
            _seg(7, "Just to be sure, shall I order it?", end=11),
            _seg(14, "Would you like me to order the coffee?", end=18),
        ],
    )
    failures, metrics = sim.hard_checks(record, {}, 3000)
    assert metrics["reasksAfterYes"] == 2
    assert any("re-asked for confirmation 2x" in f for f in failures)


def test_echo_logged_as_caller_fails():
    record = _record(
        [
            _turn(2, 3, "Coffee."),
            _turn(4.4, 5.0, "", kind="echo", transcript="Let me check.", markers=["echo"]),
            _turn(9, 10, "Yes.", transcript="order it? Yes.", echoText="order it?"),
        ],
        [_seg(4, "Let me check.")],
        logged=[
            {"t": 3.2, "speaker": "user", "text": "Coffee."},
            {"t": 5.1, "speaker": "user", "text": "Let me check."},
            {"t": 10.1, "speaker": "user", "text": "order it? Yes."},
        ],
    )
    failures, metrics = sim.hard_checks(record, {}, 3000)
    assert metrics["echoLogged"] == 2
    assert any("logged as caller" in f for f in failures)
    assert any("kept in caller turn" in f for f in failures)


def test_missing_confirmation_after_place_order_fails():
    record = _record(
        [_turn(9, 10, "Yes.")],
        [_seg(4, "Shall I order it?", end=8), _seg(11, "Let me check.")],
        tools=[{"t": 10.8, "name": "place_order", "input": {}, "result": PAID}],
    )
    failures, _ = sim.hard_checks(record, {}, 3000)
    assert any("no confirmation was heard" in f for f in failures)


def test_confirmation_after_a_barge_in_counts():
    # The templated line was cut off; the next reply said it in other words.
    record = _record(
        [_turn(9, 10, "Yes."), _turn(11.5, 12, "Did it go through?")],
        [
            _seg(4, "Shall I order it?", end=8),
            _seg(11, "Placing that now. Done. Your", cut=True, unheard="order is placed"),
            _seg(13, "Yes, it went through. Your coffee is on its way."),
        ],
        tools=[{"t": 10.8, "name": "place_order", "input": {}, "result": PAID}],
    )
    failures, _ = sim.hard_checks(record, {}, 3000)
    assert not any("no confirmation" in f for f in failures)


def test_transcript_splits_agent_speech_at_a_family_action():
    hold = _seg(10, "I'll stay on the line. Good news. Dana said yes.", end=16)
    hold["wordT"] = [10.4, 10.8, 11.2, 11.6, 13.2, 14.0, 14.4, 15.0, 15.5, 16.0]
    record = _record([], [hold])
    record["events"] = [{"t": 13.0, "kind": "family", "result": {"action": "approve"}}]
    lines = sim.render_transcript(record).splitlines()
    marker = "{at 13.0s: family action {'action': 'approve'}}"
    assert [line.split("] ", 1)[1] for line in lines] == [
        f"AGENT  I'll stay on the line. {marker} Good news. Dana said yes."
    ]


def test_slow_first_audio_and_injected_delay():
    record = _record(
        [
            _turn(1, 2, "Hi.", injectedDelayMs=6400),
            _turn(6, 7, "Hello?", kind="hello"),
            _turn(12, 13, "Coffee."),
        ],
        [_seg(8.5, "I'm here."), _seg(16.5, "Sure.")],
    )
    failures, metrics = sim.hard_checks(record, {}, 3000)
    lat = metrics["ttfaTurns"]
    assert lat[0] == {
        "turn": "Hi.",
        "kind": "real",
        "injected": True,
        "ttfaMs": 4000,
        "noAudio": True,
    }
    assert [r["ttfaMs"] for r in lat[1:]] == [1500, 3500]
    assert failures == ["first audio after 3500 ms (> 3000) for 'Coffee.'"]


def test_silence_prompt_while_agent_talks_fails():
    record = _record(
        [_turn(1, 2, "Bye.")],
        [_seg(3, "It was lovely talking with you. Take your time.", end=12)],
        events=[
            {"t": 2.9, "kind": "agent_text", "text": "It was lovely talking with you."},
            {"t": 8.9, "kind": "agent_text", "text": "Take your time."},
        ],
    )
    failures, metrics = sim.hard_checks(record, {}, 3000)
    assert metrics["earlySilencePrompts"] == 1
    assert any("the agent was still talking" in f for f in failures)
    ok = _record(
        [],
        [_seg(0, "Hello."), _seg(7.5, "Take your time.")],
        events=[{"t": 7.0, "kind": "agent_text", "text": "Take your time."}],
    )
    assert sim.hard_checks(ok, {}, 3000)[1]["earlySilencePrompts"] == 0
    # The model said "Take your time." itself: the turn log has no silence prompt there.
    record["logged"] = [{"t": 8.9, "speaker": "assistant", "text": "x", "silence": False}]
    assert sim.hard_checks(record, {}, 3000)[1]["earlySilencePrompts"] == 0
    record["logged"][0]["silence"] = True
    assert sim.hard_checks(record, {}, 3000)[1]["earlySilencePrompts"] == 1


def test_transcript_markers():
    record = _record(
        [
            _turn(
                2,
                3,
                "I'll take the six-roll.",
                transcript="I'll take the 6th row.",
                markers=["stt-noise"],
            ),
            _turn(4.5, 5, "", kind="echo", transcript="Let me", markers=["echo"]),
        ],
        [_seg(4, "Let me check.", cut=True, unheard="Glad to hear")],
    )
    text = sim.render_transcript(record)
    assert "[stt-noise]" in text and 'heard as "I\'ll take the 6th row."' in text
    assert "[echo]" in text and "[cut] ‹Glad to hear›" in text


def test_add_noise_keeps_the_wav_header_and_length():
    import struct

    pcm = struct.pack("<8h", 1000, -1000, 2000, -2000, 1000, -1000, 2000, -2000)
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + bytes(20)
    wav = header + b"data" + struct.pack("<I", len(pcm)) + pcm
    noisy = sim.add_noise(wav, 10.0, random.Random(1))
    assert len(noisy) == len(wav) and noisy[:44] == wav[:44] and noisy[44:] != pcm
    assert sim.add_noise(wav, None, random.Random(1)) == wav
