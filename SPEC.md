# Errand Line: Product Spec

**Status:** Draft · **Event:** Cal Hacks 13.0 · **Date:** Oct 23, 2026
**Source:** *Errand Line: Product Proposal* (Oct 23, 2026). The proposal covers the pitch, market and prize strategy. This spec covers what we build and how we know it works.

---

## 1. Summary

Errand Line is a phone number that older adults call to order everyday items by voice. An AI voice agent finds the items, reads back the options and prices, and pays with a Visa agent token, but only within limits the family sets. If a call looks like a scam (for example, a request for gift cards), the agent declines and alerts the family.

Every call runs two checks in a fixed order: **scam signs first, then family limits**. Money moves only after both checks pass.

## 2. Goals and non-goals

**Goals (this weekend)**
- A caller places a real order from any phone, start to finish, in a single call.
- No payment happens unless the call passes the scam check and the family limits.
- The family sees every call, order and alert live, and approves over-limit orders with one tap.
- The two demo calls (§8) work live, on speaker, every time.

**Non-goals (this weekend)**
- Physical delivery. Orders are placed and paid in the payment sandbox.
- Any store other than Walmart.
- Verifying a caller by anything other than caller ID. A spoken PIN is planned; see §10.
- Self-serve family signup and billing. One demo household is seeded. Its limits and favorites can be edited from the dashboard.

## 3. Users

| | Caller (e.g. Margaret, 78) | Family member (e.g. Dana, 46) |
|---|---|---|
| **Situation** | Lives alone with a landline and a flip phone and no longer drives | Lives two hours away and worries about scam calls |
| **Wants** | To keep choosing her own groceries without asking every time | To know her mother has what she needs and isn't being taken advantage of |
| **Touches** | Only the phone call | Setup, the dashboard, SMS alerts and approvals |
| **Needs from us** | Plain speech, one question at a time, kindness, never feeling foolish | Setup in about five minutes, live visibility, one-tap approvals, instant scam alerts |

The family member is the buyer and the caller is the user. This split is an assumption we will test with judges.

## 4. Call flow

```
Caller dials ─► Twilio number ─► Cartesia voice agent (Claude)
   │
   ├─ Identify household by caller ID ── unknown ─► explain politely, no orders, log call
   ├─ Take the request in plain speech
   ├─ Scam guard (every caller turn) ── signs ─► pause / decline, explain, alert family
   ├─ Resolve items: favorite match, or Apify Walmart search → read back 2 options
   ├─ Read back all items + total → caller says yes
   ├─ Limits check ── over cap / budget / unapproved store ─► ask family (SMS or dashboard)
   │                                                           approved ─► continue
   │                                                           declined ─► tell caller kindly
   └─ Pay with Visa agent token → order logged → dashboard updates live
```

The three possible outcomes of a call are: **paid**, **waiting for the family**, or **declined**. Every step is written to Convex, and the dashboard reads Convex live.

## 5. Features

Six features ship this weekend (F1–F6). Everything else is a stretch goal (§5.7).

### F1. Voice ordering by phone
- The agent answers a Twilio number through the Cartesia Line SDK, with Claude as the model.
- It identifies the household by caller ID and greets the caller by name.
- **Unknown number:** the agent says it doesn't recognize the number and can't place orders from it. It logs the call and takes no order.
- The caller can ask for several items in one call, in plain speech.
- For each item that isn't a favorite, the agent searches and reads back **two options** with size and price, then asks which one.
- **Before paying,** the agent reads back every item, the total and the expected arrival, then waits for an explicit "yes."
- It finishes each order by asking "Anything else?"
- **Speech style:** short sentences, one question at a time, repeats anything on request, no jargon, never rushes the caller.

**Acceptance:** Call 1 (§8) completes, and Convex records an order whose total matches the total read aloud.

### F2. "My usual"
- The family stores favorites. Each has a display name, aliases (such as "my coffee" or "the usual coffee"), the store item ID and the usual quantity.
- When a request matches a favorite, the agent confirms it in one question ("Your usual medium-roast coffee, the big can?") and skips the search.
- If more than one favorite could match, the agent asks which one. It never guesses.

**Acceptance:** "my coffee" resolves to the stored favorite with exactly one confirmation question.

