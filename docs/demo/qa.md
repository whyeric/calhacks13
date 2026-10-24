# Judge Q&A prep (#53)

Each answer should take about 20 seconds. Answers are grounded in the code as of Oct 24 (file paths given so anyone can check). **[confirm]** marks a claim that depends on something not yet verified on a real phone or live service; if it is still unverified at judging, use the fallback in brackets.

Rule: if a judge asks about something we didn't build, say so plainly and say what we'd do. Never round "written" up to "works".

The original proposal ("Errand Line: Product Proposal", Oct 23) is not in the repo. **Ask the team for it** and add any of its questions missing here.

## Safety and scams

**"How does it actually stop a scam? Isn't the model just told not to buy gift cards?"**
No. Three layers, and the model isn't the one deciding. First, a deterministic rule in the agent (`agent/scam.py`) catches gift cards, wires and crypto in the caller's words and speaks a templated decline without calling Claude. Second, a Claude Haiku classifier scores every caller turn for softer signs (claimed authority, secrecy, urgency, out-of-pattern spending) in the background, and two weak or one strong signal puts the call on a scam hold. Third, the order function in Convex re-checks the same hard rule and the hold before any money moves (`dashboard/convex/orders.ts`). No prompt can talk past it. [**confirm** the guard is wired into `agent/main.py` before saying "every turn" in the present tense.]

**"What if the scammer says it's a birthday present, or 'you're allowed to buy gift cards for me'?"**
Still blocked. The hard rule ignores the reason, and memory can't change rules: limits and the hard rule live in code, and the memory block is labeled as notes, not instructions. The family can override a block from the dashboard, and every override is logged with who did it.

**"What about false alarms? Margaret mentions her bank and gets refused?"**
One weak signal only triggers a gentle question ("Did someone ask you to buy this?"), and then the order carries on. A passing mention of gift card scams doesn't trip the hard rule; it needs a request. Our target is at most 1 false decline in 20 benign scripts; we have a 20-script benign set (`harness/scam_set.py`). [**confirm** the latest score before quoting it.]

**"Could someone prompt-inject it by speaking a fake system message?"**
Guard notes ride on the next user turn as a `<guard>` tag, and caller speech is sanitized so a caller can't produce one. The conversation is append-only, and money decisions aren't the model's anyway.

**"What does it do if someone says they fell or wants to die?"**
The 911 and 988 lines are templated text, not generated, so they're word-for-word every time ("If you're hurt, please hang up and call 911 now…" / "You can call or text 988 any time…"), and it alerts the family and tells the caller it's doing so (`agent/wellbeing.py`). It is not an emergency service and doesn't call 911 itself. [**confirm** wired and tested on a phone.]

**"Could a scammer call pretending to be Margaret?"**
Today we identify the caller by caller ID only, which can be spoofed. The exposure is capped: orders only ship to Margaret's address, and family limits still apply. A spoken PIN for new numbers is planned, not built. Unknown numbers get a polite explanation and can't order.

## Privacy and memory

**"Isn't it creepy that it remembers?"**
It only remembers what the caller said, and every fact shows her exact words as evidence and the call it came from. She can say "forget that", and the family can see and delete anything on the Memory screen. Chat-only transcripts are hidden from the family unless Margaret agrees, but scam alerts always go through.

**"What if it remembers wrong, or makes something up?"**
After each call, a Claude memory writer proposes facts, and code drops any fact whose evidence doesn't match something the caller actually said, caps it at 10 facts per call, and quarantines claims made during a scam call as an incident instead of facts (`dashboard/convex/memory.ts`, `memoryRules.ts`). The prompt tells the agent to ask rather than assert when unsure, and corrections supersede old facts.

**"Who can see the dashboard?"**
For the demo, a long shared access key checked inside every Convex function, not just the web page, so the browser can't read data without it (`docs/decisions/dashboard-access.md`). Clerk sign-in is wired on the server side as the upgrade path. We'd rotate the key after the event.

**"What data do you keep, and for how long?"**
This weekend it's seeded demo data only, no real older adults. No card numbers are spoken or stored; payment references only. Retention is an open decision; we'd set it with a pilot partner.

## Latency

**"How is it fast with all that memory?"**
The memory is a cached prompt prefix. While the templated greeting plays, we pre-warm Claude's cache with the exact request settings, so the first real turn reads it from cache. In our harness, 11 of 11 calls hit the cache on the first turn. Everything streams, and speech starts on the first clause.

