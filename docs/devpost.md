# Devpost submission: Errand Line (#61, #70, #74)

Copy each section into the matching Devpost field. **[confirm]** marks a claim that must be verified, or reworded, before submitting. Before pasting, search this file for "[confirm]" and resolve every one; none may reach Devpost.

Tagline (Devpost "elevator pitch", 200 characters max):

> A phone number older adults call to order groceries, have a chat and stay safe from scams. It remembers them, and it knows when not to buy.

---

## Inspiration

Last year Americans over 60 reported **$7.7 billion** stolen by scammers, about 60% more than the year before ([FBI via AARP](https://www.aarp.org/money/scams-fraud/fbi-ftc-report-2025-losses.html)). The tell is usually the payment: gift cards, wires, crypto. At the same time, **one in three** adults aged 50–80 feels lonely ([University of Michigan National Poll on Healthy Aging](https://ihpi.umich.edu/news/loneliness-and-isolation-back-pre-pandemic-levels-still-high-older-adults)), and the Surgeon General compares the health impact of social disconnection to smoking up to 15 cigarettes a day.

Shopping tools assume a smartphone. Grocery apps need one, smart speakers need a device and an account, and phone services like GoGoGrandparent rely on human operators and keypad menus. We wanted something a 78-year-old with a landline and a flip phone could just call, that her daughter could trust, and that would be good company rather than a checkout.

## What it does

Errand Line is a phone number. Margaret, 78, calls it from any phone. A Claude voice agent:

- **Errands.** Takes her order in plain speech, offers at most two options with prices ("eight ninety-seven"), reads back every item and the total, and only orders after an explicit "yes". "My coffee" resolves to her usual from saved favorites.
- **Company.** Remembers her from call to call. It opens with one follow-up ("How did Lily's recital go on Saturday?"), is happy to just chat, says it's an AI whenever asked, and when she says she misses her daughter, offers to let Dana know she'd love a call.
- **Protection.** Gift cards, wire transfers and crypto are blocked by a deterministic rule before the model is even asked, and blocked again inside the order function. A Claude classifier scores each caller turn for softer signs (claimed authority, secrecy, urgency, out-of-pattern spending), and a scam hold stops all ordering for the rest of the call. The family is alerted right away. **[confirm]** the guard is wired into the live agent.
- **Family limits.** Dana sets a per-order cap, a monthly budget and approved stores. They're checked in code on the payment path. Over-limit orders wait for Dana's approval, and nothing is charged until she says yes.
- **Wellbeing.** If Margaret mentions a fall or self-harm, templated 911 and 988 lines are spoken word for word, and the family is alerted. **[confirm]** wired into the live agent.
- **Live family dashboard.** Dana sees calls with live transcripts, orders and monthly spend, alerts with transcript excerpts, approvals with Approve/Decline buttons, everything Errand Line remembers (each fact with Margaret's own words as evidence and a Forget button), settings, and a developer panel with latency percentiles, cache hit rate and Claude cost per call.

Chat-only transcripts stay private unless Margaret agrees, but scam alerts always reach the family.

What it does **not** do yet: real payments (the demo runs on a mock rail with the same limits; our Visa Intelligent Commerce integration is written but not run against the sandbox), live store search (cached Walmart results), a spoken PIN, or delivery.

## How we built it

- **Voice.** A Cartesia phone number and Cartesia speech (STT, TTS, turn-taking, barge-in). We self-host a custom Cartesia Line SDK agent in Python instead of using a managed LLM agent, so we build every Claude request ourselves. For the hackathon it runs on a laptop behind a Cloudflare HTTPS tunnel.
- **Claude Haiku 5.5** (`claude-haiku-5-5`) for every role: the conversation (low effort, adaptive thinking, streaming), the per-turn scam classifier (structured output, run in the background) and the post-call memory writer.
- **Memory as a cached prompt.** Tools → static system prompt (1-hour cache breakpoint) → the household memory block (5-minute breakpoint) → the live conversation. The memory block is serialized deterministically so it's byte-identical between calls. While the templated greeting plays, we send a `max_tokens: 0` pre-warm request with the exact same settings, so the first real turn reads from cache. In our harness, 11 of 11 calls hit the cache on the first turn.
- **Convex** is the backend: nine tables, authenticated HTTP actions for the agent (shared secret, constant-time compare) and a separate secret for the alert agent. `place_order` is the only path that moves money: a transactional `reserve` mutation runs the hard scam rule, the scam hold and the limits; prices come from a server-side catalog (the model's prices are ignored); an idempotency key per tool call means a retry never pays twice. The memory writer runs as a scheduled Convex action after hang-up, and code validates each proposed fact against what the caller actually said.
- **Family alerts** are outbound calls placed through Cartesia's agent-calls API to a small Cartesia alert agent, which reads the alert and takes a spoken yes or no on approvals. **[confirm]** that an alert call has rung a real phone; otherwise say "designed as outbound calls; demoed on the dashboard".
- **Dashboard:** Next.js 16 and React with Convex reactive queries, Tailwind, and an access-key gate checked inside every Convex function (Clerk sign-in is wired server-side as the upgrade path).
- **Testing:** `convex-test` suites on the real schema (limits, idempotency, double-pay crash, scam rule, sharing rules, memory validation), pytest for the agent and tools, and a scripted-call harness that runs the real agent against real Claude with 31 scripts mirroring our test plan (orders, limits, scams, memory, companion, wellbeing, latency). **[confirm]** current pass counts: run `npm test` and `uv run pytest` and paste the numbers.

## Challenges we ran into

- **Latency vs. patience.** Older callers pause mid-sentence, so answering fast and not cutting people off pull in opposite directions. We added a 700 ms hold-off when a turn ends on "um", "and" or a comma, log every cut-off, and treat interrupting as worse than a short pause. Cartesia's tunable end-of-turn profiles aren't settable from a self-hosted agent, so we did it agent-side.
- **Hitting the latency budget.** Our target is 800 ms voice-to-voice at the median. The model's time to first word measured about 770 ms at the median from a laptop (1.7 s p95), so with speech stages we project about 1.3 s. We haven't hit the target yet; we found the slow turns spend 180–300 tokens thinking before an ordering tool call, and that tail stalls dominate p95.
- **Keeping the model away from money.** In early runs the agent applied the $50 cap itself and refused, instead of letting the order system route it to Dana for approval. The fix was a prompt rule that limits are enforced by `place_order`, plus making sure every decision about money happens in Convex, not the model.
- **Prompt caching discipline.** Any byte change in the prefix breaks the cache, and Haiku 5.5 rejects edited history once thinking blocks exist. We kept the conversation strictly append-only: scam-guard notes ride on the next user turn instead of editing the system prompt.
- **External access.** We didn't get Visa sandbox credentials or run Apify live in time, so the demo uses a mock payment rail and cached search results.

## Accomplishments that we're proud of

- Money moves on code, not on the model's word: the hard scam rule, scam hold and family limits are enforced transactionally, with idempotent retries.
- Memory with receipts: every remembered fact carries the caller's own words, invented facts are dropped by code, and scam-call claims become an incident, not a "fact".
- Under a tenth of a cent of Claude per scripted call (mean $0.0008), against our $0.05 budget, thanks to caching.
- A dashboard a worried daughter can actually read, with live transcripts and one-tap approvals.
- **[confirm]** Calls 1 and 2 passed 10 of 10 rehearsal runs on real phones. Fill in the actual count.

## What we learned

- With a small, fast model, the right move is to put every rule that must never fail into code and templates (limits, scam hard rule, 911/988 lines, memory validation) and let the model do the talking.
- Prompt caching changes the economics of long memory: re-reading a large memory block every turn costs about a cent per million tokens.
- Turn-taking for older callers is its own design problem, separate from raw speed.
- Honest AI disclosure and "nudge family to call" make the companion pillar feel safe rather than sticky.

## What's next

- Real-phone testing with older adults and their families, including tuning the voice and pace with them.
- Visa Intelligent Commerce sandbox payments with agent tokens, capped by family limits.
- A spoken PIN for calls from new numbers; more stores and delivery tracking.
- Memory-driven check-in calls ("Want your usual coffee? And how did the tomatoes do?").
- A pilot with a local aging agency or Medicare Advantage plan, tracking orders, scams stopped, and loneliness with a validated short scale.

## Built with

`python` · `typescript` · `cartesia` (Line SDK, phone number, speech) · `anthropic` / `claude-haiku-5-5` · `convex` · `next.js` · `react` · `tailwindcss` · `cloudflare-tunnel` · `uv` · `pytest` · `vitest` / `convex-test`

Add only if used for real by submission: `visa-intelligent-commerce` (only if the sandbox ran; otherwise mention it in the text as "integration written"), `apify` (only if a live search ran), `figma` (only if the wireframes were moved into a Figma file), `vercel` (only if the dashboard was deployed).

Links: GitHub repo `https://github.com/whyeric/calhacks13` (public), demo video (YouTube, unlisted or public).

---

## Screenshots to capture

Capture at 1920×1080, browser zoom 125%, after a fresh reset and one run of Calls 1 and 2. Crop out the address bar (it may hold the access key) and any real phone numbers.

| # | Screen | What must be visible | Caption |
|---|---|---|---|
| 1 | **Live calls** during Call 1 | Transcript with the recital opener, per-turn latency badges, a Place Order tool chip | "Dana watches the call live, with per-turn latency." |
| 2 | **Orders** after Call 1 | Paid $21.45 order with items, "$21.45 of $200.00" budget | "Orders and monthly spend against Dana's budget." |
| 3 | **Memory** | The seeded facts with evidence quotes, plus the new recital fact from Call 1 and its source call; Forget buttons | "Every fact shows Margaret's own words. Forget anything." |
| 4 | **Alerts** after Call 2 | Scam alert with the transcript excerpt and delivery status | "A stopped $400 gift card request, with the excerpt." |
| 5 | **Live calls** scam panel during Call 2 | Scam score, signals, scam hold, `declined_scam` | "The guard decides; the model does the talking." |
| 6 | **Approvals** | An over-cap order (5 cans of coffee, $62.40) with Approve/Decline | "Over the limit? Dana approves with one tap." |
| 7 | **Developer** | Latency p50/p95, cache hit rate, cost per call | "Every turn logged: latency, cache hits and cost." |
| 8 | **Settings** | Limits, approved stores, favorites, sharing toggles | "Families set guardrails, not choices." |
| 9 | Architecture diagram | Phone → Cartesia → self-hosted agent → Claude; Convex gate; dashboard; alert calls | (Make from SPEC §10.1.) |
| 10 | Optional photo | The two demo phones next to the dashboard | "Any phone. No app." |

Devpost's first image is the thumbnail: use #3 (Memory) or #1 (Live calls).

---

## Prize tracks (#70)

From SPEC §18 and [research/sponsor-fit.md](research/sponsor-fit.md), adjusted for what is actually built. Rule from #70: **do not enter a track whose integration we didn't build.** Rewards are as listed in §18 or Devpost snippets and must be confirmed on the Devpost prizes page in a browser.

| Track | Enter? | What the sponsor does in Errand Line (paste into the per-sponsor note) | Notes |
|---|---|---|---|
| **Anthropic** ($5k Claude credits) | **Yes** | Claude Haiku 5.5 runs every call: the conversation, a per-turn scam classifier and a post-call memory writer. Prompt caching with a pre-warm lets a large per-caller memory ride on every turn for about a cent per million tokens. Community: older adults whose adult children manage their errands. | Core |
| **Cartesia: Best Use of Cartesia** ($1,516) | **Yes** | The phone number, low-latency speech and turn-taking on every call (self-hosted Line SDK agent), and an outbound alert agent that calls the family. | Core. Mention the alert agent only if it has rung a real phone **[confirm]** |
| **Convex: Best Use of Convex** ($1,308) | **Yes** | Nine-table backend, authenticated HTTP actions, the transactional `place_order` gate (hard rule, scam hold, limits, idempotency), scheduled memory writer, and the reactive family dashboard. | Core |
| **Cal Hacks: Best People-First Social Impact** | **Yes** | The whole product: scam protection and companionship for isolated older adults. | Automatic |
| **Cal Hacks overall** | **Yes** | | Automatic |
| **Visa: Reimagining Shopping** ($5,000) | **Decide** | Voice shopping within family limits, with a Visa Intelligent Commerce rail (purchase instruction capped at the order total, one-time credentials, confirmation) written against Visa's sample code. | **Human decision.** The integration is written but never run against the sandbox; the demo uses the mock rail. Enter only if the team is comfortable saying exactly that, or after a sandbox run. Recommendation: enter, with the honest wording. |
| **Microsoft: Built for the Real World** ($3,800 + laptops) | **Yes** (per sponsor-fit) | A real user need, real constraints taken seriously (limits in code, honest AI disclosure, no real money, patient turn-taking), a clear adoption path (family subscription, then health plans and aging agencies). | Ask reps if Microsoft tech is expected **[confirm]**. Needs the video. |
| **Meta: Bringing People Closer Together with AI** | **Yes, if reps OK** | Connect nudges get family to call; alerts bring Dana in at the moments that matter; success = more family calls, not more minutes with us. | Skip if the reps require Meta tech **[confirm]** |
| **Creao: Best AI-First Disruptor** | **No** | | Every signal says it requires building on Creao. Enter only if reps say no Creao build is needed. |
| **Apify** (places 1–5) | **Only if a live run happened** | `search_items` calls a Walmart search Actor and falls back to cached results. | Has never run live (no `APIFY_TOKEN`). If it doesn't run before submission, skip. |
| **Apify: Best Actor** ($400) | **No** | | Needs our own published Actor (#64), not built. |
| **Figma: Best Design** ($1,000) | **No, unless done** | | We have SVG wireframes (`docs/wireframes.svg`), not a Figma file. Enter only if #85/#102 produce a shared Figma file. |
| **Capital One: Best Use of Nessie** ($1,200) | **No** | | We used a mock rail, not Nessie. |

---

## Final submission checklist (#74)

Deadline: **Sun Oct 25, 09:00 PT**. Our target: **submitted by 08:30 PT**. Confirm the deadline on the Devpost page.

### By 06:00 (video)
- [ ] Calls 1 and 2 at 10 of 10 ([rehearsal.md](demo/rehearsal.md)), count written in #38.
- [ ] Video recorded, reviewed and uploaded to YouTube (unlisted or public) ([video.md](demo/video.md)).

### 06:00–07:30 (write-up and repo)
- [ ] Every **[confirm]** in this file resolved: verified, or the sentence reworded or removed.
- [ ] Test counts pasted into "How we built it".
- [ ] Screenshots 1–8 captured and uploaded; no access key or real phone number visible.
- [ ] **Code is on `main`.** The work lives on `codex/milestone-1-foundations` with uncommitted changes; the team must commit, open a PR and merge to `main` (or point Devpost at the branch) so judges see the real code. **Human task**; this doc doesn't do it.
- [ ] Secret scan on the final commit: `git grep -nE 'sk-ant|sk_live|sk_test|AC[0-9a-f]{32}|SK[0-9a-f]{32}'` returns nothing; `.env` files are not tracked (`git ls-files | grep '\.env'` shows only `.env.example`).
- [ ] README describes the current product, not "milestone 1". Links to SPEC, setup and this write-up.
- [ ] Rotate `DASHBOARD_ACCESS_KEY` if the link was ever shown on screen or in the video.

### 07:30–08:30 (Devpost form)
- [ ] Project name, tagline, and all sections pasted from this file.
- [ ] "Built with" tags match what was really used.
- [ ] Video URL added; plays in a logged-out browser.
- [ ] GitHub link added; opens in a logged-out browser.
- [ ] Screenshots uploaded with captions; thumbnail set.
- [ ] Every teammate added to the Devpost project and accepted the invite.
- [ ] Prize tracks selected per the table above; per-sponsor notes filled where the form allows.
- [ ] Any required sponsor questions answered (some tracks ask for extra fields; check each).
- [ ] Table number / location filled in if Cal Hacks asks for it.
- [ ] **Submit** by 08:30. Screenshot the "submitted" status.

### After submitting
- [ ] Open the public project page logged out: text, images and video render.
- [ ] Post "submitted" with the link in the team channel.
- [ ] Edits are usually allowed until the deadline; don't make risky ones after 08:45.
