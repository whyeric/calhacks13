"""Direct Anthropic streaming with a tool loop (#31 #78 #36 #75).

One caller turn may span several requests: text streams to TTS as it arrives; when the
model calls tools, they run, their results are appended, and the follow-up response keeps
streaming in the same turn. History is append-only and thinking blocks are passed back
unchanged. Barge-in at any point leaves a valid history (no tool_use without tool_result).

Orders: "Placing that now." is spoken as soon as the model starts a place_order call. When the
result is paid or needs_approval, its templated line (tools.order.confirmation_line) is spoken
at once and recorded as the assistant's reply, with no follow-up request (#77).

Thinking stays adaptive by default (CLAUDE_THINKING_CONVERSATION): with thinking disabled the
scripted T2 check failed 5 of 5 runs; see docs/latency.md.
"""

import asyncio
import json
import logging
import os
import re
import time

log = logging.getLogger(__name__)

RECOVERY_LINE = "Sorry, could you say that another way?"
# Templated wellbeing line (WB-5); the wellbeing issue owns the final wording.
SAFETY_LINE = (
    "If you're in danger or this is an emergency, please hang up and call 911. "
    "If you're thinking about hurting yourself, you can call or text 988 any time."
)
FILLER_LINE = "Let me check."
# Spoken as soon as the model starts a place_order call (the caller has just said yes).
ORDER_FILLER_LINE = "Placing that now."
# Tools that send a message rather than look something up: "Let me check." would be odd.
SEND_FILLER_LINE = "One moment."
SEND_TOOLS = {"connect_family", "raise_wellbeing_alert", "forget_fact", "stop_checkins"}
EMPTY_LINE = "Sorry, could you say that again?"
TOOL_LIMIT_LINE = "I'm sorry, I couldn't finish that just now. Could we try again?"
HARM_PATTERN = re.compile(
    r"\b(suicid\w*|kill(ing)? (myself|me)|end (my life|it all)|hurt(ing)? (myself|me)|"
    r"want(ed)? to die|overdos\w*|emergency|chest pains?|can'?t breathe|bleeding|"
    r"fallen|abus\w*|911|988)\b",
    re.IGNORECASE,
)
MAX_TOOL_ROUNDS = 6
# Call end: wait for tool calls still running (place_order can take up to ~20s) before the
# call-end outcome is computed; anything still running after this is cancelled.
DRAIN_TIMEOUT_S = 25
COMPLETE_STOPS = {"end_turn", "tool_use", "stop_sequence"}
INTERRUPTED_RESULT = {
    "error": "Interrupted: the caller started speaking before this finished, so the outcome "
    "is unknown. Do not repeat it unless the caller asks again; if it completes, a later "
    "system note will report the result."
}
# Not an error: the payment may be going through. Never let the model say it failed.
INTERRUPTED_ORDER_RESULT = {
    "status": "unconfirmed",
    "message": "The caller started speaking before the order finished, so its outcome is not "
    "known yet; the payment may still go through. Don't say it failed or that nothing was "
    "charged, and don't place it again unless the caller asks. A later system note will "
    "report the result.",
}
# place_order outcomes whose templated line ("say") ends the turn: nothing is left for the model
# to add, so no follow-up request is made. Other outcomes with a line (blocked) still go back to
# the model, which is told the caller already heard it.
SAY_ENDS_TURN = {"paid", "needs_approval"}
ALREADY_SAID = (
    "The caller has already heard you say this outcome; don't repeat it. Continue briefly from "
    "there."
)
THINKING_MODES = {"adaptive", "disabled"}
HOLD_DONE_NOTE = (
    "<tool_update>System note, not from the caller: after place_order returned needs_approval, "
    "the Errand Line system really did keep the caller on the line and check the order's status "
    "with the family; your last reply told the caller what it found. Result: {result}. This "
    "replaces the needs_approval result as the order's current status. It is true, so don't "
    "take it back, correct it or apologize for it; if the caller asks, confirm it in one short "
    "sentence.</tool_update>"
)
HOLD_RUNNING_NOTE = (
    "<tool_update>System note, not from the caller: the Errand Line system is still waiting "
    "for the family's answer on the order in the background, as you told the caller, and will "
    "report it in a later note. That was true, so don't take it back.</tool_update>"
)
HOLD_BACKGROUND_NOTE = (
    "<tool_update>System note, not from the caller: the caller cut in before hearing the "
    "needs_approval outcome. The Errand Line system is now checking with the family in the "
    "background and will report their answer in a later note. Until then the order is waiting "
    "for the family's okay and nothing has been charged.</tool_update>"
)
ONE_ORDER_RESULT = {
    "error": "Only one order can be placed at a time, so this one was not placed. Ask the "
    "caller before placing another order."
}


