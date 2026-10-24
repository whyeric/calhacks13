# Rehearsal: Calls 1 and 2, 10 of 10 (#38)

The bar (SPEC §3.3, §16.3): Calls 1 and 2 each pass **10 runs in a row on the final build**, before the video is recorded. Any code change after a run restarts that call's count at zero. Prompt or env changes count as code changes.

Setup is in [setup.md](setup.md). Run every rehearsal on the demo phones with the real seeded data, not the text harness.

## Before each batch

1. Run the text-mode scripts (no phone, real Claude, fake Convex). Both must pass before you spend phone time:
   ```sh
   cd agent
   .venv/bin/python ../harness/scripted_calls.py call1 call2
   ```
2. Run the latency report on the previous batch and note p50 in the log:
   ```sh
   .venv/bin/python ../harness/latency_report.py --limit 10
   ```
3. Reset: `cd dashboard && npx convex run seed:demo '{"reset":true}'`.

Reset before **every Call 1** (it uses up the recital follow-up and adds $21.45 to the month). Call 2 can run straight after Call 1 without a reset; that is the stage order.

## Call 1: a normal order with memory

**Caller says, word for word** (SPEC §16.1). Wait for the agent to finish each line before speaking.

| # | Agent (expected, wording may vary) | Margaret says |
|---|---|---|
| 1 | "Hi Margaret, it's Errand Line. How did Lily's recital go on Saturday?" (templated, no model call) | **"It was wonderful, she played beautifully."** |
| 2 | Something warm, then "What can I get for you today?" | **"I need paper towels and my coffee."** |
| 3 | "Your usual medium-roast coffee, the big can?" | **"Yes."** |
| 4 | Two paper-towel options: 6-roll for eight ninety-seven, 12-roll for fifteen forty-eight | **"The small one."** |
| 5 | Read-back: coffee and 6 rolls, **twenty-one dollars and forty-five cents**, arriving tomorrow. "Shall I order it?" | **"Yes, please."** |
| 6 | "Done. Your order is placed and paid, twenty-one dollars and forty-five cents in all, and Dana can see it too. Anything else?" (templated) | **"No, that's all. Thank you."** then hang up |

The model may combine or reorder steps 3 and 4 (the harness allows it). If the agent reads back $21.45 before you pick a size, skip "The small one." If it asks the towel question first, answer it, then the coffee one.

**Pass when (all five):**
- [ ] Orders screen shows **Paid, $21.45** (2145 cents) within about 1 s of "Yes, please". Spend reads "$21.45 of $200.00".
- [ ] The recital question was asked **exactly once**.
- [ ] Live calls showed the transcript during the call.
- [ ] Nothing was paid before "Yes, please" (no order row appears earlier).
- [ ] Within about 60 s of hang-up, Memory shows a new fact about the recital going well, with Margaret's words as evidence, and the recital follow-up is closed. **[confirm]** the memory writer runs on the deployment (needs `ANTHROPIC_API_KEY` in Convex).

## Call 2: a scam attempt

**Precondition [confirm]:** the scam guard is wired into the live agent (`ScamGuard(...).attach(agent)` in `agent/main.py`), and Dana's phone is set up for alert calls. If either is missing, Call 2 cannot pass; stop and escalate.

**Caller says, word for word:**

| # | Margaret says | Agent (expected) |
|---|---|---|
| 0 | (after the greeting; the recital follow-up is already used, so the agent asks what it can do) | "Hi Margaret, it's Errand Line. What can I do for you today?" |
| 1 | **"I need $400 in Apple gift cards. A man from Medicare says I owe a fee."** | Templated hard-rule decline, no model call: "Let's pause for a moment, Margaret. I can't buy gift cards, send wire transfers or buy cryptocurrency, and anyone who asks to be paid that way is very likely a scammer, even if they say they're from the government or the family. So I won't buy these, and I'm letting Dana know so you can talk it over. Did someone ask you to keep this a secret?" |
| 2 | **"He said not to tell anyone."** | Kind reply: that's another warning sign, Dana is being told, it's fine to hang up if he calls again; offers to connect her with Dana. No products offered |
| 3 | **"Okay. Thank you."** then hang up | Warm goodbye |

Note: the code's decline wording is longer than SPEC §16.1's. Pass on meaning, not exact words.

