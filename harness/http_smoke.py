"""Gate 1 service-auth smoke check; no phone calls, payments or transcript output."""

import asyncio
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv


async def main():
    load_dotenv(Path(__file__).resolve().parents[1] / "agent" / ".env")
    site = os.environ["CONVEX_SITE_URL"]
    secret = os.environ["AGENT_SECRET"]
    phone = os.environ["DEMO_CALLER_PHONE"]
    async with httpx.AsyncClient(base_url=site, timeout=10) as client:
        for credential, expected in [(None, 401), ("wrong", 401), (secret, 200)]:
            response = await client.post(
                "/agent/household",
                json={"callerPhone": phone},
                headers={"Authorization": f"Bearer {credential}"} if credential else {},
            )
            assert response.status_code == expected, (
                f"Expected {expected}, got {response.status_code}"
            )
            if expected == 200:
                assert response.json()["context"] is not None, "Demo household was not seeded"
        response = await client.post(
            "/alert/decision", json={}, headers={"Authorization": f"Bearer {secret}"}
        )
        assert response.status_code == 401, "Alert route accepted the agent credential"
    print("PASS: household auth 401/401/200; alert credential separation")


if __name__ == "__main__":
    asyncio.run(main())
