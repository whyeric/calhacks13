"""Pooled authenticated HTTP client. Background turn writes never delay speech."""

import asyncio
import logging
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)


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
            timeout=5,
            transport=transport,
        )
        self.pending: set[asyncio.Task] = set()

    async def post(self, route: str, payload: dict) -> dict:
        response = await self.client.post(route, json=payload)
        response.raise_for_status()
        return response.json()

    def log_turn(self, payload: dict):
        async def write():
            try:
                await self.post("/agent/turn", payload)
            except Exception:  # noqa: BLE001 -- background boundary; never log credential-bearing errors
                # Do not log request bodies, URLs or exception reprs containing credentials.
                log.warning("Background turn write failed")

        task = asyncio.create_task(write())
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    async def flush(self):
        if self.pending:
            await asyncio.gather(*list(self.pending), return_exceptions=True)

    async def close(self):
        await self.flush()
        await self.client.aclose()
