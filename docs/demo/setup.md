# Demo setup checklist (#43)

Physical setup for the live demo: two phones, seeded memory, the dashboard on the big screen, cached search, the backup video and a venue noise check. Read with SPEC §17.1, §15 and §20 ("Hall noise"), and [gate-2-runbook.md](../gate-2-runbook.md), which has the full commands.

Items marked **[confirm]** have not been verified as of Oct 24. Do not assume them on stage until someone ticks them here.

## What is verified today, and what is not

| Piece | Status (from docs/milestone-1.md, milestone-2.md, local-demo-smoke.json) |
|---|---|
| Laptop agent behind a Cloudflare tunnel, Cartesia number assigned | Verified by an automated smoke with an invented caller |
| A **real phone** call reaching the agent with correct caller ID | **[confirm]** Not yet done (Gate 1 row 1.1, runbook step 3) |
| Dana's phone ringing with an **alert call** | **[confirm]** Never done. Needs the Cartesia alert agent (`ALERT_AGENT_ID`, `ALERT_FROM_NUMBER_ID`, `ALERT_SECRET` on its webhook tool) and `DEMO_FAMILY_PHONE` |
| Scam guard (hard rule, classifier, ladder) in the live agent | **[confirm]** `agent/scam.py` exists and is tested, but on Oct 24 `agent/main.py` did not yet call `ScamGuard(...).attach(agent)`. Check that it is wired before rehearsing Call 2 |
| Wellbeing guard in the live agent | **[confirm]** Same as above for `agent/wellbeing.py` |
| Payments | Mock rail (`PAYMENT_RAIL` unset). Visa is never called. Say "sandbox-ready" only after visa.md's checklist passes |
| Search | Cached fixtures (`SEARCH_MODE=fixtures`). Apify live search has never run |
| Dashboard | Runs locally (`npm run dev`); Vercel deploy optional and not done |

## T-minus 2 hours: accounts and data

- [ ] **Margaret's phone.** A consenting teammate's phone. Its number in E.164 is `DEMO_CALLER_PHONE` in Convex. Turn off "hide caller ID" on this phone.
- [ ] **Dana's phone.** A second teammate's phone, set as `DEMO_FAMILY_PHONE` in Convex. Without it the seed creates no family contact: the agent says "your family" instead of "Dana", and **no alert call can ring**.
- [ ] **Alert agent configured** in Cartesia, with `ALERT_AGENT_ID`, `ALERT_FROM_NUMBER_ID`, `ALERT_SECRET` set in Convex and as the webhook tool secret ([setup.md](../setup.md), "alert agent"). Place one test alert to Dana's phone and say "yes"; `alerts.decision` must read `approved`. **[confirm]**
- [ ] `ALERT_RING_TIMEOUT_SECONDS=30` (default).
- [ ] Push the backend: `cd dashboard && npx convex dev --once`.
- [ ] `npx convex env list` shows `AGENT_SECRET`, `ALERT_SECRET`, `DASHBOARD_ACCESS_KEY`, `DEMO_CALLER_PHONE`, `DEMO_FAMILY_PHONE`, `ANTHROPIC_API_KEY` (memory writer and summaries need it). `PAYMENT_RAIL` unset or `mock`.
- [ ] `agent/.env` has `SEARCH_MODE=fixtures` so Call 1 prices are guaranteed ($8.97 / $15.48 / $12.48).
- [ ] **Seed and reset:** `npx convex run seed:demo '{"reset":true}'`. Time it; Gate 4.6 wants under 1 minute.

### Seeded memory to check on the Memory screen

From `fixtures/household.json`. Each fact has the caller's own words as evidence.

| Fact | Used in |
|---|---|
| Granddaughter Lily had a piano recital on Saturday | Call 1 opener ("How did Lily's recital go on Saturday?") |
| Margaret likes medium-roast coffee in the big can | Call 1 "my coffee" (favorite `demo-coffee-big`, $12.48) |
| Grandson Tyler is at college in Ohio | Q&A or the S4 bail variant |
| Margaret planted tomatoes last month | Call 3 (backup only) |
| Dana has been busy lately | Call 3 (backup only) |

