"""Wellbeing safety net (#73, SPEC §8.8 WB-1, WB-2, WB-5).

The 911 and 988 lines are templated text, never generated. A deterministic classifier runs on
every caller turn before the model; when it fires, the agent speaks the template as the whole
reply (no model request), records it in the conversation history, and alerts family through
Convex (/agent/wellbeing). A model refusal on a harmful-sounding turn alerts family too.

Errand Line is not an emergency service and never calls 911 itself (§14.4).
"""

import logging
import re

log = logging.getLogger(__name__)

# WB-1: a fall with injury, can't get up, chest pain, trouble breathing, sudden confusion.
EMERGENCY = re.compile(
    r"\b("
    r"(i|i've|i have|i just)\s+(fell|fallen|had a fall)|"
    r"(can'?t|cannot|can not)\s+(get up|stand up|get off the floor|breathe)|"
    r"trouble breathing|hard to breathe|"
    r"chest (pain|pains|hurts|is tight)|pain in my chest|"
    r"(i'?m|i am) bleeding|"
    r"(having|had) a (stroke|heart attack)|"
    r"(the )?(house|kitchen|stove) is on fire|there'?s a fire|"
    r"(someone|somebody|he|she|they) (is |are )?(hurting|hit|hitting|attacking) me|"
    r"(i'?m|i am) (so )?confused (and|i) don'?t know where i am|don'?t know where i am"
    r")\b",
    re.IGNORECASE,
)
# WB-2: self-harm or wanting to die.
CRISIS = re.compile(
    r"\b("
    r"want(ed)? to die|wish i (was|were) dead|better off dead|"
    r"kill(ing)? myself|end (my life|it all)|take my (own )?life|"
    r"hurt(ing)? myself|harm(ing)? myself|suicid\w*|"
    r"don'?t want to (live|be alive|be here anymore|go on)|no reason to (live|go on)|"
    r"overdose"
    r")\b",
    re.IGNORECASE,
)
NEGATED = re.compile(r"\b(never|not|didn'?t|don'?t|wouldn'?t)\b[^.?!]{0,12}$", re.IGNORECASE)
# claude.py's harm pattern on refused turns (VO-8): a refusal here still alerts family.
REFUSAL_HARM = re.compile(
    r"\b(suicid\w*|kill(ing)? (myself|me)|end (my life|it all)|hurt(ing)? (myself|me)|"
    r"want(ed)? to die|overdos\w*|emergency|chest pains?|can'?t breathe|bleeding|"
    r"fallen|abus\w*|911|988)\b",
    re.IGNORECASE,
)


def detect(text: str) -> str | None:
    """'crisis', 'emergency' or None for one caller turn. Crisis wins when both match."""
    for level, pattern in (("crisis", CRISIS), ("emergency", EMERGENCY)):
        for match in pattern.finditer(text or ""):
            # "I would never hurt myself" is not a crisis statement.
            if not NEGATED.search(text[: match.start()]):
                return level
    return None


def emergency_line(family: str | None) -> str:
    tell = f" I'm letting {family} know right away." if family else ""
    return f"If you're hurt, please hang up and call 911 now.{tell} Are you safe right now?"


def crisis_line(family: str | None) -> str:
    tell = f" I'm letting {family} know too." if family else ""
    return (
        "I'm so glad you told me. You can call or text 988 any time to talk with someone "
        "right now, and if you're in immediate danger, please call 911."
        f"{tell} Are you safe right now?"
    )


def safety_line(level: str, family: str | None) -> str:
    return emergency_line(family) if level == "emergency" else crisis_line(family)


def _family(context: dict | None) -> str | None:
    contacts = ((context or {}).get("household") or {}).get("familyContacts") or []
    name = " ".join(str(contacts[0].get("name") or "").split()) if contacts else ""
    return name or None


def add_to_history(conversation, caller_text: str, line: str):
    """Append the caller's turn and the templated reply to the live, append-only history,
    exactly as ClaudeConversation.reply would (settling any interrupted turn first)."""
    settle = getattr(conversation, "_settle", None)
    if settle:
        settle(getattr(conversation, "_inflight", None))
    late = getattr(conversation, "_late_notes", None)
    notes = late() if late else []
    conversation.messages.append(
        {"role": "user", "content": notes + [{"type": "text", "text": caller_text}]}
    )
    conversation.messages.append({"role": "assistant", "content": [{"type": "text", "text": line}]})


class WellbeingGuard:
    """Per-call classifier and alert sender. One alert per level per call (Convex dedupes too)."""

    def __init__(self, api, call_id: str | None, context: dict | None):
        self.api = api
        self.call_id = call_id
        self.context = context
        self.alerted: set[str] = set()

    @property
    def can_alert(self) -> bool:
        return bool(self.api and self.call_id and self.context and _family(self.context))

    def alert(self, level: str, caller_text: str, source: str):
        if not self.can_alert or level in self.alerted:
            return
        self.alerted.add(level)
        summary = "Said: " + " ".join(caller_text.split())[:300]
        self.api.fire(
            "/agent/wellbeing",
            {"callId": self.call_id, "level": level, "summary": summary, "source": source},
        )
        log.info("Wellbeing alert requested (%s, %s)", level, source)

    def check(self, caller_text: str) -> str | None:
        """The templated line to speak instead of a model reply, or None. Alerts family."""
        level = detect(caller_text)
        if not level:
            return None
        family = _family(self.context) if self.can_alert else None
        self.alert(level, caller_text, "classifier")
        return safety_line(level, family)

    def after_refusal(self, caller_text: str):
        """VO-8 / WB-5: the model refused a harmful-sounding turn; alert family too."""
        if not REFUSAL_HARM.search(caller_text or ""):
            return
        self.alert(detect(caller_text) or "emergency", caller_text, "refusal")
