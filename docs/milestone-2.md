# Milestone 2: Phase 1 · Core loop

- **Branch:** `codex/milestone-1-foundations`, with an uncommitted working tree on top of `9d6a4b1`.
- **Scope:** [GitHub milestone 2](https://github.com/whyeric/calhacks13/milestone/2). Text messaging was removed from scope and is not built.
- **Audited:** October 24, 2026, Pacific time, criterion by criterion against the code.

The money path, the dashboard, the prompt and the tool wiring are complete and tested. Two groups of work are left:

- **Agent-side gaps.** These are listed below.
- **Things only people or credentials can do.** A real phone call (Gate 2), a 20-call latency run, Apify, Visa, sponsor answers and team sign-off.

Gate 2 follows the step-by-step [Gate 2 runbook](gate-2-runbook.md).

## Status by issue

**Status key**

- **Ready**: every criterion has evidence. Close now, or after the Gate 2 row named.
- **Gate 2**: code and tests are done. Close when the named Gate 2 row passes on a phone.
- **Gap**: code is missing. The owner is named.
- **External**: needs a person, credentials or a decision.

| Issue | Status | Evidence | Remaining |
|---|---|---|---|
| #4 End-of-turn spike | External + gap | [research/end-of-turn.md](research/end-of-turn.md) lists the options, says whether semantic detection exists, recommends a profile and names gaps | No trial on slow-speech recordings. The 700 ms agent-side hold-off it recommends is not in `agent/main.py`. §21 is not ticked |
| #7 Sponsor fit | External | [research/sponsor-fit.md](research/sponsor-fit.md) has a recommendation per prize | Questions to the sponsor reps; update the §18 prize map |
| #8 search_items | External | `agent/tools/search.py`; tests `test_live_search_maps_results_to_two_options` and `test_live_search_failure_falls_back_to_cache` | `APIFY_TOKEN` and `APIFY_WALMART_ACTOR`, then one live run. Minor: a one-item live result is not topped up to two |
| #12 Search fixtures | **Ready** | `fixtures/walmart/search.json` (897, 1548 and 1248 cents); `test_fixture_catalog_supports_call_one_total`; `test_search_mode_fixtures_never_calls_network` | — |
| #19 Favorites | **Ready** | `agent/tools/favorites.py`; `test_personal_alias_matches_the_big_can`; `test_similar_favorites_are_ambiguous_never_guessed`; script `t2` | — |
| #23 place_order | **Ready** (Gate 2.1, 2.4) | `convex/payments.ts` and `orders.reserve`/`settle`. Tests T1, S1, Gate 2.4, the double-pay crash and in-flight retries (`core_loop.test.ts`) | — |
| #29 Limits | **Ready** (Gate 2.2, 2.3) | Tests T3, T5 (store and month) and LIM-3. The reason text is spoken and goes into the approval alert | — |
| #31 Haiku 5.5 client | **Ready** | `agent/claude.py` reads `CLAUDE_MODEL_*`/`CLAUDE_EFFORT_*`; adaptive thinking; no sampling parameters. Test `test_text_turn_streams_preserves_signed_thinking_and_request_shape` | `max_tokens` defaults to 2048 rather than about 1024, which is more headroom |
| #34 Order records | **Ready** (Gate 2.1) | `canTransition`; APR-3 test; integer cents | — |
| #36 Refusal handling | Gap (agent) | Templated line and harm-specific safety line; `test_refusal_speaks_templated_recovery_and_keeps_history_valid` | The refusal is not marked in `turns`. Convex now accepts `refused: true` on `/agent/turn`, and the dashboard shows it; the agent must send it. No W1/W2 refusal scripts |
| #39 Visa rail | External | `convex/visaRail.ts`; [visa.md](visa.md); test "PAYMENT_RAIL=visa without sandbox credentials fails without paying" | Sandbox access and credentials (#2); never run live |
| #41 System prompt | **Ready** | `agent/prompts/system/01–06`; `test_static_prompt_has_sections_in_order_and_no_per_call_data` | — |
| #44 Fallback rail | **Ready** | Mock rail behind `PAYMENT_RAIL`; limits stay in `reserve`; tests T1, payment failure, unknown rail | — |
| #46 Household lookup | Gate 2 (smoke call) | Lookup runs before the agent is built (`agent/main.py`); `startCall`; test "caller lookup creates one call on retries" | Caller ID has not yet arrived on a real phone (runbook step 3) |
| #49 Recent orders | **Ready** | `recentOrders` (10 newest, 90 days). New `spendSummary` and `outOfPattern` in `convex/orders.ts`, returned by `/agent/household`. Test "#49: spendSummary digests paid orders; a first-ever $400 order is out of pattern" | Agent follow-up: render `spendSummary` in the memory block and the scam digest |
| #51 Unknown caller | Gap (agent) | Templated greeting, no memory, `unknown_caller` kind and outcome; script `t4` | `search_items` still runs; only ordering is refused. The call is not ended gently: no `AgentEndCall`, and the model keeps chatting |
| #52 Memory rules | **Ready** (Gate 2.1 for M1) | `06_memory.txt` sits after wellbeing and before memory block B | M6 ("gift cards allowed") has no automated check, though the hard rule in `reserve` blocks it anyway |
| #57 Greeting / follow-up | Gate 2.1 | Opener injected as an assistant turn; `/agent/followup`; `test_known_caller_greeting_asks_followup_once_without_llm_request` | Only the `max_tokens: 0` pre-warm request runs before the caller replies |
| #62 Context builder | Gap (agent) | Deterministic block; 60K cap; `<call_context>`; byte-identity tests | Call summaries and recent transcripts are not rendered. The cap uses a length/3 estimate. No M2 test |
| #68 Prompt caching | **Ready** | Breakpoints A (1h) and B (5m) plus the automatic tail; TTL and prefix tests; [claude-spike.json](claude-spike.json) shows cache reads | — |
| #72 Pre-warm | External | `prewarm_request`; config-match test; L2 passed 11 of 11 in text mode | L2 needs 20 calls (criterion) and a run on a 60K block |
| #75 Streaming | Gate 2 / External | Clause streaming; thinking skipped; barge-in tests | Barge-in and timing on a real phone |
| #77 Ordering flow | Gate 2.1, 2.5 | `03_tools.txt`; harness `placeOrderOnlyAfterYes`; script `call1` paid 2145 cents | — |
| #78 Tool wiring | **Ready** | Six fixed tools; `test_tool_list_is_fixed_ordered_and_byte_identical_across_imports`; `test_dispatch_never_raises`; Phase 2 stubs | — |
| #80 log_turn | Gap (agent) | Fire-and-forget `/agent/turn`; usage includes cache read and write | Only 3 of 5 timing marks are logged; `speechEndAt` and `ttsFirstAudioAt` are missing. Tool calls are not logged: Convex now accepts `tools: [{name, result}]` per turn and the dashboard shows them. No scam result is attached (the classifier is a separate issue) |
| #82 Latency harness | Partly / external | `scripted_calls.py`; `latency_report.py`; L1 has 56 turns | Real calls need Twilio or a phone. L3 barge-in stop time and L4 cut-offs are not reported. L2 has 11 calls, not 20 |
| #84 Latency baseline | Partly / external | [latency.md](latency.md): table against targets, largest miss named, next steps | Voice-to-voice is projected only; it needs real calls with the #80 timing marks |
| #86 Dashboard scaffold | **Ready** | Next.js 16 + Convex; all 7 routes build; access-key gate; tests `dashboard.test.ts` | Not deployed to Vercel, which no criterion requires (see the runbook) |
| #87 Live calls screen | **Ready** (Gate 2.1) for transcript and latency | `/live`: transcript, per-turn latency, scam panel, recent calls, sharing rules and redaction tests | "Scam score per caller turn during Call 2" needs the scam classifier, which no agent code writes yet |
| #88 Orders screen | **Ready** (Gate 2.1, 2.2) | `/orders`: items, cents formatted with integer maths, status badges, approver, monthly spend | Approve and decline go through `npx convex run orders:approve`. The Approvals buttons are Phase 2, so `/approvals` is a placeholder |
| #89 Approval wait | External | [Decision proposal](decisions/approval-wait.md) | Team sign-off before Sat 12:00 |
| #122 Gate 2 | External | [Runbook](gate-2-runbook.md) | Independent reviewer on real phones |

### Changes in this pass (dashboard and docs)

- **#49:** `spendSummary` (paid count, typical and largest order, stores) plus `outOfPattern`, returned in the household context.
- **Gate 2.3 and LIM-3:** an internal mutation `households:setLimits` lets the CLI change limits.
- **#36 and #80:** `turns` accepts optional `refused` and `tools` fields. The Live calls screen shows them as badges.
- **Runbook:** [gate-2-runbook.md](gate-2-runbook.md), which also covers Vercel, Clerk, Apify and Visa.

These changes must be pushed with `npx convex dev --once` before Gate 2.

## Verification evidence

- **Convex tests:** 64 pass (`convex-test`, real schema). They cover:
  - idempotent retry and double-pay protection
  - limits, `setLimits` and the hard scam rule
  - ended-call rejection
  - payment failure creating an alert
  - outcome never downgraded at call end
  - dashboard access-key auth
  - turn `refused`/`tools` validation
  - spend summary determinism
- **Dashboard checks:** TypeScript typecheck, `next build` and Prettier all pass. The project has no ESLint configuration; Next 16 removed `next lint`.
- **Python:** tests run from `agent/` (they cover agent, tools and harness). At this audit, 100 of 101 passed. The one failure, `test_is_echo_matches_whole_recent_sentences_but_never_plain_answers`, is in turn-taking work that was still in progress. Ruff is clean.
- **Earlier live development smoke against the cloud deployment:**
  - Call 1 paid 2145 cents.
  - A retry returned the same order.
  - An over-cap order returned `needs_approval`.
  - A gift card was `blocked`.
  - Dashboard queries returned the data, and a wrong key was rejected.
- **Latency baseline:** measures only the LLM stage, against a fake Convex.

No real phone call, Apify search, Visa payment, Clerk sign-in or deployed dashboard is claimed.

## Running it

```sh
cd dashboard && npm install && npm run dev          # Next.js; push Convex with: npx convex dev --once
open "http://localhost:3000/live#key=$DASHBOARD_ACCESS_KEY"
caffeinate -i agent/.venv/bin/python harness/local_demo.py   # phone demo via HTTPS tunnel
```
