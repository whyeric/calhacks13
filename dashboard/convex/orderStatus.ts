import { internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";

const RECENT_ORDERS = 5;

/** First name of who decided, or null for a system decision (expiry). */
function decider(by: string | undefined) {
  if (!by || by.startsWith("system:")) return null;
  return by.split(/[\s(]/)[0] || null;
}

/**
 * #55 order_status: the household's newest orders, read fresh for the call asking (not the
 * snapshot taken at call start). Read-only. Only the call's own household is visible, and
 * no payment identifiers leave Convex.
 */
export const recentForCall = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call) throw new ConvexError("Call not found");
    const householdId = call.householdId;
    if (!householdId) return { orders: [] };
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(RECENT_ORDERS);
    return {
      orders: rows.map((o) => ({
        status: o.status,
        store: o.store,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
        items: o.items.map((i) => ({ name: i.name, qty: i.qty })),
        reason: o.reason ?? null,
        decidedBy: decider(o.approvedBy ?? o.declinedBy),
        expired: (o.declinedBy ?? "") === "system:expired",
        thisCall: o.callId === callId,
      })),
    };
  },
});
