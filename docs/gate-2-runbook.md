# Gate 2 runbook: first real phone order

Use this checklist to accept [#122](https://github.com/whyeric/calhacks13/issues/122). The reviewer is Person 3, who must not have built the code under review. Allow 30 minutes for the tests and about 20 minutes beforehand for setup. Every command runs from the repository root unless it says otherwise. Do not paste secrets into issues, chat or this file.

Payments use the **mock rail**: no money moves, and nothing calls Visa. Leave `PAYMENT_RAIL` unset unless the Visa sandbox has been proven first (see the end of this file).

## 0. What you need

- A laptop with this checkout, `agent/.venv` (`cd agent && uv sync --frozen`), `dashboard/node_modules` (`cd dashboard && npm ci`) and `cloudflared` (`brew install cloudflared`).
- `agent/.env` with `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID`, `CARTESIA_PHONE_NUMBER_ID`, `CARTESIA_PHONE_NUMBER`, `CONVEX_SITE_URL` and `AGENT_SECRET`. These are already set on the demo laptop. `APIFY_*` is not needed: with no token, search uses the cached fixtures, which give the Call 1 prices.
- **Margaret's phone.** This is the phone of a consenting team member whose number is `DEMO_CALLER_PHONE` in Convex. Use E.164 format, `+1…`.
- **Optional: Dana's phone**, as `DEMO_FAMILY_PHONE`. Set it if you want row 2.2 to name Dana. Without it, the seed creates no family contact, so the agent says "your family" instead.
- A second screen for the dashboard.

## 1. Push the backend and reset the demo data (5 min)

The working tree has Convex changes that are not yet on the dev deployment: `households:setLimits` and the turn `refused`/`tools` fields. Push them first.

```sh
cd dashboard
npx convex dev --once                       # pushes functions + schema to the dev deployment
npx convex env list                         # names only; confirm AGENT_SECRET, DASHBOARD_ACCESS_KEY, DEMO_CALLER_PHONE
npx convex env set DEMO_FAMILY_PHONE "+1…"  # optional, for "check with Dana"
npx convex run seed:demo '{"reset":true}'   # fresh Margaret: $50 per order, $200 a month, Walmart only, recital follow-up
```

`AGENT_SECRET` in Convex must equal the value in `agent/.env`. Do not reset while a call is live.

## 2. Start the dashboard (2 min)

```sh
cd dashboard && npm run dev
open "http://localhost:3000/live#key=$(grep ^DASHBOARD_ACCESS_KEY= .env.local | cut -d= -f2-)"
```

The key is removed from the address bar and remembered on this browser. Check that the header says "Margaret's line" and that Orders shows "No orders yet" with "$0.00 of $200.00 budget".

Vercel is optional. The [Vercel section](#optional-deployed-dashboard-on-vercel) covers it.

## 3. Start the voice agent behind the HTTPS tunnel (3 min)

```sh
caffeinate -i agent/.venv/bin/python harness/local_demo.py
```

Wait for "Local voice agent and HTTPS tunnel are ready." and "Call +1…". The launcher does the following:

1. Starts the agent on `127.0.0.1:8010`.
2. Opens a Cloudflare Quick Tunnel and checks its HTTPS `/status`.
3. Registers the tunnel URL with the existing Cartesia agent and assigns the number.
4. Reads the configuration back from Cartesia.

A new hostname can take up to 90 seconds to resolve. Keep the terminal open and the lid up. Ctrl+C stops everything, and rerunning the command re-registers the new URL.

**Smoke test.** Call the number from Margaret's phone and hang up after the greeting. **Live calls** must show a new call within about 1 s. The greeting must use her name and ask about Lily's recital. If the dashboard shows an unknown caller, the phone's caller ID does not match `DEMO_CALLER_PHONE`: fix the env var, then rerun the reset from step 1.

Because the smoke call asked the recital question, run `npx convex run seed:demo '{"reset":true}'` again before row 2.1.

## 4. Run the gate

Fill in the table on #122 as you go. Record what you heard and saw, a call ID (shown in the Convex dashboard `calls` table, or `npx convex data calls --limit 1 --order desc`), and a screenshot of the dashboard.

### 2.1 Call 1

From Margaret's phone, follow SPEC §16.1:

1. Answer the recital question.
2. Ask for "paper towels and my coffee".
3. Pick the 6-roll pack.
4. Say "yes" at the read-back.

| What to check | Expected |
|---|---|
| The recital question | Asked once |
| Paper-towel options | Two options: 6-roll at $8.97 and 12-roll at $15.48 |
| Read-back | The total is twenty-one forty-five |
| Live calls screen | Transcript turns appear during the call. Agent turns show latency badges and `Place Order · …` tool chips once the agent sends them |
| Orders screen | After "yes," the order shows **Paid** at **$21.45** within about 1 s. Spend reads "$21.45 of $200.00" |

### 2.2 Over the per-order cap

Ask for five cans of the usual coffee: 5 × $12.48 = $62.40, which is over the $50 cap.

- The agent says it needs to check with Dana, or with the family.
- Orders shows **Awaiting approval** with the reason "…over your $50.00 per-order limit."
- The Approvals badge reads 1.
- Nothing is paid.

Optional: check that approval updates live. Approving does not pay; payment after approval is Phase 2.

```sh
cd dashboard
npx convex data orders --limit 1 --order desc   # copy the _id
npx convex run orders:approve '{"orderId":"<_id>","by":"Dana"}'
```

The badge changes to **Approved** with "Approved by Dana".

### 2.3 Monthly budget

Lower the budget below this month's spend, which is $21.45 after row 2.1:

```sh
cd dashboard && npx convex run households:setLimits '{"monthlyBudgetCents":2000}'
```

Call again and order "my usual coffee". Orders shows **Awaiting approval** with "…over your $20.00 monthly budget." Nothing is paid.

Restore the budget afterwards:

```sh
npx convex run households:setLimits '{"monthlyBudgetCents":20000}'
```

### 2.4 Idempotent replay

Replay the Call 1 order with its original idempotency key:

```sh
cd dashboard
npx convex data orders --format jsonLines | grep '"status":"paid"' | head -1   # note _id, callId, idempotencyKey, store
cd ..
set -a; . agent/.env; set +a       # loads AGENT_SECRET and CONVEX_SITE_URL without printing them
curl -s "$CONVEX_SITE_URL/agent/order" -H "Authorization: Bearer $AGENT_SECRET" -H 'Content-Type: application/json' \
  -d '{"callId":"<callId>","idempotencyKey":"<idempotencyKey>","store":"Walmart","items":[{"name":"x","storeItemId":"demo-coffee-big","qty":1,"priceCents":1248}]}'
```

**Expected:** `{"status":"paid","orderId":"<same _id>",…}`. Orders still shows one $21.45 order, and `npx convex data alerts` shows one `order_placed` alert for it. The mock rail has no ledger, so one `paymentTokenRef` and one `order_placed` alert are the record of a single charge.

The item list in the replay does not matter, because a known key returns the stored order before anything is read. This works after the call has ended.

### 2.5 Improvise

On a new call:

1. Start an order and change your mind ("actually, the big pack").
2. Ask for two items in one breath.

The read-back must match your final choice. Orders must show nothing new before your "yes."

### 2.6 Baseline and listening note

1. Paste the table from [latency.md](latency.md) into #122. It covers the LLM stage only.
2. Run the report against today's real calls:

   ```sh
   agent/.venv/bin/python harness/latency_report.py --limit 10
   ```

3. Record p50 and p95, the first-turn cache hit rate and the cost per call, against §12.1 and §15.
4. Listen to one full call and write a one-line note.

The agent does not log `speechEndAt` or `ttsFirstAudioAt` yet, so the report cannot give true voice-to-voice times. Time one reply by ear or by stopwatch, and say so in the note.

## 5. Verdict

Every row needs an actual result and a pass or fail mark. Close #122 with a comment that says `PASS` or `FAIL`, signed by the reviewer. A failure on a **money** row (2.1–2.4) blocks Phase 2 until it is fixed. Any other failure is fixed or cut, and the cut is recorded on #122 with its §7 item.

Afterwards, if you want to rehearse again, reset with `npx convex run seed:demo '{"reset":true}'`.

---

## External items: what each one needs

### Optional: deployed dashboard on Vercel

No issue in milestone 2 requires a deployed dashboard; #86 asks for one that runs locally. To show it from any browser:

1. Run `cd dashboard && vercel link`. The CLI is signed in as `frenchbaguetteman`, and there is no Errand Line project yet. Create a new project, for example `errand-line-dashboard`, with `dashboard` as the root directory. Vercel detects the framework as Next.js.
2. Run `vercel env add NEXT_PUBLIC_CONVEX_URL production`. Set it to the `.convex.cloud` URL of the deployment the agent writes to (the `CONVEX_URL` in `dashboard/.env.local`). It is read at **build** time.
3. Run `vercel deploy --prod`, then open `https://<project>.vercel.app/live#key=<DASHBOARD_ACCESS_KEY>`.
   - `DASHBOARD_ACCESS_KEY` lives in Convex, not Vercel. No Clerk keys are needed.
   - Data stays private behind the access key. Without it, the site shows only the key form.
4. If you point Vercel at a production Convex deployment instead, that deployment needs its own environment variables, its own seed, `npx convex deploy`, and the agent's `CONVEX_SITE_URL` switched to match.

### Clerk

Clerk is not needed for milestone 2. The dashboard uses the `DASHBOARD_ACCESS_KEY` gate; it has no Clerk SDK and uses a plain `ConvexProvider`. Convex already accepts Clerk identities through `CLERK_JWT_ISSUER_DOMAIN`, which is currently empty. Family sign-in would need four things:

1. A Clerk application with a JWT template named `convex`.
2. `npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-app>.clerk.accounts.dev`.
3. `DEMO_FAMILY_AUTH_SUBJECT` set to Dana's Clerk user ID, followed by a reseed.
4. In the dashboard: `@clerk/nextjs`, `ConvexProviderWithClerk`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.

That is Phase 2 or later work.

### Apify (#8)

Live search is optional, because the demo uses fixtures.

1. In `agent/.env`, set `APIFY_TOKEN`, `APIFY_WALMART_ACTOR` (for example `xtracto/walmart-search-scraper`, per #3), and optionally `APIFY_WALMART_QUERY_FIELD` and `APIFY_TIMEOUT_SECONDS`, which defaults to 2.5.
2. Leave `SEARCH_MODE` unset (auto).
3. Live results use `walmart-*` item IDs, which the server price catalog rejects. To accept them at the agent's price, also run `npx convex env set ALLOW_LIVE_ITEM_PRICES 1`.

For the demo, set `SEARCH_MODE=fixtures` so the Call 1 prices are guaranteed.

### Visa sandbox (#39)

Visa is blocked on sponsor access (#2). [visa.md](visa.md) lists the nine required Convex environment variables, including the MLE keys, `VISA_CONSUMER_ID` and `VISA_TOKEN_ID`, and has a checklist. Prove auth with Visa's sample repository first. Then set `PAYMENT_RAIL=visa` on the **dev** deployment only and rerun row 2.1. Until then, the mock rail is the accepted fallback (#44).
