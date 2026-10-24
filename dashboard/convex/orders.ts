import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireFamily } from "./auth";
export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(100);
  },
});
