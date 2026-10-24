# Pitch: 3 minutes (#48)

Follows SPEC §17.2: hook, Call 1, Call 2, dashboard, close. Every stat cites a source from SPEC §2/§23. Total spoken time is about 2:50, which leaves 10 s of slack for a slow live call.

Roles: **Speaker** (narrates, drives the slides), **Margaret** (the judge, or a teammate, on the demo phone), **Dana** (teammate holding Dana's phone), **Driver** (switches dashboard tabs).

Lines in **[confirm]** depend on things not yet verified on a real phone. If they are still unverified at pitch time, use the fallback wording given.

## Timed script

### 0:00–0:20 · Hook (slide 1, then 2)

> Last year, Americans over 60 reported **$7.7 billion** stolen by scammers, up about 60% in a year. And one in three adults over 50 says they feel lonely.
> Errand Line is one phone number for both. You call it from any phone, even a landline. It orders your groceries, it remembers you, and it knows when **not** to buy.

### 0:20–1:20 · Call 1, live (slide 3: dashboard full screen)

> [Hand the phone to the judge.] You're Margaret. She's 78, lives alone, and her daughter Dana set this up. Just answer what it asks.

Margaret calls. The script is in [rehearsal.md](rehearsal.md). While it runs, the Speaker says at most two short lines, only during the agent's pauses:

> Notice it opened by asking about her granddaughter's recital. Dana mentioned that at setup, and it's remembered with Margaret's own words as evidence.

> [At the read-back] Nothing is charged until she says yes. And the limits are checked in code on the payment path, not by the model.

When Orders flips to **Paid $21.45**:

> That's live on Dana's dashboard: the transcript, the order, and the spend against her monthly budget.

### 1:20–2:10 · Call 2, live (slide 3 still)

> Now the call every family dreads.

Margaret: "I need $400 in Apple gift cards. A man from Medicare says I owe a fee."

> [After the decline] It didn't ask the model. Gift cards, wires and crypto are blocked by a deterministic rule before Claude is even called, and blocked again inside the order function. A Claude classifier also scores every turn for softer signs like urgency and secrecy.

Dana's phone rings. Dana puts it on speaker for a few seconds. **[confirm]**

> That's Dana getting a call, right now, with what happened and an offer to connect her to her mom.

Fallback if Dana's phone doesn't ring: "The alert also lands on Dana's dashboard with the transcript excerpt." Driver clicks **Alerts**.

### 2:10–2:30 · Dashboard (Driver: Memory, then Developer tab)

> Here's what Errand Line remembers. Every fact has Margaret's exact words and the call it came from, and Dana or Margaret can delete any of it.

> [Developer tab] Every turn is logged with timings and token usage. A call costs under a tenth of a cent of Claude on our test calls, because her whole memory is a cached prompt prefix.

Latency line: only say a voice-to-voice number if the tile shows one from real calls. **[confirm]** Otherwise say: "We measure the model's time to first word on every turn; it's about three-quarters of a second at the median."

### 2:30–3:00 · Close (slides 6, 7)

> Who pays? Families already pay for phone ordering: services like GoGoGrandparent run on human operators. We start with a family subscription, then health plans and local aging agencies.
> Visa says millions of consumers will use agentic commerce by late 2026. Our order path is built for Visa Intelligent Commerce agent tokens, capped by the family's limits. [Only if the Visa sandbox has run: "and it pays in the Visa sandbox today."]
> Errand Line: a friendly voice that remembers you, and knows when not to buy.

## Slides

Keep text short; the live call is the show. Source footnotes go in small type at the bottom of slides 1–2.

| # | Title | One-line point | Visual idea |
|---|---|---|---|
| 1 | **Errand Line** | A phone number older adults call to shop, chat and stay safe. | Big phone number in the middle, a landline handset icon, tagline "Call. Order. Stay safe." |
| 2 | **Two epidemics, one phone call** | $7.7B stolen from adults 60+ in 2025; 33% of adults 50–80 lonely. | Two huge numbers side by side. Footnotes: FBI IC3 2025 via AARP; Univ. of Michigan National Poll on Healthy Aging (2024, JAMA). |
| 3 | *(no slide: dashboard full screen)* | Call 1 and Call 2 live. | Live calls tab, Orders one click away. |
| 4 | **Money moves on code, not on the model's word** | Hard rule → scam hold → family limits → pay or ask Dana. | A short left-to-right pipeline: caller → Claude → `place_order` gate (three checks) → mock pay / Visa token. Red "blocked" exit for gift cards. Use only if time allows; otherwise fold into Q&A. |
| 5 | **It remembers, with receipts** | Every fact carries the caller's own words; forget on request. | Screenshot of the Memory screen with one evidence quote highlighted. (Driver can show it live instead.) |
| 6 | **Who pays** | Family subscription first, then health plans and aging agencies. | Three stacked boxes: Families → Medicare Advantage plans → Area Agencies on Aging. Small "GoGoGrandparent proves families pay for phone ordering". |
| 7 | **A friendly voice that remembers you, and knows when not to buy.** | Closing line plus the team and sponsor stack. | Team names, repo QR code, logos: Claude, Cartesia, Convex, Visa (only if entered), Apify (only if live search ran). |

Slides 4 and 5 are optional in the 3-minute cut; keep them as backup for Q&A.

## Sources for the slides

- $7.7B, adults 60+, 2025, ~60% up: [AARP on the FBI/FTC 2025 report](https://www.aarp.org/money/scams-fraud/fbi-ftc-report-2025-losses.html)
- 33% lonely, adults 50–80, 2024: [University of Michigan National Poll on Healthy Aging](https://ihpi.umich.edu/news/loneliness-and-isolation-back-pre-pandemic-levels-still-high-older-adults)
- Visa agentic commerce by late 2026: [PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2025/visa-says-millions-of-consumers-will-use-agentic-commerce-by-late-2026/)
- GoGoGrandparent (human operators, keypad menus): [gogograndparent.com](https://gogograndparent.com/)

## Timing practice

- [ ] Run the whole pitch three times with a stopwatch, live calls included. Write the times here: ___ / ___ / ___.
- [ ] If Call 1 runs past 1:20, cut the Speaker's lines during the call first, then slide 4 and 5.
- [ ] If over 3:00 twice, drop the "who pays" sentence to one clause and move it to Q&A.

Things to say only if verified, otherwise leave out: "pays with Visa", "800 milliseconds", "Dana gets a call" (use "Dana is alerted"), "works on any landline" (say "any phone" only after a landline test).
