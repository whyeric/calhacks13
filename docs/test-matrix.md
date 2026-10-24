# Test matrix results (#33) and the model escalation check (#28)

**Date:** Oct 24, 2026. **Build:** branch `codex/milestone-1-foundations`, uncommitted working tree.
**Models:** every role on Claude Haiku 5.5 (`claude-haiku-5-5`). The conversation runs at effort `low` with adaptive thinking; the scam classifier and memory writer run at the default `medium`.

**How it was run** (from `agent/`):

```bash
.venv/bin/python ../harness/scripted_calls.py --report <out>.json --save <out>-full.json   # every script, fake Convex
.venv/bin/python ../harness/scripted_calls.py call1 call2 t3_approve t3_decline m4_no_invented_memory m5_scam_claims_incident --live-convex --hold-seconds 15
```

What these runs measure:
- **The harness runs the real agent in-process**, not real phone calls (see `docs/latency.md`). Latency figures cover the LLM stage only, with a 500 ms budget added for everything else.
- **Fake-Convex mode** uses `harness/scripted_calls.py`'s `FakeConvex`. It checks speech, tools and the order service, but not Convex state.
- **Live mode** runs against the dev deployment and also checks Convex state.
- **The approval hold** in fake mode lasts 5 s, because fake orders are only decided by script actions.

## Results: fake Convex, full matrix

56 of 57 calls passed. The 57 calls made 213 caller turns: 147 conversational and 66 tool turns. Claude cost was $0.069 for the whole run, $0.0012 per call on average and $0.0055 at most.

