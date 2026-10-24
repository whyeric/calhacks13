# Decision: approval wait (hold vs call-back) and approval timeout

**Status: Proposed. Needs team sign-off.** Issue #89 · SPEC §21 "Waiting for approval" and "Approval timeout" (owner C, due Sat 12:00) · §8.6 APR-1 to APR-4 · §10.6 · test T3/T5.
The numbers below are a **recommended default with rationale**, not agreed values. Tick §21 only after the team agrees.

## Constraints (from the spec and the code)

- Family hears approval requests as an **outbound Cartesia alert call** (§10.6, APR-2). Ring timeout is configurable **5–80 s**; `dashboard/convex/alerts.ts` already reads `ALERT_RING_TIMEOUT_SECONDS` (default **30**) and passes it as `ringing_timeout_seconds`.
- An unanswered alert call leaves the approval open on the dashboard (Approve / Decline buttons). The first response wins (APR-3).
- **Outbound calls to the caller are P1** (§3.2, §7). A call-back to Margaret has no P0 path this weekend.
- Order statuses: `pending`, `awaiting_approval`, `approved`, `declined`, `paid`, `failed`. There is no `expired` status.
- Text messaging is out of scope. It is not an option for reaching either the caller or the family.

## Options

| | A. Hold on the line | B. Call the caller back | C. Release, tell her next call (no hold) |
|---|---|---|---|
| Caller experience | Hears the outcome in the same call | Hangs up, phone rings later | Hangs up not knowing the outcome |
| Needs | Agent polls Convex for the order's decision while holding | Outbound call to the caller (**P1**) plus a second agent flow | Follow-up row so the next call opens with the outcome |
| Meets APR-4 ("confirm to the caller") | Yes, if the family answers in time | Yes | Only on the next call |
| Risk | Long silence for an older caller; Dana doesn't pick up | Out of scope; another outbound flow to build and test | Margaret is unsure whether the order went through |
| Demo / T3 fit | Good: Dana's phone is in the room, decision arrives in ~1 min | Poor: not P0 | Weak: T3 says "the caller is told" |

## Recommendation (proposed)

**A + C hybrid: hold for a bounded time, then release with the order kept open.** No call-back this weekend.

1. On `needs_approval`, the agent says the approval line (below) and offers to hold: "It usually takes about a minute. Would you like to stay on the line?" If she says no, go straight to step 4.
2. While holding, the agent polls the order's status and speaks a short reassurance roughly every **20 s**. The §9.3 silence prompts ("Take your time", end call) are **suspended** during the hold.
3. If a decision arrives within the **hold window**, speak the approve or decline line.
4. If the hold window ends with no decision, speak the timeout line and end the call warmly. The order **stays `awaiting_approval`**, so Dana can still approve it from the dashboard or her alert call.
5. The approval stays open for the **approval validity** period. After that it is set to `declined` with reason "expired" and recorded as a system decision. A follow-up is written either way so the **next call opens with the outcome** ("Dana said yes to your coffee order yesterday, and it's on its way").

### Proposed numbers

| Setting | Proposed default | Rationale |
|---|---|---|
| Alert ring timeout (`ALERT_RING_TIMEOUT_SECONDS`) | **30 s** (already the code default) | Long enough for a phone in a pocket; well under the 80 s max. Assumption (not verified): many US carriers send unanswered calls to voicemail after roughly 20–30 s, so a longer ring adds little |
| Hold window on the caller's line | **90 s** from `needs_approval` | Ring (≤ 30 s) + alert agent reads items, total, limit (~15–20 s) + spoken yes/no (~5–10 s) ≈ 50–60 s, plus margin. Longer than 90 s of hold is hard on an older caller |
| Reassurance interval during hold | **~20 s** | Avoids dead air; fewer than five lines in the whole hold |
| Approval validity (order stays approvable) | **Until 9 pm local the same day**, or 12 h, whichever is shorter | Family often answers later from the dashboard; a stale approval the next week would surprise everyone. For the demo/T3 this never triggers |
| Multiple family contacts | Call all approval contacts **at once**; first answer wins (APR-3) | Calling in sequence would blow the 90 s hold. Demo has one contact (Dana) |