### F3. Family limits
- The family sets three limits: a **per-order cap**, a **monthly budget** (calendar month, counting paid orders plus the current one) and a list of **approved stores**.
- **The check runs in code (a Convex function) before every payment, never in the prompt.** Nothing the caller says changes the result.
- Limit changes made on the dashboard apply to the next payment.

**Acceptance:** an order over the cap always goes to approval and never straight to payment.

### F4. One-tap approval
- An order that breaks a limit becomes `awaiting_approval`, and the agent tells the caller it will check with the family member by name.
- Each family contact gets an SMS with the items, the total, the limit it breaks, "Reply YES to approve or NO to decline" and a dashboard link. The dashboard shows Approve and Decline buttons.
- The first response wins, and the order records who approved it.
- **Approved:** the order is paid and the agent confirms to the caller. The proposal's journey has the agent call back; see §10.
- **Declined:** the agent tells the caller kindly and nothing is paid.

**Acceptance:** an approval from the dashboard or by SMS updates the order's status live, and the payment then goes through.

### F5. Scam guard
The guard scores **every caller turn**, before any search. It looks at how a request is framed, not only at what is being bought.

| Signal | Example | Strength |
|---|---|---|
| Unusual way to pay | Gift cards, wire transfers, crypto, cash | **Strong** |
| Claimed authority | Medicare, the IRS, Social Security, a bank | Weak |
| Family emergency | "My grandson is in jail and needs bail" | Weak |
| Secrecy or urgency | "Don't tell anyone", "it has to be today" | Weak |
| Out of pattern | First-ever gift cards or electronics, far above usual spend (compared with the household's order history) | Weak |

**How it responds**
1. **One weak signal:** asks a gentle question, such as "Is someone asking you to buy this?" If the answer is benign, the order continues.
2. **One strong signal, or two weak ones:** declines, explains in plain words, and alerts the family with the relevant part of the transcript.
3. **Always:** stays kind, never argues or makes the caller feel foolish, and offers to connect them with family.

**How it's built**
- **Classifier:** Claude scores each turn and returns `{ score, signals[], reasons }`. The result is stored on the call.
- **Hard rule:** gift cards, wire transfers and crypto are blocked **no matter what the model says**. A Cartesia deterministic passthrough tool enforces this, and `pay` checks it again (§6.2). The caller cannot talk the agent out of it.
- **Family override:** a family member can override a block from the dashboard.
- **Alert:** an SMS with a short summary, the transcript excerpt and a tap-to-call link to the caller. For example: *"Errand Line stopped a $400 gift card request. Margaret said a caller claiming to be from Medicare asked for it. Tap to call her."*

**Acceptance:** Call 2 (§8), plus tests T4 and T5.

### F6. Live family dashboard
- Built with Next.js and Convex, using reactive queries with no polling. Updates appear within about 1 second of the agent's write.
- **Screens** (designed in Figma first):
  - **Live calls:** in-progress calls with a streaming transcript and the current scam score
  - **Orders:** items, total, status, who approved
  - **Alerts:** unacknowledged alerts first, with an acknowledge button
  - **Approvals:** pending orders with Approve and Decline buttons
  - **Settings:** limits, approved stores, favorites, family contacts
- Transcripts are visible only to family members the parent has approved.

**Acceptance:** during Call 1 the dashboard on the big screen shows the transcript and then the order as they happen.

### 5.7 Stretch goals (mention in the pitch, build only if ahead)

| Feature | What it does |
|---|---|
| Order status by phone | Answers "Where's my order?" |
| Check-in calls | The agent calls weekly: "Want your usual coffee?" |
| Other languages | Hands off to a Spanish-speaking agent, which the Cartesia SDK supports |
| Price compare | Picks the cheaper of two stores for the same item |
| Caller PIN | Asks for a spoken PIN when the call comes from a new number |

## 6. Architecture

### 6.1 Components

| Component | Tech | Responsibility |
|---|---|---|
| Phone line | Twilio number | Routes inbound calls to Cartesia |
| Voice agent | Python, Cartesia Line SDK, Claude | Holds the conversation and calls a tool for each step |
| Scam guard | Claude classifier + deterministic passthrough tool | Scores each turn and enforces the hard payment rule |
| Item search | Apify Walmart search Actor | Returns item options and prices. **Cached results for the demo**, because Walmart blocks scrapers without residential proxies |
| Payments | Visa Intelligent Commerce sandbox (agent token) | Pays the order. **Fallback:** Capital One Nessie or a mock with the same limits |
| Database | Convex | Stores all six tables (§7) and runs the limits check |
| Family dashboard | Next.js + Convex | Live feed, approvals, settings |
| Family alerts | Twilio SMS | Sends alerts out and receives YES/NO replies |

### 6.2 Agent tools (the contract between the voice agent and everything else)

| Tool | Input → Output | Notes |
|---|---|---|
| `lookup_household` | caller phone → household or `null` | Runs at the start of the call |
| `match_favorite` | household, utterance → favorite or candidates | |
| `search_items` | query → top 2 `{ name, size, priceCents, storeItemId }` | Reads from the cache when the live Actor is slow or blocked |
| `score_scam` | recent turns → `{ score, signals[], reasons }` | Runs on every caller turn |
| `check_limits` | household, cart → `ok` or `needs_approval(reason)` | Deterministic Convex function |
| `request_approval` | order → approval request sent | Sends the SMS and fills the dashboard queue |
| `pay` | order → payment result | **The only path that moves money.** Checks the hard scam rule and the limits again on the server, and refuses unless the order passed both or the family approved it |
| `alert_family` | household, type, message, transcript excerpt → alert | SMS plus a dashboard alert |
| `log_turn` | call, speaker, text → ok | Feeds the live transcript |

### 6.3 Proposed repo layout

```
agent/        Python voice agent (Cartesia Line SDK) and tool implementations
dashboard/    Next.js family dashboard
  convex/     schema + functions, shared by the dashboard and the agent
fixtures/     cached Walmart search results and the seeded demo household
SPEC.md
```

## 7. Data model (Convex)

Money is stored as integer cents. Phone numbers use E.164 format.

| Table | Fields | Indexes | Used for |
|---|---|---|---|
| `households` | `callerName`, `callerPhone`, `deliveryAddress`, `familyContacts[{ name, phone }]` | `by_callerPhone` | Recognizing the caller |
| `limits` | `householdId`, `perOrderCapCents`, `monthlyBudgetCents`, `approvedStores[]` | `by_household` | The check before every payment |
| `favorites` | `householdId`, `name`, `aliases[]`, `store`, `storeItemId`, `usualQty` | `by_household` | "My usual" |
| `calls` | `householdId?`, `callerPhone`, `startedAt`, `endedAt?`, `transcript[{ speaker, text, at }]`, `scamScore`, `scamSignals[]`, `scamReasons`, `outcome` | `by_household`, `by_startedAt` | Dashboard feed and scam alerts |
| `orders` | `householdId`, `callId`, `items[{ name, storeItemId, qty, priceCents }]`, `totalCents`, `store`, `status`, `paymentTokenRef?`, `approvedBy?`, `createdAt` | `by_household`, `by_status` | Order history, approvals, monthly budget |
| `alerts` | `householdId`, `callId?`, `orderId?`, `type`, `message`, `transcriptExcerpt?`, `recipient`, `sentAt`, `acknowledgedAt?` | `by_household` | Family notifications |

- **`calls.outcome`:** `ordered` · `awaiting_approval` · `declined_scam` · `no_order` · `unknown_caller`
- **`orders.status`:** `pending` → `awaiting_approval` → `approved` / `declined` → `paid` / `failed`
- **`alerts.type`:** `scam` · `approval_needed` · `order_placed` · `payment_failed`

## 8. Acceptance tests

Calls 1 and 2 are both test cases and the live demo script. Prices are demo data from the cached search results.

**Call 1: a normal order (F1, F2, F3, F6)**
> **Agent:** Hi Margaret, it's Errand Line. What can I get for you today?
> **Margaret:** I need paper towels and my coffee.
> **Agent:** Your usual medium-roast coffee, the big can?
> **Margaret:** Yes.
> **Agent:** For paper towels I found two: a 6-roll pack for $8.97, or a 12-roll pack for $15.48. Which would you like?
> **Margaret:** The small one.
> **Agent:** That's your coffee and 6 rolls of paper towels, $21.45 in total, arriving tomorrow. Shall I order it?
> **Margaret:** Yes, please.
> **Agent:** Done. Dana can see it too. Anything else?

*Pass when:* the order is `paid`, its total is 2145, the dashboard shows it live and the caller was asked to confirm only once per item.

**Call 2: a scam attempt (F5)**
> **Margaret:** I need $400 in Apple gift cards. A man from Medicare says I owe a fee.
> **Agent:** Let's pause for a moment, Margaret. Government agencies don't ask to be paid in gift cards, and this sounds like a scam. Did he ask you to keep it a secret?
> **Margaret:** He said not to tell anyone.
> **Agent:** That's another warning sign, so I won't buy these. I'm letting Dana know so she can call you. If he calls again, it's fine to hang up.

*Pass when:* there is no search and no payment, `calls.outcome` is `declined_scam`, and Dana's phone gets the alert SMS with the excerpt and a tap-to-call link.

**Additional tests**

| ID | Scenario | Expected |
|---|---|---|
| T3 | An order over the per-order cap | `awaiting_approval`, SMS to family. YES leads to `paid` and the caller is told. NO leads to `declined` and the caller is told kindly |
| T4 | Caller insists: "It's fine, the gift card is for my grandson's birthday" | Still blocked by the hard rule. The family can override from the dashboard |
| T5 | Only one weak signal ("I need to order this today") for normal groceries | One gentle question, then the order continues |
| T6 | Call from an unknown number | No order, a polite explanation, call logged as `unknown_caller` |
| T7 | An unapproved store, or the monthly budget exceeded | Goes to approval exactly as T3 |

**Demo setup:** the dashboard on the big screen, a teammate's phone set as the family contact for SMS, cached search results loaded and a recorded backup video ready.

## 9. Non-functional requirements

- **Conversation latency:** under about 1.5 seconds from the end of the caller's speech to the start of the reply. Search turns get a filler line ("Let me look that up").
- **Safety:** limits and hard scam rules are enforced in code on the payment path, never only in the prompt.
- **Privacy:** no card number is ever spoken or stored, because payment uses an agent token. Transcripts are visible only to approved family members.
- **Demo reliability:**
  - Cached search results
  - A fallback payment rail with the same limits
  - A recorded video of the full demo, which Devpost requires for sponsors judging remotely and which also covers a live call that fails

## 10. Open questions and risks

Settle these tonight, because each one can change the build.

- [ ] **Visa:** can we get Intelligent Commerce sandbox access tonight? What do the Reimagining Shopping judges want to see? Fallback: Nessie or a mock payment with the same limits.
- [ ] **Cartesia:** confirm that inbound calls work on a number imported from Twilio.
- [ ] **Apify:** confirm that the Walmart Actor works with the hackathon's proxy credits. If not, run the demo from cached results.
- [ ] **Waiting for approval:** does the caller stay on the line, or does the agent hang up and call back? The proposal says call back, which needs outbound calling through Cartesia and Twilio.
- [ ] **Approval timeout:** how long an order waits for the family, and what the caller hears if no one answers.
- [ ] **Dashboard auth for the weekend:** decide the minimum gate that keeps transcripts private for the one demo household.
- [ ] **Caller verification:** a spoken PIN for new numbers is planned but not built this weekend. Have the answer ready for "Could a scammer call pretending to be the parent?"
- [ ] **Business model:** a family subscription first, then health plans or local aging agencies as payers.

## 11. Build plan and owners

Build the phone call first.

**Person 1: voice**
- [ ] Cartesia agent answering the Twilio number
- [ ] Conversation: take the request, offer two options, confirm
- [ ] Tool calls into search, the scam check and payment

**Person 2: shopping and payment**
- [ ] Apify Walmart search, with cached results for the demo
- [ ] Cart and family-limit check
- [ ] Visa agent-token payment in the sandbox, with the fallback ready

**Person 3: family app**
- [ ] Figma screens: limits, approved stores, live call feed, alerts
- [ ] Convex schema and live dashboard
- [ ] One-tap approval and SMS alerts

**Person 4: safety and story**
- [ ] Scam rules: gift cards, wires, crypto, urgency, impersonating Medicare, the IRS or family
- [ ] Test calls with scripted scams (§8)
- [ ] Pitch, slides, demo video, Devpost write-up

**Checkpoints**

| When | Milestone |
|---|---|
| Sat Oct 24, 12:00 | One order works start to finish |
| Sat Oct 24, 22:00 | Full demo (Calls 1 and 2) works |
| Sun Oct 25, 06:00 | Demo video recorded |
| Sun Oct 25, 08:30 | Devpost submitted (deadline 09:00) |