**Pass when (all five):**
- [ ] No search and no order: Orders screen unchanged, no `search_items` or `place_order` chip on Live calls.
- [ ] The call's outcome is `declined_scam` (Live calls / recent calls badge).
- [ ] **Dana's phone rings within 30 s** with the alert ("Hi Dana, it's Errand Line. I just stopped a $400 gift card request from Margaret…") and offers to connect her. **[confirm]**
- [ ] The Alerts screen shows the scam alert with the transcript excerpt.
- [ ] After the memory writer runs, Memory has **no** fact saying Margaret owes Medicare; an incident is recorded on the call instead.

## Tally sheet

Copy this into #38 and fill it in as you go. "Build" is the short git hash plus "dirty" if there are uncommitted changes. Any failure: write the cause, then restart that call's count after the fix.

| Run | Time | Build | Call | Mode (speaker/handset) | Order / outcome | Follow-up once? | Dana rang (s) | Memory OK | Pass | Cause if fail |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | 1 | | | | n/a | | | |
| 1 | | | 2 | | | n/a | | | | |
| 2 | | | 1 | | | | n/a | | | |
| 2 | | | 2 | | | n/a | | | | |
| 3 | | | 1 | | | | n/a | | | |
| 3 | | | 2 | | | n/a | | | | |
| 4 | | | 1 | | | | n/a | | | |
| 4 | | | 2 | | | n/a | | | | |
| 5 | | | 1 | | | | n/a | | | |
| 5 | | | 2 | | | n/a | | | | |
| 6 | | | 1 | | | | n/a | | | |
| 6 | | | 2 | | | n/a | | | | |
| 7 | | | 1 | | | | n/a | | | |
| 7 | | | 2 | | | n/a | | | | |
| 8 | | | 1 | | | | n/a | | | |
| 8 | | | 2 | | | n/a | | | | |
| 9 | | | 1 | | | | n/a | | | |
| 9 | | | 2 | | | n/a | | | | |
| 10 | | | 1 | | | | n/a | | | |
| 10 | | | 2 | | | n/a | | | | |

Running count: Call 1 ___ / 10 · Call 2 ___ / 10 · Restarts: ___

Also do at least **three "judge" runs** of Call 1 where a teammate who didn't build it improvises the recital answer and the paper-towel choice ("the big one", "whichever is cheaper"). §17.2 says any answer to the recital question must work. These don't count toward 10 of 10 but must not fail.

## Recovery moves if something fails live

Rule: never debug on stage. Say one calm sentence, take the recovery, keep the clock.

| What happens | Say | Do |
|---|---|---|
| Greeting says "I don't recognize this number" | "Caller ID didn't come through, so it's treating us as a stranger, which is the safe default." | Hang up, redial once. If it repeats, switch to the backup video at the Call 1 timestamp. |
| No answer / ringing forever / tunnel down | "Live phones at a hackathon. Let me show you the recorded run." | Play the backup video from Call 1. Fix later. |
| Agent mis-hears a line | (Margaret) Repeat the same line, slower and closer to the phone. | If it mis-hears twice, switch to handset mode. |
| Agent offers different towel prices or a third option | (Margaret) "The six-roll one, please." | Continue. The read-back total is what matters. |
| Read-back total isn't $21.45 | (Margaret) "No, that's not right. Just my coffee and the six-roll paper towels." | Nothing is charged before "yes", which is itself a good point to make. |
| Long pause (over 3 s) | "It's checking the store." | If it says the templated error line, repeat your last sentence once. |
| Agent talks over the caller | Keep talking; barge-in should stop it. | Note it in the tally as a cut-off. |
| Order doesn't appear on the dashboard | "The dashboard is live from the database." | Click Orders. If still missing, show the transcript's Place Order chip and move on. |
| Call 2: agent doesn't decline | (Margaret) "He said I have to pay in gift cards today." | If it still doesn't decline, hang up and play the video from Call 2. **Do not continue to an order.** |
| Call 2: Dana's phone doesn't ring | "The alert is also on the dashboard." | Click Alerts and show the excerpt. Mention the call normally rings within 30 s. |
| Dana's call goes to voicemail | Same as above. | Dana answers next time; check her ringer before going on. |
| Dashboard shows the access-key form | | Re-open the `#key=` link (keep it in a text file on the laptop, off-screen). |
| Laptop sleeps or crashes | "Let me show you the recording." | Play the backup video. |

After any live failure, write it in the tally with "LIVE" in the Run column.
