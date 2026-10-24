# Latency and cost: harness and Haiku 5.5 baseline

This doc covers issues #82 (latency harness) and #84 (Haiku 5.5 latency and cost baseline). Read it with SPEC §12 and §16.

**What's measured.** We have no Twilio account and no recorded caller audio, so the harness
can't place real calls yet. `harness/scripted_calls.py` runs the real agent in-process from
`get_agent` onward: the templated opening, the cache pre-warm, `ClaudeConversation` calling
real Claude, the real tools and the real `ConvexAPI`. It feeds the agent the same Line events a
phone call produces. The numbers below therefore cover the **LLM stage only**, from the
moment the caller's turn ends (the agent receives `UserTurnEnded`) to the agent's first text
chunk, including any tool rounds. End-of-turn detection, STT, TTS, telephony and the network
to the caller are **not included**. The baseline ran from a laptop, not from the co-located
US region in §10.5.

## How to run

All commands run from `agent/`.

```bash
# Offline tests: percentile and cost math, script assertions, fake Convex. No network.
.venv/bin/python -m pytest ../harness/test_harness.py -q

# Scripted calls with real Claude (ANTHROPIC_API_KEY from agent/.env) and an in-memory fake Convex.
.venv/bin/python ../harness/scripted_calls.py                    # every script in harness/scripts/
.venv/bin/python ../harness/scripted_calls.py call1 -v           # one script, with transcript
.venv/bin/python ../harness/scripted_calls.py call1 l1_latency --save   # baseline -> docs/latency-baseline.json

# Against the real Convex deployment. This writes calls, turns and orders there.
# Needs CONVEX_SITE_URL, AGENT_SECRET and DEMO_CALLER_PHONE.
.venv/bin/python ../harness/scripted_calls.py call1 --live-convex

# Real phone calls: per-stage percentiles from the turns table (see "Real calls" below).
.venv/bin/python ../harness/latency_report.py --limit 20
.venv/bin/python ../harness/latency_report.py --from-json exported_calls.json
```

`scripted_calls.py` exits with a non-zero code if any script assertion fails. The options are:

- `--first-delay` (default 3 s): the pause between the greeting and the caller's first line. It stands in for the greeting audio plus the caller's reply, so the parallel pre-warm can finish as it would on a real call.
- `--reply-delay` (default 1 s): the pause before each later caller line.
- `--repeat N`: run the selected scripts N times.

### Scripts (`harness/scripts/*.json`)

| Script | Covers | Pass conditions checked |
|---|---|---|
| `call1` | §16.1 Call 1 / T1 | Order `paid` with total 2145 and items {6-roll towels ×1, `demo-coffee-big` ×1}. `place_order` runs only on a "yes" after a read-back question. Follow-up marked asked exactly once. $8.97 and $21.45 are spoken. Outcome `ordered`. |
| `t2_ambiguous_coffee` | T2 | "Coffee" makes the agent ask which one (decaf, or the usual big can) with no order that turn. The decaf is then ordered and paid at 1048. |
| `t3_over_cap` | T3, first half | 4 × 24-roll toilet paper ($95.88) ends as `needs_approval`, nothing is paid, and approval or the limit is mentioned. Outcome `awaiting_approval`. |
| `t4_unknown_caller` | T4 | No order reaches the order service. The agent explains it doesn't recognize the number. Kind and outcome are `unknown_caller`. |
| `l1_latency` | L1, text-mode stand-in | 10 calls × 5 caller turns = 50 turns of chit-chat and small orders. Assertions are lenient: no order without a confirmed read-back, and the expected number of follow-ups asked. |

A script is `{name, caller: "margaret"|"unknown", household: {followup, limits, monthSpentCents, recentOrders}, turns, expect}`, or a suite `{name, calls: [...]}`. A turn is
`{say, alts: [{ifAgent: regex, say}], skipIfAgent: regex, expect}`. `alts` and `skipIfAgent`
let a fixed script follow a model that combines or reorders questions. For example, Call 1's
"The small one." is skipped when the agent has already read back the $21.45 total. Every speech
check is a case-insensitive regex, and `|` separates alternatives. The available expectations are:

- Per turn: `speechIncludes` / `speechExcludes` and `toolsCalled` / `toolsNotCalled`.
- Per call: `finalOrder {status, totalCents, items}`, `noPaidOrder`, `noOrders`, `placeOrderOnlyAfterYes`, `followupsAsked` (fake Convex only), `outcome` and `kind`.

