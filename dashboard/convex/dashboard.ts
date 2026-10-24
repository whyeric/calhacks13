import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  accessArgs,
  actorArgs,
  resolveActor,
  resolveHousehold,
} from "./access";
import { forgetFact as forgetMemoryFact } from "./memory";

// Read caps: every dashboard read is bounded.
const RECENT_CALLS = 20;
const TURNS_PER_CALL = 400;
const ORDERS_SHOWN = 100;
const MONTH_SCAN = 1000;
const BADGE_SCAN = 200;
const FACTS_SHOWN = 100;
const FOLLOWUPS_SHOWN = 50;
const RECENT_FOLLOWUPS = 8;

/** The timezone if Intl knows it, else UTC (a bad value must not break reads). */
function zoneOrUtc(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Year-month ("2026-10") of an instant in an IANA timezone (UTC if invalid). */
export function monthInTimezone(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zoneOrUtc(timeZone),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(at));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

/** Whether a call has any order or alert (indexed point lookups, §14.2). */
async function hasOrderOrAlert(ctx: QueryCtx, callId: Id<"calls">) {
  const [order, alert] = await Promise.all([
    ctx.db
      .query("orders")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .first(),
    ctx.db
      .query("alerts")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .first(),
  ]);
  return order !== null || alert !== null;
}

/**
 * Whether the family may see a call's full transcript: always when chat sharing is
 * on, otherwise only for calls with an order, an alert or a scam signal (§14.2).
 */
async function transcriptVisible(
  ctx: QueryCtx,
  household: Doc<"households">,
  call: Doc<"calls">,
) {
  return (
    household.sharing.chatTranscripts ||
    call.kind === "order" ||
    call.kind === "mixed" ||
    call.outcome === "ordered" ||
    call.outcome === "awaiting_approval" ||
    call.outcome === "declined_scam" ||
    call.scamHold.active ||
    (await hasOrderOrAlert(ctx, call._id))
  );
}

function summarizeCall(
  household: Doc<"households">,
  call: Doc<"calls">,
  visible: boolean,
) {
  return {
    _id: call._id,
    startedAt: call.startedAt,
    endedAt: call.endedAt ?? null,
    kind: call.kind,
    outcome: call.outcome,
    summary: call.summary ?? null,
    scamScore: call.scamScore,
    scamSignals: call.scamSignals,
    scamReasons: call.scamReasons,
    scamHold: {
      active: call.scamHold.active,
      reason: call.scamHold.reason ?? null,
      at: call.scamHold.at ?? null,
    },
    // #95: every family override of a scam hold, with who and when (always visible, §14.1).
    scamOverrides: (call.scamOverrides ?? []).map((o) => ({
      by: o.by,
      at: o.at,
      holdReason: o.holdReason ?? null,
      note: o.note ?? null,
    })),
    transcriptVisible: visible,
    // #99 / WB-3: mood notes only while the caller agrees to share them (server-side gate).
    moodNote: household.sharing.moodNotes ? (call.moodNote ?? null) : null,
    moodNotesShared: household.sharing.moodNotes,
  };
}

function diff(later?: number, earlier?: number) {
  return later !== undefined && earlier !== undefined && later >= earlier
    ? Math.round(later - earlier)
    : null;
}

function presentTurn(turn: Doc<"turns">) {
  const t = turn.timings;
  return {
    _id: turn._id,
    idx: turn.idx,
    speaker: turn.speaker,
    // Redacted text never leaves the server.
    text: turn.redacted ? null : turn.text,
    redacted: turn.redacted,
    at: turn.at,
    scam: turn.scam ?? null,
    refused: turn.refused ?? false,
    tools: (turn.tools ?? []).map((t) => ({
      name: t.name,
      result: t.result ?? null,
    })),
    // Same stage definitions as harness/latency_report.py.
    latency: {
      sttMs: diff(t.sttFinalAt, t.speechEndAt),
      // Claude time to first token for the request that produced the reply.
      llmMs: diff(t.llmFirstTokenAt, t.llmRequestAt),
      // Final transcript to first reply text (includes tool calls).
      replyMs: diff(t.llmFirstTokenAt, t.sttFinalAt),
      ttsMs: diff(t.ttsFirstAudioAt, t.llmFirstTokenAt),
      voiceToVoiceMs: diff(t.ttsFirstAudioAt, t.speechEndAt),
    },
    usage: turn.usage,
  };
}

/** Household summary for the header and settings. No phone numbers. */
export const household = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const [limits, favorites] = await Promise.all([
      ctx.db
        .query("limits")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .first(),
      ctx.db
        .query("favorites")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .take(50),
    ]);
    return {
      _id: household._id,
      callerName: household.callerName,
      preferredName: household.preferredName,
      timezone: household.timezone,
      sharing: household.sharing,
      // Never full numbers: the last four digits are enough to tell contacts apart.
      familyContacts: household.familyContacts.map((c) => ({
        name: c.name,
        relation: c.relation,
        phoneLast4: c.phone.slice(-4),
      })),
      limits: limits
        ? {
            perOrderCapCents: limits.perOrderCapCents,
            monthlyBudgetCents: limits.monthlyBudgetCents,
            approvedStores: limits.approvedStores,
          }
        : null,
      favorites: favorites.map((f) => ({
        _id: f._id,
        name: f.name,
        aliases: f.aliases,
        store: f.store,
        storeItemId: f.storeItemId,
        usualQty: f.usualQty,
      })),
    };
  },
});

