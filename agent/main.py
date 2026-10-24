import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from line.events import (
    AgentSendText,
    CallEnded,
    CallStarted,
    UserTextSent,
    UserTurnEnded,
    UserTurnStarted,
)
from line.voice_agent_app import VoiceAgentApp

from claude import ClaudeConversation
from context import system_blocks
from convex_api import ConvexAPI

load_dotenv()
log = logging.getLogger(__name__)


class ErrandAgent:
    def __init__(self, conversation, api, call_id, context):
        self.conversation = conversation
        self.api = api
        self.call_id = call_id
        self.context = context
        self.idx = 0
        self.warm_task = None

    def record(self, speaker, text, timings=None):
        if self.call_id:
            self.api.log_turn(
                {
                    "callId": self.call_id,
                    "idx": self.idx,
                    "speaker": speaker,
                    "text": text,
                    "at": time.time() * 1000,
                    "timings": timings or {},
                    "usage": self.conversation.usage
                    if speaker == "assistant"
                    else {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                }
            )
            self.idx += 1

    async def warm(self):
        try:
            await self.conversation.prewarm()
        except Exception:  # noqa: BLE001 -- pre-warm failure must not prevent conversation
            log.warning("Cache pre-warm unavailable; live turns will still be attempted")

    async def process(self, env, event):
        if isinstance(event, CallStarted):
            self.warm_task = asyncio.create_task(self.warm())
            greeting = "Hello, it's Errand Line, your AI phone assistant. How can I help you today?"
            if self.context:
                name = self.context["household"]["preferredName"]
                greeting = (
                    f"Hi {name}, it's Errand Line, your AI phone assistant. How can I help today?"
                )
            self.record("assistant", greeting)
            yield AgentSendText(text=greeting)
        elif isinstance(event, UserTurnEnded):
            text = " ".join(c.content for c in event.content if isinstance(c, UserTextSent))
            if not text.strip():
                return
            self.record("user", text)
            timings = {"sttFinalAt": time.time() * 1000, "llmRequestAt": time.time() * 1000}
            spoken = ""
            try:
                async for chunk in self.conversation.reply(text):
                    timings.setdefault("llmFirstTokenAt", time.time() * 1000)
                    spoken += chunk
                    yield AgentSendText(text=chunk)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 -- event boundary needs a spoken recovery
                log.warning("Conversation request failed")
                recovery = "I'm having trouble answering just now. Please try again in a moment."
                spoken += recovery
                yield AgentSendText(text=recovery)
            finally:
                if spoken:
                    self.record("assistant", spoken, timings)
        elif isinstance(event, CallEnded):
            if self.warm_task:
                self.warm_task.cancel()
                await asyncio.gather(self.warm_task, return_exceptions=True)
            await self.api.flush()
            if self.call_id:
                await self.api.post("/agent/call-end", {"callId": self.call_id})


async def get_agent(env, request):
    # Never replace missing caller ID with Margaret's number.
    result = await api.post(
        "/agent/household",
        {
            "callerPhone": request.from_,
            "providerCallId": request.agent_call_id,
        },
    )
    conversation = ClaudeConversation(anthropic_client, system_blocks(result["context"]))
    agent = ErrandAgent(conversation, api, result["callId"], result["context"])
    return agent, [CallStarted, UserTurnEnded, CallEnded], [UserTurnStarted]


api = None
anthropic_client = None
app = VoiceAgentApp(get_agent=get_agent)


@asynccontextmanager
async def lifespan(_):
    global api, anthropic_client
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


app.fastapi_app.router.lifespan_context = lifespan

if __name__ == "__main__":
    app.run(host="0.0.0.0")