| ID | Result | Notes |
|---|---|---|
| T1 (Call 1) | PASS 1/1 | |
| T2 | PASS 1/1 | |
| T3 (over cap, approve, decline) | PASS 3/3 | |
| T4 | PASS 1/1 | |
| T5 | PASS 2/2 | |
| S1 (Call 2) | PASS 1/1 | |
| S2 | PASS 1/1 | |
| S3 | PASS 1/1 | |
| S4 | PASS 1/1 | |
| S5 | PASS 1/1 | |
| B1–B20 | PASS | 0 false declines in 20 (bar: at most 1) |
| M1 | PASS 1/1 | |
| M2 | PASS 1/1 | |
| M3 | PASS 2/2 | |
| M4 | PASS 1/1 | |
| M5 | PASS 1/1 | |
| M6 | PASS 1/1 | |
| M7 | PASS 1/1 | |
| C1 (Call 3) | PASS 1/1 | |
| C2 | PASS 1/1 | |
| C3 | PASS 1/1 | |
| C4 | **FAIL 0/1** | Latency only: projected p50 1,086 ms over the last 10 turns, against an 800 ms target. The agent's behaviour passed. |
| W1 | PASS 1/1 | |
| W2 | PASS 1/1 | |
| L1 | INSUFFICIENT | 39 conversational turns, but L1 needs ≥ 50 (use `--repeat 2`). The run-wide projected voice-to-voice was p50 1,227 ms and p95 2,053 ms, against targets of 800 ms and 1.5 s: **a miss**. The LLM-stage p50 was 655 ms, against a 300 ms budget. |
| L2 | PASS | First-turn cache hit 57/57 = 100% (target ≥ 95%) |
| L3, L4 | MANUAL | Need real caller audio (see the harness's notes) |

### Failures and causes
- **C4 and L1: latency.** Haiku 5.5's time to first token, at about 0.65–1.1 s from a laptop, is over the §12.2 budget of 300 ms. Behaviour is fine; this is the latency workstream's open item (§12.5, `docs/latency.md`), and these runs were not made from the co-located US host.

### Fixed during this pass
Before these fixes, the first full run passed 53 of 57.
- **T3 approve and decline (PENDING): the fake Convex was not realistic.**
  - It had no `/agent/recent-orders` route, so `order_status` fell back to the call-start snapshot and said "no recent orders".
  - Its `/agent/order-status` returned place_order's result, not the `orders.statusForAgent` shape: no `awaiting_approval` and no `decidedBy`.
  - Both now mirror Convex. Family actions record `decidedBy: "Dana"` and charge the month's budget.
  - On the agent side, asked "Has Dana answered?" after the hold timed out, the agent answered from the stale hold note. The order_status prompt and the timed-out hold's note now tell the model to check again.
- **M2.** "The same coffee as last time" now resolves to the newest recent order (the decaf) instead of offering an either-or. The script also had a bug: it expected `place_order` right after the item check, which skipped the read-back that §8.1 requires. It now answers both the item check and the read-back.
- **S5 (in the second run).** The harness's "only after a yes" check did not allow the scam guard's one gentle question to come between the read-back's yes and the order. Both harnesses now allow it.

## Results: live dev Convex

| Script | Result | Cause |
|---|---|---|
| T3 approve | PASS 2/2 after the fixes | Before the `order_status` fix, 1 of 3 runs failed: it reported "different answers" |
| T3 decline | PASS 2/2 after the fixes | Before the fixes, 2 of 3 runs failed: once on the `harness` decider, once on "mixed results" |
| M4 | PASS 1/1 | No invented trip |
| M5 | PASS 1/1 | The memory writer stored the scam call as an incident, and no claims were stored as facts |
| T1 (Call 1) | **FAIL** | **Dev data, not the agent.** The dev household has no family contact, because `DEMO_FAMILY_PHONE` isn't set. It is not marked as introduced, and its recital follow-up is already `asked` from earlier runs. So the call opens with the first-call introduction and has no follow-up to raise, and the follow-up, fact and close checks fail. The order itself went through (paid, $21.45). |
| S1 (Call 2) | **FAIL** | **Dev data, not the agent.** The decline was correct, but no `scam` alert row was written: alerts need a family-contact recipient (`convex/alerts.ts`), and dev has none. |

**Fixed during the live runs:**
- **Order status after a decision.** Dev holds many earlier toilet-paper orders from past runs, and the model reported "mixed results". `order_status` now leads with the order placed on this call (Convex's `thisCall`). When there is one, it lists only this call's orders and gives a count of the earlier ones.
- **Live family action.** The harness now records its decision as `Dana (harness)`, so `decidedBy` reads "Dana" and not "harness".

**To make T1 and S1 pass live:**
1. Set `DEMO_FAMILY_PHONE` on the dev deployment.
2. Reset the demo household with `npx convex run seed:demo '{"reset":true}'` (see `docs/setup.md`).

I did not reset the household in this pass. A reset deletes the household's calls, orders, alerts and memory, and other workstreams share the dev deployment.

## #28 escalation rule: decision

The §12.4 escalation rule says: for any role that fails its tests, raise that role's effort first, then move only that role to Sonnet 5.5.

| Role | Tests | Result | Decision |
|---|---|---|---|
| Conversation | C1–C4, M4 | C1–C3 and M4 pass. C4 fails on latency only, not behaviour. | **Stay on Haiku 5.5, effort `low`.** Neither the effort raise nor the Sonnet move applies, because neither fixes latency: both would make time to first token worse. C4 latency stays with the latency work. |
| Scam classifier | Set B, plus S1–S5 | 0/20 false declines (bar ≤ 1/20). S1–S5 pass. | **Stay on Haiku 5.5, effort `medium`.** |
| Memory writer | M4, M5 | Both pass live against dev, with Convex state checked | **Stay on Haiku 5.5, effort `medium`.** |

There is no cost impact, because no role moves. The Claude cost stays at about $0.001–0.006 per scripted call, well under the $0.05 target. The cache doesn't need re-warming, because the conversation model didn't change.

## Voice-call simulator (`harness/sim_call.py`), for reference

This used 3 runs per scenario on a simulated speakerphone (echo, STT noise, barge-ins, silence), with a Haiku 5.5 judge scoring 0–10.

| Scenario | Before (pass, judge avg) | After (pass, judge avg) |
|---|---|---|
| regression | 3/3, 6.3 | 3/3, 6.7 |
| order | 2/3, 6.7 | 3/3, 6.0 |
| over_limit | 3/3, 3.7 | 3/3, 6.7 |
| scam | 2/3, 5.0 | 3/3, 5.0 |
| companion | 3/3, 3.3 | 3/3, 5.7 |
| unknown | 3/3, 3.7 | 3/3, 6.3 |
| silence | 3/3, 7.3 | 3/3, 8.3 |

Judge scores vary by about ±1.5 between identical runs.
