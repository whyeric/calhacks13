import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import {
  accessArgs,
  actorArgs,
  resolveActor,
  resolveHousehold,
} from "./access";

/**
 * #60: outbound check-in calls driven by memory.
 *
 * Trigger: a family member presses "Check in now" on the dashboard, or the weekly-style
 * schedule (crons.ts runs `tick` hourly). Each attempt is a `checkins` row. The call is placed
 * through Cartesia's outbound API (the same path as alert calls) to the Errand Line agent
 * itself (CHECKIN_AGENT_ID); the agent recognizes the call with `/agent/checkin-start`.
 *
 * Voicemail safety: the opener carries no private details ("calling to check in. Is now a good
 * time?"). The memory line (the usual item and at most one follow-up, MEM-2) is said only after
 * a person answers. The caller can stop check-ins on any call (stop_checkins tool), and the
 * family can turn them off on the dashboard.
 */

const DAY_MS = 86_400_000;
const ACTIVE_WINDOW_MS = 15 * 60_000;
const RECENT = 10;

function clean(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** "Medium-roast coffee, big can" -> "medium-roast coffee". */
export function spokenItem(name: string) {
  const head = clean(name.split(/[,(]/)[0]);
  return head.charAt(0).toLowerCase() + head.slice(1);
}

/**
 * The voicemail-safe opener and the memory line said once a person answers: the usual item
 * plus at most one open follow-up (MEM-2).
 */
export function checkinLines(
  preferredName: string,
  usual: string | null,
  followup: string | null,
) {
  const opener = `Hi ${clean(preferredName)}, it's Errand Line, your AI assistant, calling to check in. Is now a good time?`;
  const parts = [
    usual
      ? `Would you like me to order your usual ${spokenItem(usual)} this week?`
      : "Is there anything you need from the store this week?",
  ];
  if (followup) parts.push(`And ${lowerFirst(clean(followup))}`);
  return { opener, memoryLine: parts.join(" ") };
}

const QUESTION_STARTS = new Set([
  "How",
  "Did",
  "What",
  "Was",
  "Is",
  "Are",
  "Have",
  "Has",
  "Do",
  "Does",
]);

/** "How did the tomatoes do?" -> "how did the tomatoes do?"; names stay capitalized. */
function lowerFirst(text: string) {
  const [first, ...rest] = text.split(" ");
  return QUESTION_STARTS.has(first)
    ? [first.toLowerCase(), ...rest].join(" ")
    : text;
}

async function settingsFor(ctx: QueryCtx, householdId: Id<"households">) {
  return ctx.db
    .query("checkin_settings")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .unique();
}

/** The usual item: the favorite paid for most often recently, else the first favorite. */
async function usualItem(ctx: QueryCtx, householdId: Id<"households">) {
  const [favorites, orders] = await Promise.all([
    ctx.db
      .query("favorites")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .take(50),
    ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(50),
  ]);
  if (!favorites.length) return null;
  const counts = new Map<string, number>();
  for (const o of orders)
    if (o.status === "paid")
      for (const i of o.items)
        counts.set(i.storeItemId, (counts.get(i.storeItemId) ?? 0) + 1);
  const best = [...favorites].sort(
    (a, b) =>
      (counts.get(b.storeItemId) ?? 0) - (counts.get(a.storeItemId) ?? 0),
  )[0];
  return best.name;
}

async function enqueue(
  ctx: MutationCtx,
  household: Doc<"households">,
  trigger: "manual" | "schedule",
  requestedBy: string,
) {
  const settings = await settingsFor(ctx, household._id);
  if (settings?.optedOutAt !== undefined)
    throw new ConvexError(
      `${household.preferredName} asked not to get check-in calls`,
    );
  const now = Date.now();
  const latest = await ctx.db
    .query("checkins")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .order("desc")
    .first();
  if (
    latest &&
    (latest.status === "queued" || latest.status === "ringing") &&
    now - latest.createdAt < ACTIVE_WINDOW_MS
  )
    throw new ConvexError("A check-in call is already in progress");
  const followups = await ctx.db
    .query("followups")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", household._id).eq("status", "open"),
    )
    .take(20);
  const followup =
    followups
      .filter((f) => f.notBefore <= now && f.speakable.trim())
      .sort((a, b) => a.notBefore - b.notBefore)[0] ?? null;
  const lines = checkinLines(
    household.preferredName,
    await usualItem(ctx, household._id),
    followup?.speakable ?? null,
  );
  const checkinId = await ctx.db.insert("checkins", {
    householdId: household._id,
    status: "queued",
    trigger,
    requestedBy,
    ...lines,
    ...(followup ? { followupId: followup._id } : {}),
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.checkins.place, { checkinId });
  return checkinId;
}

// ---------- Dashboard ----------

export const overview = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const settings = await settingsFor(ctx, household._id);
    const recent = await ctx.db
      .query("checkins")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(RECENT);
    return {
      enabled: settings?.enabled ?? false,
      everyDays: settings?.everyDays ?? 7,
      nextAt: settings?.nextAt ?? null,
      optedOutAt: settings?.optedOutAt ?? null,
      optedOutBy: settings?.optedOutBy ?? null,
      recent: recent.map((c) => ({
        _id: c._id,
        status: c.status,
        trigger: c.trigger,
        requestedBy: c.requestedBy,
        memoryLine: c.memoryLine,
        createdAt: c.createdAt,
        callId: c.callId ?? null,
      })),
    };
  },
});