The fake Convex is `FakeConvex` in `scripted_calls.py`. It serves the context from
`fixtures/household.json`, where Lily's recital follow-up is on by default. Prices come from the
catalog in `fixtures/walmart/search.json`, and the price the agent sends is ignored. An unknown
item returns 400 "Unknown item". It applies the per-order cap, monthly budget and approved-store
limits, returns `paid` (mock payment) or `needs_approval` with a spoken-friendly reason, and is
idempotent per `idempotencyKey`.

## Baseline: claude-haiku-5-5, effort `low` (2026-10-24, fake Convex)

The run was `call1` plus `l1_latency`: 11 calls and 56 caller turns, of which 44 were conversational and 12 used tools. All 11 calls passed their assertions.
Raw data, with per-turn timings, usage and transcripts, is in `docs/latency-baseline.json`.

### LLM stage (turn end → first text chunk)

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| All turns: first chunk (the L1 analogue) | 56 | 767 ms | 2,111 ms | 6,311 ms |
| Conversational turns: first chunk | 44 | 773 ms | 1,748 ms | 6,311 ms |
| Tool turns: first chunk (the "Let me check." filler, sent when the model starts a `tool_use`) | 12 | 761 ms | 2,323 ms | 3,125 ms |
| Tool turns: first text after the tool result | 12 | 1,964 ms | 3,658 ms | 3,760 ms |
| Request → first token (TTFT of the turn's first request) | 56 | 767 ms | 2,111 ms | 6,311 ms |
| Turn total (last chunk) | 56 | 1,077 ms | 3,562 ms | 6,551 ms |
| Tool execution (cached search, favorites, mock order) | 12 | 0.3 ms | 1.1 ms | 1.3 ms |

Request → first token is almost identical to "all turns". The agent adds at most 3 ms
between `UserTurnEnded` and the Claude request, so nearly all of the stage is Claude time to
first token. Tool execution is negligible because search is served from cached fixtures.

### Against the targets

The projected rows add the unmeasured §12.2 non-LLM budget of 500 ms: end-of-turn detection
250 ms, STT 100 ms, TTS 100 ms and network 50 ms. They are estimates, not measurements.

| Target (SPEC) | Measured / projected | Target | Result |
|---|---|---|---|
| Claude time to first token, p50 (§12.2 budget) | 773 ms (conversational) | 300 ms | **MISS (2.6×)** |
| Voice-to-voice p50 (§12.1, L1), projected | 1,267 ms | 800 ms | MISS (1.6×) |
| Voice-to-voice p95 (§12.1, L1), projected | 2,611 ms | 1,500 ms | MISS (1.7×) |
| Tool turn → filler starts, p50 / p95, projected | 1,261 / 2,823 ms | 800 / 1,500 ms | MISS / MISS |
| Tool turn → result spoken, p50 / p95, projected | 2,464 / 4,158 ms | 2,500 / 4,000 ms | PASS / MISS (1.04×) |
| First-turn cache hit (L2) | 100% (11/11 calls) | ≥ 95% | PASS |
| Claude cost per call | mean $0.0008, max $0.0014 | ≤ $0.05 | PASS |

**Largest budget miss: Claude time to first token.** The p50 is 773 ms against a 300 ms
budget. This miss alone takes the projected p50 over the 800 ms voice-to-voice target. Some
details from the run:

- **Fastest conversational turn: 497 ms.** That was with a warm cache: about 6.3K cached tokens, about 4 uncached input tokens and roughly 30 output tokens. Even the best case is above 300 ms from this laptop, so part of the gap may be network distance from Claude. Re-measure from the deployed region before concluding anything.
- **Slow turns.** The 7 turns over 1.5 s split into two groups:
  - 4 turns spent 180–300 output tokens, most of it adaptive thinking, before the first text or tool call. Examples are the first ordering turn and "Do you remember what coffee I like?".
  - 3 turns had little output (41–50 tokens) but still took 1.8–6.3 s. That looks like API-side tail latency.
- **Earlier run (agent code from before the latest changes, not saved).** One request hit the 20 s client timeout (`max_retries=0`), and the caller heard the templated error line after 20 s. In the same session, one tool turn took 29 s to its first text after the tool. These tails dominate p95 and max whenever they happen.

**Cache.** Every call's first model request read the cache (about 6.3K tokens). Later requests read 6.3K–7.6K tokens as the history grows.
The pre-warm finished before the first caller turn in every call. One pre-warm took 2.6 s,
which the 3 s greeting delay covered. Each turn writes only the conversation tail: 50–500
tokens, at the 5-minute rate.

**Cost.** List prices for claude-haiku-5-5, from the pricing page fetched 2026-10-24, which
matches SPEC §12.4:

| Prompt size | Input | Output | 5-minute cache write | 1-hour cache write | Cache read |
|---|---|---|---|---|---|
| Up to 100K tokens | $0.10/M | $0.50/M | $0.125/M | $0.20/M | $0.01/M |
| Over 100K tokens | $0.50/M | $2.50/M | $0.625/M | $1.00/M | $0.05/M |

These short scripted calls (5–6 caller turns) cost $0.0005–$0.0014 each, pre-warm included,
and the whole 11-call run cost $0.009. That is far under both the $0.05 target and the SPEC's
~$0.02–0.03 estimate. A 10-minute companion call (C4) will grow linearly with turns, because
each turn re-reads the cached prefix of about 6.5K tokens plus the history.

### Script results (current agent code)

| Script | Result | Notes |
|---|---|---|
| `call1` | PASS | Paid 2145, items 6-roll towels + `demo-coffee-big`, follow-up asked once. The agent confirmed the coffee first, then searched towels, as in §16.1. |
| `l1_latency` (10 calls) | PASS | Five small paid orders, all after a read-back and a yes. |
| `t2_ambiguous_coffee` | PASS | "Would you like your usual medium-roast coffee, the big can, or the decaf medium-roast?" |
| `t4_unknown_caller` | PASS | Polite explanation, no order, `unknown_caller`. |
| `t3_over_cap` | PASS only because the caller insists | See below. |

**T3 finding (prompt).** In 3 of 3 runs, asking for four 24-roll packs ($95.88) did not
produce an order for approval. The agent applied the $50 cap itself, said "I can't place it",
and offered two packs instead. When the scripted caller refused that and insisted ("No, I
really do need four… Dana can okay it"), the agent read the order back. After the caller said
yes, it placed the order, which came back `needs_approval`, and the agent spoke the templated
approval line correctly. The script now includes that insistence, so it passes. Without the
insistence, the result is `no_order` instead of `awaiting_approval`. SPEC T3/F5 expects the over-cap
order to go to approval. The cause is in the prompt, not in the tools or the harness:
`06_memory.txt` and the memory block's limits line give the model the cap, and nothing tells it
to place over-limit orders anyway and let the ordering system route them to family approval.

## Thinking on vs off, and the order confirmation (2026-10-24)

**Decision: keep adaptive thinking (effort `low`) as the default for conversation turns.**
`CLAUDE_THINKING_CONVERSATION=disabled` still works, but use it only for experiments. Thinking
off makes the slow tail shorter, but it does not change the median, and it breaks order
correctness. The time-to-first-word fix for orders is the templated confirmation described
below, not turning thinking off.

**Why the earlier thinking-off run looked broken.** It was not a problem with how the request
is built. A direct probe of `claude-haiku-5-5` with `thinking: {type: "disabled"}`, effort
`low`, `cache_control` and a history that replays signed thinking blocks from adaptive turns
returned 200 every time, and so did the prewarm request with `max_tokens: 0`. Three full
thinking-off runs had no request errors in about 600 turns: two sequential runs and one run in
parallel with a thinking-on run, so rate limits and overload were also ruled out. The harness
hid errors, though:

- The SDK sends the streaming request inside `messages.stream().__aenter__`. A 4xx, 429 or 529 response, or a timeout before the headers, therefore raised there.
- `_TimedStreamManager` only recorded errors in `__aexit__`, which never runs when `__aenter__` raises.
- `main.py` caught the exception and spoke `ERROR_LINE`, logging only "Conversation request failed".
- The result was a turn that looked fast and free, with no error recorded. It cost $0, and its "first chunk" time was however long the failure took to arrive.

A failed API request takes about 200 ms from this laptop (a 404 probe measured 190–220 ms).
The ~10 ms failures therefore never reached the network: something in the agent raised before
the request. Most likely the shared working tree was mid-edit at the time. That can't be
checked any more. The 20 s cases are the client timeout (`max_retries=0`, `timeout=20`), which
was also seen with thinking on (see above). These now fail loudly:

- `harness/scripted_calls.py` records errors raised when the stream opens, with class, status and API message.
- A recorded request error, or the spoken error line, fails the turn.
- `claude.py` logs `Claude request failed: <class> <status> request_id=… <message>`.
- An unknown `CLAUDE_THINKING_CONVERSATION` value (for example `off`) falls back to `adaptive` instead of sending an invalid thinking type.

**Measurements.** All runs used the fake Convex and the LLM stage only. "First chunk" is turn
end to the first text sent to TTS.

| Run (same code, run back to back) | Calls passed | All turns: first chunk p50 / p95 | Conversational p50 / p95 | Tool result text p50 / p95 |
|---|---|---|---|---|
| Full suite ×2, adaptive (28 calls, 130 turns) | 28/28 | 670 / 1,546 ms | 676 / 1,513 ms | 1,796 / 2,778 ms |
| Full suite ×2, disabled, earlier code (28 calls, 130 turns) | 26/28 (`t2` 0/2) | 638 / 1,069 ms | 642 / 1,108 ms | 1,662 / 2,385 ms |
| `t2`/`t3`/`t4` ×5, adaptive | 14/15 (`t2` 4/5) | 668 / 1,728 ms | 736 / 1,713 ms | 1,323 / 2,511 ms |
| `t2`/`t3`/`t4` ×5, disabled | 10/15 (`t2` 0/5) | 630 / 1,001 ms | 630 / 1,012 ms | 1,341 / 2,369 ms |
| `call1 call2 t2 t3 s3 s5` ×3, adaptive | 16/18 | 836 / 2,402 ms | 904 / 2,680 ms | 1,753 / 3,981 ms |
| `call1 call2 t2 t3 s3 s5` ×3, disabled | 16/18 | 632 / 1,268 ms | 600 / 973 ms | 1,367 / 3,604 ms |

Two more runs had other agents' code changing between them, so they are left out of the table.
On the 40 scripts both runs had (80 calls, about 305 turns), adaptive passed 63/80 with a p50
of 699 ms and p95 of 1,481 ms. Disabled passed 51/80 with a p50 of 606 ms and p95 of 1,151 ms.
Neither had any request errors. Cost is about $0.0007–0.0008 per call either way.

What the numbers say:

- **The median barely moves.** Thinking off saves 30–200 ms at p50. Most turns spend under 60 output tokens, so there is little thinking to remove.
- **The tail does move.** Thinking off cuts conversational p95 by roughly 0.4–1.7 s. The slow turns are the ones where adaptive thinking spends 180–300 tokens.
- **Correctness gets worse with thinking off, on money-relevant checks:**
  - T2 (an ambiguous favorite has to be asked about) failed 7 of 8 runs.
  - One `t2` run placed the order after "is that right?" without a full read-back.
  - In one `t3` run the model shrank an over-cap order to two packs, against rule 9. It also spoke a garbled total ("eighty-八 cents").
  - With adaptive thinking, T2 failed 1 of 8 runs. The remaining adaptive failures came from the new scam-check question and happened in both modes.
- The real-call replies that took 3–7 s include STT, TTS and the network on top of this stage. From here, the LLM stage rarely exceeds 3 s with either setting.

**Order confirmation (d): "yes" → spoken outcome.** Changes:

- `claude.py` speaks "Placing that now." as soon as the model starts a `place_order` call.
- `tools/order.py` `confirmation_line()` builds the outcome line from the result:
  - **paid:** "Done. Your order is placed and paid, twenty-one dollars and forty-five cents in all, and Dana can see it too. Anything else?"
  - **needs_approval:** the reason, then that Dana was asked and nothing has been charged.
  - **blocked:** "I couldn't place that order." plus the reason.
- For paid and needs_approval the line is spoken as soon as the result arrives. It is recorded as the assistant's reply (after the `tool_result`), and no second model request is made.
- For blocked the line is spoken at once. The model then continues with the scam guidance, and its `tool_result` carries `alreadySaid`, so it doesn't repeat the line.
- When `place_order` shares a round with another tool, or the result is anything else, the model words the outcome as before.

Measured on the order turns of the `t2`/`t3` runs:

| | Before (model words the result) | After (templated) |
|---|---|---|
| Time to the outcome being spoken, p50 / p95 | 1.60 / 1.97 s | 0.89 / 1.81 s |
| Model requests on the turn | 2 | 1 |

The saving is a whole model round trip. On the real call that is the reported 7 s gap: the
second request's thinking plus TTFT, after a real `/agent/order`.

**Approval hold (#92).** On `needs_approval` the agent stays on the line, following
[decisions/approval-wait.md](decisions/approval-wait.md):

1. It says the reason and "I'll stay on the line while I wait".
2. It polls `/agent/order-status` (`ConvexAPI.order_status`) every 2 s, for up to `APPROVAL_HOLD_S` (90 s by default; `0` turns the hold off).
3. Every 20 s it says a reassurance line.
4. When the decision arrives, it says the templated paid, approved, declined, failed, expired or timeout line, all in the same turn.

The lines grow one assistant reply in the history. The next request carries a system note
saying that the hold really happened. Without that note the model told the caller "I can't wait
on the line", 3 of 3 times. With it, 0 of 3.

A barge-in or hang-up behaves differently:

- **Barge-in:** stops the spoken hold, but polling continues, and the decision reaches the model as a `<tool_update>` note on the next turn.
- **Hang-up:** `drain()` cancels the polling at once.

With the fake Convex, `scripted_calls.py` uses a 5 s hold (`--hold-seconds`). The fake only
decides orders between turns.

## Real calls: `harness/latency_report.py`

This script computes per-stage p50/p95, the first-turn cache hit rate and the cost per call
from the `turns` table. It reads calls one of two ways:

- `npx convex run calls:latencyExport '{"limit":20}'` against the dev deployment. This is read-only.
- `--from-json` with an exported file.

The internal query `calls:latencyExport` in `dashboard/convex/calls.ts` provides this data:

```ts
// Read-only export for harness/latency_report.py. No transcript text, no phone numbers.
export const latencyExport = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const calls = await ctx.db.query("calls").withIndex("by_startedAt").order("desc")
      .take(Math.min(limit ?? 20, 100));
    return Promise.all(calls.map(async (call) => ({
      callId: call._id, startedAt: call.startedAt, kind: call.kind, outcome: call.outcome,
      turns: (await ctx.db.query("turns").withIndex("by_call_idx", (q) => q.eq("callId", call._id))
        .take(500)).map(({ idx, speaker, at, timings, usage }) => ({ idx, speaker, at, timings, usage })),
    })));
  },
});
```

The report covers the following stages. Each is listed only when both of its timestamps are
logged.

- speechEnd→sttFinal
- sttFinal→llmRequest
- llmRequest→llmFirstToken
- sttFinal→llmFirstToken
- llmFirstToken→ttsFirstAudio
- voice-to-voice (speechEnd→ttsFirstAudio)

Three limits of the current turn log:

- **Missing timestamps.** The agent logs only `sttFinalAt` (when it receives `UserTurnEnded`), `llmRequestAt` and `llmFirstTokenAt`. It does not log `speechEndAt` or `ttsFirstAudioAt` yet, so real-call voice-to-voice can't be computed. Those need Line/Cartesia timestamps if the platform exposes them (§21).
- **Cost.** Usage is summed per turn and cache writes aren't split by TTL. Writes are priced at the 5-minute rate by default (`--write-ttl 1h` to change), and pre-warm requests aren't logged, so real-call cost reads slightly low.
- **L3 and L4.** The report now counts cut-off calls (#35): calls with a caller turn logged with `timings.cutOff = 1`, meaning the caller started within 1 s of the agent starting to speak. It shows them against the §3.3 target of fewer than 1 call in 10, plus the number of turns where `holdOffMs` fired. `calls:latencyExport` already passes the whole `timings` object through. Barge-in stop time (L3) is still not reported.

## Recommended next steps (per #84, without deciding any model or effort escalation)

The model and effort escalation decision belongs to the Sat 18:00 check (§12.4).

1. **Measure from the deployed region.** Run `scripted_calls.py l1_latency` from the Fly machine, or a US VM next to it. That separates network distance from model time to first token before any prompt work.
2. **T3 prompt gap: fixed.** `03_tools.txt` rule 9 says limits are enforced by `place_order`. A strict T3 variant, where the caller never insists, passed 5/5 after the fix and failed 3/3 before.
3. **Cut thinking on the ordering turns.** (Measured since: turning thinking off fails order checks; see "Thinking on vs off" above. The tool filler and the templated order confirmation are done.) The slowest turns spend 180–300 output tokens before the first word. Options inside the current model and effort:
   - Tighten the tool instructions so the model calls `match_favorite`/`search_items` straight away.
   - Speak the filler as soon as a caller turn looks like an errand, instead of waiting for the `tool_use` block, which on its own costs a p50 of 761 ms and a p95 of 2.3 s.
4. **Handle tail stalls.** One 20 s timeout and one 29 s tool turn were seen in a short session.
   - Consider a shorter first-token deadline (for example 3–4 s) that speaks a holding line and retries once, rather than a single 20 s timeout with `max_retries=0`.
   - Log the request ID on slow turns to investigate.
5. **Log the missing timestamps.** Add `speechEndAt` and `ttsFirstAudioAt` to the turn log as soon as Line exposes them.
6. **Keep the memory cap and caching as they are.** First-turn cache hits are 100%, and cost is about 40× under budget, so there's no cost reason to lower the memory cap now.
