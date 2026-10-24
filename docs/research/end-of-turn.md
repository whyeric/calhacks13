# Research: end-of-turn detection for slower speakers (Cartesia)

Issue #4 · SPEC §12.6, §9.3, §12.2 (250 ms end-of-turn budget), §20 risk, §21 open question (A, Sat 09:00) · test L4.
Researched 2026-10-24 against `cartesia-line` **0.2.19** (installed in `agent/.venv`) and docs.cartesia.ai.

## Short answer

- **Semantic detection exists.** Cartesia's speech-to-text Ink-2 detects turns semantically: it weighs whether the sentence is linguistically complete and can tell hesitation from being done, not just silence. It has four tunable thresholds and a documented **"Patient"** profile. [Turn Detection docs](https://docs.cartesia.ai/use-the-api/stt/turns.md)
- **But our self-hosted Line agent has no documented way to set those thresholds.** Cartesia's harness runs speech-to-text and turn-taking. Our code only gets `UserTurnStarted` / `UserTurnEnded`. So the gap is that we **cannot directly tune** the end-of-turn threshold from code we own (details below).
- **Recommendation:** (1) ask Cartesia for the Patient profile on our agent, and try the undocumented pre-call config path; (2) add an **agent-side hold-off** for filler-word and incomplete endings, which we fully control; (3) measure the cut-off metric on every call.

## What the installed SDK actually exposes (verified in source)

Path: `agent/.venv/lib/python3.13/site-packages/line/`

| Knob | Where | What it does |
|---|---|---|
| Run / cancel event filters | `get_agent` returns `(agent, run_filter, cancel_filter)`; `voice_agent_app.py` `_prepare_agent` | Which events start a reply (`UserTurnEnded`) and which cancel it (`UserTurnStarted` = barge-in). Filters may be **callables**, not just lists |
| `AgentSendText(interruptible=False)` | `events.py` | Makes a line non-interruptible (useful for safety lines, not for turn detection) |
| `PreCallResult(config={...})` via `VoiceAgentApp(pre_call_handler=...)` | `voice_agent_app.py` L83–223 | A **free-form dict** returned to Cartesia from `/chats`. The SDK does not validate keys |
| `AgentUpdateCall` → `ConfigOutput{tts, stt{language}}` | `_harness_types.py` L152–167 | Mid-call config: voice, pronunciation dictionary, language only |

There is **no** silence threshold, voice activity detection (VAD) setting or turn-threshold field anywhere in the SDK. The harness signals turns with `user_state: speaking|idle` (`_harness_types.UserStateInput`), which the SDK maps to `UserTurnStarted` / `UserTurnEnded`.

