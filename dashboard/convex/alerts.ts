import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { alertType, decision, delivery } from "./schema";
import { requireFamily } from "./auth";
import { actorArgs, resolveActor, resolveHousehold } from "./access";
import { decide } from "./orders";

const alertArgs = {
  householdId: v.id("households"),
  callId: v.optional(v.id("calls")),
  orderId: v.optional(v.id("orders")),
  type: alertType,
  message: v.string(),
  transcriptExcerpt: v.optional(v.string()),
  recipient: v.string(),
};

export const create = internalMutation({
  args: alertArgs,
  handler: async (ctx, args) => {
    const household = await ctx.db.get(args.householdId);
    if (!household?.familyContacts.some((c) => c.phone === args.recipient))
      throw new ConvexError("Recipient is not an approved family contact");
    if (!args.message.trim() || args.message.length > 4000)
      throw new ConvexError("Invalid message");
    if (
      args.callId &&
      (await ctx.db.get(args.callId))?.householdId !== args.householdId
    )
      throw new ConvexError("Call household mismatch");
    if (
      args.orderId &&
      (await ctx.db.get(args.orderId))?.householdId !== args.householdId
    )
      throw new ConvexError("Order household mismatch");
    const channel = ["order_placed", "payment_failed"].includes(args.type)
      ? ("dashboard" as const)
      : ("call" as const);
    return ctx.db.insert("alerts", {
      ...args,
      channel,
      delivery: channel === "call" ? "queued" : "sent",
      sentAt: Date.now(),
    });
  },
});

export const updateDelivery = internalMutation({
  args: {
    alertId: v.id("alerts"),
    delivery,
    providerCallId: v.optional(v.string()),
  },
  handler: async (ctx, { alertId, delivery: next, providerCallId }) => {
    const alert = await ctx.db.get(alertId);
    if (!alert) throw new ConvexError("Alert not found");
    // A webhook can arrive before the outbound request returns. Never regress a terminal state.
    if (["answered", "no_answer", "failed", "sent"].includes(alert.delivery))
      return;
    await ctx.db.patch(alertId, {
      delivery: next,
      ...(providerCallId ? { providerCallId } : {}),
    });
  },
});

export const getInternal = internalQuery({
  args: { alertId: v.id("alerts") },
  handler: (ctx, { alertId }) => ctx.db.get(alertId),
});

export const householdContext = internalQuery({
  args: { householdId: v.id("households"), recipient: v.string() },
  handler: async (ctx, { householdId, recipient }) => {
    const household = await ctx.db.get(householdId);
    const contact = household?.familyContacts.find(
      (c) => c.phone === recipient,
    );
    if (!household || !contact)
      throw new ConvexError("Family contact not found");
    return {
      callerName: household.preferredName,
      callerPhone: household.callerPhone,
      recipient: contact.name,
    };
  },
});

