# Turn-taking, silence and voice (#9, #15, #30, #35, #4)

Code: `agent/main.py` (`ErrandAgent.should_run` / `should_cancel` / `observe`, `_caller_turn`, `silence`) and `agent/voice.py`. Tests: `harness/test_agent.py`. None of this has been checked on a real phone call yet.

## Barge-in (#9)
- Line's cancel filter is `ErrandAgent.should_cancel`. When the caller starts speaking, it cancels the reply task. This closes the Claude stream, and the unspoken rest of the reply is never sent. Line's harness stops TTS playback for interruptible text.
- The next caller turn gets an `<interrupted>` note quoting what the caller actually heard (from Line's `AgentTextSent` history).
- Echo guard: while a reply is waiting on a tool, the filler line ("Let me check." / "Placing that now.") is sent as non-interruptible, and a barge-in is held back, not cancelled. Nothing more is spoken until the caller's words arrive.
  - If those words are only the agent's own voice, the reply carries on.
  - If they are real speech, the new turn starts and cancels the reply. Tool calls are shielded, so an order is never abandoned halfway.
- Logged timings:
  - `bargeInAt` on the caller turn
  - `replyStoppedAt` on the cut-off assistant turn. This is when the agent cancelled; the time the audio actually stopped is harness-side and not visible to us.

## Silence (#15)
- The timer starts when Line reports the agent stopped talking (`AgentTurnEnded`), and only if no reply is running and the caller isn't talking. If the caller starts talking, the timer is cancelled.
- After any agent turn (not only after a question):
  - 6 s of silence: "Take your time."
  - 8 s more: "I'll be right here whenever you need me. You can call back any time."
  - 8 s more: the call ends with no further words.
- The waits are set by `SILENCE_STEPS_MS` (default `6000,8000,8000`).
- The lines are templated, so there is no model call. They are logged as assistant turns with `silenceMs`.
- When the caller speaks again, the count resets, and the model receives a `<silence>` note saying what was said.
- **Depends on Line sending `agent_state` (AgentTurnStarted/Ended).** If the harness doesn't send it, no silence prompts happen. This is unverified.

## End-of-turn and the cut-off metric (#4, #35)
- Hold-off: if a caller turn ends on a filler or an unfinished phrase ("um", "and", "the", a comma, an ellipsis…), the agent waits `END_OF_TURN_HOLDOFF_MS` (default 700) before answering. If the caller goes on, the two parts become one turn.
  - `holdOffMs` is logged on that caller turn.
  - Complete sentences are answered immediately.
- Cut-off: when the caller starts talking within 1 s of the agent starting to speak, the caller turn is logged with `cutOff: 1` and `agentSpeechStartAt`.
  - The start time comes from Line's `AgentTurnStarted`; if that is missing, the time of the reply's first text is used instead.
  - Echo turns are never logged, so they don't count.
  - The per-call rate (target: fewer than 1 in 10 calls) is computed by the latency report.
- Cartesia's Ink-2 turn thresholds (Patient profile) still can't be set from a self-hosted agent; see `research/end-of-turn.md`.

## Voice (#30)
- `agent/voice.py` returns the TTS settings in Line's pre-call config on every call, so the live Cartesia agent's own settings are never changed.
  - `CARTESIA_VOICE_ID`: default **Michelle** `d7bf7d75-64b7-4c1e-86c0-79d647366587`, a Cartesia stock voice described as "gentle and reassuring". It was picked from the read-only voice list; it has not been auditioned with older listeners yet.
  - `CARTESIA_VOICE_SPEED`: default **0.9** (range 0.6–1.5, 1.0 = normal).
  - Set either variable to an empty value to fall back to the agent's own configured setting.
- The voice is sent the way Cartesia's own Line examples do it (`tts.voice`). Whether the harness honours `tts.speed` in the pre-call config is **unverified**: check on a call, and if it is ignored, set the speed on the Cartesia agent by hand.
