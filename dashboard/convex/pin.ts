import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
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
 * #65: spoken PIN for calls from a new number.
 *
 * The family sets a 4-8 digit PIN and the extra numbers allowed to use it on the Settings
 * screen. A call from one of those numbers starts as an unknown caller (nothing can be looked
 * up or ordered: T4); the agent asks for the PIN by voice and sends the digits here. Only a
 * salted SHA-256 hash is stored; attempts are logged without the PIN; three wrong attempts in
 * an hour lock the number for the hour and alert the family by phone. Unapproved numbers never
 * get a PIN prompt.
 */

export const MAX_FAILURES = 3;
const LOCK_WINDOW_MS = 60 * 60_000;
const MAX_NUMBERS = 5;
const E164 = /^\+[1-9]\d{7,14}$/;
const PIN = /^\d{4,8}$/;

async function hashPin(salt: string, householdId: string, pin: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${householdId}:${pin}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const masked = (phone: string) => `••• ${phone.slice(-4)}`;

// ---------- Settings (family) ----------

export const status = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const numbers = await ctx.db
      .query("pin_numbers")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .take(MAX_NUMBERS);
    return {
      pinSet: household.pinAccess !== undefined,
      setBy: household.pinAccess?.setBy ?? null,
      setAt: household.pinAccess?.setAt ?? null,
      // The dashboard never receives full phone numbers.
      numbers: numbers.map((n) => ({ _id: n._id, label: masked(n.phone) })),
    };
  },
});

/** Set or change the PIN and (optionally) replace the approved numbers. */
export const setPin = mutation({
  args: {
    ...actorArgs,
    pin: v.optional(v.string()),
    numbers: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const by = await resolveActor(ctx, household, args);
    if (args.pin !== undefined) {
      if (!PIN.test(args.pin))
        throw new ConvexError("The PIN must be 4 to 8 digits");
      const salt = randomSalt();
      await ctx.db.patch(household._id, {
        pinAccess: {
          salt,
          hash: await hashPin(salt, household._id, args.pin),
          setBy: by,
          setAt: Date.now(),
        },
      });
    }
    if (args.numbers !== undefined) {
      const numbers = [
        ...new Set(args.numbers.map((n) => n.replace(/[\s().-]/g, ""))),
      ];
      if (numbers.length > MAX_NUMBERS)
        throw new ConvexError(`At most ${MAX_NUMBERS} numbers`);
      for (const phone of numbers) {
        if (!E164.test(phone))
          throw new ConvexError(
            "Phone must be in E.164 format, like +14155550101",
          );
        if (phone === household.callerPhone)
          throw new ConvexError("That's already the caller's own number");
        const owner = await ctx.db
          .query("households")
          .withIndex("by_callerPhone", (q) => q.eq("callerPhone", phone))
          .unique();
        const claimed = await ctx.db
          .query("pin_numbers")
          .withIndex("by_phone", (q) => q.eq("phone", phone))
          .unique();
        if (owner || (claimed && claimed.householdId !== household._id))
          throw new ConvexError("That number belongs to another household");
      }
      const existing = await ctx.db
        .query("pin_numbers")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .take(MAX_NUMBERS + 5);
      for (const row of existing) await ctx.db.delete(row._id);
      for (const phone of numbers)
        await ctx.db.insert("pin_numbers", {
          phone,
          householdId: household._id,
          addedBy: by,
          addedAt: Date.now(),
        });
    }
    return null;
  },
});

/** Turn PIN calls off: removes the PIN and every approved number. */
export const clearPin = mutation({
  args: actorArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    await resolveActor(ctx, household, args);
    await ctx.db.patch(household._id, { pinAccess: undefined });
    const rows = await ctx.db
      .query("pin_numbers")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .take(MAX_NUMBERS + 5);
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

// ---------- Agent ----------

async function recentFailures(ctx: MutationCtx, callerPhone: string) {
  const since = Date.now() - LOCK_WINDOW_MS;
  const attempts = await ctx.db
    .query("pin_attempts")
    .withIndex("by_callerPhone", (q) => q.eq("callerPhone", callerPhone))
    .order("desc")
    .take(MAX_FAILURES * 2);
  let failures = 0;
  for (const a of attempts) {
    if (a.at < since || a.ok) break;
    failures += 1;
  }
  return failures;
}

async function approvedHousehold(
  ctx: MutationCtx,
  callerPhone: string,
): Promise<Doc<"households"> | null> {
  const row = await ctx.db
    .query("pin_numbers")
    .withIndex("by_phone", (q) => q.eq("phone", callerPhone))
    .unique();
  if (!row) return null;
  const household = await ctx.db.get(row.householdId);
  return household?.pinAccess ? household : null;
}

/** Whether to ask this unknown number for a PIN. Never says which household it belongs to. */
export const check = internalMutation({
  args: { callerPhone: v.string() },
  handler: async (ctx, { callerPhone }) => {
    const household = await approvedHousehold(ctx, callerPhone);
    if (!household) return { pinRequired: false, locked: false };
    return {
      pinRequired: true,
      locked: (await recentFailures(ctx, callerPhone)) >= MAX_FAILURES,
    };
  },
});

/**
 * Check a spoken PIN for the call. On success the call is linked to the household, so
 * place_order's checks (limits, scam rule) apply as for the caller's own phone.
 */
export const verify = internalMutation({
  args: { callId: v.id("calls"), pin: v.string() },
  handler: async (ctx, { callId, pin }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.endedAt !== undefined)
      throw new ConvexError("Call not found");
    if (call.householdId) {
      // Already unlocked (a retry): report the household again.
      const household = await ctx.db.get(call.householdId);
      return household && call.pinVerifiedAt
        ? { status: "ok" as const, callerPhone: household.callerPhone }
        : { status: "not_available" as const };
    }
    const callerPhone = call.callerPhone;
    const household = await approvedHousehold(ctx, callerPhone);
    if (!household?.pinAccess) return { status: "not_available" as const };
    const failures = await recentFailures(ctx, callerPhone);
    if (failures >= MAX_FAILURES) return { status: "locked" as const };
    const digits = pin.replace(/\D/g, "");
    const ok =
      PIN.test(digits) &&
      sameText(
        await hashPin(household.pinAccess.salt, household._id, digits),
        household.pinAccess.hash,
      );
    await ctx.db.insert("pin_attempts", {
      callerPhone,
      householdId: household._id,
      callId,
      ok,
      at: Date.now(),
    });
    if (ok) {
      await ctx.db.patch(callId, {
        householdId: household._id,
        kind: "chat",
        outcome: "no_order",
        pinVerifiedAt: Date.now(),
      });
      return { status: "ok" as const, callerPhone: household.callerPhone };
    }
    const left = MAX_FAILURES - failures - 1;
    if (left <= 0) {
      const recipient = household.familyContacts[0]?.phone;
      if (recipient)
        await ctx.scheduler.runAfter(0, internal.alerts.call, {
          householdId: household._id as Id<"households">,
          type: "scam",
          recipient,
          // Never the PIN or what was said: only that the attempts failed.
          message: `Someone calling ${household.preferredName}'s Errand Line from a new number ending in ${callerPhone.slice(-4)} said the wrong PIN ${MAX_FAILURES} times. That number is locked for an hour and nothing can be ordered from it.`,
        });
      return { status: "locked" as const };
    }
    return { status: "wrong" as const, attemptsLeft: left };
  },
});