export const call = internalAction({
  args: alertArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ alertId: string; delivery: string }> => {
    const alertId = await ctx.runMutation(internal.alerts.create, args);
    if (["order_placed", "payment_failed"].includes(args.type))
      return { alertId, delivery: "sent" };
    try {
      const key = process.env.CARTESIA_API_KEY;
      const agent = process.env.ALERT_AGENT_ID;
      const from = process.env.ALERT_FROM_NUMBER_ID;
      const timeout = Number(process.env.ALERT_RING_TIMEOUT_SECONDS || "30");
      if (
        !key ||
        !agent ||
        !from ||
        !Number.isInteger(timeout) ||
        timeout < 5 ||
        timeout > 80
      )
        throw new Error("Alert configuration missing");
      const names = await ctx.runQuery(internal.alerts.householdContext, {
        householdId: args.householdId,
        recipient: args.recipient,
      });
      const response = await fetch("https://api.cartesia.ai/agents/calls", {
        method: "POST",
        headers: {
          "X-API-Key": key,
          "Cartesia-Version": process.env.CARTESIA_API_VERSION || "2026-08-14",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agent,
          outbound_calls: [
            {
              to_number: args.recipient,
              from_number_id: from,
              ringing_timeout_seconds: timeout,
              dynamic_variables: {
                ...names,
                alertId,
                summary: args.message,
                type: args.type,
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Outbound call rejected");
      const result = await response.json();
      const providerCallId =
        result.outbound_calls?.[0]?.agent_call_id ??
        result.calls?.[0]?.agent_call_id ??
        result.agent_call_id;
      if (typeof providerCallId !== "string")
        throw new Error("Missing outbound call ID");
      await ctx.runMutation(internal.alerts.updateDelivery, {
        alertId,
        delivery: "ringing",
        providerCallId,
      });
      await ctx.scheduler.runAfter(2000, internal.alerts.poll, {
        alertId,
        attempt: 0,
      });
      return { alertId, delivery: "ringing" };
    } catch {
      // Keep a failed alert visible and unacknowledged; never automatically redial an ambiguous POST.
      await ctx.runMutation(internal.alerts.updateDelivery, {
        alertId,
        delivery: "failed",
      });
      return { alertId, delivery: "failed" };
    }
  },
});

export const poll = internalAction({
  args: { alertId: v.id("alerts"), attempt: v.number() },
  handler: async (ctx, { alertId, attempt }) => {
    const alert = await ctx.runQuery(internal.alerts.getInternal, { alertId });
    if (!alert || alert.delivery !== "ringing" || !alert.providerCallId) return;
    try {
      const response = await fetch(
        `https://api.cartesia.ai/agents/calls/${encodeURIComponent(alert.providerCallId)}`,
        {
          headers: {
            "X-API-Key": process.env.CARTESIA_API_KEY!,
            "Cartesia-Version":
              process.env.CARTESIA_API_VERSION || "2026-08-14",
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error("Status unavailable");
      const call = await response.json();
      if (["active", "completed", "ended"].includes(call.status)) {
        await ctx.runMutation(internal.alerts.updateDelivery, {
          alertId,
          delivery: "answered",
        });
        return;
      }
      if (
        ["no_answer", "busy", "failed", "canceled", "cancelled"].includes(
          call.status,
        )
      ) {
        await ctx.runMutation(internal.alerts.updateDelivery, {
          alertId,
          delivery: call.status === "failed" ? "failed" : "no_answer",
        });
        return;
      }
    } catch {
      /* Retry status reads only. */
    }
    if (attempt >= 44)
      await ctx.runMutation(internal.alerts.updateDelivery, {
        alertId,
        delivery: "failed",
      });
    else
      await ctx.scheduler.runAfter(2000, internal.alerts.poll, {
        alertId,
        attempt: attempt + 1,
      });
  },
});

export const recordDecision = internalMutation({
  args: { alertId: v.id("alerts"), decision },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert || alert.channel !== "call" || alert.type !== "approval_needed")
      throw new ConvexError("Not an approval alert");
    if (alert.decision)
      return {
        alertId: alert._id,
        decision: alert.decision,
        alreadyResolved: true,
      };
    if (!alert.orderId) {
      // No order attached (a test or manual alert): record the answer; nothing to pay.
      await ctx.db.patch(alert._id, {
        decision: args.decision,
        delivery: "answered",
        decidedAt: Date.now(),
        decidedBy: alert.recipient,
      });
      return {
        alertId: alert._id,
        decision: args.decision,
        alreadyResolved: false,
        decidedBy: alert.recipient,
      };
    }
    if (alert.delivery !== "answered")
      await ctx.db.patch(alert._id, { delivery: "answered" });
    const household = await ctx.db.get(alert.householdId);
    const contact = household?.familyContacts.find(
      (c) => c.phone === alert.recipient,
    );
    // #92 APR-3: the same first-response-wins decision as the dashboard buttons. It marks
    // every approval alert on the order (this one included) and, on yes, schedules payment.
    const result = await decide(
      ctx,
      alert.orderId,
      `${contact?.name ?? "Family"} (alert call)`,
      args.decision,
    );
    return {
      alertId: alert._id,
      // When the dashboard answered first, report the decision that stands.
      decision:
        result.status === "approved" || result.status === "paid"
          ? ("approved" as const)
          : result.status === "declined"
            ? ("declined" as const)
            : args.decision,
      alreadyResolved: result.alreadyResolved,
      decidedBy: result.decidedBy,
    };
  },
});

export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return ctx.db
      .query("alerts")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(100);
  },
});

/** #94: a family member has seen this alert. Idempotent; the first acknowledgement stands. */
export const acknowledge = mutation({
  args: { ...actorArgs, alertId: v.id("alerts") },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const alert = await ctx.db.get(args.alertId);
    if (!alert || alert.householdId !== household._id)
      throw new ConvexError("Alert not found");
    const who = await resolveActor(ctx, household, args);
    if (alert.acknowledgedAt !== undefined)
      return { alertId: alert._id, alreadyAcknowledged: true };
    await ctx.db.patch(alert._id, {
      acknowledgedAt: Date.now(),
      acknowledgedBy: who,
    });
    return { alertId: alert._id, alreadyAcknowledged: false };
  },
});
