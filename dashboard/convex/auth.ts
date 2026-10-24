import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function requireFamily(
  ctx: QueryCtx,
  householdId: Id<"households">,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Unauthenticated");
  const household = await ctx.db.get(householdId);
  if (
    !household?.familyContacts.some(
      (contact) => contact.authSubject === identity.subject,
    )
  ) {
    throw new ConvexError("Forbidden");
  }
  return household;
}

// Fixed-length digest comparison; secret strings themselves are never compared byte by byte.
export async function authorized(request: Request, role: "agent" | "alert") {
  const expected =
    process.env[role === "agent" ? "AGENT_SECRET" : "ALERT_SECRET"];
  const other = process.env[role === "agent" ? "ALERT_SECRET" : "AGENT_SECRET"];
  if (!expected || expected.length < 32 || expected === other) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 1024) return false;
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [actual, wanted] = await Promise.all([
    digest(header.slice(7)),
    digest(expected),
  ]);
  let difference = 0;
  for (let i = 0; i < wanted.length; i++) difference |= actual[i] ^ wanted[i];
  return difference === 0;
}
