import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const callKind = v.union(
  v.literal("order"),
  v.literal("chat"),
  v.literal("mixed"),
  v.literal("unknown_caller"),
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
export const timings = v.object({
  speechEndAt: v.optional(v.number()),
  sttFinalAt: v.optional(v.number()),
  llmRequestAt: v.optional(v.number()),
  llmFirstTokenAt: v.optional(v.number()),
  ttsFirstAudioAt: v.optional(v.number()),
});
export const usage = v.object({
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
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
    redacted: v.boolean(),
  })
    .index("by_call", ["callId"])
    .index("by_call_idx", ["callId", "idx"]),
  orders: defineTable({
    householdId: v.id("households"),
    callId: v.id("calls"),
    idempotencyKey: v.string(),
    items: v.array(
      v.object({
        name: v.string(),
        storeItemId: v.string(),
        qty: v.number(),
        priceCents: v.number(),
      }),
    ),
    totalCents: v.number(),
    store: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("awaiting_approval"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("paid"),
      v.literal("failed"),
    ),
    paymentTokenRef: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_household", ["householdId"])
    .index("by_status", ["status"])
    .index("by_idempotencyKey", ["idempotencyKey"]),
  alerts: defineTable({
    householdId: v.id("households"),
    callId: v.optional(v.id("calls")),
    orderId: v.optional(v.id("orders")),
    type: alertType,
    channel: v.union(
      v.literal("call"),
      v.literal("dashboard"),
      v.literal("sms"),
    ),
    delivery,
    message: v.string(),
    transcriptExcerpt: v.optional(v.string()),
    recipient: v.string(),
    sentAt: v.number(),
    decision: v.optional(decision),
    acknowledgedAt: v.optional(v.number()),
    providerCallId: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.string()),
  }).index("by_household", ["householdId"]),
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
  }).index("by_household_status", ["householdId", "status"]),
  followups: defineTable({
    householdId: v.id("households"),
    speakable: v.string(),
    sourceCallId: v.id("calls"),
    notBefore: v.number(),
    status: v.union(v.literal("open"), v.literal("asked"), v.literal("closed")),
    askedInCallId: v.optional(v.id("calls")),
  }).index("by_household_status", ["householdId", "status"]),
});