/** Manual trigger: "Check in now". */
export const requestNow = mutation({
  args: actorArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const who = await resolveActor(ctx, household, args);
    return enqueue(ctx, household, "manual", who);
  },
});

/**
 * Turn the schedule on or off. Turning it on after the caller opted out needs
 * `callerAgreed`: the family confirms the caller now wants check-ins again.
 */
export const configure = mutation({
  args: {
    ...actorArgs,
    enabled: v.boolean(),
    everyDays: v.optional(v.number()),
    callerAgreed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    await resolveActor(ctx, household, args);
    const everyDays = args.everyDays ?? 7;
    if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 30)
      throw new ConvexError("Check every 1 to 30 days");
    const existing = await settingsFor(ctx, household._id);
    if (
      args.enabled &&
      existing?.optedOutAt !== undefined &&
      !args.callerAgreed
    )
      throw new ConvexError(
        `${household.preferredName} asked not to get check-in calls`,
      );
    // A caller's opt-out stays on record unless the family confirms they agreed to resume.
    const keepOptOut =
      existing?.optedOutAt !== undefined &&
      !(args.enabled && args.callerAgreed);
    const row = {
      householdId: household._id,
      enabled: args.enabled,
      everyDays,
      ...(args.enabled ? { nextAt: Date.now() + everyDays * DAY_MS } : {}),
      ...(keepOptOut
        ? { optedOutAt: existing!.optedOutAt, optedOutBy: existing!.optedOutBy }
        : {}),
    };
    if (existing) {
      await ctx.db.replace(existing._id, row);
    } else await ctx.db.insert("checkin_settings", row);
    return null;
  },
});

// ---------- Schedule ----------

/** Hourly (crons.ts): place due scheduled check-ins. */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("checkin_settings")
      .withIndex("by_enabled_and_nextAt", (q) =>
        q.eq("enabled", true).lte("nextAt", now),
      )
      .take(10);
    let placed = 0;
    for (const s of due) {
      await ctx.db.patch(s._id, { nextAt: now + s.everyDays * DAY_MS });
      const household = await ctx.db.get(s.householdId);
      if (!household || s.optedOutAt !== undefined) continue;
      try {
        await enqueue(ctx, household, "schedule", "schedule");
        placed += 1;
      } catch {
        /* Already in progress or opted out: try again next period. */
      }
    }
    return { placed };
  },
});