/** The latest call and, when sharing allows, its turns (oldest first). */
export const liveCall = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const call = await ctx.db
      .query("calls")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .first();
    if (!call) return null;
    const visible = await transcriptVisible(ctx, household, call);
    const turns = visible
      ? await ctx.db
          .query("turns")
          .withIndex("by_call_idx", (q) => q.eq("callId", call._id))
          .take(TURNS_PER_CALL)
      : [];
    return {
      call: summarizeCall(household, call, visible),
      live: call.endedAt === undefined,
      turns: turns.map(presentTurn),
    };
  },
});

/** Recent calls with one-line summaries (always visible, §14.2). */
export const recentCalls = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(RECENT_CALLS);
    return Promise.all(
      calls.map(async (call) =>
        summarizeCall(
          household,
          call,
          await transcriptVisible(ctx, household, call),
        ),
      ),
    );
  },
});

/**
 * Orders newest first plus the paid spend for `month` ("YYYY-MM", in the
 * household's timezone) against the monthly budget. The client passes the
 * month so this query never reads the wall clock.
 */
export const orders = query({
  args: { ...accessArgs, month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    if (args.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month))
      throw new ConvexError("Invalid month");
    const recent = await ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(ORDERS_SHOWN);
    let monthly: {
      month: string;
      spentCents: number;
      paidCount: number;
      budgetCents: number | null;
    } | null = null;
    if (args.month) {
      const limits = await ctx.db
        .query("limits")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .first();
      let spentCents = 0;
      let paidCount = 0;
      let scanned = 0;
      for await (const order of ctx.db
        .query("orders")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .order("desc")) {
        if (++scanned > MONTH_SCAN) break;
        const month = monthInTimezone(order.createdAt, household.timezone);
        // Newest first: once we are past the month, older orders cannot count.
        if (month < args.month) break;
        if (month === args.month && order.status === "paid") {
          spentCents += order.totalCents;
          paidCount++;
        }
      }
      monthly = {
        month: args.month,
        spentCents,
        paidCount,
        budgetCents: limits?.monthlyBudgetCents ?? null,
      };
    }
    return {
      orders: recent.map((o) => ({
        _id: o._id,
        callId: o.callId,
        items: o.items.map((i) => ({
          name: i.name,
          qty: i.qty,
          priceCents: i.priceCents,
        })),
        totalCents: o.totalCents,
        store: o.store,
        status: o.status,
        approvedBy: o.approvedBy ?? null,
        declinedBy: o.declinedBy ?? null,
        // Spoken-friendly reason (limit broken, or why payment failed).
        reason: o.reason ?? null,
        decidedAt: o.decidedAt ?? null,
        paidAt: o.paidAt ?? null,
        // A short reference only; never a full payment token (§14.1).
        paymentRef: o.paymentTokenRef ? o.paymentTokenRef.slice(-6) : null,
        createdAt: o.createdAt,
      })),
      monthly,
    };
  },
});

