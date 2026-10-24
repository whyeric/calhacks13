# Milestone 1: Phase 0 · Foundations

Branch: `codex/milestone-1-foundations`, based on `errand-line` at `fed8106` (also the current local `origin/main`). Scope comes from [GitHub milestone 1](https://github.com/whyeric/calhacks13/milestone/1), not Phase 1 / milestone 2. Verified on October 23, 2026, Pacific time.

**Milestone is not yet complete.** Local code, Claude compatibility, the cloud development backend, caller-only seed, and live HTTP authentication are verified. A Cartesia inbound number is provisioned but not routed to a hosted agent. Production hosting, real phone calls, sponsor answers, and independent human acceptance remain pending. No issue or acceptance gate is marked complete on the strength of local mocks.

| Issue | Delivered on this branch | Remaining evidence / external action |
|---|---|---|
| #6 Accounts and keys | Empty environment template, ignore rules, distinct service secrets; Claude and Cartesia keys verified; Convex development secrets configured privately | Fly, Apify, Visa, Vercel, Clerk accounts/access; production configuration |
| #11 Scaffold | `agent/`, `dashboard/convex/`, `fixtures/`, `harness/`, README, uv project/lock, container | Ready for review |
| #16 Inbound number | Cartesia number provisioned; caller ID passes through to an idempotent Convex call record; unknown numbers never receive household context | Assign hosted agent; real cell/landline tests; verify actual caller ID |
| #21 Voice skeleton | Custom Line `process`, fixed AI greeting, direct AsyncAnthropic streaming, interruption filters, call-end flush | Full hosted two-way conversation and Gate 1 row 1.1 |
| #26 Custom-agent spike | Live pre-warm, cache reads and signed-thinking roundtrip; local stream cancellation test | Real-phone interruption event/audio timing and team decision record |
| #50 Always-on host | Non-root Docker image, frozen dependencies, Fly config with health check, restart and auto-stop off | Docker build/run (Docker not installed here), provision host, measure candidate-region RTTs, register HTTPS URL, restart/laptop-closed test |
| #79 Convex deployments | Development deployment linked, schema/functions pushed successfully, service secrets configured, agent URL linked locally | Create/configure production deployment |
| #81 Nine-table schema | All nine tables, enums, required indexes and typed APIs; cloud `convex dev --once` passes | Agree/freeze shared contract with team |
| #83 Seed | Caller-only cloud demo seeded with limits, two favorites, five evidenced facts and an open recital follow-up; no family contact, per user request | Add family recipient when requested; seed production and time rehearsal reset |
| #85 Figma | Importable six-screen plus developer-panel SVG wireframes | Install/connect Figma or import manually; create editable shared file and record team URL |
| #90 Alert calls | Scoped recipient validation, Cartesia transport, status polling, failed-call visibility, first-response decision mutation, managed-agent prompt/tool contract | Configure managed agent/tool secret/number; verify outbound API response and statuses with actual account; ring Dana within 15 seconds and record yes; check managed Claude catalog and transfer configuration |
| #120 HTTP auth | Seven POST routes, fixed-size digest comparison, credential separation, pooled Python client; live 401/401/200 smoke and alert credential separation pass | Order/forget implementations are intentionally 501 until #23/#47 |
| #121 Gate 1 | Instructions and automated support checks | Independent reviewer must perform/sign all four real acceptance rows below |
| #2 Visa access | Credential placeholders and decision checklist | Sponsor response, sandbox access, judging criteria, mTLS requirement; no access claimed |
| #3 Apify proxy check | Account/run checklist | Claim credits, run actual Actor, record success/latency/fields, save genuine sample output |
| #91 Text messaging | Removed from the prototype, including stretch goals, at the user's request; schema and spec allow call/dashboard notifications only | No implementation planned |

## Verification evidence

- 20 Convex tests pass using the official `convex-test` runtime and the actual schema. Tests cover missing/wrong/cross-role secrets on every route, invalid JSON, denied money/forget routes, seed idempotency/reset/evidence, caller-only setup without alert destinations, caller isolation, turn retries/call end, family access/transcript sharing, outbound request construction, no-answer handling, and first decision wins.
- 8 Python tests pass using the installed Line SDK event types. They cover service startup/health, pooled bearer requests, background-write drain, configuration validation, signed-thinking preservation, stream cancellation, pre-warm settings, and spoken error recovery.
- TypeScript typecheck and Ruff checks pass. `npm audit` reports zero vulnerabilities after updating the initial test dependency selection.
- Generated Convex types were produced using the installed Convex generator's offline mode, not copied by hand. Run `npx convex dev` after account login to regenerate and verify against the actual deployment.
- Live Anthropic model listing authenticated and included `claude-haiku-5-5`. [Recorded usage](claude-spike.json) shows successful `max_tokens: 0`, cache reads on both conversational turns, and a successful follow-up request containing preserved signed thinking. The local conversation prompt is deliberately small; this spike uses an expanded static prefix to test the provider's cache behavior, not production latency or first-turn cache-hit rate.
- The cloud development deployment accepts the schema/functions and the [live development smoke](development-smoke.json) confirms household auth 401/401/200, rejection of the agent secret on the alert route, five seeded facts, and zero family contacts. The optional Clerk issuer is explicitly empty until sign-in is configured; no JWT providers are registered.

No phone latency, real alert delivery, hosted uptime, region comparison, Apify search, Visa sandbox payment, shared Figma file, or human acceptance result is asserted.

## Schema extensions and deferred implementation

Required §13 fields and enums are preserved. Foundation-specific additions are `familyContacts.authSubject?` for Clerk authorization; `calls.providerCallId?` and an index for provider retries; a composite turn index for idempotent logs; and alert provider/decision audit fields. `calls.scamHold` is represented as `{active, reason?, at?}` and `scamReasons` as strings. Money values use Convex numbers; payment-path safe-integer validation and transactional reservations belong to #23/#29.

The HTTP surface is closed by default, including when secrets are missing, short, or identical. `/agent/order` and `/agent/forget` authenticate but return 501. Call end records termination and explicitly reports `memoryStatus: not_implemented`; the durable memory writer is #32. No route claims to pay, approve an order, delete evidence or write memory. Alert decisions are audited but do not trigger payment until #92. These boundaries are stated in the agent prompts and [API contract](setup.md#api-contract).

The stock Line SDK's ingress does not authenticate its WebSocket clients. Restrict it using supported Cartesia/hosting controls before public production use. Only seeded demo data is appropriate for the human gate. This branch does not claim production caller authentication.

## Gate 1 actual results

Reviewer must not be the implementer. Timebox: 30 minutes. Fill evidence and sign `PASS` or `FAIL` in #121; leave it open until then.

| Row | Expected | Actual | Pass |
|---|---|---|---|
| 1.1 | Real inbound call answers within 1.5 seconds and creates correct `callerPhone` | Number and development backend ready; host/routing and phone test pending | Pending |
| 1.2 | Dana rings within 15 seconds; spoken yes records approved | Deferred: user requested caller-only setup for now | Pending |
| 1.3 | Missing/wrong/correct household secret → 401/401/200 | Live development smoke passes, including the seeded household; independent human review pending | Pending |
| 1.4 | No API credentials in tracked source | Local secret scan passes; private `agent/.env` ignored, mode 0600 | Pending human review |