// ---------- Outbound call ----------

export const forPlacement = internalQuery({
  args: { checkinId: v.id("checkins") },
  handler: async (ctx, { checkinId }) => {
    const checkin = await ctx.db.get(checkinId);
    if (!checkin) return null;
    const household = await ctx.db.get(checkin.householdId);
    if (!household) return null;
    return { status: checkin.status, toNumber: household.callerPhone };
  },
});

export const setStatus = internalMutation({
  args: {
    checkinId: v.id("checkins"),
    status: v.union(
      v.literal("ringing"),
      v.literal("answered"),
      v.literal("no_answer"),
      v.literal("failed"),
    ),
    providerCallId: v.optional(v.string()),
  },
  handler: async (ctx, { checkinId, status, providerCallId }) => {
    const checkin = await ctx.db.get(checkinId);
    if (!checkin) return;
    // Never regress a finished attempt (the agent may report "answered" before the poll).
    if (!["queued", "ringing"].includes(checkin.status)) return;
    if (checkin.status === "ringing" && status === "ringing") return;
    await ctx.db.patch(checkinId, {
      status,
      ...(providerCallId ? { providerCallId } : {}),
    });
  },
});

const cartesiaHeaders = () => ({
  "X-API-Key": process.env.CARTESIA_API_KEY ?? "",
  "Cartesia-Version": process.env.CARTESIA_API_VERSION || "2026-08-14",
  "Content-Type": "application/json",
});

