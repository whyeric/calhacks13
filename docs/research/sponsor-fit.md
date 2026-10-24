# Research: sponsor fit for Meta, Microsoft and Creao

Issue #7 · SPEC §18 prize map (Meta "Check", Microsoft "Stretch", Creao "Check") · §21 sponsor questions (D, Sat morning).
Researched 2026-10-24. **Caveat:** the Devpost prize page (https://cal-hacks-13-0.devpost.com/prizes) is behind a Cloudflare challenge and could not be fetched directly. Prize details below come from search-engine snippets of that page and are marked **(snippet)**. Confirm them on Devpost in a browser and with the sponsor reps before acting on them. The issue says this is a questions-only task: **build nothing for these prizes**.

## Summary

| Prize | Listed reward | Fit | Recommendation | Extra effort |
|---|---|---|---|---|
| Meta: Bringing People Closer Together with AI | Invite to Round 2 at Meta (Menlo Park, travel covered) (snippet) | **Strong** on the story; check with the reps | **Enter**, if the reps don't require Meta tech | ~30 min (a Devpost paragraph and a pitch line) |
| Microsoft: Built for the Real World | $3,800 cash + a Surface laptop per member (snippet) | **Good**: a real user need, and the judging is about applicability | **Enter** | ~30–45 min (a Devpost section; no build) |
| Creao: Best AI-First Disruptor | SPEC says $3,000 + perks; a snippet says **$8,760** cash + mentorship (conflict, unverified) | **Likely requires building on Creao** | **Skip**, unless the reps say no Creao build is needed | 0 if skipped; 3–6 h+ to integrate Creao (not worth it) |

## Meta: "Bringing People Closer Together with AI"

- **Verified:** the track name, and that it's listed for Cal Hacks 13.0 (snippet of the Devpost page). Reward: an invitation to Round 2 at Meta's Menlo Park campus, with travel and accommodation (snippet).
- **Not found:** track-specific judging criteria, and whether Meta products (Llama, WhatsApp, Messenger, Ray-Ban Meta) are required.
- **Our fit:** the product's measure of success is *more human contact* (§14.3). Connect nudges (CMP-4, Call 3) get Dana to call Margaret. Alert calls bring the family in at the moments that matter (scams, approvals). The memory opener ("How did Lily's recital go?") is the agent being a warm link, not a replacement. §17.3 already answers "Aren't you replacing family with an AI?"
- **Risk:** if the judges expect Meta tech, we don't use any, and adding Llama would contradict the Anthropic-core story (§18).
- **Question for the reps:** "Does a phone agent for older adults that nudges family to call, and loops them in on scams and approvals, fit the track? Is using a Meta model or platform required?"
- **What's needed to enter:** select the track on Devpost and write one paragraph framing Call 3 and the connect nudge as the centrepiece. Optionally put the family-connection metric in the pitch ("success = more calls from family, not more minutes with us").

## Microsoft: "Built for the Real World"

- Reward: $3,800 cash and a Microsoft Surface laptop per team member, plus mentorship (snippet).
- **Judging (snippet; possibly the general Cal Hacks criteria rather than Microsoft-specific):** Application (who it helps, why they'd adopt it) · Intentionality (purposeful design for the target user) · Functionality (a smooth live demo **and a video on Devpost for asynchronous sponsor judging**) · Creativity · Technical complexity.
- **Our fit:** a clear user (older adults whose adult children manage errands), a real cost of the problem (§2: fraud losses, loneliness), real constraints taken seriously (limits enforced in code, honest AI disclosure, no real money, a patient turn-taking design). Microsoft Azure use is **not** required as far as we could find, but that is **unverified**. Ask.
- **Question for the reps:** "What do the judges want to see beyond the general criteria? Is any Microsoft technology expected?"
- **What's needed to enter:** a Devpost section on real-world adoption (who pays: a family subscription, then health plans or aging agencies, §21 business model), the safety design, and the demo video (already planned, §17.2). No build.

## Creao: "Best AI-First Disruptor"

- **What Creao is (verified, https://creao.ai/):** a platform that "builds AI agents that run your work", meaning no-code or low-code business agents that plug into tools with OAuth or API keys. A public project using Creao sends agent context through "CREAO's API trigger" (snippet), which suggests the sponsor expects Creao agents in the build.
- **Reward conflict:** §18 lists "$3,000 cash plus perks". A Devpost snippet lists "1st Place … $8,760 in cash, plus product mentorship, founder meetings, and launch support". Treat both as unverified.
- **The spec's rule:** "Only if it doesn't require building on Creao" (§18, §21). Every signal we found points to Creao agents being expected. Our architecture (self-hosted Line agent, Claude via the Anthropic SDK, Convex) has no natural place for a Creao agent. Bolting one on (for example, a post-call summary agent) would duplicate the Convex memory writer and add a new dependency the night before the deadline.
- **Question for the reps:** "Does the AI-First Disruptor prize require building on Creao?"
- **Recommendation:** **skip** unless the answer is an unambiguous "no". If no, enter with zero build work (the same Devpost text as Microsoft, framed as an AI-first replacement for phone-order services such as GoGoGrandparent).

## Process (Sat morning, ~45 min total)

1. Visit the three sponsor booths, or the Cal Hacks Discord sponsor channels, with the questions above. Note who answered and when.
2. Open the Devpost prizes page in a browser and confirm each reward and any "must use" rule. Update §18 if the Creao amount differs.
3. Record go / no-go per prize on #7, and pass the result to the "Select prize tracks on Devpost" issue.
4. Deadline check: submissions are due **Sun Oct 25, 09:00 PT** (snippet; matches §19.2's 08:30 internal target).

## Sources

- Cal Hacks 13.0 Devpost (prizes; fetch blocked, used via search snippets): https://cal-hacks-13-0.devpost.com/
- Cal Hacks site (sponsor logos only, no track details): https://www.calhacks.io/
- Creao: https://creao.ai/
- SPEC §18 prize map, §21 open questions, §14.3, §17.3