def zero_usage() -> dict:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}


def interrupted_result(tool_use: dict) -> dict:
    return INTERRUPTED_ORDER_RESULT if tool_use.get("name") == "place_order" else INTERRUPTED_RESULT


def _done_future(result: dict) -> asyncio.Future:
    future = asyncio.get_running_loop().create_future()
    future.set_result(result)
    return future


def _model_view(result: dict) -> dict:
    # "say" is a line for the caller, spoken by reply(); the model sees it as its own speech.
    # "_"-prefixed keys are agent-side objects (e.g. the approval hold), never model input.
    return {k: v for k, v in result.items() if k != "say" and not k.startswith("_")}


def describe_error(exc: BaseException) -> str:
    """Class, HTTP status and request ID of a failed request (never the request body)."""
    parts = [type(exc).__name__]
    if getattr(exc, "status_code", None):
        parts.append(str(exc.status_code))
    if getattr(exc, "request_id", None):
        parts.append(f"request_id={exc.request_id}")
    body = getattr(exc, "body", None)
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        parts.append(str(body["error"].get("message", ""))[:200])
    return " ".join(parts)


def tool_result_block(tool_use: dict, result: dict) -> dict:
    result = _model_view(result)
    block = {
        "type": "tool_result",
        "tool_use_id": tool_use["id"],
        "content": json.dumps(result, sort_keys=True, ensure_ascii=False),
    }
    if "error" in result:
        block["is_error"] = True
    return block


def thinking_mode(value: str | None) -> str:
    """CLAUDE_THINKING_CONVERSATION: "adaptive" (default) or "disabled". Anything else (e.g.
    "off") would be sent as an invalid thinking type and fail every request, so it falls back."""
    mode = (value or "").strip().lower() or "adaptive"
    if mode not in THINKING_MODES:
        log.warning("Unknown CLAUDE_THINKING_CONVERSATION %r; using adaptive", value)
        return "adaptive"
    return mode


def filler_line(tool_name: str | None) -> str:
    """The short line covering a tool call when nothing was said yet this turn."""
    if tool_name == "place_order":
        return ORDER_FILLER_LINE
    return SEND_FILLER_LINE if tool_name in SEND_TOOLS else FILLER_LINE


def order_line(tool_uses: list[dict], results: list) -> tuple[str | None, bool]:
    """The templated place_order line to speak now, and whether it ends the turn.

    Only when place_order was the round's only tool call, so no other result needs wording.
    """
    if len(tool_uses) != 1 or tool_uses[0].get("name") != "place_order":
        return None, False
    result = results[0] if results else None
    if not isinstance(result, dict) or not result.get("say"):
        return None, False
    return str(result["say"]), result.get("status") in SAY_ENDS_TURN


def _hold_decision(task: asyncio.Future) -> dict:
    if task.cancelled() or task.exception() is not None:
        return {"status": "unknown"}
    result = task.result()
    return result if isinstance(result, dict) else {"status": "unknown"}


