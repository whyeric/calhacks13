import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";

/**
 * Scam guard, Convex side (SPEC §8.7). The agent's guard (agent/scam.py) scores caller turns
 * and decides holds; this module records them, arms the hold that orders.reserve enforces,
 * sends the family alert call (SCM-5) and keeps scam claims out of memory (SCM-7).
 */

const SIGNAL = /^[a-z_]{1,64}$/;
const MAX_SIGNALS = 20;
const MAX_REASONS = 20;
const REASON_CHARS = 300;
const EXCERPT_TURNS = 8;
const EXCERPT_CHARS = 1500;
export const QUARANTINE_SCORE = 0.7;
const INCIDENT_WINDOW_MS = 90 * 86_400_000;

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function incidentDate(at: number, timeZone: string) {
  const opts = { month: "short", day: "numeric" } as const;
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...opts,
      timeZone: "UTC",
    }).format(at);
  }
}

async function excerptFor(ctx: MutationCtx, callId: Id<"calls">) {
  const turns = await ctx.db
    .query("turns")
    .withIndex("by_call_idx", (q) => q.eq("callId", callId))
    .order("desc")
    .take(EXCERPT_TURNS);
  const lines = turns
    .reverse()
    .filter((t) => !t.redacted && t.text.trim())
    .map(
      (t) =>
        `${t.speaker === "user" ? "Caller" : "Errand Line"}: ${clip(t.text, 300)}`,
    );
  return lines.join("\n").slice(-EXCERPT_CHARS);
}

export type HoldRequest = {
  reason: string;
  hardRule: boolean;
  /** e.g. "a $400 gift card request" */
  what?: string;
  /** e.g. "a caller claiming to be from Medicare asked for it" */
  claim?: string;
  excerpt?: string;
};

/**
 * Put a call on a scam hold (SCM-3) once: outcome declined_scam, an incident line for the
 * memory writer (SCM-7) and an alert call to every family contact (SCM-5, §14.2: scam alerts
 * always go to family, whatever the sharing settings). A family override (#95) blocks
 * re-arming by the classifier, never by the hard rule. Returns how many alerts were queued.
 */
export async function armHold(
  ctx: MutationCtx,
  callId: Id<"calls">,
  hold: HoldRequest,
): Promise<{ armed: boolean; alerted: number }> {
  const call = await ctx.db.get(callId);
  if (!call) throw new ConvexError("Call not found");
  if (call.scamHold.active) return { armed: false, alerted: 0 };
  if (!hold.hardRule && (call.scamOverrides?.length ?? 0) > 0)
    return { armed: false, alerted: 0 };
  const now = Date.now();
  const household = call.householdId
    ? await ctx.db.get(call.householdId)
    : null;
  const name = household?.preferredName ?? "the caller";
  const what = clip(hold.what || "what looked like a scam request", 160);
  const claim = hold.claim ? clip(hold.claim, 200) : "";
  const incident = `Scam attempt on ${incidentDate(now, household?.timezone ?? "UTC")}: ${what}${
    claim ? `; ${name} said ${claim}` : ""
  }. Errand Line declined and alerted family.`;
  await ctx.db.patch(callId, {
    scamHold: { active: true, reason: clip(hold.reason, 200), at: now },
    outcome: "declined_scam", // the highest outcome rank; never downgraded later
    scamIncident: incident,
  });
  if (!household) return { armed: true, alerted: 0 };
  const excerpt = hold.excerpt?.trim()
    ? hold.excerpt.trim().slice(-EXCERPT_CHARS)
    : await excerptFor(ctx, callId);
  let alerted = 0;
  for (const contact of household.familyContacts) {
    const message =
      `Hi ${contact.name}, it's Errand Line. I just stopped ${what} from ${name}. ` +
      (claim ? `${name} said ${claim}. ` : "") +
      `Would you like me to connect you to ${name} now?`;
    await ctx.scheduler.runAfter(0, internal.alerts.call, {
      householdId: household._id,
      callId,
      type: "scam",
      message,
      ...(excerpt ? { transcriptExcerpt: excerpt } : {}),
      recipient: contact.phone,
    });
    alerted += 1;
  }
  return { armed: true, alerted };
}

/**
 * /agent/scam: the agent's per-turn classifier result (SCM-1) and, when the guard decides,
 * the hold (SCM-3). Idempotent for the same turn; scores only ever raise the call's score.
 */