export const place = internalAction({
  args: { checkinId: v.id("checkins") },
  handler: async (ctx, { checkinId }) => {
    const target = await ctx.runQuery(internal.checkins.forPlacement, {
      checkinId,
    });
    if (!target || target.status !== "queued") return;
    try {
      const agent = process.env.CHECKIN_AGENT_ID;
      const from =
        process.env.CHECKIN_FROM_NUMBER_ID || process.env.ALERT_FROM_NUMBER_ID;
      if (!process.env.CARTESIA_API_KEY || !agent || !from)
        throw new Error("Check-in calling is not configured");
      const response = await fetch("https://api.cartesia.ai/agents/calls", {
        method: "POST",
        headers: cartesiaHeaders(),
        body: JSON.stringify({
          agent_id: agent,
          outbound_calls: [
            {
              to_number: target.toNumber,
              from_number_id: from,
              ringing_timeout_seconds: 30,
              // Only an opaque id: the agent fetches everything else from Convex.
              dynamic_variables: { checkinId },
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
      await ctx.runMutation(internal.checkins.setStatus, {
        checkinId,
        status: "ringing",
        providerCallId,
      });
      await ctx.scheduler.runAfter(5000, internal.checkins.poll, {
        checkinId,
        attempt: 0,
      });
    } catch {
      // Never redial automatically: the POST may have been accepted.
      await ctx.runMutation(internal.checkins.setStatus, {
        checkinId,
        status: "failed",
      });
    }
  },
});

export const getInternal = internalQuery({
  args: { checkinId: v.id("checkins") },
  handler: (ctx, { checkinId }) => ctx.db.get(checkinId),
});

/** Ring status until answered or not (no answer leaves no message: nothing was said). */
export const poll = internalAction({
  args: { checkinId: v.id("checkins"), attempt: v.number() },
  handler: async (ctx, { checkinId, attempt }) => {
    const checkin = await ctx.runQuery(internal.checkins.getInternal, {
      checkinId,
    });
    if (!checkin || checkin.status !== "ringing" || !checkin.providerCallId)
      return;
    try {
      const response = await fetch(
        `https://api.cartesia.ai/agents/calls/${encodeURIComponent(checkin.providerCallId)}`,
        { headers: cartesiaHeaders(), signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw new Error("Status unavailable");
      const call = await response.json();
      if (["active", "completed", "ended"].includes(call.status)) {
        await ctx.runMutation(internal.checkins.setStatus, {
          checkinId,
          status: "answered",
        });
        return;
      }
      if (
        ["no_answer", "busy", "failed", "canceled", "cancelled"].includes(
          call.status,
        )
      ) {
        await ctx.runMutation(internal.checkins.setStatus, {
          checkinId,
          status: call.status === "failed" ? "failed" : "no_answer",
        });
        return;
      }
    } catch {
      /* Retry status reads only. */
    }
    if (attempt >= 30)
      await ctx.runMutation(internal.checkins.setStatus, {
        checkinId,
        status: "no_answer",
      });
    else
      await ctx.scheduler.runAfter(3000, internal.checkins.poll, {
        checkinId,
        attempt: attempt + 1,
      });
  },
});

// ---------- Agent ----------

/**
 * The agent answered an outbound call: find its check-in, open the call record (outbound,
 * kind "checkin") and return what the agent needs. Matched by the check-in id passed as a
 * dynamic variable, else the provider call id, else the household's latest active check-in
 * for the number called. The number called must be the household's caller phone.
 */
export const startForAgent = internalMutation({
  args: {
    providerCallId: v.string(),
    calledPhone: v.string(),
    checkinId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.providerCallId || args.providerCallId.length > 200)
      throw new ConvexError("Invalid providerCallId");
    const household = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", args.calledPhone))
      .unique();
    if (!household) return null;
    let checkin: Doc<"checkins"> | null = null;
    const byId = args.checkinId
      ? ctx.db.normalizeId("checkins", args.checkinId)
      : null;
    if (byId) checkin = await ctx.db.get(byId);
    if (!checkin)
      checkin = await ctx.db
        .query("checkins")
        .withIndex("by_providerCallId", (q) =>
          q.eq("providerCallId", args.providerCallId),
        )
        .first();
    if (!checkin) {
      const latest = await ctx.db
        .query("checkins")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .order("desc")
        .first();
      if (
        latest &&
        ["queued", "ringing", "answered"].includes(latest.status) &&
        Date.now() - latest.createdAt < ACTIVE_WINDOW_MS
      )
        checkin = latest;
    }
    if (!checkin || checkin.householdId !== household._id) return null;
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_providerCallId", (q) =>
        q.eq("providerCallId", args.providerCallId),
      )
      .unique();
    const callId =
      existing?._id ??
      (await ctx.db.insert("calls", {
        householdId: household._id,
        providerCallId: args.providerCallId,
        callerPhone: household.callerPhone,
        startedAt: Date.now(),
        kind: "checkin",
        outcome: "no_order",
        scamScore: 0,
        scamSignals: [],
        scamReasons: [],
        scamHold: { active: false },
        outbound: true,
        checkinId: checkin._id,
      }));
    if (["queued", "ringing"].includes(checkin.status))
      await ctx.db.patch(checkin._id, { status: "answered", callId });
    else if (!checkin.callId) await ctx.db.patch(checkin._id, { callId });
    return {
      callId,
      callerPhone: household.callerPhone,
      checkin: {
        checkinId: checkin._id,
        opener: checkin.opener,
        memoryLine: checkin.memoryLine,
        followupId: checkin.followupId ?? null,
      },
    };
  },
});

/** stop_checkins: the caller asked for no more check-in calls (on any call). */
export const stopForCall = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call?.householdId) throw new ConvexError("Call not found");
    const householdId = call.householdId;
    const existing = await settingsFor(ctx, householdId);
    const now = Date.now();
    if (existing)
      await ctx.db.patch(existing._id, {
        enabled: false,
        optedOutAt: now,
        optedOutBy: "caller",
      });
    else
      await ctx.db.insert("checkin_settings", {
        householdId,
        enabled: false,
        everyDays: 7,
        optedOutAt: now,
        optedOutBy: "caller",
      });
    return { status: "stopped" };
  },
});
