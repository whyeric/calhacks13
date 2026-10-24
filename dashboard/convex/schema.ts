import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const callKind = v.union(
  v.literal("order"),
  v.literal("chat"),
  v.literal("mixed"),
  v.literal("unknown_caller"),
  // #60: an outbound check-in call placed by Errand Line.
  v.literal("checkin"),
);
export const callOutcome = v.union(
  v.literal("ordered"),
  v.literal("awaiting_approval"),
  v.literal("declined_scam"),
  v.literal("no_order"),
  v.literal("unknown_caller"),
);
export const alertType = v.union(
  v.literal("scam"),
  v.literal("approval_needed"),
  v.literal("order_placed"),
  v.literal("payment_failed"),
  v.literal("wellbeing"),
  v.literal("connect_nudge"),
);
export const delivery = v.union(
  v.literal("queued"),
  v.literal("ringing"),
  v.literal("answered"),
  v.literal("no_answer"),
  v.literal("sent"),
  v.literal("failed"),
);
export const decision = v.union(v.literal("approved"), v.literal("declined"));
export const orderStatus = v.union(
  v.literal("pending"),
  v.literal("awaiting_approval"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("paid"),
  v.literal("failed"),
);
export const orderItem = v.object({
  name: v.string(),
  storeItemId: v.string(),
  qty: v.number(),
  priceCents: v.number(),
});
export const timings = v.object({
  speechEndAt: v.optional(v.number()),
  sttFinalAt: v.optional(v.number()),
  llmRequestAt: v.optional(v.number()),
  llmFirstTokenAt: v.optional(v.number()),
  ttsFirstAudioAt: v.optional(v.number()),
  // Turn-taking marks (#9 barge-in, #15 silence, #35 cut-off metric), epoch ms unless named.
  agentSpeechStartAt: v.optional(v.number()),
  bargeInAt: v.optional(v.number()),
  replyStoppedAt: v.optional(v.number()),
  cutOff: v.optional(v.number()), // 1 when the caller spoke within 1 s of the agent starting
  holdOffMs: v.optional(v.number()),
  silenceMs: v.optional(v.number()),
});
export const usage = v.object({
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
});
// #80: model-called tools during an assistant turn (name and short outcome, never arguments).
export const turnTool = v.object({
  name: v.string(),
  result: v.optional(v.string()),
});

export const memoryWrite = v.object({
  status: v.union(
    v.literal("written"),
    v.literal("skipped"),
    v.literal("refused"),
    v.literal("failed"),
  ),
  at: v.number(),
  ms: v.number(),
  added: v.number(),
  dropped: v.number(),
  notes: v.optional(v.array(v.string())),
});

export const scam = v.object({
  score: v.number(),
  signals: v.array(v.string()),
});

export default defineSchema({
  households: defineTable({
    callerName: v.string(),
    preferredName: v.string(),
    callerPhone: v.string(),
    timezone: v.string(),
    deliveryAddress: v.string(),
    familyContacts: v.array(
      v.object({
        name: v.string(),
        phone: v.string(),
        relation: v.string(),
        authSubject: v.optional(v.string()),
      }),
    ),
    sharing: v.object({ chatTranscripts: v.boolean(), moodNotes: v.boolean() }),
    introducedAt: v.optional(v.number()),
    // #65: spoken PIN for calls from family-approved extra numbers. Only a salted hash is kept.
    pinAccess: v.optional(
      v.object({
        hash: v.string(),
        salt: v.string(),
        setBy: v.string(),
        setAt: v.number(),
      }),
    ),
  }).index("by_callerPhone", ["callerPhone"]),
  limits: defineTable({
    householdId: v.id("households"),
    perOrderCapCents: v.number(),
    monthlyBudgetCents: v.number(),
    approvedStores: v.array(v.string()),
  }).index("by_household", ["householdId"]),
  favorites: defineTable({
    householdId: v.id("households"),
    name: v.string(),
    aliases: v.array(v.string()),
    store: v.string(),
    storeItemId: v.string(),
    usualQty: v.number(),
  }).index("by_household", ["householdId"]),
  calls: defineTable({
    householdId: v.optional(v.id("households")),
    providerCallId: v.optional(v.string()),
    callerPhone: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    kind: callKind,
    outcome: callOutcome,
    summary: v.optional(v.string()),
    scamScore: v.number(),
    scamSignals: v.array(v.string()),
    scamReasons: v.array(v.string()),
    scamHold: v.object({
      active: v.boolean(),
      reason: v.optional(v.string()),
      at: v.optional(v.number()),
    }),
    // #95 / SCM-6: family overrides of a scam hold from the dashboard, oldest first (bounded).
    // An override lifts the hold only; the hard rule in orders.reserve still blocks.
    scamOverrides: v.optional(
      v.array(
        v.object({
          by: v.string(),
          at: v.number(),
          holdReason: v.optional(v.string()),
          note: v.optional(v.string()),
        }),
      ),
    ),
    // #27 / SCM-7: incident line for a scam call ("Scam attempt on Oct 24: ..."). The memory
    // writer records it as an incident, never as facts. Set by scam.armHold.
    scamIncident: v.optional(v.string()),
    // #76: one short mood/health note the caller stated; written only when sharing.moodNotes.
    moodNote: v.optional(v.string()),
    // #32: post-call memory writer telemetry (timing and what was kept or dropped).
    memoryWrite: v.optional(memoryWrite),
    // #60: true for calls Errand Line placed (check-ins); the check-in that placed it.
    outbound: v.optional(v.boolean()),
    checkinId: v.optional(v.id("checkins")),
    // #65: the household was unlocked on this call by a spoken PIN from an approved number.
    pinVerifiedAt: v.optional(v.number()),
  })
    .index("by_household", ["householdId"])
    .index("by_startedAt", ["startedAt"])
    .index("by_providerCallId", ["providerCallId"]),
  turns: defineTable({
    callId: v.id("calls"),
    idx: v.number(),
    speaker: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    at: v.number(),
    timings,
    usage,
    scam: v.optional(scam),
    // #36: the model refused and a templated line was spoken instead.
    refused: v.optional(v.boolean()),
    tools: v.optional(v.array(turnTool)),
    redacted: v.boolean(),
  })
    .index("by_call", ["callId"])
    .index("by_call_idx", ["callId", "idx"]),
  orders: defineTable({
    householdId: v.id("households"),
    callId: v.id("calls"),
    idempotencyKey: v.string(),
    items: v.array(orderItem),
    totalCents: v.number(),
    store: v.string(),
    status: orderStatus,
    paymentTokenRef: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
    createdAt: v.number(),
    // Spoken-friendly reason: the limit broken (awaiting_approval) or why payment failed.
    reason: v.optional(v.string()),
    declinedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    // Set (atomically, in orders.reserve) by the one request allowed to call the payment rail.
    // A pending order with this set is in flight or its outcome is unknown: never pay it again.
    paymentClaimedAt: v.optional(v.number()),
  })
    .index("by_household", ["householdId"])
    .index("by_status", ["status"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_callId", ["callId"]),
  alerts: defineTable({
    householdId: v.id("households"),
    callId: v.optional(v.id("calls")),
    orderId: v.optional(v.id("orders")),
    type: alertType,
    channel: v.union(v.literal("call"), v.literal("dashboard")),
    delivery,
    message: v.string(),
    transcriptExcerpt: v.optional(v.string()),
    recipient: v.string(),
    sentAt: v.number(),
    decision: v.optional(decision),
    acknowledgedAt: v.optional(v.number()),
    // #94: which family member acknowledged it.
    acknowledgedBy: v.optional(v.string()),
    providerCallId: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.string()),
  })
    .index("by_household", ["householdId"])
    .index("by_orderId", ["orderId"])
    .index("by_callId", ["callId"]),
  memory_facts: defineTable({
    householdId: v.id("households"),
    text: v.string(),
    category: v.string(),
    evidence: v.string(),
    sourceCallId: v.id("calls"),
    createdAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("superseded"),
      v.literal("forgotten"),
    ),
    supersededBy: v.optional(v.id("memory_facts")),
    // #47 / MEM-6: who forgot it ("caller" or the family member) and when.
    forgottenAt: v.optional(v.number()),
    forgottenBy: v.optional(v.string()),
  }).index("by_household_status", ["householdId", "status"]),
  followups: defineTable({
    householdId: v.id("households"),
    speakable: v.string(),
    sourceCallId: v.id("calls"),
    notBefore: v.number(),
    status: v.union(v.literal("open"), v.literal("asked"), v.literal("closed")),
    askedInCallId: v.optional(v.id("calls")),
  }).index("by_household_status", ["householdId", "status"]),
  // #60: one row per outbound check-in attempt.
  checkins: defineTable({
    householdId: v.id("households"),
    status: v.union(
      v.literal("queued"),
      v.literal("ringing"),
      v.literal("answered"),
      v.literal("no_answer"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    trigger: v.union(v.literal("manual"), v.literal("schedule")),
    requestedBy: v.string(),
    opener: v.string(),
    memoryLine: v.string(),
    followupId: v.optional(v.id("followups")),
    providerCallId: v.optional(v.string()),
    callId: v.optional(v.id("calls")),
    createdAt: v.number(),
  })
    .index("by_household", ["householdId"])
    .index("by_providerCallId", ["providerCallId"]),
  // #60: per-household check-in schedule and opt-out.
  checkin_settings: defineTable({
    householdId: v.id("households"),
    enabled: v.boolean(),
    everyDays: v.number(),
    nextAt: v.optional(v.number()),
    optedOutAt: v.optional(v.number()),
    optedOutBy: v.optional(v.string()),
  })
    .index("by_household", ["householdId"])
    .index("by_enabled_and_nextAt", ["enabled", "nextAt"]),
  // #65: extra numbers the family approved for PIN calls (one household per number).
  pin_numbers: defineTable({
    phone: v.string(),
    householdId: v.id("households"),
    addedBy: v.string(),
    addedAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_household", ["householdId"]),
  // #65: each spoken-PIN attempt (never the PIN itself), for rate limiting and the audit trail.
  pin_attempts: defineTable({
    callerPhone: v.string(),
    householdId: v.optional(v.id("households")),
    callId: v.optional(v.id("calls")),
    ok: v.boolean(),
    at: v.number(),
  }).index("by_callerPhone", ["callerPhone"]),
});