/** Nav badge counts. */
export const counts = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const [orders, alerts] = await Promise.all([
      ctx.db
        .query("orders")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .order("desc")
        .take(BADGE_SCAN),
      ctx.db
        .query("alerts")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .order("desc")
        .take(BADGE_SCAN),
    ]);
    return {
      openApprovals: orders.filter((o) => o.status === "awaiting_approval")
        .length,
      unacknowledgedAlerts: alerts.filter((a) => a.acknowledgedAt === undefined)
        .length,
    };
  },
});

/** Read-only memory: active facts with evidence, and open follow-ups. */
export const memory = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const [facts, followups, asked, closed] = await Promise.all([
      ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "active"),
        )
        .order("desc")
        .take(FACTS_SHOWN),
      ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "open"),
        )
        .order("desc")
        .take(FOLLOWUPS_SHOWN),
      ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "asked"),
        )
        .order("desc")
        .take(RECENT_FOLLOWUPS),
      ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", household._id).eq("status", "closed"),
        )
        .order("desc")
        .take(RECENT_FOLLOWUPS),
    ]);
    // Source call start times ("from the call on Oct 20"), one read per distinct call.
    const sourceIds = [...new Set(facts.map((f) => f.sourceCallId))];
    const sourceCalls = await Promise.all(
      sourceIds.map((id) => ctx.db.get(id)),
    );
    const startedAt = new Map<Id<"calls">, number>();
    for (const c of sourceCalls)
      if (c && c.householdId === household._id)
        startedAt.set(c._id, c.startedAt);
    return {
      facts: facts.map((f) => ({
        _id: f._id,
        text: f.text,
        category: f.category,
        evidence: f.evidence,
        sourceCallId: f.sourceCallId,
        sourceCallStartedAt: startedAt.get(f.sourceCallId) ?? null,
        createdAt: f.createdAt,
      })),
      followups: followups.map((f) => ({
        _id: f._id,
        speakable: f.speakable,
        notBefore: f.notBefore,
      })),
      // Recently asked or closed ("How did Lily's recital go?" after Call 1), newest first.
      pastFollowups: [...asked, ...closed]
        .sort((a, b) => b._creationTime - a._creationTime)
        .slice(0, RECENT_FOLLOWUPS)
        .map((f) => ({
          _id: f._id,
          speakable: f.speakable,
          status: f.status,
        })),
    };
  },
});

// ---------- Alerts (#94) ----------

const ALERTS_SHOWN = 100;

/** Who an alert went to, by name; never a phone number. */
function recipientName(household: Doc<"households">, recipient: string) {
  if (recipient === "dashboard") return "Dashboard";
  return (
    household.familyContacts.find((c) => c.phone === recipient)?.name ??
    "Family contact"
  );
}

/**
 * Every alert, newest first. Scam and wellbeing alerts and their excerpts are always shown,
 * whatever the sharing settings say (§14.2). Scam alerts carry their call's hold state and
 * override history so the family can lift a hold here (#95).
 */
export const alerts = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(ALERTS_SHOWN);
    const callIds = [
      ...new Set(
        rows.filter((a) => a.type === "scam" && a.callId).map((a) => a.callId!),
      ),
    ];
    const calls = new Map<Id<"calls">, Doc<"calls">>();
    for (const call of await Promise.all(callIds.map((id) => ctx.db.get(id))))
      if (call && call.householdId === household._id) calls.set(call._id, call);
    return rows.map((a) => {
      const call = a.callId ? calls.get(a.callId) : undefined;
      return {
        _id: a._id,
        type: a.type,
        channel: a.channel,
        delivery: a.delivery,
        message: a.message,
        transcriptExcerpt: a.transcriptExcerpt ?? null,
        recipient: recipientName(household, a.recipient),
        sentAt: a.sentAt,
        callId: a.callId ?? null,
        orderId: a.orderId ?? null,
        decision: a.decision ?? null,
        decidedBy: a.decidedBy
          ? a.decidedBy.startsWith("+")
            ? recipientName(household, a.decidedBy)
            : a.decidedBy
          : null,
        decidedAt: a.decidedAt ?? null,
        acknowledgedAt: a.acknowledgedAt ?? null,
        acknowledgedBy: a.acknowledgedBy ?? null,
        scamCall: call
          ? {
              holdActive: call.scamHold.active,
              holdReason: call.scamHold.reason ?? null,
              live: call.endedAt === undefined,
              overrides: (call.scamOverrides ?? []).map((o) => ({
                by: o.by,
                at: o.at,
                note: o.note ?? null,
              })),
            }
          : null,
      };
    });
  },
});

