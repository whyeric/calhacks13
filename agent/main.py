import asyncio
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from line.events import (
    AgentEndCall,
    AgentSendText,
    AgentTextSent,
    AgentTurnEnded,
    AgentTurnStarted,
    CallEnded,
    CallStarted,
    UserTextSent,
    UserTurnEnded,
    UserTurnStarted,
)
from line.voice_agent_app import VoiceAgentApp
from loguru import logger as line_logger

import checkin
import pin
import scam
import spanish
import tools
import voice
import wellbeing
from claude import (
    FILLER_LINE,
    ORDER_FILLER_LINE,
    SEND_FILLER_LINE,
    ClaudeConversation,
    zero_usage,
)
from context import call_context, due_followup, greeting, system_blocks
from convex_api import ConvexAPI

load_dotenv()
log = logging.getLogger(__name__)

ORDER_TOOLS = {"match_favorite", "search_items", "place_order"}
OUTCOME_BY_STATUS = {
    "paid": "ordered",
    "needs_approval": "awaiting_approval",
    "blocked": "declined_scam",
}
OUTCOME_PRIORITY = ["ordered", "awaiting_approval", "declined_scam"]
# The order's outcome is not known to the agent; Convex records the real call outcome itself.
UNSETTLED_ORDER_STATUSES = {"processing", "unconfirmed", "pending"}
# Payment identifiers stay out of the model's context (never spoken, never needed).
PRIVATE_ORDER_FIELDS = ("orderId", "paymentRef")
ERROR_LINE = "I'm having trouble answering just now. Please try again in a moment."
UNAVAILABLE_LINE = "I'm sorry, I'm having trouble right now. Please call back in a few minutes."
HEARD_TAIL_CHARS = 160
# Missing any of these means the caller missed a price, quantity or total.
NUMBER_WORD = re.compile(
    r".*\d.*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\w+teen|twenty|"
    r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dollars?|cents?|half|dozen"
)
# A question ends the reply (speech rules); nothing after it reaches the caller.
QUESTION_END = re.compile(r"\?[\"')\]]*")
# Echo suppression: the caller's phone can feed the agent's own voice back as a user turn.
ECHO_WINDOW_S = 10
# End-of-turn hold-off (#4, docs/research/end-of-turn.md): when the caller stops on a filler or
# an unfinished phrase, wait this long before answering; if they go on, it is one turn.
INCOMPLETE_END = re.compile(
    r"(\b(um+|uh+|er+|erm|hmm+|so|and|but|or|the|my|a|an|to|of|for|with|because)[.,…-]*"
    r"|,|\.\.\.|…|-)\s*$",
    re.IGNORECASE,
)
# Silence (#15): templated lines, no model call. Waits (ms) after the agent stops talking:
# "Take your time.", then the reassurance line, then the call ends gently.
SILENCE_LINES = [
    "Take your time.",
    "I'll be right here whenever you need me. You can call back any time.",
]
SILENCE_STEPS_MS = os.getenv("SILENCE_STEPS_MS") or "6000,8000,8000"
# #51: an unknown caller is told why we can't help, then the call ends gently.
UNKNOWN_CALLER_CLOSING = "Take care, and goodbye."
UNKNOWN_CALLER_MAX_TURNS = 3
# Echo cut-offs answered by replaying the reply's unheard words, before asking the model.
MAX_ECHO_REPLAYS = 2
# Before that goodbye: the reply must not end on a question nobody can answer.
LAST_REPLY_NOTE = (
    "<last_reply>System note: this is your last reply on this call; the system says goodbye "
    "right after it. Answer in one short, kind sentence and don't ask a question. Don't say "
    "goodbye or thank them for calling yourself."
    "</last_reply>"
)
FAREWELL = re.compile(
    r"\b(good\s?-?bye|bye(-bye)?|that'?s all|nothing else|no,? thank you|have a (good|nice) "
    r"(day|night))\b",
    re.IGNORECASE,
)
# Cut-off metric (#35, §12.6): the caller starts talking within this long of the agent starting.
CUT_OFF_MS = 1000
# A one-word caller turn this soon after the agent's audio starts, matching its first word, is
# echo (Line cuts the audio at the echo's start, so only that word comes back).
FIRST_WORD_ECHO_MS = 1200
# A reply with no text after this long first says "One moment." so the caller isn't left in
# silence (the model's thinking time has a long tail). 0 turns it off.
SLOW_REPLY_S = float(os.getenv("SLOW_REPLY_MS", "1800")) / 1000
SLOW_REPLY_LINE = "One moment."
# After a filler line plays, its speakerphone echo can arrive this much later (ms).
FILLER_ECHO_MS = 1500
# Short covering lines while a tool runs: echo of them must not cut them off.
FILLER_LINES = {FILLER_LINE, ORDER_FILLER_LINE, SEND_FILLER_LINE, SLOW_REPLY_LINE}
# Tool-wait lines that add nothing after SLOW_REPLY_LINE ("Placing that now." still does).
COVER_LINES = {FILLER_LINE, SEND_FILLER_LINE}
# Speaking rate estimate, for when Line doesn't report when the agent stopped talking.
WORDS_PER_S = 2.5
ECHO_CUT_NOTE = (
    "<interrupted>System note: the caller did not interrupt you. The phone line picked up your "
    "own voice and cut you off; the caller heard only up to: "
)
ECHO_RESUME_NOTE = (
    "<echo>System note: the caller did not speak. The phone line picked up your own voice and "
    "cut you off. Say again, briefly and in fresh words, the part of your last reply the "
    "caller did not hear, and end with the same question if it had one. Don't apologize, "
    "mention the cut, or say you are picking up where you left off.</echo>"
)
# A transcript made only of these is treated as a real answer, even if the agent said it too.
ANSWER_WORD = re.compile(
    r"yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|please|thanks?|you|of|course|alright|all|right|"
    r"correct|fine|good|great|perfect|sounds|go|ahead|do|it|thats?|is|absolutely|definitely|"
    r"certainly|wait|stop|hold|on|hello|sorry|what"
)
# Words a spoken answer can end on; an answer-word run ending otherwise ("that sounds") is a
# fragment, and if the agent just said it, it is echo.
ANSWER_END = re.compile(
    r"yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|please|thanks?|you|course|alright|right|"
    r"correct|fine|good|great|perfect|ahead|it|absolutely|definitely|certainly|wait|stop|on|"
    r"hello|sorry|what"
)


