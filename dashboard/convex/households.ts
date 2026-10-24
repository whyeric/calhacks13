import {
  internalQuery,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { requireFamily } from "./auth";
import {
  actorArgs,
  demoHousehold,
  resolveActor,
  resolveHousehold,
} from "./access";
import { recentOrders, spendSummary } from "./orders";
import { recentIncidents } from "./scam";

const RECENT_CALL_WINDOW_MS = 90 * 86_400_000;
const SUMMARY_CALLS = 30;
const TRANSCRIPT_CALLS = 5;
const TRANSCRIPT_TURNS = 60;
const TURN_CHARS = 1_000;

/**
 * #62: summaries of the household's ended calls in the last 90 days (newest first) and the
 * transcripts of the few most recent ones, for the memory block. Bounded reads; redacted
 * turns are left out. No IDs: the agent renders these as notes, not references.
 */
async function recentCalls(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
) {
  const calls = (
    await ctx.db
      .query("calls")
      .withIndex("by_household", (q) =>
        q
          .eq("householdId", householdId)
          .gte("_creationTime", now - RECENT_CALL_WINDOW_MS),
      )
      .order("desc")
      .take(SUMMARY_CALLS + 10)
  )
    // Only ended calls: never the call being looked up or another one in progress.
    .filter((c) => c.endedAt !== undefined)
    .sort(
      (a, b) => b.startedAt - a.startedAt || a._creationTime - b._creationTime,
    )
    .slice(0, SUMMARY_CALLS);
  const callSummaries = calls
    .filter((c) => c.summary)
    .map((c) => ({
      startedAt: c.startedAt,
      kind: c.kind,
      outcome: c.outcome,
      summary: c.summary!,
    }));
  const recentTranscripts = await Promise.all(
    calls.slice(0, TRANSCRIPT_CALLS).map(async (c) => ({
      startedAt: c.startedAt,
      turns: (
        await ctx.db
          .query("turns")
          .withIndex("by_call_idx", (q) => q.eq("callId", c._id))
          .take(TRANSCRIPT_TURNS)
      )
        .filter((t) => !t.redacted && t.text.trim())
        .map((t) => ({
          speaker: t.speaker,
          text: t.text.slice(0, TURN_CHARS),
        })),
    })),
  );
  return {
    callSummaries,
    recentTranscripts: recentTranscripts.filter((t) => t.turns.length),
  };
}

export const lookup = internalQuery({
  // `now` is passed by the caller so the query itself never reads the clock.
  args: { callerPhone: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, { callerPhone, now: at }) => {
    const now = at ?? Date.now();
    const household = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", callerPhone))
      .unique();
    if (!household) return null;
    const [limits, favorites, facts, openFollowups, orders, spend, history] =
      await Promise.all([
        ctx.db
          .query("limits")
          .withIndex("by_household", (q) => q.eq("householdId", household._id))
          .unique(),
        ctx.db
          .query("favorites")
          .withIndex("by_household", (q) => q.eq("householdId", household._id))
          .take(50),
        ctx.db
          .query("memory_facts")
          .withIndex("by_household_status", (q) =>
            q.eq("householdId", household._id).eq("status", "active"),
          )
          .take(200),
        ctx.db
          .query("followups")
          .withIndex("by_household_status", (q) =>
            q.eq("householdId", household._id).eq("status", "open"),
          )
          .take(20),
        recentOrders(ctx, household._id, now),
        spendSummary(ctx, household._id, now),
        recentCalls(ctx, household._id, now),
      ]);
    // Only follow-ups that are due; the agent asks at most one per call (/agent/followup).
    const followups = openFollowups.filter((f) => f.notBefore <= now);
    return {
      // Agent-facing allow-list: no phone numbers, address or auth subjects.
      household: {
        preferredName: household.preferredName,
        callerName: household.callerName,
        timezone: household.timezone,
        sharing: household.sharing,
        // #69: false until the first-call introduction has happened.
        introduced: household.introducedAt !== undefined,
        familyContacts: household.familyContacts.map((c) => ({
          name: c.name,
          relation: c.relation,
        })),
      },
      limits,
      favorites,
      facts,
      followups,
      recentOrders: orders,
      // #49 usual-spend digest for the scam guard (SCM-4) and the memory block.
      spendSummary: spend,
      // #62: earlier calls, for the memory block's summaries and recent transcripts.
      callSummaries: history.callSummaries,
      recentTranscripts: history.recentTranscripts,
      // #18/#27: prior scam incidents (newest first, at most 3) for the scam classifier digest.
      scamIncidents: await recentIncidents(ctx, household._id, now),
    };
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

/**
 * Operator tool for rehearsals and Gate 2 rows 2.2/2.3 (LIM-3): change the demo
 * household's limits from the Convex CLI. Internal only; the Settings screen editor is
 * Phase 2. The next order reads the new values.
 */
export const setLimits = internalMutation({
  args: {
    householdId: v.optional(v.id("households")),
    perOrderCapCents: v.optional(v.number()),
    monthlyBudgetCents: v.optional(v.number()),
    approvedStores: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { householdId, ...changes }) => {
    const household = householdId
      ? await ctx.db.get(householdId)
      : await demoHousehold(ctx);
    if (!household) throw new ConvexError("Household not found");
    return applyLimits(ctx, household, changes);
  },
});

type LimitChanges = {
  perOrderCapCents?: number;
  monthlyBudgetCents?: number;
  approvedStores?: string[];
};

/** Validate and write limits; `reserve` reads them on the next order (LIM-3). */
async function applyLimits(
  ctx: MutationCtx,
  household: Doc<"households">,
  changes: LimitChanges,
) {
  for (const cents of [changes.perOrderCapCents, changes.monthlyBudgetCents])
    if (cents !== undefined && (!Number.isSafeInteger(cents) || cents < 0))
      throw new ConvexError("Limits must be whole, non-negative cents");
  const stores = changes.approvedStores?.map((s) => s.trim());
  if (stores?.some((s) => !s || s.length > 100) || (stores?.length ?? 0) > 20)
    throw new ConvexError("Invalid store");
  const patch = {
    ...(changes.perOrderCapCents !== undefined && {
      perOrderCapCents: changes.perOrderCapCents,
    }),
    ...(changes.monthlyBudgetCents !== undefined && {
      monthlyBudgetCents: changes.monthlyBudgetCents,
    }),
    ...(stores && { approvedStores: stores }),
  };
  const limits = await ctx.db
    .query("limits")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .unique();
  if (limits) await ctx.db.patch(limits._id, patch);
  else {
    if (
      patch.perOrderCapCents === undefined ||
      patch.monthlyBudgetCents === undefined ||
      patch.approvedStores === undefined
    )
      throw new ConvexError("No limits yet: set all three fields");
    await ctx.db.insert("limits", {
      householdId: household._id,
      perOrderCapCents: patch.perOrderCapCents,
      monthlyBudgetCents: patch.monthlyBudgetCents,
      approvedStores: patch.approvedStores,
    });
  }
  const updated = await ctx.db
    .query("limits")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .unique();
  return {
    perOrderCapCents: updated!.perOrderCapCents,
    monthlyBudgetCents: updated!.monthlyBudgetCents,
    approvedStores: updated!.approvedStores,
  };
}

// ---------- Settings screen (#97): family edits, read by place_order on the next order ----------

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_FAVORITES = 50;
const MAX_CONTACTS = 10;

function text(value: string, label: string, max = 100) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max)
    throw new ConvexError(`Invalid ${label}`);
  return trimmed;
}

/** Authorize a settings change; returns the household and who made it. */
async function settingsAccess(
  ctx: MutationCtx,
  args: { accessKey?: string; householdId?: Id<"households">; actor?: string },
) {
  const household = await resolveHousehold(ctx, args);
  const by = await resolveActor(ctx, household, args);
  return { household, by };
}

/** LIM-1/LIM-3: per-order cap, monthly budget (integer cents) and approved stores. */
export const updateLimits = mutation({
  args: {
    ...actorArgs,
    perOrderCapCents: v.optional(v.number()),
    monthlyBudgetCents: v.optional(v.number()),
    approvedStores: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    return applyLimits(ctx, household, {
      perOrderCapCents: args.perOrderCapCents,
      monthlyBudgetCents: args.monthlyBudgetCents,
      approvedStores: args.approvedStores,
    });
  },
});

/** Add (no favoriteId) or edit a favorite; aliases feed match_favorite (T2). */
export const saveFavorite = mutation({
  args: {
    ...actorArgs,
    favoriteId: v.optional(v.id("favorites")),
    name: v.string(),
    aliases: v.array(v.string()),
    store: v.string(),
    storeItemId: v.string(),
    usualQty: v.number(),
  },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    const aliases = [
      ...new Set(args.aliases.map((a) => a.trim()).filter(Boolean)),
    ];
    if (aliases.length > 20 || aliases.some((a) => a.length > 100))
      throw new ConvexError("Invalid aliases");
    if (
      !Number.isSafeInteger(args.usualQty) ||
      args.usualQty < 1 ||
      args.usualQty > 20
    )
      throw new ConvexError(
        "Usual quantity must be a whole number from 1 to 20",
      );
    const row = {
      householdId: household._id,
      name: text(args.name, "name", 200),
      aliases,
      store: text(args.store, "store"),
      storeItemId: text(args.storeItemId, "store item ID", 200),
      usualQty: args.usualQty,
    };
    if (args.favoriteId) {
      const existing = await ctx.db.get(args.favoriteId);
      if (!existing || existing.householdId !== household._id)
        throw new ConvexError("Favorite not found");
      await ctx.db.replace(args.favoriteId, row);
      return args.favoriteId;
    }
    const count = (
      await ctx.db
        .query("favorites")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .take(MAX_FAVORITES)
    ).length;
    if (count >= MAX_FAVORITES) throw new ConvexError("Too many favorites");
    return ctx.db.insert("favorites", row);
  },
});

export const removeFavorite = mutation({
  args: { ...actorArgs, favoriteId: v.id("favorites") },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    const existing = await ctx.db.get(args.favoriteId);
    if (!existing || existing.householdId !== household._id)
      throw new ConvexError("Favorite not found");
    await ctx.db.delete(args.favoriteId);
    return null;
  },
});

