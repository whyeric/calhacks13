"""Direct Anthropic streaming, preserving full content blocks including thinking."""

import os


class ClaudeConversation:
    def __init__(self, client, system: list[dict]):
        self.client = client
        self.system = system
        self.messages: list[dict] = []
        self.model = os.getenv("CLAUDE_MODEL_CONVERSATION") or "claude-haiku-5-5"
        self.effort = os.getenv("CLAUDE_EFFORT_CONVERSATION") or "low"
        self.max_tokens = 256
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}

    def request(self, max_tokens=None):
        return {
            "model": self.model,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
            "system": self.system,
            "messages": self.messages or [{"role": "user", "content": "Hello"}],
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
            "cache_control": {"type": "ephemeral"},
        }

    async def prewarm(self):
        # This is an explicit provider capability probe; do not infer support from a local mock.
        message = await self.client.messages.create(**self.request(max_tokens=0))
        return message.usage.model_dump()

    async def reply(self, text: str):
        self.messages.append({"role": "user", "content": text})
        spoken = ""
        complete = False
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        try:
            # Exiting this context on CancelledError closes the provider stream on barge-in.
            async with self.client.messages.stream(**self.request()) as stream:
                async for chunk in stream.text_stream:
                    spoken += chunk
                    yield chunk
                final = await stream.get_final_message()
            self.usage = {
                "input": final.usage.input_tokens,
                "output": final.usage.output_tokens,
                "cacheRead": final.usage.cache_read_input_tokens or 0,
                "cacheWrite": final.usage.cache_creation_input_tokens or 0,
            }
            content = [block.model_dump(exclude_none=True) for block in final.content]
            self.messages.append({"role": "assistant", "content": content})
            complete = True
            if final.stop_reason == "refusal" and not spoken:
                yield "I can't help with that request. Is there something else I can help with?"
        finally:
            # Keep interrupted history valid without copying incomplete signed thinking blocks.
            if not complete and spoken:
                self.messages.append({"role": "assistant", "content": spoken})
