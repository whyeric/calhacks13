# Foundations setup

## 1. Accounts and local secrets

For the first phone test, create an [Anthropic Console](https://console.anthropic.com/) account with API credit, a [Cartesia](https://play.cartesia.ai/) account with Agents and a US number, a [Convex](https://dashboard.convex.dev/) account, and a [Fly.io](https://fly.io/) account with billing. Use two consenting team members' phones, one as Margaret and one as Dana. Apify, Visa, Vercel and Clerk accounts are also tracked in #6; they do not block the minimal inbound voice test. Clerk is needed before any family query can return private data.

Copy `.env.example` to `agent/.env` if the file does not already exist. Preserve existing values. Fill these names first:

```dotenv
ANTHROPIC_API_KEY=
CARTESIA_API_KEY=
CONVEX_SITE_URL=
AGENT_SECRET=
ALERT_SECRET=
```

`AGENT_SECRET` and `ALERT_SECRET` must be different random values, each at least 32 characters. Generate them with Python's `secrets.token_urlsafe(48)` and place them directly in the ignored file. Do not paste secrets into chat, issues or commands that get committed. Store the alert secret only in Convex and the alert webhook tool; the inbound voice process only needs the agent secret.

Blank model variables use `claude-haiku-5-5`, adaptive thinking and low effort. The live compatibility evidence is in [claude-spike.json](claude-spike.json).

## 2. Link Convex

From the repository root:

```sh
cd dashboard
npm ci
npx convex dev --once
```

Follow the CLI browser login, create a project named Errand Line, and choose a cloud development deployment. This writes ignored `.env.local` configuration and refreshes generated types. Keep generated source files in Git.

In the Convex dashboard's development deployment settings, add `AGENT_SECRET`, `ALERT_SECRET`, `CARTESIA_API_KEY`, `ALERT_AGENT_ID`, `ALERT_FROM_NUMBER_ID`, `DEMO_CALLER_PHONE`, `DEMO_FAMILY_PHONE`, and later `CLERK_JWT_ISSUER_DOMAIN` / `DEMO_FAMILY_AUTH_SUBJECT`. Phone values must use E.164 (`+` followed by country code and number). Set `ALERT_RING_TIMEOUT_SECONDS` to 30, or another integer from 5 through 80. Keep agent and alert secrets identical to their respective service copies, but different from each other.

Copy the deployment's **HTTP Actions URL** ending in `.convex.site` into `agent/.env` as `CONVEX_SITE_URL`. This is different from the `.convex.cloud` client URL used later by Next.js.

```sh
npx convex run seed:demo '{}'
```

The seed creates Margaret, Dana, $50 per-order / $200 monthly limits, two favorites, five facts with transcript evidence, and Lily's recital follow-up. Sharing starts off. Repeating the command does not duplicate data. For an intentional rehearsal reset of that household and all its calls, orders, alerts and memory:

```sh
npx convex run seed:demo '{"reset":true}'
```

The seed is an **internal mutation**, callable by the authenticated Convex CLI/dashboard, never a public browser API. Reset deletes only the household identified by `DEMO_CALLER_PHONE`. Do not reset during a live call or while an alert is pending.

Create the production deployment from Convex, configure its environment independently, then run `npx convex deploy` when ready. Record dev/prod URLs in the private team configuration, never deploy keys.

## 3. Local voice service and always-on host

```sh
cd agent
uv sync --frozen
uv run python main.py
```

`GET /status` is the SDK health check. Missing required configuration prevents startup. The SDK serves `POST /chats` and `/ws`; Cartesia connects speech and telephony to these endpoints. A local tunnel can be used for initial testing, but the acceptance gate needs a stable HTTPS host.

For Fly.io, install its CLI and sign in, then from `agent/`:

```sh
fly launch --no-deploy --copy-config
```

Choose a unique app name. `fly.toml` keeps one machine running with auto-stop off, HTTPS, a `/status` check, and restart-on-exit. `sjc` is an initial candidate, **not a measured region winner**. Before committing to a region, measure authenticated Cartesia and Anthropic request RTTs from candidate hosts (for example `sjc`, `lax`, `iad`), record p50 across at least ten requests to each, and choose the lowest combined result (#50).

Use Fly's secret manager to set `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`, `CONVEX_SITE_URL` and `AGENT_SECRET`; do not upload the entire local `.env` or the alert secret. Then:

```sh
fly deploy
fly checks list
fly status
```

Redeploy with `fly deploy` after `uv sync` updates the lockfile. Verify `/status` and one inbound call after every deployment. The Docker build uses the committed lockfile and runs as an unprivileged user. Docker is not installed in the current workspace, so the container still needs an actual build/run check.

## 4. Cartesia inbound number

Create a Line SDK / self-hosted agent in Cartesia. Register the Fly HTTPS URL as its `self_hosted_deployment_url`, configure a voice in the Playground, and assign the US phone number to it. Confirm the current account's number-slot allowance in the dashboard. Keep the self-hosted service URL restricted using any authentication/network controls Cartesia currently supports; the stock Line SDK does not authenticate incoming WebSocket sessions by itself. Do not publish the service URL as an end-user API.

Call from Margaret's seeded phone. The agent must greet, identify itself as AI, and answer “Hello, who is this?” Check `calls.callerPhone` in Convex against the actual phone. Repeat from a second number: it must produce an unknown-caller record with no household memory. Caller ID is never substituted with the demo number. The custom agent talks directly to Anthropic; Line handles speech and interrupts on `UserTurnStarted`.

## 5. Managed alert agent

Create a separate Cartesia Managed Agent. Start from [the alert prompt](../agent/prompts/alert.txt). Set `ALERT_AGENT_ID` and `ALERT_FROM_NUMBER_ID` in Convex. Use an available Claude model in Cartesia's catalog if offered; record the actual choice in #90 rather than assuming catalog support.

Add a webhook tool named `record_decision`:

- URL: `https://YOUR-DEPLOYMENT.convex.site/alert/decision`
- Method: `POST`
- Authorization header: `Bearer <ALERT_SECRET>`, stored as a Cartesia **tool secret**
- JSON body: `{"alertId":"<dynamic alertId>","decision":"approved"}` or `"declined"`
- Schema: both fields required; `decision` restricted to `approved` / `declined`

Enable Cartesia's `transfer_to_number` system tool only for approved family/caller destinations and after explicit consent. The Phase 0 transport does not automatically transfer. Non-approval alerts simply read their message and do not call the decision tool. The agent must not invent or substitute an alert ID.

From the authenticated Convex dashboard/CLI, invoke the internal action with the seeded household ID and Dana's seeded phone:

```sh
npx convex run alerts:call '{"householdId":"YOUR_HOUSEHOLD_ID","type":"approval_needed","message":"This is an Errand Line test. Do you approve?","recipient":"YOUR_DANA_E164_PHONE"}'
```

Dana should receive the call within 15 seconds. Say yes, then verify `alerts.decision === "approved"` and `delivery === "answered"`. A replayed conflicting decision must leave the first decision intact. This test alert has no order and never charges money. Never use arbitrary third-party destinations; the action requires a seeded approved family phone.

Urgent `scam`, `wellbeing`, `approval_needed`, and `connect_nudge` alerts use calls regardless of chat sharing. `order_placed` and `payment_failed` are dashboard only. Failed calls stay unacknowledged. Delivery is polled using Cartesia's call-status API; transport acceptance and status mapping still require a real Cartesia integration test. The action never automatically retries a potentially accepted outbound POST.

## 6. Human acceptance and other foundation issues

Run `agent/.venv/bin/python harness/http_smoke.py` after linking Convex; it checks missing/wrong/correct agent credentials and the alert boundary without making a phone call. Run Gate 1 (#121) with an independent human reviewer and real phones; record call IDs, timings and actual results. No automated check substitutes for that gate.

For #85, import [wireframes.svg](wireframes.svg) into a Figma design file, make the frames editable, share it with the team and record its URL. The Figma plugin is suggested but not connected yet; a local SVG is not proof that a shared Figma file exists.

For #3, claim Apify hackathon proxy credits and run `xtracto/walmart-search-scraper` for paper towels and coffee; record time and result fields before deciding whether live search is supported. For #2, ask Visa staff for sandbox availability, judging criteria and client certificate requirements; no sandbox access has been confirmed. Keep both issues open until there is evidence.

## API contract

All routes are POST JSON with bearer authentication. There are no unauthenticated transcript or money functions.

| Route | Credential | Body / behavior |
|---|---|---|
| `/agent/household` | Agent | `{callerPhone, providerCallId?}` → `{context, callId}`. Supplying the provider ID opens or resumes one call. Unknown numbers get `context: null`. |
| `/agent/turn` | Agent | `{callId, idx, speaker, text, at, timings, usage, scam?}`. Unique `(callId, idx)` makes retries safe. |
| `/agent/call-end` | Agent | `{callId, kind?, outcome?, summary?}`. Idempotently ends the call; memory writer is deferred to #32. |
| `/agent/alert` | Agent | `{householdId, callId?, orderId?, type, message, transcriptExcerpt?, recipient}`. Creates an alert and dispatches its channel. |
| `/alert/decision` | Alert | `{alertId, decision}`. Approval alerts only; first response wins. No payment is triggered in Foundations. |
| `/agent/order` | Agent | 501 until #23 implements the transactional payment path. |
| `/agent/forget` | Agent | 501 until #47 implements evidence redaction and summary regeneration. |

Dashboard queries require a Clerk identity whose `subject` exactly matches a family contact's `authSubject`. This extra optional field is the explicit schema extension for the access gate. Until configured, queries deny everyone. Chat-only transcripts remain hidden server-side unless sharing is enabled; calls with actual orders or alerts remain visible to authenticated family.

References: [Line custom agents](https://docs.cartesia.ai/line/sdk/agents), [events and interruption filters](https://docs.cartesia.ai/line/sdk/events), [Cartesia outbound calling example](https://www.cartesia.ai/learn/ai-cold-calling), [Convex auth](https://docs.convex.dev/auth), [Convex HTTP actions](https://docs.convex.dev/functions/http-actions).