// ---------- Approvals (#93) ----------

const APPROVAL_SCAN = 200;
const RESOLVED_SHOWN = 15;

/**
 * Orders waiting for the family, oldest first, and recent decisions. Each carries the
 * family alert calls placed for it (ringing, answered, no answer) and who decided.
 */
export const approvals = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const recent = await ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(APPROVAL_SCAN);
    const pending = recent
      .filter((o) => o.status === "awaiting_approval")
      .reverse();
    const resolved = recent
      .filter(
        (o) =>
          o.status !== "awaiting_approval" &&
          (o.approvedBy !== undefined || o.declinedBy !== undefined),
      )
      .slice(0, RESOLVED_SHOWN);
    const present = async (o: Doc<"orders">) => {
      const calls = (
        await ctx.db
          .query("alerts")
          .withIndex("by_orderId", (q) => q.eq("orderId", o._id))
          .take(20)
      ).filter((a) => a.type === "approval_needed" && a.channel === "call");
      const decidedBy = o.approvedBy ?? o.declinedBy ?? null;
      return {
        _id: o._id,
        callId: o.callId,
        items: o.items.map((i) => ({
          name: i.name,
          qty: i.qty,
          priceCents: i.priceCents,
        })),
        totalCents: o.totalCents,
        store: o.store,
        status: o.status,
        reason: o.reason ?? null,
        createdAt: o.createdAt,
        decidedAt: o.decidedAt ?? null,
        decision: o.approvedBy
          ? ("approved" as const)
          : o.declinedBy
            ? ("declined" as const)
            : null,
        decidedBy:
          decidedBy === "system:expired" ? "No answer in time" : decidedBy,
        paidAt: o.paidAt ?? null,
        alertCalls: calls.map((a) => ({
          _id: a._id,
          recipient: recipientName(household, a.recipient),
          delivery: a.delivery,
          decision: a.decision ?? null,
          sentAt: a.sentAt,
        })),
      };
    };
    return {
      pending: await Promise.all(pending.map(present)),
      resolved: await Promise.all(resolved.map(present)),
    };
  },
});

// ---------- Developer panel (#98) ----------

const DEV_CALLS = 15;
const DEV_TURNS_PER_CALL = 300;
const LONG_PROMPT_TOKENS = 100_000;

/** Claude Haiku 5.5, USD per million tokens (SPEC §12.4; same table as harness/latency_report.py). */
export const HAIKU_PRICES = {
  le100k: { input: 0.1, output: 0.5, write5m: 0.125, read: 0.01 },
  gt100k: { input: 0.5, output: 2.5, write5m: 0.625, read: 0.05 },
} as const;

/** §12.1 / §16.2 targets shown next to the numbers. */
export const DEV_TARGETS = {
  voiceToVoiceP50Ms: 800,
  voiceToVoiceP95Ms: 1500,
  llmP50Ms: 300,
  sttP50Ms: 100,
  ttsP50Ms: 100,
  firstTurnCacheHit: 0.95,
  costPerCallUsd: 0.05,
} as const;

/** Linear-interpolation percentile (numpy's default), as in harness/latency_report.py. */
export function percentile(values: number[], q: number): number | null {
  const data = [...values].sort((a, b) => a - b);
  if (data.length === 0) return null;
  if (data.length === 1) return data[0];
  const pos = ((data.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return data[lo] + (data[hi] - data[lo]) * (pos - lo);
}

/**
 * USD cost of one turn's logged usage. Cache writes are priced as 5-minute writes and the
 * tier is chosen from the turn's summed prompt (conservative), matching the harness.
 */
export function turnCostUsd(u: Doc<"turns">["usage"]) {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const p = HAIKU_PRICES[prompt > LONG_PROMPT_TOKENS ? "gt100k" : "le100k"];
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.read +
      u.cacheWrite * p.write5m) /
    1_000_000
  );
}

const STAGES = [
  {
    key: "voiceToVoice",
    label: "Voice to voice (caller stops → agent speaks)",
  },
  { key: "stt", label: "Speech to final transcript" },
  { key: "turnSetup", label: "Final transcript → Claude request" },
  { key: "llm", label: "Claude time to first token" },
  { key: "reply", label: "Final transcript → first reply text" },
  { key: "tts", label: "First token → first audio" },
] as const;
type StageKey = (typeof STAGES)[number]["key"];