/**
 * Add (no index) or edit a family contact. Contacts are addressed by position plus their
 * current name, so a stale screen cannot edit the wrong person. The phone is only replaced
 * when a new one is given (the dashboard never receives full numbers).
 */
export const saveContact = mutation({
  args: {
    ...actorArgs,
    index: v.optional(v.number()),
    currentName: v.optional(v.string()),
    name: v.string(),
    relation: v.string(),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    const name = text(args.name, "name");
    const relation = text(args.relation, "relation", 50);
    const phone = args.phone?.replace(/[\s().-]/g, "");
    if (phone !== undefined && !E164.test(phone))
      throw new ConvexError("Phone must be in E.164 format, like +14155550101");
    if (phone === household.callerPhone)
      throw new ConvexError("A family contact can't use the caller's number");
    const contacts = [...household.familyContacts];
    const clash = (i: number | null) =>
      contacts.some(
        (c, j) =>
          j !== i &&
          (c.name.trim().toLowerCase() === name.toLowerCase() ||
            (phone !== undefined && c.phone === phone)),
      );
    if (args.index === undefined) {
      if (phone === undefined)
        throw new ConvexError("A new contact needs a phone");
      if (contacts.length >= MAX_CONTACTS)
        throw new ConvexError("Too many contacts");
      if (clash(null)) throw new ConvexError("That contact already exists");
      contacts.push({ name, relation, phone });
    } else {
      const current = contacts[args.index];
      if (!current || current.name !== args.currentName)
        throw new ConvexError("Contact changed; reload and try again");
      if (clash(args.index))
        throw new ConvexError("That contact already exists");
      contacts[args.index] = {
        ...current,
        name,
        relation,
        ...(phone !== undefined ? { phone } : {}),
      };
    }
    await ctx.db.patch(household._id, { familyContacts: contacts });
    return null;
  },
});

export const removeContact = mutation({
  args: { ...actorArgs, index: v.number(), currentName: v.string() },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    const contacts = [...household.familyContacts];
    if (contacts[args.index]?.name !== args.currentName)
      throw new ConvexError("Contact changed; reload and try again");
    if (contacts.length <= 1)
      throw new ConvexError(
        "Keep at least one family contact for approvals and alerts",
      );
    contacts.splice(args.index, 1);
    await ctx.db.patch(household._id, { familyContacts: contacts });
    return null;
  },
});

/** §14.2 sharing choices. The dashboard asks for the caller's agreement before turning one on. */
export const setSharing = mutation({
  args: {
    ...actorArgs,
    chatTranscripts: v.optional(v.boolean()),
    moodNotes: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { household } = await settingsAccess(ctx, args);
    const sharing = {
      chatTranscripts:
        args.chatTranscripts ?? household.sharing.chatTranscripts,
      moodNotes: args.moodNotes ?? household.sharing.moodNotes,
    };
    await ctx.db.patch(household._id, { sharing });
    return sharing;
  },
});
