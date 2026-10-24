import { ConvexError, v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFamily } from "./auth";

/** Shared argument validators for every dashboard query. */
export const accessArgs = {
  accessKey: v.optional(v.string()),
  householdId: v.optional(v.id("households")),
};

const MIN_KEY_LENGTH = 32;
const MAX_KEY_LENGTH = 1024;

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/**
 * True when `accessKey` matches the DASHBOARD_ACCESS_KEY env var. A missing or
 * short (< 32 chars) configured key disables the access-key path entirely.
 * Fixed-length digest comparison; the secret strings are never compared directly.
 */
export async function accessKeyMatches(accessKey: string) {
  const expected = process.env.DASHBOARD_ACCESS_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH) return false;
  if (!accessKey || accessKey.length > MAX_KEY_LENGTH) return false;
  const [actual, wanted] = await Promise.all([
    sha256(accessKey),
    sha256(expected),
  ]);
  let difference = 0;
  for (let i = 0; i < wanted.length; i++) difference |= actual[i] ^ wanted[i];
  return difference === 0;
}

/** Shown to the dashboard so a missing server setting isn't mistaken for a typo. */
export const ACCESS_NOT_CONFIGURED = "Dashboard access is not configured";

async function requireAccessKey(accessKey: string) {
  const expected = process.env.DASHBOARD_ACCESS_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH)
    throw new ConvexError(ACCESS_NOT_CONFIGURED);
  if (!(await accessKeyMatches(accessKey)))
    throw new ConvexError("Invalid access key");
}

/**
 * The household the shared dashboard access key unlocks: the household whose
 * callerPhone is DASHBOARD_HOUSEHOLD_PHONE (falling back to DEMO_CALLER_PHONE),
 * else the only household when exactly one exists.
 */
export async function demoHousehold(ctx: QueryCtx) {
  const phone =
    process.env.DASHBOARD_HOUSEHOLD_PHONE || process.env.DEMO_CALLER_PHONE;
  if (phone) {
    const household = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", phone))
      .unique();
    if (household) return household;
  }
  const candidates = await ctx.db.query("households").take(2);
  if (candidates.length === 1) return candidates[0];
  throw new ConvexError(
    candidates.length === 0
      ? "No household has been set up yet"
      : "Set DASHBOARD_HOUSEHOLD_PHONE to choose the dashboard household",
  );
}

/**
 * Authorize access to one household: a Clerk family identity listed on the
 * household (same semantics as requireFamily) or a valid dashboard access key.
 * An access key only unlocks the configured demo household.
 */
export async function requireHouseholdAccess(
  ctx: QueryCtx,
  householdId: Id<"households">,
  accessKey?: string,
): Promise<Doc<"households">> {
  if (accessKey !== undefined) {
    await requireAccessKey(accessKey);
    const household = await demoHousehold(ctx);
    if (household._id !== householdId) throw new ConvexError("Forbidden");
    return household;
  }
  return requireFamily(ctx, householdId);
}

/**
 * Resolve the household for a dashboard request. With an access key, the
 * demo household; otherwise the caller must be signed in as family of the
 * given householdId.
 */
export async function resolveHousehold(
  ctx: QueryCtx,
  args: { accessKey?: string; householdId?: Id<"households"> },
): Promise<Doc<"households">> {
  if (args.accessKey !== undefined) {
    await requireAccessKey(args.accessKey);
    const household = await demoHousehold(ctx);
    if (args.householdId && args.householdId !== household._id)
      throw new ConvexError("Forbidden");
    return household;
  }
  if (!args.householdId) throw new ConvexError("Unauthenticated");
  return requireFamily(ctx, args.householdId);
}

/** Arguments every dashboard mutation needs: access plus who is acting. */
export const actorArgs = {
  ...accessArgs,
  // The family member using the dashboard, by contact name. With a shared access key this is
  // self-declared (chosen from the household's contacts); with Clerk it comes from the identity.
  actor: v.optional(v.string()),
};

/**
 * Who is acting, for audit fields (approvedBy, override logs). A signed-in family member is
 * the contact matching their identity; with the shared access key, `actor` must name one of
 * the household's family contacts and is recorded as "<name> (dashboard)".
 */
export async function resolveActor(
  ctx: QueryCtx,
  household: Doc<"households">,
  args: { accessKey?: string; actor?: string },
): Promise<string> {
  if (args.accessKey === undefined) {
    const identity = await ctx.auth.getUserIdentity();
    const contact = household.familyContacts.find(
      (c) => identity && c.authSubject === identity.subject,
    );
    if (!contact) throw new ConvexError("Forbidden");
    return contact.name;
  }
  const wanted = args.actor?.trim().toLowerCase();
  const contact = wanted
    ? household.familyContacts.find(
        (c) => c.name.trim().toLowerCase() === wanted,
      )
    : undefined;
  if (!contact)
    throw new ConvexError("Choose which family member you are first");
  return `${contact.name} (dashboard)`;
}
