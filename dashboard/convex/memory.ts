import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireFamily } from "./auth";
export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return {
      facts: await ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", householdId).eq("status", "active"),
        )
        .collect(),
      followups: await ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", householdId).eq("status", "open"),
        )
        .collect(),
    };
  },
});
