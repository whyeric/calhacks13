import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import fixture from "../../fixtures/household.json";

export const demo = internalMutation({
  args: {
    callerPhone: v.optional(v.string()),
    familyPhone: v.optional(v.string()),
    familyAuthSubject: v.optional(v.string()),
    reset: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const callerPhone = args.callerPhone ?? process.env.DEMO_CALLER_PHONE;
    const familyPhone =
      (args.familyPhone ?? process.env.DEMO_FAMILY_PHONE) || undefined;
    if (
      !callerPhone ||
      !/^\+[1-9]\d{7,14}$/.test(callerPhone) ||
      (familyPhone !== undefined && !/^\+[1-9]\d{7,14}$/.test(familyPhone))
    )
      throw new ConvexError(
        "Set DEMO_CALLER_PHONE in E.164; DEMO_FAMILY_PHONE is optional and must be E.164 when provided",
      );
    const existing = await ctx.db
      .query("households")
      .withIndex("by_callerPhone", (q) => q.eq("callerPhone", callerPhone))
      .unique();
    if (existing && !args.reset)
      return { householdId: existing._id, created: false };
    if (existing) {
      const calls = await ctx.db
        .query("calls")
        .withIndex("by_household", (q) => q.eq("householdId", existing._id))
        .collect();
      for (const call of calls) {
        for (const turn of await ctx.db
          .query("turns")
          .withIndex("by_call", (q) => q.eq("callId", call._id))
          .collect())
          await ctx.db.delete(turn._id);
        await ctx.db.delete(call._id);
      }
      for (const table of [
        "limits",
        "favorites",
        "orders",
        "alerts",
      ] as const) {
        for (const row of await ctx.db
          .query(table)
          .withIndex("by_household", (q) => q.eq("householdId", existing._id))
          .collect())
          await ctx.db.delete(row._id);
      }
      for (const table of ["memory_facts", "followups"] as const) {
        for (const row of await ctx.db
          .query(table)
          .withIndex("by_household_status", (q) =>
            q.eq("householdId", existing._id),
          )
          .collect())
          await ctx.db.delete(row._id);
      }
      await ctx.db.delete(existing._id);
    }
    const authSubject =
      args.familyAuthSubject ?? process.env.DEMO_FAMILY_AUTH_SUBJECT;
    const householdId = await ctx.db.insert("households", {
      callerName: fixture.callerName,
      preferredName: fixture.preferredName,
      callerPhone,
      timezone: fixture.timezone,
      deliveryAddress: fixture.deliveryAddress,
      familyContacts: familyPhone
        ? [
            {
              name: fixture.familyName,
              phone: familyPhone,
              relation: fixture.relation,
              ...(authSubject ? { authSubject } : {}),
            },
          ]
        : [],
      sharing: { chatTranscripts: false, moodNotes: false },
    });
    await ctx.db.insert("limits", { householdId, ...fixture.limits });
    for (const favorite of fixture.favorites)
      await ctx.db.insert("favorites", { householdId, ...favorite });
    const now = Date.now();
    const sourceCallId = await ctx.db.insert("calls", {
      householdId,
      callerPhone,
      startedAt: now - 86400000,
      endedAt: now - 86340000,
      kind: "chat",
      outcome: "no_order",
      summary: "Seeded demo conversation about family, coffee and tomatoes.",
      scamScore: 0,
      scamSignals: [],
      scamReasons: [],
      scamHold: { active: false },
    });
    for (const [idx, fact] of fixture.facts.entries()) {
      await ctx.db.insert("memory_facts", {
        householdId,
        ...fact,
        sourceCallId,
        createdAt: now,
        status: "active",
      });
      await ctx.db.insert("turns", {
        callId: sourceCallId,
        idx,
        speaker: "user",
        text: fact.evidence,
        at: now - 86400000 + idx * 1000,
        timings: {},
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        redacted: false,
      });
    }
    await ctx.db.insert("followups", {
      householdId,
      speakable: fixture.followup,
      sourceCallId,
      notBefore: now - 1,
      status: "open",
    });
    return { householdId, created: true };
  },
});
