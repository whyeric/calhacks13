"""Spanish handoff (#67): hand a Spanish-speaking caller to the Spanish agent on the same call.

Design (the spec leaves it open): the handoff happens inside the running call, so there is no
re-dial and Convex keeps one call record. When a caller turn is Spanish, or asks for Spanish,
SpanishHandoff
  1. sends Line an AgentUpdateCall with language "es" (speech recognition and voice switch to
     Spanish) and, if CARTESIA_VOICE_ID_ES is set, a Spanish voice;
  2. from then on, adds the Spanish agent's prompt to the caller's turn as a system note.

The system prompt, tools and history are unchanged (append-only: prompt caching and thinking
blocks stay valid), so every money rule carries over exactly: place_order, family limits and
the scam hard rule run in code and Convex, not in the prompt (§14.1). The English path is
untouched until a handoff happens.

Known limits: templated lines written in code (the filler "Let me check.", the place_order
confirmation and silence lines) are still English; Convex's consent check for connect_family
reads English yes-words, so a Spanish "sí" fails closed (the message isn't sent).
"""

import logging
import os
import re
import time
import unicodedata

from line.events import AgentUpdateCall, UserTextSent, UserTurnEnded

log = logging.getLogger(__name__)

SPANISH_PROMPT = (
    "<language>System note, not from the caller: the caller speaks Spanish, so the call has "
    "been handed to Errand Line's Spanish agent. From now on reply only in Spanish, with the "
    "same warmth and the same short sentences. Every rule above still applies, unchanged: "
    "confirm a usual item in one question; offer at most two options; before place_order, read "
    "back every item, the total and the expected arrival in Spanish, ask «¿Lo pido?», and only "
    "an explicit yes in their latest turn counts («sí», «sí, por favor», «adelante», «hágalo»). "
    "Say prices in Spanish words: 2145 cents is «veintiún dólares con cuarenta y cinco "
    "centavos». Family limits, approvals and the scam rules are enforced by the tools exactly "
    "as before; never translate a refusal into a promise. If the system speaks a line in "
    "English, briefly repeat its meaning in Spanish.</language>"
)
SPANISH_REMINDER = "<language>System note: reply in Spanish.</language>"

# Words that are clearly Spanish (accents folded) and rare in English speech.
_SPANISH = frozenset(
    [
        "hola",
        "gracias",
        "quiero",
        "quisiera",
        "necesito",
        "puede",
        "puedes",
        "usted",
        "ustedes",
        "buenos",
        "buenas",
        "dias",
        "tardes",
        "noches",
        "senora",
        "senor",
        "comprar",
        "pedir",
        "cafe",
        "leche",
        "pan",
        "papel",
        "toallas",
        "ayuda",
        "ayudeme",
        "hablar",
        "habla",
        "hablo",
        "espanol",
        "tambien",
        "estoy",
        "esta",
        "estas",
        "mi",
        "mis",
        "los",
        "las",
        "una",
        "del",
        "para",
        "con",
        "que",
        "por",
        "favor",
        "si",
        "donde",
        "cuanto",
        "cuesta",
        "pedido",
        "orden",
        "mande",
        "traer",
        "necesitamos",
        "hija",
        "hijo",
        "nieta",
        "bueno",
        "claro",
    ]
)
_STRONG = frozenset(
    [
        "hola",
        "gracias",
        "quiero",
        "quisiera",
        "necesito",
        "usted",
        "espanol",
        "favor",
        "buenos",
        "buenas",
        "senora",
        "senor",
        "ayuda",
        "cuanto",
        "cuesta",
        "pedido",
    ]
)
_ASK = re.compile(
    r"\b(en espanol|habla(s)? espanol|hablo espanol|in spanish|speak spanish|spanish please|"
    r"do you speak spanish|can we speak spanish)\b"
)


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def wants_spanish(text: str) -> bool:
    """True when the caller asks for Spanish or is clearly speaking it."""
    folded = _fold(text)
    if _ASK.search(folded):
        return True
    words = re.findall(r"[a-z]+", folded)
    if not words:
        return False
    hits = [w for w in words if w in _SPANISH]
    strong = [w for w in hits if w in _STRONG]
    return len(strong) >= 2 or (len(hits) >= 3 and len(hits) / len(words) >= 0.5)


class _SpanishConversation:
    """Wraps ClaudeConversation: once handed off, every caller turn carries the Spanish note."""

    _own = ("_inner", "_owner", "_prompted")

    def __init__(self, inner, owner):
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_owner", owner)
        object.__setattr__(self, "_prompted", False)

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def __setattr__(self, name, value):
        if name in self._own:
            object.__setattr__(self, name, value)
        else:
            setattr(self._inner, name, value)

    def reply(self, text, note=None):
        if self._owner.spanish:
            extra = SPANISH_REMINDER if self._prompted else SPANISH_PROMPT
            object.__setattr__(self, "_prompted", True)
            note = f"{extra}\n{note}" if note else extra
        return self._inner.reply(text, note=note) if note else self._inner.reply(text)


class SpanishHandoff:
    """Wraps an ErrandAgent. Same call, same call id, same tools; Spanish after the handoff."""

    def __init__(self, agent):
        self.agent = agent
        self.spanish = False
        self._marked = False
        agent.conversation = _SpanishConversation(agent.conversation, self)

    _own = ("agent", "spanish", "_marked")

    def __getattr__(self, name):
        return getattr(self.agent, name)

    def __setattr__(self, name, value):
        # Anything else (dispatch, idx, followup, checkin...) belongs to the wrapped agent.
        if name in self._own:
            object.__setattr__(self, name, value)
        else:
            setattr(self.agent, name, value)

    def should_run(self, event):
        return self.agent.should_run(event)

    def should_cancel(self, event):
        return self.agent.should_cancel(event)

    def handoff_event(self) -> AgentUpdateCall:
        voice = (os.getenv("CARTESIA_VOICE_ID_ES") or "").strip() or None
        return AgentUpdateCall(language="es", voice_id=voice)

    async def process(self, env, event):
        if isinstance(event, UserTurnEnded) and not self.spanish:
            text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
            if wants_spanish(text):
                self.spanish = True
                log.info("Spanish handoff on this call")
                yield self.handoff_event()
        async for out in self.agent.process(env, event):
            yield out
        if self.spanish and isinstance(event, UserTurnEnded):
            self._mark_handoff()

    def _mark_handoff(self):
        """Show the handoff once on the dashboard (as a tool badge on the next logged turn)."""
        if self._marked:
            return
        self._marked = True
        api, call_id = getattr(self.agent, "api", None), getattr(self.agent, "call_id", None)
        if api and call_id:
            api.log_turn(
                {
                    "callId": call_id,
                    "idx": self.agent.idx,
                    "speaker": "assistant",
                    "text": "(Handed off to the Spanish agent.)",
                    "at": time.time() * 1000,
                    "timings": {},
                    "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                },
                tools=[("spanish_handoff", "es")],
            )
            self.agent.idx += 1


def wrap(agent):
    """The agent main.py returns to Line; a no-op for English callers until they need it."""
    if (os.getenv("SPANISH_HANDOFF") or "1").strip().lower() in {"0", "false", "off"}:
        return agent
    return SpanishHandoff(agent)
