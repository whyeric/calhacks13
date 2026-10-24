import { internalMutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { callKind, callOutcome, timings, usage, scam } from "./schema";
import { requireFamily } from "./auth";

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
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.idx) ||
      args.idx < 0 ||
      args.text.length > 20000
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
    if (!call.endedAt)
      await ctx.db.patch(callId, { ...changes, endedAt: Date.now() });
    // The durable memory writer is Phase 2 (#32); no fabricated summary or memory here.
    return { callId, memoryStatus: "not_implemented" };
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
