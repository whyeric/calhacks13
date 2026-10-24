/**
 * Companion and wellbeing actions the agent's tools call (#63 connect_family, #73 and #76
 * raise_wellbeing_alert). Consent is enforced here in code, from the logged transcript:
 * the agent flushes its turn writes before calling, so the caller's yes is on record.
 */
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { consentGiven } from "./memoryRules";

const LEVELS = ["concern", "crisis", "emergency"] as const;
export const wellbeingLevel = v.union(
  v.literal("emergency"),
  v.literal("crisis"),
  v.literal("concern"),
);
const LEVEL_LABEL: Record<(typeof LEVELS)[number], string> = {
  emergency: "Wellbeing emergency",
  crisis: "Wellbeing crisis",
  concern: "Wellbeing concern",
};
const LEVEL_ADVICE: Record<(typeof LEVELS)[number], string> = {
  emergency:
    "Errand Line told them to hang up and call 911 if they are hurt. Please check on them now.",
  crisis:
    "Errand Line shared the 988 Suicide and Crisis Lifeline and said to call 911 if they are in immediate danger. Please reach them now.",
  concern: "They agreed that you should know. Errand Line gives no medical advice.",
};

const clean = (s: string, max: number) =>
  s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function callContext(ctx: MutationCtx, callId: Id<"calls">) {
  const call = await ctx.db.get(callId);
  if (!call?.householdId) throw new ConvexError("Call not found");
  if (call.endedAt !== undefined) throw new ConvexError("Call has ended");
  const household = await ctx.db.get(call.householdId);
  if (!household) throw new ConvexError("Household not found");
  const turns = (
    await ctx.db
      .query("turns")
      .withIndex("by_call_idx", (q) => q.eq("callId", callId))
      .order("desc")
      .take(8)
  ).reverse();
  return { call, household, turns };
}

function excerpt(turns: Doc<"turns">[]): string {
  return turns
    .filter((t) => !t.redacted)
    .slice(-4)
    .map((t) => `${t.speaker === "user" ? "Caller" : "Errand Line"}: ${t.text}`)
    .join("\n")
    .slice(0, 1500);
}

/** Resolve "Dana", "my daughter" or "" (when there is one contact) to a family contact. */
export function resolveContact(
  contacts: Doc<"households">["familyContacts"],
  wanted: string,
) {
  const w = wanted.toLowerCase();
  const exact = contacts.filter(
    (c) =>
      w.includes(c.name.toLowerCase()) ||
      (c.relation && w.includes(c.relation.toLowerCase())),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length === 0 && contacts.length === 1) return contacts[0];
  return null;
}

export const prepareConnect = internalMutation({
  args: { callId: v.id("calls"), contact: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const { call, household, turns } = await callContext(ctx, args.callId);
    if (!consentGiven(turns))
      return {
        status: "needs_consent" as const,
        message:
          "Nothing was sent. Ask the caller first whether they would like you to let their family know, and only call connect_family after a clear yes.",
      };
    const contact = resolveContact(household.familyContacts, args.contact);
    if (!contact)
      return {
        status: "unknown_contact" as const,
        message: household.familyContacts.length
          ? `Nothing was sent. Ask which one: ${household.familyContacts.map((c) => c.name).join(" or ")}.`
          : "Nothing was sent: no family contact is set up. Tell the caller kindly.",
      };
    const existing = await ctx.db
      .query("alerts")
      .withIndex("by_callId", (q) => q.eq("callId", call._id))
      .take(50);
    if (
      existing.some(
        (a) => a.type === "connect_nudge" && a.recipient === contact.phone,
      )
    )
      return {
        status: "already_sent" as const,
        contact: contact.name,
        message: `${contact.name} has already been told on this call.`,
      };
    const said = clean(args.message, 200);
    const nudge =
      `${household.preferredName} called Errand Line to chat today and said they'd love to hear from you this week.` +
      (said ? ` Their message: ${said}` : "");
    return {
      status: "ready" as const,
      householdId: household._id,
      recipient: contact.phone,
      contact: contact.name,
      nudge,
      transcriptExcerpt: excerpt(turns),
    };
  },
});

