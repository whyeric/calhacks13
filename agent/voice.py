"""The Cartesia voice and speaking rate used on every call (#30).

Sent to Cartesia per call through the Line SDK's pre-call config (the path Cartesia's own Line
examples use for `tts.voice`), so the live agent's dashboard settings are never changed remotely.
Settings come from the environment, with defaults chosen for older callers:

- CARTESIA_VOICE_ID: default "Michelle" (gentle, reassuring; a Cartesia stock voice). Set it
  empty to keep whatever voice the Cartesia agent is configured with.
- CARTESIA_VOICE_SPEED: 0.6 to 1.5, 1.0 is the voice's normal pace; default 0.9 (a little
  slower, still clear on a landline). Set it empty to use the voice's default speed.
"""

import logging
import os

from line.voice_agent_app import PreCallResult

log = logging.getLogger(__name__)

DEFAULT_VOICE_ID = "d7bf7d75-64b7-4c1e-86c0-79d647366587"  # Michelle: gentle and reassuring
DEFAULT_SPEED = 0.9
SPEED_RANGE = (0.6, 1.5)


def _setting(name: str, default):
    value = os.getenv(name)
    return default if value is None else value.strip()


def tts_config() -> dict:
    """The per-call TTS settings; never raises (a pre-call error would reject the call)."""
    tts: dict = {}
    voice = _setting("CARTESIA_VOICE_ID", DEFAULT_VOICE_ID)
    if voice:
        # Cartesia's examples use "voice"; the SDK's mid-call TTS config calls it "voice_id".
        tts["voice"] = tts["voice_id"] = voice
    speed = _setting("CARTESIA_VOICE_SPEED", DEFAULT_SPEED)
    if speed not in ("", None):
        try:
            tts["speed"] = round(min(max(float(speed), SPEED_RANGE[0]), SPEED_RANGE[1]), 2)
        except ValueError:
            log.warning("Ignoring CARTESIA_VOICE_SPEED that is not a number")
    return {"tts": tts} if tts else {}


async def pre_call(_request) -> PreCallResult:
    # Returning None would reject the call, so always return a result.
    return PreCallResult(config=tts_config())
