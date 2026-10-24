"""Spoken PIN for calls from a new number (#65).

A call from a number that is not a household's caller phone starts as an unknown caller. If the
family approved that number for PIN calls (Settings screen), Convex says so (/agent/pin-check)
and the call goes through PinGate first: the agent asks for the PIN by voice (no keypad, so
landlines and flip phones work), turns the spoken digits into a number here, and sends them to
Convex (/agent/pin-verify), which checks a salted hash, logs the attempt, limits wrong tries and
alerts the family after three. On success Convex links the call to the household and returns
its context, and PinGate hands every later event to a normal ErrandAgent.

The PIN never reaches the model, the transcript, memory or alerts: the caller's PIN turn is
logged as a placeholder, and the model only ever sees conversation after the unlock.
"""

import logging
import re
import time

from line.events import (
    AgentEndCall,
    AgentSendText,
    CallEnded,
    CallStarted,
    UserTextSent,
    UserTurnEnded,
)

log = logging.getLogger(__name__)

PIN_PROMPT = (
    "Hello, this is Errand Line, an AI phone assistant. I don't recognize this number yet. If "
    "your family set up a PIN for you, please say it now, one number at a time."
)
LOCKED_LINE = (
    "I'm sorry, I can't take a PIN from this number right now. Please call back later, or "
    "from your usual phone. Goodbye."
)
RETRY_LINE = "That PIN didn't match. Please say it again, one number at a time."
NO_DIGITS_LINE = "Please say your PIN one number at a time, like four, eight, two, one."
GIVE_UP_LINE = (
    "I'm sorry, I couldn't confirm the PIN. Please call back from your usual phone, or ask your "
    "family for help. Goodbye."
)
TROUBLE_LINE = "I'm sorry, I'm having trouble checking that right now. Please call back soon."
PIN_TURN_PLACEHOLDER = "(PIN spoken; not recorded)"
MAX_PROMPTS = 4

_WORDS = {
    "zero": "0",
    "oh": "0",
    "o": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
}


def spoken_digits(text: str) -> str | None:
    """The 4-8 digit PIN in a transcript ("4 8 2 1", "4821", "four eight two one", "it's
    four eight two one"), or None. Words other than digits are ignored."""
    digits = ""
    for token in re.findall(r"[a-z]+|\d", str(text or "").lower()):
        if token.isdigit():
            digits += token
        elif token in _WORDS and not (token in {"o", "oh"} and not digits):
            digits += _WORDS[token]
    return digits if 4 <= len(digits) <= 8 else None


async def gate_needed(api, caller_phone: str) -> dict | None:
    """{"pinRequired", "locked"} when this unknown number was approved for PIN calls."""
    try:
        result = await api.post("/agent/pin-check", {"callerPhone": caller_phone})
    except Exception as exc:  # noqa: BLE001 -- fall back to the plain unknown-caller flow
        log.warning("PIN check failed (%s); treating as an unknown caller", type(exc).__name__)
        return None
    return result if result.get("pinRequired") else None


class PinGate:
    """Asks for the spoken PIN, then hands the call to `build(context, idx)` -> agent."""

    def __init__(self, api, call_id: str, build, *, locked: bool = False):
        self.api = api
        self.call_id = call_id
        self.build = build
        self.locked = locked
        self.inner = None
        self.idx = 0
        self.prompts = 0

    # Line filters: the gate answers every caller turn until the inner agent takes over.
    def should_run(self, event) -> bool:
        if self.inner is not None:
            return self.inner.should_run(event)
        return isinstance(event, (CallStarted, CallEnded, UserTurnEnded))

    def should_cancel(self, event) -> bool:
        return self.inner.should_cancel(event) if self.inner is not None else False

    def _log(self, speaker: str, text: str):
        self.api.log_turn(
            {
                "callId": self.call_id,
                "idx": self.idx,
                "speaker": speaker,
                "text": text,
                "at": time.time() * 1000,
                "timings": {},
                "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            }
        )
        self.idx += 1

    def _say(self, text: str):
        self._log("assistant", text)
        return AgentSendText(text=text)

    async def process(self, env, event):
        if self.inner is not None:
            async for out in self.inner.process(env, event):
                yield out
            return
        if isinstance(event, CallStarted):
            if self.locked:
                yield self._say(LOCKED_LINE)
                yield AgentEndCall(reason="pin_locked")
                return
            yield self._say(PIN_PROMPT)
        elif isinstance(event, UserTurnEnded):
            async for out in self._caller_turn(env, event):
                yield out
        elif isinstance(event, CallEnded):
            await self.api.flush()
            await self.api.post(
                "/agent/call-end",
                {"callId": self.call_id, "kind": "unknown_caller", "outcome": "unknown_caller"},
            )

    async def _caller_turn(self, env, event):
        text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
        if not text.strip():
            return
        digits = spoken_digits(text)
        # Never the caller's words here: they may hold the PIN, even a mistyped one.
        self._log("user", PIN_TURN_PLACEHOLDER)
        self.prompts += 1
        if digits is None:
            if self.prompts >= MAX_PROMPTS:
                yield self._say(GIVE_UP_LINE)
                yield AgentEndCall(reason="pin_not_given")
                return
            yield self._say(NO_DIGITS_LINE)
            return
        try:
            await self.api.flush()
            result = await self.api.post(
                "/agent/pin-verify", {"callId": self.call_id, "pin": digits}
            )
        except Exception as exc:  # noqa: BLE001 -- event boundary needs a spoken line
            log.warning("PIN verify failed (%s)", type(exc).__name__)
            yield self._say(TROUBLE_LINE)
            yield AgentEndCall(reason="pin_unavailable")
            return
        status = result.get("status")
        if status == "ok" and result.get("context"):
            self.inner = self.build(result["context"], self.idx)
            # The inner agent greets the caller by name as on their own phone.
            async for out in self.inner.process(env, CallStarted()):
                yield out
            return
        if status == "wrong" and self.prompts < MAX_PROMPTS:
            yield self._say(RETRY_LINE)
            return
        yield self._say(LOCKED_LINE if status == "locked" else GIVE_UP_LINE)
        yield AgentEndCall(reason="pin_failed")