/** Latency, cache and cost stats over calls' turns (pure, so it is unit-testable). */
export function developerStats(
  calls: { call: Doc<"calls">; turns: Doc<"turns">[] }[],
) {
  const samples: Record<StageKey, number[]> = {
    voiceToVoice: [],
    stt: [],
    turnSetup: [],
    llm: [],
    reply: [],
    tts: [],
  };
  let firstKnown = 0;
  let firstHits = 0;
  let modelTurnsTotal = 0;
  let over100k = 0;
  const perCall = calls.map(({ call, turns }) => {
    let cost = 0;
    let modelTurns = 0;
    let firstHit: boolean | null = null;
    const v2v: number[] = [];
    for (const turn of [...turns].sort((a, b) => a.idx - b.idx)) {
      if (turn.speaker !== "assistant") continue;
      const u = turn.usage;
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      if (prompt <= 0) continue; // templated line: no Claude request
      modelTurns++;
      if (prompt > LONG_PROMPT_TOKENS) over100k++;
      if (firstHit === null) firstHit = u.cacheRead > 0;
      cost += turnCostUsd(u);
      const t = turn.timings;
      const push = (key: StageKey, value: number | null) => {
        if (value !== null) samples[key].push(value);
      };
      const voice = diff(t.ttsFirstAudioAt, t.speechEndAt);
      push("voiceToVoice", voice);
      if (voice !== null) v2v.push(voice);
      push("stt", diff(t.sttFinalAt, t.speechEndAt));
      push("turnSetup", diff(t.llmRequestAt, t.sttFinalAt));
      push("llm", diff(t.llmFirstTokenAt, t.llmRequestAt));
      push("reply", diff(t.llmFirstTokenAt, t.sttFinalAt));
      push("tts", diff(t.ttsFirstAudioAt, t.llmFirstTokenAt));
    }
    modelTurnsTotal += modelTurns;
    if (firstHit !== null) {
      firstKnown++;
      if (firstHit) firstHits++;
    }
    return {
      callId: call._id,
      startedAt: call.startedAt,
      outcome: call.outcome,
      modelTurns,
      costUsd: modelTurns ? cost : null,
      firstTurnCacheHit: firstHit,
      voiceToVoiceP50Ms: percentile(v2v, 50),
    };
  });
  const costs = perCall
    .map((c) => c.costUsd)
    .filter((c): c is number => c !== null);
  return {
    callsAnalyzed: calls.length,
    modelTurns: modelTurnsTotal,
    turnsOver100kPrompt: over100k,
    stages: STAGES.map((s) => ({
      key: s.key,
      label: s.label,
      n: samples[s.key].length,
      p50: percentile(samples[s.key], 50),
      p95: percentile(samples[s.key], 95),
    })),
    cache: {
      hits: firstHits,
      known: firstKnown,
      rate: firstKnown ? firstHits / firstKnown : null,
    },
    cost: {
      calls: costs.length,
      p50: percentile(costs, 50),
      max: costs.length ? Math.max(...costs) : null,
      latest: costs.length
        ? (perCall.find((c) => c.costUsd !== null)?.costUsd ?? null)
        : null,
    },
    perCall,
    targets: DEV_TARGETS,
  };
}

/** DSH-5: p50/p95 per stage, first-turn cache hit rate and Claude cost per call. No text. */
export const developer = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .order("desc")
      .take(DEV_CALLS);
    const withTurns = await Promise.all(
      calls.map(async (call) => ({
        call,
        turns: await ctx.db
          .query("turns")
          .withIndex("by_call_idx", (q) => q.eq("callId", call._id))
          .take(DEV_TURNS_PER_CALL),
      })),
    );
    return developerStats(withTurns);
  },
});

// ---------- Memory delete (#96, MEM-6, §11.6 "forget means forget") ----------

/**
 * A family member deletes a remembered fact: it becomes `forgotten` (logged with who and
 * when), its evidence turn is redacted and the source call's summary is regenerated.
 */
export const forgetFact = mutation({
  args: { ...actorArgs, factId: v.id("memory_facts") },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const fact = await ctx.db.get(args.factId);
    if (!fact || fact.householdId !== household._id)
      throw new ConvexError("Fact not found");
    const who = await resolveActor(ctx, household, args);
    return forgetMemoryFact(ctx, args.factId, who);
  },
});
