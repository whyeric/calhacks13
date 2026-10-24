import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from claude import ClaudeConversation
from convex_api import ConvexAPI
from line.events import AgentSendText, CallEnded, CallStarted, UserTextSent, UserTurnEnded
from main import ErrandAgent


def test_service_lifespan_starts_and_health_check_requires_no_provider_requests(monkeypatch):
    import main
    from fastapi.testclient import TestClient

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-only-credential")
    monkeypatch.setenv("CARTESIA_API_KEY", "test-only-credential")
    monkeypatch.setenv("CONVEX_SITE_URL", "https://test.convex.site")
    monkeypatch.setenv("AGENT_SECRET", "test-only-secret".ljust(48, "a"))
    monkeypatch.setattr(main, "api", None)
    monkeypatch.setattr(main, "anthropic_client", None)
    with TestClient(main.app.fastapi_app) as client:
        response = client.get("/status")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_api_pools_authenticates_and_drains_background_writes():
    received = []

    async def handle(request):
        received.append(request)
        return httpx.Response(200, json={"turnId": "t1"})

    api = ConvexAPI(
        "https://example.convex.site",
        "test-agent-".ljust(40, "a"),
        transport=httpx.MockTransport(handle),
    )
    api.log_turn({"text": "hello"})
    await api.flush()
    assert len(received) == 1
    assert received[0].headers["Authorization"].startswith("Bearer test-agent-")
    await api.close()


def test_api_rejects_insecure_deployment_url_and_short_secret():
    with pytest.raises(ValueError):
        ConvexAPI("http://example.com", "a" * 40)
    with pytest.raises(ValueError):
        ConvexAPI("https://example.com", "short")


class Block:
    def __init__(self, value):
        self.value = value

    def model_dump(self, **kwargs):
        return self.value


class FakeStream:
    def __init__(self, *, hang=False):
        self.closed = False
        self.hang = hang
        self.text_stream = self.chunks()

    async def chunks(self):
        yield "Hello."
        if self.hang:
            await asyncio.Event().wait()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def get_final_message(self):
        return SimpleNamespace(
            content=[
                Block({"type": "thinking", "thinking": "reasoning", "signature": "signed-content"}),
                Block({"type": "text", "text": "Hello."}),
            ],
            usage=SimpleNamespace(
                input_tokens=10,
                output_tokens=3,
                cache_read_input_tokens=5,
                cache_creation_input_tokens=0,
            ),
            stop_reason="end_turn",
        )


@pytest.mark.asyncio
async def test_stream_preserves_signed_thinking_and_caching_configuration():
    stream = FakeStream()
    captured = []

    def start(**kwargs):
        captured.append(kwargs)
        return stream

    client = SimpleNamespace(messages=SimpleNamespace(stream=start))
    conversation = ClaudeConversation(client, [{"type": "text", "text": "rules"}])
    assert [chunk async for chunk in conversation.reply("hello")] == ["Hello."]
    assert stream.closed
    assert conversation.messages[-1]["content"][0]["signature"] == "signed-content"
    assert conversation.usage["cacheRead"] == 5
    assert captured[0]["thinking"] == {"type": "adaptive"}
    assert captured[0]["cache_control"] == {"type": "ephemeral"}


@pytest.mark.asyncio
async def test_barge_in_cancellation_closes_provider_stream():
    stream = FakeStream(hang=True)
    client = SimpleNamespace(messages=SimpleNamespace(stream=lambda **kwargs: stream))
    conversation = ClaudeConversation(client, [])
    started = asyncio.Event()

    async def run():
        async for chunk in conversation.reply("hello"):
            started.set()

    task = asyncio.create_task(run())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed
    assert conversation.messages[-1] == {"role": "assistant", "content": "Hello."}


@pytest.mark.asyncio
async def test_prewarm_matches_live_settings_but_uses_zero_output_tokens():
    create = AsyncMock(return_value=SimpleNamespace(usage=Block({"cache_read_input_tokens": 1})))
    conversation = ClaudeConversation(SimpleNamespace(messages=SimpleNamespace(create=create)), [])
    await conversation.prewarm()
    prewarm = create.call_args.kwargs
    live = conversation.request()
    for setting in ["model", "thinking", "output_config", "system", "cache_control"]:
        assert prewarm[setting] == live[setting]
    assert prewarm["max_tokens"] == 0


@pytest.mark.asyncio
async def test_line_lifecycle_logs_known_caller_without_speaking_internal_data():
    api = SimpleNamespace(
        log_turn=lambda payload: writes.append(payload), flush=AsyncMock(), post=AsyncMock()
    )
    writes = []
    conversation = SimpleNamespace(
        prewarm=AsyncMock(), usage={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    )
    agent = ErrandAgent(conversation, api, "call-1", {"household": {"preferredName": "Margaret"}})
    opening = [event async for event in agent.process(None, CallStarted())]
    assert isinstance(opening[0], AgentSendText)
    assert "Margaret" in opening[0].text
    assert "AI" in opening[0].text
    assert writes[0]["callId"] == "call-1"
    assert [event async for event in agent.process(None, CallEnded())] == []
    api.post.assert_awaited_once_with("/agent/call-end", {"callId": "call-1"})


@pytest.mark.asyncio
async def test_stream_error_speaks_recovery_and_writes_turns():
    async def fail(text):
        raise RuntimeError("provider unavailable")
        yield ""

    writes = []
    conversation = SimpleNamespace(
        reply=fail, usage={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    )
    api = SimpleNamespace(log_turn=writes.append)
    agent = ErrandAgent(conversation, api, "call-1", None)
    events = [
        event
        async for event in agent.process(
            None, UserTurnEnded(content=[UserTextSent(content="Hello")])
        )
    ]
    assert "trouble" in events[0].text
    assert [turn["speaker"] for turn in writes] == ["user", "assistant"]
