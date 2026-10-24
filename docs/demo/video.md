# Demo video: shot list and narration (#56)

Target length **2:30** (hard cap 3:00). Record only after Calls 1 and 2 pass 10 of 10 ([rehearsal.md](rehearsal.md)), by Sun 06:00. The video goes on Devpost for remote sponsor judging and is the backup if a live call fails.

Honesty rule: the video shows real calls on real phones with the real dashboard. No re-voiced agent lines, no mocked screens. If a step was not achieved on a phone (for example Dana's alert call), leave it out and say what does happen instead. Cuts between takes are fine; say "recorded live, trimmed for time" in the description.

## Capture setup

- **Screen:** record the dashboard browser window at 1920×1080 with QuickTime or OBS. Zoom the browser to 125% so text survives compression.
- **Call audio:** both sides of the call must be audible. Best option: Margaret's phone on speaker next to a USB mic connected to the recording laptop, in a quiet room. Alternative: record the phone's screen and audio on the phone itself and sync it in the edit (clap at the start of each take).
- **Dana's phone:** a second phone films Dana's phone ringing and her answering on speaker. **[confirm]** the alert call works first.
- **Narration:** record separately afterwards, close to the mic, in a quiet room. Keep it under 150 words per minute.
- Hide the access key, terminal windows, notifications and real phone numbers. Blur any number shown on a phone screen; use only teammates who agreed to appear.
- Reset before each take: `npx convex run seed:demo '{"reset":true}'`.

## Shot list

| # | Time | Picture | Audio |
|---|---|---|---|
| 1 | 0:00–0:12 | Title card: "Errand Line". Then a landline phone or a hand holding a flip phone. | Narration N1 |
| 2 | 0:12–0:25 | Two big stat cards with sources in small type ($7.7B; 1 in 3). | N2 |
| 3 | 0:25–0:32 | Dashboard, Memory screen: the Lily recital fact with its evidence quote. | N3 |
| 4 | 0:32–1:20 | Split screen: phone on the left, dashboard Live calls on the right, transcript filling in. Call 1 in full, trimmed only in silences. | Live call audio. N4 over the first second of the read-back, ducked under the call |
| 5 | 1:20–1:28 | Zoom on Orders: **Paid $21.45**, budget "$21.45 of $200.00". | N5 |
| 6 | 1:28–1:55 | Split screen again: Call 2. The templated decline plays in full. | Live call audio, then N6 |
| 7 | 1:55–2:08 | Dana's phone ringing; Dana answers on speaker and hears the alert. Cut to the Alerts screen with the excerpt. **[confirm]** If the alert call isn't working, show only the Alerts screen. | Alert call audio, then N7 |
| 8 | 2:08–2:20 | Developer tab: latency tiles, cache hit rate, cost per call. Then Memory showing the new recital fact written after Call 1. | N8 |
| 9 | 2:20–2:35 | Simple architecture diagram: phone → Cartesia → our agent → Claude; Convex gate for money; dashboard. | N9 |
| 10 | 2:35–2:45 | Closing card: tagline, repo URL, team names. | N10 |

## Narration

**N1.** This is Errand Line: a phone number older adults call to order groceries, have a chat, and stay safe from scams. It works from any phone, no app.

**N2.** Last year, Americans over 60 reported seven point seven billion dollars stolen. And one in three adults over fifty feels lonely. We built one phone call that helps with both.

**N3.** Margaret's daughter Dana set this up and mentioned Lily's piano recital. Errand Line remembers it, with Margaret's own words as evidence.

**N4.** Nothing is charged until Margaret says yes, and the family's limits are checked in code before any money moves.

**N5.** Dana sees the order the moment it's placed. Payments here run on a mock rail with the same limits; no real money moves.

**N6.** Gift cards, wires and crypto are blocked by a fixed rule before the AI is even asked, and checked again in the order system. A Claude classifier watches every turn for softer warning signs.

**N7.** Dana gets a call right away, with what happened and an offer to connect her to her mom. *(If no alert call: "Dana is alerted right away, with the part of the call that matters.")*

**N8.** Every turn is logged with timings and cost. Margaret's whole memory is a cached prompt, so a call costs a fraction of a cent of Claude. After the call, a Claude memory writer saved how the recital went, and code checks each fact against what she actually said.

**N9.** Under the hood: a Cartesia phone number and voice, our own agent calling Claude Haiku 5.5 directly so we control caching, and Convex for the dashboard, memory and the one function that can move money.

**N10.** Errand Line. A friendly voice that remembers you, and knows when not to buy.

Narration word count is about 300 words, about 2:00 of speech, leaving room for the live call audio.

Do not narrate: "pays with Visa" (unless the sandbox run happened), "under 800 milliseconds" (unless real-call voice-to-voice shows it), "tested with older adults".

## Review checklist

- [ ] Length 2:00–3:00.
- [ ] Every agent line in the video is real call audio from a passing run.
- [ ] Call 1 shows the paid $21.45 order; Call 2 shows the decline and the alert (call or dashboard).
- [ ] Memory and latency panels appear.
- [ ] Audio is clear on laptop speakers and on phone speakers.
- [ ] No keys, access-key URLs or real phone numbers visible.
- [ ] Exported as MP4 (H.264), uploaded to YouTube as **Unlisted or Public** (Devpost needs a YouTube, Vimeo or Youku link), and checked while logged out.
- [ ] Local copy on the demo laptop and a USB stick.
