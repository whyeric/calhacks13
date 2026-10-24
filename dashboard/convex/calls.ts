import { internalMutation, internalQuery, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import {
  callKind,
  callOutcome,
  timings,
  usage,
  scam,
  turnTool,
} from "./schema";
import { requireFamily } from "./auth";
import { internal } from "./_generated/api";
import { OUTCOME_RANK } from "./orders";

export const logTurn = internalMutation({
  args: {
    callId: v.id("calls"),
    idx: v.number(),
    speaker: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    at: v.number(),
    timings,
    usage,
    scam: v.optional(scam),
    refused: v.optional(v.boolean()),
    tools: v.optional(v.array(turnTool)),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.idx) ||
      args.idx < 0 ||
      args.text.length > 20000 ||
      (args.tools &&
        (args.tools.length > 10 ||
          args.tools.some(
            (t) => t.name.length > 64 || (t.result?.length ?? 0) > 64,
          )))
    )
      throw new ConvexError("Invalid turn");
    if (!(await ctx.db.get(args.callId)))
      throw new ConvexError("Call not found");
    const existing = await ctx.db
      .query("turns")
      .withIndex("by_call_idx", (q) =>
        q.eq("callId", args.callId).eq("idx", args.idx),
      )
      .unique();
    return (
      existing?._id ?? ctx.db.insert("turns", { ...args, redacted: false })
    );
  },
});

export const end = internalMutation({
  args: {
    callId: v.id("calls"),
    kind: v.optional(callKind),
    outcome: v.optional(callOutcome),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, { callId, ...changes }) => {
    const call = await ctx.db.get(callId);
    if (!call) throw new ConvexError("Call not found");
    if (!call.endedAt) {
      const { outcome, ...rest } = changes;
      // #60: an outbound check-in stays a check-in unless an order was part of it.
      if (call.kind === "checkin" && rest.kind === "chat") delete rest.kind;
      // Outcomes recorded by the order path (e.g. declined_scam) are never downgraded by the agent.
      const keep =
        outcome === undefined ||
        OUTCOME_RANK[outcome] <= OUTCOME_RANK[call.outcome];
      await ctx.db.patch(callId, {
        ...rest,
        ...(keep ? {} : { outcome }),
        endedAt: Date.now(),
      });
      // #32 (SPEC §10.6): the memory writer is scheduled in the same transaction that closes
      // the call, so memory is written even if the agent restarts after hang-up.
      if (call.householdId) {
        await ctx.scheduler.runAfter(0, internal.memory.write, { callId });
        return { callId, memoryStatus: "scheduled" };
      }
    }
    return {
      callId,
      memoryStatus: call.householdId ? "already_ended" : "unknown_caller",
    };
  },
});

export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return ctx.db
      .query("calls")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(50);
  },
});

export const transcript = query({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call?.householdId) throw new ConvexError("Call not found");
    const household = await requireFamily(ctx, call.householdId);
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .collect();
    const alerts = await ctx.db
      .query("alerts")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .collect();
    const visible =
      household.sharing.chatTranscripts ||
      orders.some((o) => o.callId === callId) ||
      alerts.some((a) => a.callId === callId);
    if (!visible) return { shared: false, turns: [] };
    return {
      shared: true,
      turns: await ctx.db
        .query("turns")
        .withIndex("by_call_idx", (q) => q.eq("callId", callId))
        .collect(),
    };
  },
});

// Read-only export for harness/latency_report.py. No transcript text, no phone numbers.
export const latencyExport = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_startedAt")
      .order("desc")
      .take(Math.max(1, Math.min(limit ?? 20, 100)));
    return Promise.all(
      calls.map(async (call) => ({
        callId: call._id,
        startedAt: call.startedAt,
        kind: call.kind,
        outcome: call.outcome,
        turns: (
          await ctx.db
            .query("turns")
            .withIndex("by_call_idx", (q) => q.eq("callId", call._id))
            .take(500)
        ).map(({ idx, speaker, at, timings, usage }) => ({
          idx,
          speaker,
          at,
          timings,
          usage,
        })),
      })),
    );
  },
});