export const record = internalMutation({
  args: {
    callId: v.id("calls"),
    idx: v.optional(v.number()),
    score: v.optional(v.number()),
    signals: v.optional(v.array(v.string())),
    reasons: v.optional(v.array(v.string())),
    hold: v.optional(
      v.object({
        reason: v.string(),
        hardRule: v.boolean(),
        what: v.optional(v.string()),
        claim: v.optional(v.string()),
        excerpt: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new ConvexError("Call not found");
    const signals = [...new Set(args.signals ?? [])];
    if (signals.length > 10 || signals.some((s) => !SIGNAL.test(s)))
      throw new ConvexError("Invalid signals");
    if ((args.reasons?.length ?? 0) > 5)
      throw new ConvexError("Invalid reasons");
    const reasons = (args.reasons ?? [])
      .map((r) => clip(r, REASON_CHARS))
      .filter(Boolean);
    let score: number | undefined;
    if (args.score !== undefined) {
      if (!Number.isFinite(args.score)) throw new ConvexError("Invalid score");
      score = Math.min(1, Math.max(0, args.score));
    }
    let turnPatched = false;
    if (args.idx !== undefined && score !== undefined) {
      if (!Number.isSafeInteger(args.idx) || args.idx < 0)
        throw new ConvexError("Invalid turn");
      const turn = await ctx.db
        .query("turns")
        .withIndex("by_call_idx", (q) =>
          q.eq("callId", args.callId).eq("idx", args.idx!),
        )
        .unique();
      if (turn && turn.speaker === "user") {
        const prior = turn.scam;
        await ctx.db.patch(turn._id, {
          scam: {
            score: Math.max(prior?.score ?? 0, score),
            signals: [...new Set([...(prior?.signals ?? []), ...signals])],
          },
        });
        turnPatched = true;
      }
    }
    if (score !== undefined || signals.length || reasons.length) {
      await ctx.db.patch(args.callId, {
        scamScore: Math.max(call.scamScore, score ?? 0),
        scamSignals: [...new Set([...call.scamSignals, ...signals])].slice(
          0,
          MAX_SIGNALS,
        ),
        scamReasons: [...new Set([...call.scamReasons, ...reasons])].slice(
          0,
          MAX_REASONS,
        ),
      });
    }
    const held = args.hold
      ? await armHold(ctx, args.callId, args.hold)
      : { armed: false, alerted: 0 };
    const fresh = (await ctx.db.get(args.callId))!;
    return {
      turnPatched,
      holdActive: fresh.scamHold.active,
      armed: held.armed,
      alerted: held.alerted,
    };
  },
});

export type Quarantine = {
  quarantined: boolean;
  incident: string | null;
  flaggedTurnIdx: number[];
};

/**
 * SCM-7 / #27 contract for the memory writer. A call is quarantined when it was held,
 * declined as a scam, scored high or has an incident. Flagged turns: caller turns with a
 * high score or any scam signal, and every turn at or after the hold.
 */
export async function scamQuarantine(
  ctx: QueryCtx,
  callId: Id<"calls">,
): Promise<Quarantine> {
  const call = await ctx.db.get(callId);
  if (!call) return { quarantined: false, incident: null, flaggedTurnIdx: [] };
  const quarantined =
    call.scamHold.active ||
    call.outcome === "declined_scam" ||
    call.scamScore >= QUARANTINE_SCORE ||
    !!call.scamIncident;
  const turns = await ctx.db
    .query("turns")
    .withIndex("by_call_idx", (q) => q.eq("callId", callId))
    .take(500);
  const holdAt = call.scamHold.at;
  const flaggedTurnIdx = turns
    .filter(
      (t) =>
        (t.speaker === "user" &&
          ((t.scam?.score ?? 0) >= QUARANTINE_SCORE ||
            (t.scam?.signals.length ?? 0) > 0)) ||
        (holdAt !== undefined && t.at >= holdAt),
    )
    .map((t) => t.idx);
  return {
    quarantined,
    incident: call.scamIncident ?? null,
    flaggedTurnIdx,
  };
}

export const quarantine = internalQuery({
  args: { callId: v.id("calls") },
  handler: (ctx, { callId }) => scamQuarantine(ctx, callId),
});

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** True when a fact's evidence quotes one of the flagged turns (fuzzy: normalized substring). */
export function isQuarantinedEvidence(
  evidence: string,
  flaggedTurnTexts: string[],
) {
  const e = words(evidence);
  if (!e) return false;
  return flaggedTurnTexts.some((t) => {
    const w = words(t);
    return !!w && (w.includes(e) || e.includes(w));
  });
}

/** #18 / §11.7 prior incidents for the scam classifier's digest (newest first, at most 3). */
export async function recentIncidents(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<string[]> {
  const calls: Doc<"calls">[] = await ctx.db
    .query("calls")
    .withIndex("by_household", (q) =>
      q
        .eq("householdId", householdId)
        .gte("_creationTime", now - INCIDENT_WINDOW_MS),
    )
    .order("desc")
    .take(40);
  return calls
    .filter((c) => c.endedAt !== undefined && c.scamIncident)
    .slice(0, 3)
    .map((c) => c.scamIncident!);
}
