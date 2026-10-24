"""Live #26 check. Run explicitly with credentials; outputs usage only, never keys or text."""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from anthropic import APIStatusError, AsyncAnthropic
from dotenv import load_dotenv

from claude import ClaudeConversation
from context import system_blocks


async def main():
    load_dotenv(Path(__file__).resolve().parents[1] / "agent" / ".env")
    # Large deterministic static prefix to exceed provider minimum cache length.
    blocks = system_blocks(None)
    blocks[0]["text"] += "\n" + (
        "Speak patiently. Use short sentences. Respect caller choice.\n" * 600
    )
    async with AsyncAnthropic(max_retries=0, timeout=30) as client:
        conversation = ClaudeConversation(client, blocks)
        result = {"model": conversation.model}
        try:
            result["prewarm_usage"] = await conversation.prewarm()
            async for _ in conversation.reply("Say hello in one sentence."):
                pass
            result["first_turn_usage"] = conversation.usage
            async for _ in conversation.reply("Say goodbye in one sentence."):
                pass
            result["second_turn_usage"] = conversation.usage
            result["thinking_blocks_retained"] = any(
                isinstance(m["content"], list)
                and any(b["type"] == "thinking" for b in m["content"])
                for m in conversation.messages
            )
            # Low effort may emit no thinking. A separate high-effort request probes the path.
            if not result["thinking_blocks_retained"]:
                conversation.effort = "high"
                conversation.max_tokens = 1024
                async for _ in conversation.reply(
                    "How many integers from 1 through 1000 are divisible by exactly two of 3, 5 and 7? Explain briefly."
                ):
                    pass
                has_thinking = any(
                    isinstance(m["content"], list)
                    and any(b["type"] == "thinking" for b in m["content"])
                    for m in conversation.messages
                )
                async for _ in conversation.reply("Thanks. Say goodbye."):
                    pass
                result["thinking_blocks_retained"] = has_thinking
                result["thinking_roundtrip"] = "passed" if has_thinking else "not_observed"
            result["status"] = "complete"
        except APIStatusError as error:
            result.update(status="provider_rejected", http_status=error.status_code)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