**Why not call-back:** it needs outbound calling to the caller, which is P1, plus a second agent flow and its tests. The hybrid gets the same outcome for the common case (Dana answers within a minute) and degrades to "you'll hear next call" without new infrastructure.

## What the caller hears (exact lines)

`{family}` = the approving contact's first name from `household.familyContacts`; `{reason}` = the `reason` string from `/agent/order`. Prices spoken the §9.2 way.

| Moment | Line |
|---|---|
| `needs_approval` | "{reason} So I've asked {family} to okay it before I buy anything. Nothing has been charged. It usually takes about a minute. Would you like to stay on the line while I wait?" |
| Caller declines to hold | "That's fine. Your order is saved, and {family} can approve it. Nothing is charged unless {family} says yes. I'll tell you how it went next time you call." |
| While holding (every ~20 s, rotate) | "I'm still here. I'm waiting to hear back from {family}." · "Still waiting on {family}. Thanks for your patience." · "{family}'s phone is ringing. I'll let you know as soon as I hear." |
| Approved | "Good news. {family} said yes, and your order is placed. That's {items}, {total} in total, arriving {arrival}. Anything else?" |
| Approved, but payment failed | "{family} said yes, but the payment didn't go through just now. Nothing was charged, and {family} can see it to sort it out." |
| Declined | "{family} would rather hold off on this one, so I haven't ordered it, and nothing was charged. Is there anything else I can help with, maybe something smaller?" |
| Timeout (hold window ends) | "I haven't been able to reach {family} yet. Your order is saved, and nothing has been charged. {family} can still approve it, and if they do, it will go through. I'll tell you how it went next time you call. Is there anything else for now?" |
| Caller asks later in the call | Answer from the order's current status; never guess. |

Tone rules: never imply Margaret did something wrong; name the limit, not a judgment ("over the fifty-dollar limit", not "too expensive"). Never promise a call-back.

## Phase 1 lines for the CORE prompt (`needs_approval`, before hold exists)

Phase 1 has no hold or polling yet, so the agent should state the facts and move on. Lines for `agent/prompts/system.txt` (or a tool-result instruction):

> When `place_order` returns `needs_approval`, do not retry and do not offer workarounds. Say, in one or two short sentences:
> 1. The `reason` from the result, as given.
> 2. "So I've asked {family} to okay it first. Nothing has been charged."
> 3. "Once {family} says yes, it will go through. I'll let you know how it went next time you call."
> Then ask "Is there anything else I can help with?"

Single-line form: *"{reason} So I've asked {family} to okay it first, and nothing has been charged. Once {family} says yes, it will go through."*

Do not say "I'll call you back" or "I'll text you". Do not say Dana "has been called" unless the backend confirms the alert call was placed. "I've asked {family}" stays true, because the approval is on the dashboard either way.

## Implementation notes (for #92 "Approval flow end to end", not this decision)

- Holding needs a way for the agent to read the decision. Proposed: a new `POST /agent/order-status {callId, orderId}` → `{status, totalCents, reason?}` (BACKEND to own), polled every ~2 s during the hold. Alternative: return the decision from a blocking HTTP action. Polling is simpler and safe against restarts.
- Run the hold as an agent-side loop that yields reassurance `AgentSendText` lines. If the caller speaks (`UserTurnStarted` cancels the task), resume the hold after replying, until the window ends.
- Approval-validity expiry is a scheduled Convex function (`ctx.scheduler.runAt`) that moves `awaiting_approval` → `declined` with the reason "expired" if no decision yet. Recording who decided: `approvedBy: "system:expired"`.
- T3 check: the spoken yes (alert call) or dashboard Approve arrives within 90 s → caller hears the approved line and the order is `paid`.

## Sign-off

- [ ] Person 3 (C, owner) · [ ] Person 1 (agent speech) · [ ] Person 2 (`place_order`) · [ ] numbers agreed, §21 ticked