async def _cover_slow_start(stream, after_s):
    """`stream`'s chunks, preceded by SLOW_REPLY_LINE when its first chunk takes over `after_s`."""
    it = aiter(stream)
    first = asyncio.ensure_future(anext(it))
    done = True
    try:
        if after_s > 0:
            done, _ = await asyncio.wait({first}, timeout=after_s)
            if not done:
                yield SLOW_REPLY_LINE + " "
        try:
            chunk = await first
        except StopAsyncIteration:
            return
        if not done and chunk.strip() in COVER_LINES:
            # "One moment." already covers the tool wait: no "One moment. Let me check."
            chunk = await anext(it, None)
            if chunk is None:
                return
            chunk = chunk.lstrip()
        yield chunk
        async for chunk in it:
            yield chunk
    finally:
        if not first.done():
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)


def _letters(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _words(text: str) -> list[str]:
    return [w for w in (_letters(t) for t in text.split()) if w]


def _heard_the_substance(said: str, heard_n: str) -> bool:
    """True when the caller heard the reply's question (all but at most its last word) and
    missed only trailing words with no numbers in them, so there is nothing to repeat."""
    tokens = [t for t in said.split() if _letters(t)]
    covered, heard_count = 0, 0
    for token in tokens:
        covered += len(_letters(token))
        if covered > len(heard_n):
            break
        heard_count += 1
    if not _letters(said).startswith(heard_n):
        return False  # heard text doesn't line up with what was said; don't guess
    unheard = tokens[heard_count:]
    if any(NUMBER_WORD.fullmatch(w) for t in unheard for w in re.split(r"[^a-z0-9]+", t.lower())):
        return False
    questions = [i for i, t in enumerate(tokens) if "?" in t]
    if not questions:
        return False
    end = questions[-1]
    start = max((i + 1 for i, t in enumerate(tokens[:end]) if t[-1] in ".!?"), default=0)
    # A short question ("Okay?") must be heard in full; a longer one may lose its last word.
    needed = end if end - start + 1 >= 3 else end + 1
    return heard_count >= needed


def until_question(chunk: str) -> tuple[str, bool]:
    """The chunk up to and including its first question mark, and whether it had one."""
    match = QUESTION_END.search(chunk)
    if not match:
        return chunk, False
    return chunk[: match.end()], True


def _sentences(text: str) -> list[list[str]]:
    return [words for part in re.split(r"[.?!]+", text) if (words := _words(part))]


def _echo_run(words: list[str], sources: list[list[str]]) -> int:
    """Length of the longest start of `words` (two words or more) that repeats a stretch of one
    of the agent's texts. Four or more words may differ in one inner word (speech-to-text
    slips); the first and last words must match, so a caller's own word is never swallowed."""
    best = 0
    for source in sources:
        for k in range(min(len(words), len(source)), max(best, 1), -1):
            head = words[:k]
            slack = 1 if k >= 4 else 0
            if any(
                head[0] == window[0]
                and head[-1] == window[-1]
                and sum(a != b for a, b in zip(head, window, strict=True)) <= slack
                for window in (source[i : i + k] for i in range(len(source) - k + 1))
            ):
                best = k
                break
    return best


def strip_echo(transcript: str, recent_speech: list[str]) -> str:
    """The caller's own words: `transcript` minus a leading or trailing stretch that repeats the
    agent's recent speech (speakerphone echo). Returns "" when the whole turn is echo.

    A transcript made only of answer words ("yes", "okay", "go ahead") is never trimmed, and is
    dropped only when the agent itself just said exactly that as a sentence.
    """
    tokens = [t for t in transcript.split() if _letters(t)]
    words = [_letters(t) for t in tokens]
    if not words:
        return transcript
    if all(ANSWER_WORD.fullmatch(w) for w in words):
        said = [s for text in recent_speech for s in _sentences(text)]
        if any(words == s for s in said):
            return ""
        # "That sounds" cut from the agent's "That sounds good": an answer never ends that way.
        if (
            len(words) >= 2
            and not ANSWER_END.fullmatch(words[-1])
            and _echo_run(words, said) == len(words)
        ):
            return ""
        return transcript
    sources = [w for text in recent_speech if (w := _words(text))]
    if len(words) == 1 and sources and words == sources[-1][:1]:
        # One word, and it is how the agent's latest reply starts ("Goodbye," from "Goodbye,
        # Margaret."): the speakerphone picking up the reply's first word. Called only while
        # the agent is talking. Dropping a real word here is harmless: the cut reply resumes,
        # and it was already saying that (a caller's "Goodbye" still gets the agent's goodbye).
        return ""
    start = _echo_run(words, sources)
    end = len(words) - _echo_run(words[start:][::-1], [w[::-1] for w in sources])
    if start == 0 and end == len(words):
        return transcript
    return " ".join(tokens[start:end])


def agent_was_speaking(history) -> bool | None:
    """Whether the agent was talking when the current caller turn started, from Line's agent
    state events; None when the history has none."""
    events = list(history or [])
    starts = [i for i, e in enumerate(events) if isinstance(e, UserTurnStarted)]
    for e in reversed(events[: starts[-1]] if starts else []):
        if isinstance(e, AgentTurnEnded):
            return False
        if isinstance(e, AgentTurnStarted):
            return True
    return None


def heard_text(history, skip=()) -> str | None:
    """What the caller heard of the agent since their previous turn, from Line's event history.

    Line appends AgentTextSent entries as TTS actually speaks (whitespace restored), so text cut
    off by a barge-in is missing. Returns None when the history can't tell us (no history, or
    the harness never reports spoken text). User turns whose event_id is in `skip` (ignored
    echoes) don't count as the caller's previous turn.
    """
    if not history or not any(isinstance(e, AgentTextSent) for e in history):
        return None
    events = list(history)
    if events and isinstance(events[-1], UserTurnEnded):
        events = events[:-1]  # the current turn
    start = 0
    for i in range(len(events) - 1, -1, -1):
        if isinstance(events[i], UserTurnEnded) and events[i].event_id not in skip:
            start = i + 1
            break
    return "".join(e.content for e in events[start:] if isinstance(e, AgentTextSent))


def unheard_rest(said: str, heard: str | None) -> str | None:
    """The words of `said` after the part the caller heard, when what they heard is exactly
    its start (whole words); None when that can't be told."""
    if heard is None:
        return None
    words, heard_n = said.split(), _letters(heard)
    for k in range(len(words)):
        if _letters(" ".join(words[:k])) == heard_n:
            return " ".join(words[k:]) or None
    return None


def interrupted_note(said: str, heard: str | None, echo: bool = False) -> str | None:
    """A system note when the caller heard only part of what the agent last said. With `echo`,
    the cut came from the agent's own voice on the line, not from the caller."""
    if heard is None or not said.strip():
        return None
    said_n, heard_n = _letters(said), _letters(heard)
    if not said_n or len(heard_n) >= len(said_n) or heard_n.endswith(said_n[-12:]):
        return None
    if heard_n and _heard_the_substance(said, heard_n):
        return None
    heard = " ".join(heard.split())
    if not heard_n:
        if echo:
            return (
                "<interrupted>System note: the caller did not interrupt you. The phone line "
                "picked up your own voice and cut you off before the caller heard any of your "
                "last reply.</interrupted>"
            )
        return (
            "<interrupted>System note: the caller started speaking before hearing any of your "
            "last reply.</interrupted>"
        )
    if len(heard) > HEARD_TAIL_CHARS:
        heard = "..." + heard[-HEARD_TAIL_CHARS:]
    heard = heard.replace("<", "‹").replace(">", "›")
    if echo:
        return f'{ECHO_CUT_NOTE}"{heard}"</interrupted>'
    return (
        "<interrupted>System note: the caller interrupted you and heard only up to: "
        f'"{heard}"</interrupted>'
    )


def quiet_line_logs():
    """Line logs call start messages (with the caller's phone number) and transcripts at INFO."""
    line_logger.remove()
    line_logger.add(sys.stderr, level="INFO", filter={"": "INFO", "line": "WARNING"})


class ErrandAgent:
    def __init__(self, conversation, api, call_id, context, *, dispatch=None, tool_context=None):
        self.conversation = conversation
        self.api = api
        self.call_id = call_id
        self.context = context
        self.dispatch = dispatch or tools.dispatch
        self.tool_context = tool_context or tools.ToolContext
        self.idx = 0
        self.warm_task = None
        self.followup = due_followup(context)
        self.checkin = None  # #60: set by checkin.attach on an outbound check-in call
        # #73 WB-5: templated 911/988 lines and family alerts, before any model request.
        self.wellbeing = wellbeing.WellbeingGuard(api, call_id, context)
        self.order_statuses: list[str] = []
        self.orders: list[dict] = []  # full place_order results, including payment identifiers
        self._last_said = ""  # what the agent sent for speech in its most recent turn
        self.turn_tools: list[set[str]] = []  # tool names used per caller turn
        self._open_turn: dict | None = None
        self._last_turn_done = True  # False when the last reply was cut off before it finished
        self._last_spoken = ""  # what the agent actually sent to TTS in its most recent turn
        self._recent_speech: list[tuple[float, str]] = []  # (when sent, text) for echo checks
        # event_ids of caller turns that are not turn boundaries (ignored echoes, held fragments)
        self._skip_turns: set[str] = set()
        self._held = ""  # caller words held back by the end-of-turn hold-off
        self.holdoff_s = float(os.getenv("END_OF_TURN_HOLDOFF_MS") or 700) / 1000
        self._last_turn_resumed = False  # the last reply was itself an echo resume
        self._echo_replays = 0  # verbatim replays of the last reply after echo cut it off
        # Live call state from Line events (see observe); None until Line reports it.
        self._agent_speaking: bool | None = None
        self._agent_speech_at: float | None = None  # ms, when the agent last started speaking
        self._caller_speaking = False
        self._caller_started_at: float | None = None  # ms
        self._speech_until = 0.0  # ms, estimated end of the agent's latest speech
        self._replying = False  # a reply (or its hold-off) is running
        self._pending_timings: dict = {}  # barge-in / cut-off timings for the next caller turn
        self._reply_first_chunk_at: float | None = None  # ms, the latest reply's first text
        self._gate = asyncio.Event()  # cleared while a barge-in waits to be confirmed as speech
        self._gate.set()
        self._filler_until = 0.0  # ms; a barge-in before this is most likely the filler's echo
        self._silences = 0
        self._silence_note = ""
        self._held_timings: dict = {}
        self._end_after_reply = False  # #51: hang up after this reply
        self.silence_steps_s = [
            int(ms) / 1000 for ms in SILENCE_STEPS_MS.split(",") if ms.strip().isdigit()
        ][: len(SILENCE_LINES) + 1]

    def record(self, speaker, text, timings=None, usage=None, *, refused=False, tools=None):
        if self.call_id:
            self.api.log_turn(
                {
                    "callId": self.call_id,
                    "idx": self.idx,
                    "speaker": speaker,
                    "text": text,
                    "at": time.time() * 1000,
                    "timings": timings or {},
                    "usage": usage or zero_usage(),
                },
                refused=refused,
                tools=tools,
            )
            self.idx += 1

    def _close_turn(self, turn):
        # Idempotent; also runs at the next event if Line dropped a cancelled generator unclosed.
        if turn is None or turn["logged"]:
            return
        turn["logged"] = True
        if self._open_turn is turn:
            self._open_turn = None
        # Text held back after a question still counts as said: the caller never heard it.
        self._last_said = turn["spoken"] + turn.get("unspoken", "")
        self._last_turn_done = turn.get("done", False)
        self._last_spoken = turn["spoken"]
        self._last_turn_resumed = turn.get("resumed", False)
        self._remember_speech(turn["spoken"])
        if turn["spoken"]:
            timings = {
                "replyStoppedAt": turn.get("stoppedAt"),
                "sttFinalAt": turn["sttFinalAt"],
                "llmRequestAt": getattr(self.conversation, "request_at", None),
                "llmFirstTokenAt": getattr(self.conversation, "first_text_at", None)
                or turn["firstChunkAt"],
                "ttsFirstAudioAt": turn.get("speechStartAt"),
            }
            usage = dict(getattr(self.conversation, "usage", None) or zero_usage())
            self.record(
                "assistant",
                turn["spoken"],
                {k: v for k, v in timings.items() if v is not None},
                usage,
                refused=bool(getattr(self.conversation, "refused", False)),
                tools=turn.get("tools") or None,
            )

    def _remember_speech(self, text):
        if text.strip():
            self._recent_speech = [*self._recent_speech[-4:], (time.time(), text)]
            end = time.time() * 1000 + len(text.split()) / WORDS_PER_S * 1000
            self._speech_until = max(self._speech_until, end)

    # ---------- Line event filters (#9 barge-in, #15 silence, #35 cut-off metric) ----------

    def observe(self, event):
        """Track who is speaking from every Line event, before the run/cancel decision."""
        now = time.time() * 1000
        if isinstance(event, AgentTurnStarted):
            self._agent_speaking, self._agent_speech_at = True, now
            turn = self._open_turn
            if turn and turn["firstChunkAt"] is not None and turn.get("speechStartAt") is None:
                turn["speechStartAt"] = now  # #80 ttsFirstAudioAt: Line heard audio start
        elif isinstance(event, AgentTurnEnded):
            self._agent_speaking = False
        elif isinstance(event, UserTurnStarted):
            self._caller_speaking, self._caller_started_at = True, now
            timings = {}
            if self._agent_talking(now):
                timings["bargeInAt"] = now
            started = self._agent_speech_at or self._reply_first_chunk_at
            if started and 0 <= now - started <= CUT_OFF_MS:
                timings.update(agentSpeechStartAt=started, cutOff=1)
            self._pending_timings = timings
        elif isinstance(event, UserTurnEnded):
            self._caller_speaking = False

    def _agent_talking(self, now):
        if self._agent_speaking is not None:
            return self._agent_speaking or self._open_turn is not None
        return self._open_turn is not None or now < self._speech_until

    def should_run(self, event) -> bool:
        self.observe(event)
        if isinstance(event, (CallStarted, CallEnded)):
            return True
        if isinstance(event, UserTurnEnded):
            if not self._gate.is_set():
                # A barge-in during a tool wait was held back. Echo or noise: carry on as if
                # nothing happened; real words: start their turn (which cancels the reply).
                if self._only_echo(event):
                    log.info("Barge-in was the agent's own voice; the reply carries on")
                    self._skip_turns.add(event.event_id)
                    self._gate.set()
                    return False
                self._gate.set()
            return True
        if isinstance(event, AgentTurnEnded):
            # Start the silence timer only when nobody is talking and no reply is running.
            return not self._replying and not self._caller_speaking and bool(self.silence_steps_s)
        return False

    def should_cancel(self, event) -> bool:
        if not isinstance(event, UserTurnStarted):
            return False
        inflight = getattr(self.conversation, "_inflight", None)
        now = time.time() * 1000
        if self._replying and (inflight and inflight.get("tasks") or now < self._filler_until):
            # Waiting on a tool after the (uninterruptible) "Let me check." The most likely
            # sound now (during the tool wait, or just after the filler while the reply that
            # follows starts) is that line coming back through a speakerphone, so don't cancel yet:
            # hold any further speech until the caller's words show whether they are real.
            self._gate.clear()
            return False
        if self._open_turn is not None:
            self._open_turn.setdefault("stoppedAt", time.time() * 1000)  # Line cancels it now
        return True

    def _only_echo(self, event) -> bool:
        text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
        if not text.strip():
            return True
        turn = self._open_turn
        recent = [said for _, said in self._recent_speech]
        if turn and turn["spoken"]:
            recent.append(turn["spoken"])
        return not strip_echo(text, recent).strip()

    async def silence(self):
        """After the agent stops talking: wait, then a templated line; finally end the call."""
        if self._silences >= len(self.silence_steps_s):
            return
        wait_s = self.silence_steps_s[self._silences]
        started = time.time() * 1000
        await asyncio.sleep(wait_s)
        now = time.time() * 1000
        # Reply text is sent before its audio starts, so the agent may have begun (or still be)
        # speaking since this timer started; that speech's own AgentTurnEnded restarts it.
        if (
            self._caller_speaking
            or self._agent_speaking
            or (self._agent_speech_at or 0) > started
            or (self._agent_speaking is None and now < self._speech_until)
        ):
            return
        step = self._silences
        self._silences += 1
        if step >= len(SILENCE_LINES):
            log.info("Ending the call gently after %d long silences", step + 1)
            yield AgentEndCall(reason="silence")
            return
        line = SILENCE_LINES[step]
        self.record("assistant", line, {"silenceMs": wait_s * 1000})
        self._silence_note += f" {line}"
        self._last_said += (" " if self._last_said else "") + line
        self._last_spoken += (" " if self._last_spoken else "") + line
        self._remember_speech(line)
        yield AgentSendText(text=line)

    def _strip_echo(self, text, history, heard):
        """The caller's own words, minus any echo of the agent's voice. Echo is only possible
        when the caller's turn started while the agent was talking: Line's agent state says so,
        or (without it) the last reply was cut off or still running when the turn arrived."""
        speaking = agent_was_speaking(history)
        if speaking is None:
            cut = heard is not None and len(_letters(heard)) < len(_letters(self._last_spoken))
            speaking = cut or not self._last_turn_done
        if not speaking:
            return text
        # The latest reply always counts: it may still be playing long after it was sent.
        cutoff = time.time() - ECHO_WINDOW_S
        recent = [
            said
            for i, (at, said) in enumerate(self._recent_speech)
            if at >= cutoff or i == len(self._recent_speech) - 1
        ]
        if self._first_word_echo(text, recent):
            return ""
        return strip_echo(text, recent)

    def _first_word_echo(self, text, recent) -> bool:
        """One word, the first word of the agent's latest reply, heard within moments of that
        reply's audio starting: the speakerphone feeding it back, even an answer word ("No"
        from "No tomatoes for me"). A caller rarely answers that fast with the very word the
        agent opened with, and if they did, the cut reply is said again and they can repeat it."""
        words = _words(text)
        latest = _words(recent[-1]) if recent else []
        started, began = self._agent_speech_at, self._caller_started_at
        return (
            len(words) == 1
            and latest[:1] == words
            and started is not None
            and began is not None
            and 0 <= began - started <= FIRST_WORD_ECHO_MS
        )

    async def run_tool(self, name, tool_input, tool_use_id):
        result = await self._run_tool(name, tool_input, tool_use_id)
        if self._open_turn is not None:
            self._open_turn["tools"].append((name, tools.tool_outcome(result)))
        return result

    async def _run_tool(self, name, tool_input, tool_use_id):
        if self.turn_tools:
            self.turn_tools[-1].add(name)
        ctx = self.tool_context(
            api=self.api, call_id=self.call_id, context=self.context, tool_use_id=tool_use_id
        )
        if name != "place_order":
            return await self.dispatch(name, tool_input, ctx)
        # Counted before the request: an order cancelled at call end stays "unconfirmed".
        slot = len(self.order_statuses)
        self.order_statuses.append("unconfirmed")
        result = await self.dispatch(name, tool_input, ctx)
        if not isinstance(result, dict):
            return result
        if result.get("status"):
            self.order_statuses[slot] = result["status"]
            self.orders.append(result)
        elif "error" in result:
            self.order_statuses[slot] = "error"  # not placed
        return {k: v for k, v in result.items() if k not in PRIVATE_ORDER_FIELDS}

    def call_end_payload(self) -> dict:
        payload = {"callId": self.call_id}
        if not self.context:
            return {**payload, "kind": "unknown_caller", "outcome": "unknown_caller"}
        outcomes = {OUTCOME_BY_STATUS.get(s) for s in self.order_statuses}
        outcome = next((o for o in OUTCOME_PRIORITY if o in outcomes), "no_order")
        if outcome == "no_order" and UNSETTLED_ORDER_STATUSES & set(self.order_statuses):
            outcome = None  # unknown here; don't overwrite what Convex recorded for the order
        order_turns = [i for i, used in enumerate(self.turn_tools) if used & ORDER_TOOLS]
        if not order_turns:
            kind = "chat"
        else:
            # Two or more conversational turns before the errand started -> mixed.
            kind = "mixed" if order_turns[0] >= 2 else "order"
        payload["kind"] = kind
        if outcome:
            payload["outcome"] = outcome
        return payload

    async def warm(self):
        try:
            usage = await self.conversation.prewarm()
            log.info(
                "Pre-warm usage: cache write %s, cache read %s",
                usage.get("cache_creation_input_tokens"),
                usage.get("cache_read_input_tokens"),
            )
        except Exception:  # noqa: BLE001 -- pre-warm failure must not prevent conversation
            log.warning("Cache pre-warm unavailable; live turns will still be attempted")

    async def _caller_turn(self, event):
        text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
        if not text.strip() and not self._held:
            return
        stt_final_at = time.time() * 1000
        heard = heard_text(event.history, skip=self._skip_turns)
        own = self._strip_echo(text, event.history, heard)
        echoed = own != text
        if echoed:
            log.info(
                "Removed echo of the agent's own voice from a caller turn (%d of %d words)",
                len(text.split()) - len(own.split()),
                len(text.split()),
            )
        own = " ".join(part for part in (self._held, own.strip()) if part)
        timings, self._pending_timings = self._pending_timings, {}
        if own and self.holdoff_s > 0 and INCOMPLETE_END.search(own):
            # The caller may be pausing mid-thought. If they go on, UserTurnStarted cancels
            # this wait and their next words are joined to these as one turn.
            self._held = own
            self._held_timings = {**timings, **self._held_timings}
            self._skip_turns.add(event.event_id)
            await asyncio.sleep(self.holdoff_s)
            self._skip_turns.discard(event.event_id)
            log.info("End-of-turn hold-off of %d ms passed", self.holdoff_s * 1000)
            timings = {**timings, "holdOffMs": self.holdoff_s * 1000}
        if self._held:
            # Timings from where the caller's turn began (its first fragment) win.
            timings = {**timings, **self._held_timings}
        self._held, self._held_timings = "", {}
        note = interrupted_note(self._last_said, heard, echo=echoed)
        resumed = False
        if not own:
            replay = None
            if note is not None and self._echo_replays < MAX_ECHO_REPLAYS:
                replay = unheard_rest(self._last_spoken, heard) if self._last_turn_done else None
            if replay:
                # The whole reply was written and the caller missed its end: say those words
                # again at once, verbatim. No model request, so no gap for a "Hello?", and the
                # history already holds the reply.
                log.info(
                    "Echo cut the reply off; replaying its unheard %d words", len(replay.split())
                )
                self._echo_replays += 1
                self._skip_turns.add(event.event_id)
                self._remember_speech(replay)
                yield AgentSendText(text=replay)
                return
            if (self._last_turn_done and note is None) or self._last_turn_resumed:
                # Nothing was lost, or the cut reply was already a resume: never loop.
                self._skip_turns.add(event.event_id)
                self._replying = False  # only waiting on silence now
                async for out in self.silence():
                    yield out
                return
            # Line cancels the reply when the echo starts; carry on rather than go silent.
            text, resumed = ECHO_RESUME_NOTE, True
        else:
            text = own
            self._echo_replays = 0
            self.record("user", text, {"sttFinalAt": stt_final_at, **timings})
            self.turn_tools.append(set())
            safety = self.wellbeing.check(text)
            if safety:
                # WB-5: the templated line is the whole reply (no model request). It joins the
                # append-only history so the model sees it next turn; family is being alerted.
                wellbeing.add_to_history(self.conversation, text, safety)
                self._silences, self._silence_note = 0, ""
                self._last_said = self._last_spoken = safety
                self._last_turn_done, self._last_turn_resumed = True, False
                self.record("assistant", safety)
                self._remember_speech(safety)
                yield AgentSendText(text=safety)
                return
            if not self.context:
                # #51: an unknown caller gets a few turns, then a gentle templated goodbye.
                if FAREWELL.search(text):
                    async for out in self._end_gently():
                        yield out
                    return
                self._end_after_reply = len(self.turn_tools) >= UNKNOWN_CALLER_MAX_TURNS
                if self._end_after_reply:
                    note = f"{note}\n{LAST_REPLY_NOTE}" if note else LAST_REPLY_NOTE
            if self._silence_note:
                silence = (
                    "<silence>System note: the caller was quiet for a while, so you said:"
                    f' "{self._silence_note.strip()}"</silence>'
                )
                note = f"{silence}\n{note}" if note else silence
            self._silences, self._silence_note = 0, ""
        self._last_said = ""
        self._reply_first_chunk_at = None
        turn = self._open_turn = {
            "resumed": resumed,
            "spoken": "",
            "unspoken": "",  # held back after the reply's question
            "asked": False,
            "done": False,
            "sttFinalAt": stt_final_at,
            "firstChunkAt": None,
            "speechStartAt": None,  # ms, Line's AgentTurnStarted after the first chunk
            "tools": [],  # (name, outcome) for the turn log
            "logged": False,
        }
        stream = self.conversation.reply(text, note=note) if note else self.conversation.reply(text)
        try:
            async for chunk in _cover_slow_start(stream, SLOW_REPLY_S):
                if turn["firstChunkAt"] is None and chunk.strip() != SLOW_REPLY_LINE:
                    turn["firstChunkAt"] = self._reply_first_chunk_at = time.time() * 1000
                # Stop talking once the question is asked; keep draining so tools and
                # history complete normally.
                say = ""
                if not turn["asked"]:
                    say, turn["asked"] = until_question(chunk)
                turn["unspoken"] += chunk[len(say) :]
                if not say:
                    continue
                # After a held-back barge-in, say nothing more until it proves to be echo.
                await self._gate.wait()
                turn["spoken"] += say
                # Echo can't cut off the short "Let me check." covering a tool call.
                filler = say.strip() in FILLER_LINES
                if filler:
                    self._filler_until = (
                        time.time() * 1000 + len(say.split()) / WORDS_PER_S * 1000 + FILLER_ECHO_MS
                    )
                yield AgentSendText(text=say, interruptible=not filler)
            turn["done"] = True
            if getattr(self.conversation, "refused", False):
                self.wellbeing.after_refusal(text)  # VO-8: a refused harmful turn alerts family
        except (asyncio.CancelledError, GeneratorExit):
            turn.setdefault("stoppedAt", time.time() * 1000)  # barge-in or call end
            raise
        except Exception:  # noqa: BLE001 -- event boundary needs a spoken recovery
            log.warning("Conversation request failed")
            recovery = (" " if turn["spoken"] else "") + ERROR_LINE
            turn["spoken"] += recovery
            turn["done"] = True
            yield AgentSendText(text=recovery)
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose:
                await aclose()
            self._close_turn(turn)

    async def _end_gently(self, after_reply: bool = False):
        """Templated goodbye, then hang up (#51 unknown caller)."""
        self._end_after_reply = False
        self.record("assistant", UNKNOWN_CALLER_CLOSING)
        self._remember_speech(UNKNOWN_CALLER_CLOSING)
        # Right after a reply, the space keeps TTS from running the two sentences together.
        lead = " " if after_reply else ""
        yield AgentSendText(text=lead + UNKNOWN_CALLER_CLOSING)
        yield AgentEndCall(reason="unknown_caller")

    async def process(self, env, event):
        self._close_turn(self._open_turn)
        if isinstance(event, AgentTurnEnded):
            async for out in self.silence():
                yield out
        elif isinstance(event, CallStarted):
            # #60: a check-in call opens with its voicemail-safe line; inbound calls are unchanged.
            context_text, opening = checkin.opening(self, greeting, call_context)
            self.conversation.begin(context_text, opening)
            # Pre-warm in parallel with the greeting; never block the greeting on it.
            self.warm_task = asyncio.create_task(self.warm())
            if self.followup and self.call_id:
                self.api.fire(
                    "/agent/followup",
                    {"callId": self.call_id, "followupId": self.followup["_id"]},
                )
            self.record("assistant", opening)
            self._last_said = self._last_spoken = opening
            self._remember_speech(opening)
            yield AgentSendText(text=opening)
        elif isinstance(event, UserTurnEnded):
            self._gate.set()
            self._replying = True
            turn = self._caller_turn(event)
            try:
                async for out in turn:
                    yield out
            finally:
                self._replying = False
                await turn.aclose()  # runs its cleanup even when cancelled mid-yield
            if self._end_after_reply:
                async for out in self._end_gently(after_reply=True):
                    yield out
                return
            if self._agent_speaking is False and not self._caller_speaking:
                # Line said the agent stopped talking before this reply finished draining,
                # so that AgentTurnEnded started no silence timer: start it here.
                async for out in self.silence():
                    yield out
        elif isinstance(event, CallEnded):
            if self.warm_task:
                self.warm_task.cancel()
                await asyncio.gather(self.warm_task, return_exceptions=True)
            # Let in-flight orders finish (or cancel them) before the outcome is computed.
            drain = getattr(self.conversation, "drain", None)
            if drain:
                await drain()
            await self.api.flush()
            try:
                if self.call_id:
                    await self.api.post("/agent/call-end", self.call_end_payload())
            finally:
                tools.forget_call(self.call_id)


class UnavailableAgent:
    """Convex could not identify the call: apologize and hang up. Never guesses a household."""

    async def process(self, env, event):
        if isinstance(event, CallStarted):
            yield AgentSendText(text=UNAVAILABLE_LINE, interruptible=False)
            yield AgentEndCall()


async def get_agent(env, request):
    # Never replace missing caller ID with Margaret's number.
    started = gate = None
    try:
        # #60: a check-in call Errand Line placed. No request is made for inbound calls.
        started = await checkin.outbound_checkin(api, request)
        result = started or await api.post(
            "/agent/household",
            {
                "callerPhone": request.from_,
                "providerCallId": request.agent_call_id,
            },
        )
        context = result["context"]
        call_id = result["callId"]
        if context is None and call_id:
            # #65: an unknown number the family approved for a spoken PIN (None otherwise).
            gate = await pin.gate_needed(api, request.from_)
    except Exception as exc:  # noqa: BLE001 -- the caller must still hear something
        # Never log the request or response: they carry the caller's phone number.
        log.warning("Household lookup failed (%s); ending the call politely", type(exc).__name__)
        return UnavailableAgent(), [CallStarted], []

    def build(context, idx=0):
        conversation = ClaudeConversation(anthropic_client, system_blocks(context), tools.TOOLS)
        agent = ErrandAgent(conversation, api, call_id, context)
        agent.idx = idx  # after a PIN unlock, turn numbering continues
        conversation.run_tool = agent.run_tool
        # Scam guard (#5 #10 #14 #25): hard rule, background classifier, guard notes, order gate.
        classifier = scam.ScamClassifier(anthropic_client) if context else None
        scam.ScamGuard(api, call_id, context, classifier=classifier).attach(agent)
        if started:
            checkin.attach(agent, started["checkin"])  # #60
        return spanish.wrap(agent)  # #67: Spanish handoff on the same call

    if gate:
        # #65: ask for the spoken PIN first; on success the gate hands over to build(context).
        agent = pin.PinGate(api, call_id, build, locked=bool(gate.get("locked")))
    else:
        agent = build(context)
    return agent, agent.should_run, agent.should_cancel


api = None
anthropic_client = None
app = VoiceAgentApp(get_agent=get_agent, pre_call_handler=voice.pre_call)


@asynccontextmanager
async def lifespan(_):
    global api, anthropic_client
    quiet_line_logs()
    for name in ["ANTHROPIC_API_KEY", "CARTESIA_API_KEY", "CONVEX_SITE_URL", "AGENT_SECRET"]:
        if not os.getenv(name):
            raise RuntimeError(f"Missing {name}; see .env.example")
    api = ConvexAPI(os.environ["CONVEX_SITE_URL"], os.environ["AGENT_SECRET"])
    anthropic_client = AsyncAnthropic(max_retries=0, timeout=20)
    try:
        yield
    finally:
        await api.close()
        await anthropic_client.close()
        await tools.close_client()


app.fastapi_app.router.lifespan_context = lifespan

if __name__ == "__main__":
    app.run(host="0.0.0.0")
