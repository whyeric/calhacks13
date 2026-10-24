import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { venueId: v.string() },
  handler: async (ctx, { venueId }) => {
    return await ctx.db
      .query("pins")
      .withIndex("by_venue", (q) => q.eq("venueId", venueId))
      .collect();
  },
});