Platform-level (verified in docs):
- The update-agent API for code agents exposes `noise_suppression_level` (0–100) and `self_hosted_deployment_url`. It has no turn fields. [Update Agent](https://docs.cartesia.ai/api-reference/agents/agents/update.md)
- Managed Agents have `config.turn` with only `inactivity_check_in_secs` (5–60, default 8) and `inactivity_end_call_secs` (20–240), plus `speculative_generation`. No end-of-turn thresholds. [Agent configuration](https://docs.cartesia.ai/agents/configuration.md). These apply to managed agents. **Assumption:** they do not apply to our self-hosted agent.

## Ink-2 turn-detection parameters (verified, raw STT API)

From [Turn Detection](https://docs.cartesia.ai/use-the-api/stt/turns.md) and [STT turns WebSocket](https://docs.cartesia.ai/api-reference/stt/turns/websocket.md). Set as query params `turn_*` on `wss://api.cartesia.ai/stt/turns/websocket`, or change them mid-session with a config command.

| Param | Default | Range | For slow speakers |
|---|---|---|---|
| `turn_start_threshold` | 0.8 | 0.5–0.9 | Keep 0.8 (barge-in responsiveness) |
| `turn_eager_end_threshold` | 0.6 | 0.3–0.8 | Lower = fewer false eager ends |
| `turn_end_threshold` | 0.3 | 0.05–0.5 | **Lower** = waits for stronger evidence; fewer mid-thought cut-offs |
| `turn_end_timeout_ms` | 5600 | 640–11200 | Upper bound when the model stays unsure |

The thresholds must stay ordered: start > eager_end > end. Documented profiles: Balanced 0.8/0.6/0.3/5600 · Responsive 0.7/0.6/0.4/4500 · **Patient 0.8/0.3/0.1/8000**. Cartesia calls Patient best for users who "pause to think" or where cutting them off is costly, which is our case.
Some third-party pages list an older default of end 0.2 and eager 0.4. Cartesia's own page says 0.3 and 0.6.

## Options, ranked

1. **Ask Cartesia (fastest, zero code).** At the Cartesia booth or support: "Can a self-hosted Line agent set Ink-2 `turn_end_threshold` / `turn_eager_end_threshold` / `turn_end_timeout_ms`, or use the Patient profile?" Record the answer on #4.
2. **Try pre-call config (unverified, ~30 min).** Add a `pre_call_handler` returning `PreCallResult(config={"stt": {"turn_end_threshold": 0.1, "turn_eager_end_threshold": 0.3, "turn_end_timeout_ms": 8000}})`. Cartesia's own demo passes `{"tts": {...}, "stt": {"languages": ["en"]}}` this way ([example](https://github.com/cartesia-ai/cartesia-enterprise-usecases-demos/blob/main/examples/06_outbound_kyc/06_outbound_kyc.py)). Whether the harness honours turn keys is **unknown**. Verify by A/B on the same recording. Owner: CORE (`agent/main.py`).
3. **Agent-side hold-off (fully in our control, recommended regardless).** On `UserTurnEnded`, if the transcript ends with a filler ("um", "uh", "er", "hmm", "so", "and", "but", "the", "my", "a") or a trailing comma or ellipsis, **wait up to 700 ms** before calling Claude. Because `UserTurnStarted` cancels the task, a resumed caller cancels the wait for free. The agent must **buffer the fragment** and prepend it to the next `UserTurnEnded`, since the SDK's `_turn_content` only collects text since the latest `UserTurnStarted`. This covers the §12.6 rule "never treat a filler word plus a pause as end of turn" even if Cartesia can't be tuned. Cost: up to +700 ms, only on suspect endings.
4. **Optional semantic check:** a cheap regex for incomplete endings is enough. Don't add an LLM call on the critical path.

**Gaps to note on the tuning issue:** (a) no documented turn thresholds for self-hosted Line agents; (b) no built-in filler-word handling we can configure, so we rely on option 3; (c) we only get `idle` from the harness, never `eager_end`, so we can't speculate on eager ends ourselves.

## Recommended starting configuration (for the Sat 09:00 baseline)

- If option 2 works or Cartesia enables it: **Patient profile** `turn_start 0.8 / eager 0.3 / end 0.1 / timeout 8000 ms`. If L1 p50 latency blows the budget, step `end` to 0.2 before touching anything else.
- Always on: agent-side hold-off, **700 ms** on filler or incomplete endings, 0 ms otherwise.
- `noise_suppression_level`: leave the default. Revisit after the venue noise check (§17.1).
- Keep barge-in as is (`UserTurnStarted` cancels).
- Expect the 250 ms end-of-turn budget (§12.2) to be **exceeded on some turns**. §12.6 says interrupting is worse than a short pause, so accept it and report it separately in the baseline.

## How to measure the cut-off metric (§12.6, test L4)

Definition: the **agent starts speaking and the caller starts talking within 1 s**. A call is a "cut-off call" if it has at least one. Target: fewer than 1 in 10 calls. Above that, lengthen the threshold or hold-off even if latency suffers.

Instrumentation (CORE owns `agent/main.py`):
- Timestamp events on receipt. Line events carry no timestamps. Use a **callable cancel filter** that records times as a side effect, e.g. `cancel_filter = lambda ev: agent.observe(ev) or isinstance(ev, UserTurnStarted)`. The SDK calls it for every event not in the run filter, including `AgentTurnStarted`.
- **Do not add `AgentTurnStarted` to the run list.** Run-list events start a new task, which cancels the reply in flight.
- `agentSpeechStartAt` = receipt time of `AgentTurnStarted` (the harness's `agent_state: speaking`), which is closer to real audio than our first `AgentSendText`. Fallback: `ttsFirstAudioAt` from §12.5.
- On `UserTurnStarted`, if `now - agentSpeechStartAt <= 1000 ms`, flag `cutOff: true` on the next logged assistant turn's `timings`, or log a `LogMetric(name="cut_off", value=1)`.
- Also log `holdOffMs` when the agent-side hold-off fires, and whether the caller resumed. This shows whether it is doing work.
- Caveat: short backchannels ("mm-hm", "okay") also count. Review flagged turns by transcript before tuning. Exclude callers who answer the agent's own question quickly.

L4 procedure: 10+ consented recordings of slow, pausing speech, including "I need, um… paper towels". Run each through the harness under (a) defaults and (b) the chosen config. Report the cut-off-call rate and p50/p95 end-of-turn time (`sttFinalAt - speechEndAt`) for both.

## Sources

- Cartesia Turn Detection: https://docs.cartesia.ai/use-the-api/stt/turns.md
- STT turns WebSocket reference: https://docs.cartesia.ai/api-reference/stt/turns/websocket.md
- Agent configuration (managed): https://docs.cartesia.ai/agents/configuration.md
- Update Agent API: https://docs.cartesia.ai/api-reference/agents/agents/update.md
- Migrate from Line SDK (self-hosted keeps working after Dec 1): https://docs.cartesia.ai/agents/migrate-from-line-sdk.md
- Pipecat `CartesiaTurnsSTTService` (same four params): https://docs.pipecat.ai/api-reference/server/services/stt/cartesia
- Installed SDK source: `agent/.venv/lib/python3.13/site-packages/line/{voice_agent_app.py,_harness_types.py,events.py}`
