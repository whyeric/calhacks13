import { internalQuery, internalMutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireFamily } from "./auth";

export const lookup = internalQuery({
  args: { callerPhone: v.string() },
  handler: async (ctx, { callerPhone }) => {
    const household = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", callerPhone))
      .unique();
    if (!household) return null;
    const [limits, favorites, facts, followups] = await Promise.all([
      ctx.db
        .query("limits")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .unique(),
      ctx.db
        .query("favorites")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .collect(),
      ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "active"),
        )
        .collect(),
      ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "open"),
        )
        .collect(),
    ]);
    return { household, limits, favorites, facts, followups };
  },
});

export const startCall = internalMutation({
  args: { callerPhone: v.string(), providerCallId: v.string() },
  handler: async (ctx, args) => {
    if (!/^\+[1-9]\d{7,14}$/.test(args.callerPhone))
      throw new ConvexError("Invalid callerPhone");
    if (!args.providerCallId || args.providerCallId.length > 200)
      throw new ConvexError("Invalid providerCallId");
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_providerCallId", (q) =>
        q.eq("providerCallId", args.providerCallId),
      )
      .unique();
    if (existing) {
      if (existing.callerPhone !== args.callerPhone)
        throw new ConvexError("Call identity mismatch");
      return existing._id;
    }
    const household = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", args.callerPhone))
      .unique();
    return ctx.db.insert("calls", {
      ...args,
      householdId: household?._id,
      startedAt: Date.now(),
      kind: household ? "chat" : "unknown_caller",
      outcome: household ? "no_order" : "unknown_caller",
      scamScore: 0,
      scamSignals: [],
      scamReasons: [],
      scamHold: { active: false },
    });
  },
});

export const get = query({
  args: { householdId: v.id("households") },
  handler: (ctx, { householdId }) => requireFamily(ctx, householdId),
});