Limits: $50 per order, $200 a month, Walmart only. Sharing: chat transcripts off, mood notes off.

## T-minus 1 hour: machines

- [ ] **Demo laptop** plugged in, sleep disabled. Start the agent: `caffeinate -i agent/.venv/bin/python harness/local_demo.py`. Wait for "Local voice agent and HTTPS tunnel are ready." A new tunnel hostname can take up to 90 s to resolve.
- [ ] **Dashboard:** `cd dashboard && npm run dev`, then open `http://localhost:3000/live#key=<DASHBOARD_ACCESS_KEY>`. On first open, pick "Dana" as the family member on this device.
- [ ] **Big screen layout** (DSH-5, §17.1): browser full screen, zoom to 125–150% so the back row can read it. Keep three tabs ready, in this order:
  1. **Live calls** (transcript, per-turn latency badges, scam panel)
  2. **Memory** (facts with evidence and source call)
  3. **Developer** (p50/p95, cache hit rate, cost per call)
  Also keep **Orders** and **Alerts** one click away in the nav.
- [ ] **Developer panel numbers.** Voice-to-voice needs both `speechEndAt` and `ttsFirstAudioAt` on turns. On Oct 24 the agent logged `ttsFirstAudioAt` but not `speechEndAt`, so the voice-to-voice tile may show a dash. **[confirm]** If it does, show the LLM-stage tile instead and say "model time to first word" on stage, not "voice to voice".
- [ ] Hide the Convex dashboard, terminals and any `.env` window from the projected screen. Turn off notifications (Focus mode) on the laptop and both phones.
- [ ] **Smoke call:** call from Margaret's phone and hang up after the greeting. Live calls must show the call within about 1 s and the greeting must say "Hi Margaret". If it shows an unknown caller, fix `DEMO_CALLER_PHONE`. Then **reseed**, because the smoke call used up the recital follow-up.

## Venue noise test (§20 risk: hall noise)

Do this on the actual stage or table, at the time slot's noise level if possible.

- [ ] Margaret's phone on **speaker**, held by a teammate 30 cm from the speaker's mouth. Run Call 1 once.
  - Pass: no turn mis-heard, no extra replies to background speech, no cut-offs.
- [ ] Watch the Live calls transcript for phantom caller turns (hall chatter transcribed as the caller). Two or more in one call is a fail.
- [ ] If speaker fails: **handset fallback.** The judge (or teammate) holds the phone to their ear and speaks normally. The room hears the agent through the dashboard transcript only, so narrate briefly. Run Call 1 once in handset mode and confirm it passes.
- [ ] Optional: a small clip-on mic or Bluetooth speaker paired to Margaret's phone so the room hears the agent. Test pairing once; if it adds lag or echo, drop it.
- [ ] Note the result here: speaker / handset / both, and how many phantom turns.

| Time | Mode | Call | Phantom turns | Cut-offs | Pass |
|---|---|---|---|---|---|
| | | | | | |

## Backup video

- [ ] The recorded video (see [video.md](video.md)) is on the demo laptop's desktop as a local file, not only on a streaming site. Test that it plays offline, with sound, on the projector.
- [ ] A second copy is on a teammate's laptop or a USB stick.

## Five minutes before going on

- [ ] `npx convex run seed:demo '{"reset":true}'` (do not reset while a call is live).
- [ ] Agent terminal shows no errors; tunnel still up (`/status` returns OK in the launcher log).
- [ ] Dashboard Live calls on screen, Orders shows "No orders yet" and "$0.00 of $200.00".
- [ ] Both phones charged above 50%, ringers **on** for Dana's phone (the room should hear it ring), Do Not Disturb **off** on Dana's phone.
- [ ] The judge knows they are "Margaret", and the card with the Call 2 line is ready (see [rehearsal.md](rehearsal.md)).
- [ ] Backup video open and paused on the first frame.

## Acceptance (#43)

- [ ] A call from Margaret's phone is recognized and greeted by name.
- [ ] Dana's phone rings with the scam alert call. **[confirm]**
- [ ] Calls 1 and 2 work in the venue on speakerphone, or the handset fallback works.
- [ ] Backup video is on the demo machine.