**"So how fast is it?"**
Honest numbers: the model's time to first word is about 770 ms at the median and 1.7 s at p95 on conversational turns, measured from a laptop on 56 scripted turns (`docs/latency.md`). Our target is 800 ms voice-to-voice, and adding the speech stages we're projecting about 1.3 s, so we're not there yet. The biggest lever is measuring from a server next to the APIs instead of a laptop, then trimming thinking on ordering turns. [If real-call voice-to-voice numbers exist by judging, quote those instead.]

**"Older people pause mid-sentence. Doesn't it cut them off?"**
That's our main turn-taking worry. If a turn ends on "um", "and" or a comma, the agent waits 700 ms more before answering, and we log a cut-off whenever the caller keeps talking within a second of the agent starting. Interrupting is worse than a short pause. We haven't tested it on recordings of older speakers yet.

## Cost

**"What does a call cost?"**
On our scripted test calls, Claude cost under a tenth of a cent per call (mean $0.0008), because Haiku 5.5's cache reads are a cent per million tokens. Our planning estimate for a long call with a full 60K-token memory, the scam classifier and the memory writer is about 3 cents. Phone minutes and speech cost more than Claude does.

**"Why Haiku and not a bigger model?"**
It's the fastest and cheapest, and the things that must never go wrong (money rules, limits, the scam hard rule, 911/988 lines, memory validation) are in code, not in the model. If a test set fails, we raise effort first, then move only that role to Sonnet.

## Payments and Visa

**"Did money actually move?"**
No real money moves. The demo uses a mock payment rail behind the same limits and idempotency checks. Our Visa Intelligent Commerce integration is written against Visa's official sample code (purchase instruction capped at the order total, one-time credentials, confirmation), but we haven't run it against the Visa sandbox because we didn't get credentials (`docs/visa.md`). [If the sandbox run happens, replace this with what it showed.]

**"What stops it double-charging?"**
Every order carries an idempotency key (call ID plus tool call ID). A retried request returns the existing order instead of paying again, and Convex mutations are transactional, so two orders can't both squeeze under the monthly budget. Prices come from the server's catalog; the price the model says is ignored.

**"What happens when an order is over the limit?"**
It's saved as awaiting approval and nothing is charged. The agent tells Margaret it's asked Dana. Dana can tap Approve or Decline on the dashboard, and the first response wins and records who decided. The design also calls Dana for a spoken yes or no. [**confirm** the alert call on a real phone; otherwise say "Dana is alerted on the dashboard".] Margaret doesn't hold on the line yet; she's told she'll hear how it went next call.

## Business and adoption

**"Who pays?"**
The family member is the buyer; the older adult is the user. A family subscription first, since families already pay for phone ordering like GoGoGrandparent, which uses human operators. Then health plans (Medicare Advantage) and local aging agencies, who care about isolation and fraud. The buyer/user split is an assumption we want judges' views on.

**"Why not just use Alexa or a grocery app?"**
Those need a smartphone or a smart speaker plus an account, and we didn't find family limits or scam checks in them. Errand Line works from any phone with no keypad.

**"Aren't you replacing family with an AI?"**
The opposite. It says it's an AI whenever asked, never discourages hanging up, and when Margaret says she misses Dana, it offers to let Dana know she'd love a call. Success means more calls from family, not more minutes with us.

**"What's next?"**
Real-phone testing with older adults and their families, a spoken PIN, Visa sandbox payments, more stores, memory-driven check-in calls, and a pilot with an aging agency, tracking loneliness with a validated short scale.

## Accessibility

**"How is it designed for older callers?"**
No app, no keypad, no screen. One question at a time, at most two options, short sentences, prices said the way people say them ("eight ninety-seven"). A calm voice at 0.9× speed. If the caller goes quiet: "Take your time", then a gentle goodbye. It repeats on request. The voice and speed haven't been tested with older listeners yet; that's the first thing we'd do.

**"Hearing aids, accents, landlines?"**
We haven't tested those. Speech recognition is Cartesia's; the landline test is on our list. [**confirm** before claiming landline support.]

## Practice log

- [ ] Each answer read aloud in under 20 s.
- [ ] One mock round with a teammate who didn't build the answer's area.
- [ ] Before judging, re-check every **[confirm]** and update the answer.
