"""Pooled authenticated HTTP client. Background turn writes never delay speech."""

import asyncio
import logging
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 5
# /agent/order may wait on the payment rail (up to ~8s); give it room so a slow payment is not
# reported as a failure.
ORDER_TIMEOUT_S = 12
ROUTE_TIMEOUTS_S = {"/agent/order": ORDER_TIMEOUT_S}
# Polled every ~2 s during an approval hold; a slow poll is simply retried.
ORDER_STATUS_TIMEOUT_S = 3

# Convex rejects a whole turn for any key or size it does not accept (convex/calls.ts logTurn).
TIMING_KEYS = frozenset(
    {
        "speechEndAt",
        "sttFinalAt",
        "llmRequestAt",
        "llmFirstTokenAt",
        "ttsFirstAudioAt",
        "agentSpeechStartAt",
        "bargeInAt",
        "replyStoppedAt",
        "cutOff",
        "holdOffMs",
        "silenceMs",
    }
)
MAX_TURN_TOOLS = 10
MAX_TOOL_FIELD = 64


def turn_payload(payload: dict, *, refused: bool = False, tools=None) -> dict:
    """A /agent/turn body Convex will accept: known numeric timings only (None dropped), `refused`
    only when true, and at most 10 tool entries with name and result each ≤64 characters."""
    out = dict(payload)
    timings = out.get("timings") or {}
    out["timings"] = {
        k: v
        for k, v in timings.items()
        if k in TIMING_KEYS and isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    if refused:
        out["refused"] = True
    entries = []
    for tool in tools or []:
        if isinstance(tool, dict):
            name, result = tool.get("name"), tool.get("result")
        else:
            name, result = tool
        if not name:
            continue
        entry = {"name": str(name)[:MAX_TOOL_FIELD]}
        if result is not None:
            entry["result"] = str(result)[:MAX_TOOL_FIELD]
        entries.append(entry)
    if entries:
        out["tools"] = entries[:MAX_TURN_TOOLS]
    return out


class ConvexAPI:
    def __init__(self, site_url: str, secret: str, *, transport=None):
        parsed = urlparse(site_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("CONVEX_SITE_URL must use HTTPS")
        if len(secret) < 32:
            raise ValueError("AGENT_SECRET must contain at least 32 characters")
        self.client = httpx.AsyncClient(
            base_url=site_url.rstrip("/"),
            headers={"Authorization": f"Bearer {secret}"},
            timeout=DEFAULT_TIMEOUT_S,
            transport=transport,
        )
        self.pending: set[asyncio.Task] = set()

    async def post(self, route: str, payload: dict, *, timeout: float | None = None) -> dict:
        timeout = timeout if timeout is not None else ROUTE_TIMEOUTS_S.get(route, DEFAULT_TIMEOUT_S)
        response = await self.client.post(route, json=payload, timeout=timeout)
        response.raise_for_status()
        return response.json()

    async def order_status(self, call_id: str, order_id: str) -> dict:
        """#92: one poll of an order's status while the caller holds for a family decision."""
        return await self.post(
            "/agent/order-status",
            {"callId": call_id, "orderId": order_id},
            timeout=ORDER_STATUS_TIMEOUT_S,
        )

    def fire(self, route: str, payload: dict):
        """Fire-and-forget write; never awaited on the reply path. Drained by flush()."""

        async def write():
            try:
                await self.post(route, payload)
            except Exception:  # noqa: BLE001 -- background boundary; never log credential-bearing errors
                # Do not log request bodies, URLs or exception reprs containing credentials.
                log.warning("Background write to %s failed", route)

        task = asyncio.create_task(write())
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    def log_turn(self, payload: dict, *, refused: bool = False, tools=None):
        """Fire-and-forget /agent/turn. `refused` (#36) and `tools` (#80) are optional extras:
        tools is [(name, outcome)] or [{"name", "result"}], trimmed to Convex's limits."""
        self.fire("/agent/turn", turn_payload(payload, refused=refused, tools=tools))

    async def flush(self):
        if self.pending:
            await asyncio.gather(*list(self.pending), return_exceptions=True)

    async def close(self):
        await self.flush()
        await self.client.aclose()