/** connect_family (CMP-4): nudge a family contact, only after the caller's recorded yes. */
export const connect = internalAction({
  args: { callId: v.id("calls"), contact: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const prep = await ctx.runMutation(internal.companion.prepareConnect, args);
    if (prep.status !== "ready") return prep;
    const sent = await ctx.runAction(internal.alerts.call, {
      householdId: prep.householdId,
      callId: args.callId,
      type: "connect_nudge",
      message: prep.nudge,
      transcriptExcerpt: prep.transcriptExcerpt,
      recipient: prep.recipient,
    });
    // The alert is on the family dashboard whether or not the phone call connects.
    return {
      status: "sent",
      contact: prep.contact,
      delivery: sent.delivery,
      message: `${prep.contact} will get the message${sent.delivery === "failed" ? " on the family dashboard" : ""}. Tell the caller simply.`,
    };
  },
});

export const prepareWellbeing = internalMutation({
  args: {
    callId: v.id("calls"),
    level: wellbeingLevel,
    summary: v.string(),
    source: v.optional(
      v.union(v.literal("model"), v.literal("classifier"), v.literal("refusal")),
    ),
  },
  handler: async (ctx, args) => {
    const { call, household, turns } = await callContext(ctx, args.callId);
    // WB-3: a non-urgent concern goes to family only with the caller's yes.
    if (args.level === "concern" && !consentGiven(turns))
      return {
        status: "needs_consent" as const,
        message:
          "Nothing was sent. For a non-urgent concern, ask the caller whether they would like their family to know, and only send it after a clear yes.",
      };
    const contact = household.familyContacts[0];
    if (!contact)
      return {
        status: "no_family_contact" as const,
        message:
          "No family contact is set up, so no alert was sent. Do not say the family was told. Keep following the safety guidance.",
      };
    // One alert per level per call; a more serious level still goes out.
    const rank = LEVELS.indexOf(args.level);
    const prior = (
      await ctx.db
        .query("alerts")
        .withIndex("by_callId", (q) => q.eq("callId", call._id))
        .take(50)
    ).filter((a) => a.type === "wellbeing");
    if (
      prior.some((a) =>
        LEVELS.slice(rank).some((l) => a.message.startsWith(LEVEL_LABEL[l])),
      )
    )
      return {
        status: "already_sent" as const,
        contact: contact.name,
        message: `${contact.name} has already been alerted on this call.`,
      };
    const summary = clean(args.summary, 400) || "No details given.";
    const message = `${LEVEL_LABEL[args.level]}: during a call just now, ${household.preferredName}: ${summary} ${LEVEL_ADVICE[args.level]}`;
    return {
      status: "ready" as const,
      householdId: household._id,
      recipient: contact.phone,
      contact: contact.name,
      message,
      transcriptExcerpt: excerpt(turns),
    };
  },
});

/** raise_wellbeing_alert (WB-1 to WB-3) and the classifier/refusal path (WB-5). */
export const wellbeing = internalAction({
  args: {
    callId: v.id("calls"),
    level: wellbeingLevel,
    summary: v.string(),
    source: v.optional(
      v.union(v.literal("model"), v.literal("classifier"), v.literal("refusal")),
    ),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const prep = await ctx.runMutation(internal.companion.prepareWellbeing, args);
    if (prep.status !== "ready") return prep;
    const sent = await ctx.runAction(internal.alerts.call, {
      householdId: prep.householdId,
      callId: args.callId,
      type: "wellbeing",
      message: prep.message,
      transcriptExcerpt: prep.transcriptExcerpt,
      recipient: prep.recipient,
    });
    return {
      status: "sent",
      contact: prep.contact,
      delivery: sent.delivery,
      message: `${prep.contact} is being alerted. Tell the caller you are letting ${prep.contact} know.`,
    };
  },
});