class ClaudeConversation:
    def __init__(self, client, system: list[dict], tools=None, run_tool=None):
        self.client = client
        self.system = system
        # The same list object is sent on every request, so it is byte-identical.
        self.tools = tools if tools is not None else []
        self.run_tool = run_tool  # async (name, input, tool_use_id) -> dict
        self.messages: list[dict] = []
        self.model = os.getenv("CLAUDE_MODEL_CONVERSATION") or "claude-haiku-5-5"
        self.effort = os.getenv("CLAUDE_EFFORT_CONVERSATION") or "low"
        self.thinking = thinking_mode(os.getenv("CLAUDE_THINKING_CONVERSATION"))
        # Thinking counts toward max_tokens; leave headroom so text is never cut off.
        self.max_tokens = int(os.getenv("CLAUDE_MAX_TOKENS_CONVERSATION") or 2048)
        self.usage = zero_usage()
        self.refused = False
        self.request_at: float | None = None
        self.first_text_at: float | None = None
        self.tools_called: list[str] = []
        self._inflight: dict | None = None
        self._late: list[tuple[dict, asyncio.Future]] = []
        # Approval holds (#92) whose caller barged in or hung up: (hold, polling task).
        self._holds: list[tuple[object, asyncio.Future]] = []
        self.hold_decisions: list[dict] = []  # family decisions heard during this call
        # Notes for the next request: the hold is agent code, so the model would otherwise
        # think the waiting lines in its reply were invented and take them back.
        self._hold_notes: list[str] = []
        self._hold_noted: set[asyncio.Future] = set()

    def begin(self, call_context: str, opening: str):
        """Seed the call: server-written context, then the templated opening already spoken."""
        self.messages = [
            {"role": "user", "content": [{"type": "text", "text": call_context}]},
            {"role": "assistant", "content": [{"type": "text", "text": opening}]},
        ]

    def request(self, max_tokens=None, messages=None):
        params = {
            "model": self.model,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
            "system": self.system,
            "messages": messages
            if messages is not None
            else (self.messages or [{"role": "user", "content": "Hello"}]),
            "thinking": {"type": self.thinking},
            "output_config": {"effort": self.effort},
            # Automatic caching of the conversation tail (after breakpoints A and B).
            "cache_control": {"type": "ephemeral"},
        }
        if self.tools:
            params["tools"] = self.tools
            params["tool_choice"] = {"type": "auto"}
        return params

    def prewarm_request(self):
        # Same model/system/tools/thinking/effort as live turns; first user turn as the tail.
        first = self.messages[:1] or [{"role": "user", "content": "Hello"}]
        return self.request(max_tokens=0, messages=first)

    async def prewarm(self):
        message = await self.client.messages.create(**self.prewarm_request())
        return message.usage.model_dump()

    def _add_usage(self, usage):
        self.usage["input"] += usage.input_tokens or 0
        self.usage["output"] += usage.output_tokens or 0
        self.usage["cacheRead"] += getattr(usage, "cache_read_input_tokens", 0) or 0
        self.usage["cacheWrite"] += getattr(usage, "cache_creation_input_tokens", 0) or 0

    async def _call_tool(self, tool_use: dict) -> dict:
        self.tools_called.append(tool_use["name"])
        if self.run_tool is None:
            return {"error": "Tools are not available on this call."}
        try:
            result = await self.run_tool(
                tool_use["name"], tool_use.get("input") or {}, tool_use["id"]
            )
        except Exception:  # noqa: BLE001 -- tool errors become results, never crashes
            log.warning("Tool %s raised; returning an error result", tool_use["name"])
            result = (
                dict(
                    INTERRUPTED_ORDER_RESULT,
                    message="The order tool failed unexpectedly, so "
                    "its outcome is unknown. Don't say it failed or that nothing was charged.",
                )
                if tool_use["name"] == "place_order"
                else {"error": "The tool failed unexpectedly. Nothing was completed."}
            )
        return result if isinstance(result, dict) else {"result": result}

    def _settle(self, turn: dict | None):
        """Make history valid after an interrupted turn. Synchronous: safe during cancellation."""
        if turn is None or self._inflight is not turn:
            return
        self._inflight = None
        if turn["tool_uses"]:
            blocks = []
            for tool_use, task in zip(turn["tool_uses"], turn["tasks"]):
                if task.done() and not task.cancelled() and task.exception() is None:
                    blocks.append(tool_result_block(tool_use, task.result()))
                    self._watch(task.result())
                else:
                    # The shielded task keeps running; its real result is reported later.
                    blocks.append(tool_result_block(tool_use, interrupted_result(tool_use)))
                    self._late.append((tool_use, task))
            self.messages.append({"role": "user", "content": blocks})
        elif turn["partial"].strip():
            # Keep what the caller heard, without incomplete signed thinking blocks.
            self.messages.append({"role": "assistant", "content": turn["partial"]})

    def _watch(self, result) -> None:
        """A needs_approval result whose hold never ran (the caller cut in before its line):
        poll for the family's answer in the background, so a later turn can tell the caller."""
        hold = result.get("_hold") if isinstance(result, dict) else None
        if hold is None:
            return
        try:
            task = asyncio.ensure_future(hold.wait())
        except RuntimeError:  # no running loop (call teardown)
            return
        self._holds.append((hold, task))
        self._hold_noted.add(task)
        self._hold_notes.append(HOLD_BACKGROUND_NOTE)

    def _late_notes(self) -> list[dict]:
        """System notes for interrupted tool calls that have finished since. Never waits."""
        notes, still = [], []
        for tool_use, task in self._late:
            if task.done() and not task.cancelled() and task.exception() is None:
                self._watch(task.result())
                result = json.dumps(_model_view(task.result()), sort_keys=True, ensure_ascii=False)
                notes.append(
                    {
                        "type": "text",
                        "text": "<tool_update>System note, not from the caller: the earlier "
                        f"{tool_use['name']} call finished after the caller interrupted. "
                        f"Result: {result}</tool_update>",
                    }
                )
            elif not task.done():
                still.append((tool_use, task))
        self._late = still
        held = []
        for hold, task in self._holds:
            if not task.done():
                held.append((hold, task))
                continue
            decision = _hold_decision(task)
            self.hold_decisions.append(decision)
            result = json.dumps(hold.model_note(decision), sort_keys=True, ensure_ascii=False)
            notes.append(
                {
                    "type": "text",
                    "text": "<tool_update>System note, not from the caller: the family "
                    "decision on the order you were holding for arrived after the caller "
                    f"interrupted the hold. Result: {result}. Tell the caller briefly."
                    "</tool_update>",
                }
            )
        self._holds = held
        for _, task in held:
            if task not in self._hold_noted:
                self._hold_noted.add(task)
                self._hold_notes.append(HOLD_RUNNING_NOTE)
        notes += [{"type": "text", "text": text} for text in self._hold_notes]
        self._hold_notes = []
        return notes

    async def _hold(self, hold, block: dict, result_block: dict | None = None):
        """Approval hold (#92): poll for the family's decision, reassure about every 20 s, then
        speak the templated outcome. Each line is added to `block` (the assistant's reply in the
        history) before it is spoken. A barge-in or hang-up cancels only this generator; the
        poll keeps running and its result is reported as a system note on the next turn."""
        task = asyncio.ensure_future(hold.wait())
        entry = (hold, task)
        self._holds.append(entry)
        n = 0
        while True:
            done, _ = await asyncio.wait({task}, timeout=hold.reassure_s)
            if done:
                break
            line = hold.reassurance_line(n)
            n += 1
            block["text"] += " " + line
            yield " " + line
        self._holds.remove(entry)
        decision = _hold_decision(task)
        self.hold_decisions.append(decision)
        note = hold.model_note(decision)
        if result_block is not None:
            # This turn made no request after place_order, so its tool_result has never been
            # sent: record the family's answer there, ahead of the reply that announces it, so
            # the history reads "needs approval -> family answered -> told the caller" and the
            # model never takes the outcome back as unchecked.
            content = json.loads(result_block["content"])
            content["familyDecisionDuringHold"] = note
            result_block["content"] = json.dumps(content, sort_keys=True, ensure_ascii=False)
        result = json.dumps(note, sort_keys=True, ensure_ascii=False)
        self._hold_notes.append(HOLD_DONE_NOTE.format(result=result))
        line = hold.outcome_line(decision)
        block["text"] += " " + line
        yield " " + line

    async def drain(self, timeout: float = DRAIN_TIMEOUT_S) -> int:
        """Call end: wait for tool calls still running, then cancel the rest.

        Returns how many were still running and got cancelled.
        """
        # A hold's caller is gone: stop polling at once instead of waiting out its window.
        for _, task in self._holds:
            task.cancel()
        self._holds = []
        tasks = [task for _, task in self._late if not task.done()]
        if self._inflight and self._inflight["tasks"]:
            tasks += [t for t in self._inflight["tasks"] if not t.done()]
        if not tasks:
            return 0
        _, pending = await asyncio.wait(tasks, timeout=timeout)
        for task in pending:
            task.cancel()
        if pending:
            log.warning("Cancelled %d tool call(s) still running at call end", len(pending))
            await asyncio.gather(*pending, return_exceptions=True)
        return len(pending)

    async def reply(self, text: str, note: str | None = None):
        """Stream one caller turn. `note` is a system-written text block placed before the
        caller's words (e.g. what the caller actually heard of the previous reply)."""
        self._settle(self._inflight)  # a previous generator may not have been closed yet
        self.usage = zero_usage()
        self.refused = False
        self.request_at = None
        self.first_text_at = None
        self.tools_called = []
        notes = self._late_notes()
        if note:
            notes.append({"type": "text", "text": note})
        self.messages.append({"role": "user", "content": notes + [{"type": "text", "text": text}]})
        turn = self._inflight = {"partial": "", "tool_uses": None, "tasks": None}
        spoken = ""  # everything the caller heard this turn, including filler
        model_spoke = False
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                turn["partial"] = ""
                if self.request_at is None:
                    self.request_at = time.time() * 1000
                # Exiting this context on cancellation closes the provider stream (barge-in).
                async with self.client.messages.stream(**self.request()) as stream:
                    async for event in stream:
                        if event.type == "text" and event.text:
                            chunk = event.text
                            if not turn["partial"] and spoken and not spoken[-1].isspace():
                                chunk = " " + chunk.lstrip()
                            if self.first_text_at is None:
                                self.first_text_at = time.time() * 1000
                            turn["partial"] += event.text
                            spoken += chunk
                            model_spoke = True
                            yield chunk
                        elif (
                            event.type == "content_block_start"
                            and event.content_block.type == "tool_use"
                            and not spoken
                        ):
                            # Cover tool time only if nothing was said yet this turn.
                            filler = filler_line(getattr(event.content_block, "name", None))
                            spoken += filler
                            yield filler
                    final = await stream.get_final_message()
                self._add_usage(final.usage)

                if final.stop_reason == "refusal":
                    self.refused = True
                    line = SAFETY_LINE if HARM_PATTERN.search(text) else RECOVERY_LINE
                    heard = (turn["partial"] + " " + line).strip()
                    turn["partial"] = ""
                    self.messages.append({"role": "assistant", "content": heard})
                    chunk = (" " if spoken else "") + line
                    spoken += chunk
                    yield chunk
                    break

                if final.stop_reason not in COMPLETE_STOPS:
                    # Cut off (max_tokens etc.): thinking blocks may be unsigned and tool input
                    # incomplete, so keep only the text the caller heard and run no tools.
                    log.warning("Response stopped early (%s)", final.stop_reason)
                    heard = turn["partial"].strip()
                    turn["partial"] = ""
                    if not heard:
                        heard = RECOVERY_LINE
                        chunk = (" " if spoken else "") + heard
                        spoken += chunk
                        yield chunk
                    self.messages.append({"role": "assistant", "content": heard})
                    break

                content = [block.model_dump(exclude_none=True) for block in final.content]
                if not content:
                    break
                self.messages.append({"role": "assistant", "content": content})
                turn["partial"] = ""
                tool_uses = [block for block in content if block.get("type") == "tool_use"]
                if not tool_uses:
                    break
                turn["tool_uses"] = tool_uses
                tasks, ordering = [], False
                for tool_use in tool_uses:
                    if tool_use["name"] == "place_order":
                        if ordering:
                            # Never dispatch a second payment from the same message.
                            tasks.append(_done_future(ONE_ORDER_RESULT))
                            continue
                        ordering = True
                    tasks.append(asyncio.ensure_future(self._call_tool(tool_use)))
                turn["tasks"] = tasks
                # Shielded: a barge-in must not abandon a payment request halfway.
                results = list(await asyncio.shield(asyncio.gather(*turn["tasks"])))
                say, ends_turn = order_line(tool_uses, results)
                if say and not ends_turn:
                    results[0] = {**results[0], "alreadySaid": say, "note": ALREADY_SAID}
                result_blocks = [
                    tool_result_block(tool_use, result)
                    for tool_use, result in zip(tool_uses, results)
                ]
                self.messages.append({"role": "user", "content": result_blocks})
                said = {"type": "text", "text": say}
                if say and ends_turn:
                    # The outcome is fully known: speak the templated line now instead of waiting
                    # for another model request, and record it as the assistant's reply.
                    self.messages.append({"role": "assistant", "content": [said]})
                turn["tool_uses"] = turn["tasks"] = None
                if say:
                    chunk = (" " if spoken and not spoken[-1].isspace() else "") + say
                    spoken += chunk
                    model_spoke = True
                    yield chunk
                    if ends_turn:
                        hold = results[0].get("_hold")
                        if hold is not None:
                            async for line in self._hold(hold, said, result_blocks[0]):
                                spoken += line
                                yield line
                        break
            else:
                line = TOOL_LIMIT_LINE
                self.messages.append({"role": "assistant", "content": line})
                chunk = (" " if spoken else "") + line
                spoken += chunk
                yield chunk
                model_spoke = True
            if not spoken and not model_spoke:
                yield EMPTY_LINE
        except Exception as exc:
            # main.py speaks the error line; make the cause visible in the logs.
            log.warning("Claude request failed: %s", describe_error(exc))
            raise
        finally:
            self._settle(turn)
