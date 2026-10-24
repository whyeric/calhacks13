/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  EVIDENCE_MATCH_THRESHOLD,
  MAX_FACTS_PER_CALL,
  REDACTED_BY_CALLER,
  consentGiven,
  evidenceScore,
  factsToForget,
  validateWrite,
  type WriterTurn,
} from "./memoryRules";
import { REGENERATE_FALLBACK } from "./memory";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
const seed = {
  callerPhone: "+14155550100",
  familyPhone: "+14155550101",
  familyAuthSubject: "dana",
};

beforeEach(() => {
  vi.stubEnv("AGENT_SECRET", AGENT);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function post(t: ReturnType<typeof convexTest>, path: string, body: unknown) {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AGENT}`,
    },
    body: JSON.stringify(body),
  });
}

async function startCall(
  t: ReturnType<typeof convexTest>,
  providerCallId: string,
  lines: [("user" | "assistant"), string][],
) {
  const res = await post(t, "/agent/household", {
    callerPhone: seed.callerPhone,
    providerCallId,
  });
  const { callId, context } = await res.json();
  for (const [idx, [speaker, text]] of lines.entries())
    await post(t, "/agent/turn", {
      callId,
      idx,
      speaker,
      text,
      at: Date.now() + idx,
      timings: {},
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  return { callId: callId as Id<"calls">, context };
}

async function setup() {
  const t = convexTest(schema, modules);
  const { householdId } = await t.mutation(internal.seed.demo, seed);
  return { t, householdId: householdId as Id<"households"> };
}

const empty = {
  summary: "",
  facts_add: [],
  facts_supersede: [],
  followups_add: [],
  followups_close: [],
  followups_reschedule: [],
  mood_note: null,
  mood_evidence: null,
  settings: {
    preferredName: null,
    chatTranscripts: null,
    moodNotes: null,
    evidence: null,
  },
};

const lookup = (t: ReturnType<typeof convexTest>) =>
  t.query(internal.households.lookup, {
    callerPhone: seed.callerPhone,
    now: Date.now() + 1000,
  });

describe("memory rules (#37)", () => {
  const turns: WriterTurn[] = [
    { idx: 0, speaker: "assistant", text: "How did Lily's recital go?", redacted: false },
    {
      idx: 1,
      speaker: "user",
      text: "Oh it went really well, Lily's recital went wonderfully!",
      redacted: false,
    },
    { idx: 2, speaker: "user", text: "I need paper towels.", redacted: false },
  ];

  test("evidence must match a caller turn: paraphrase slips pass, invented quotes fail", () => {
    expect(EVIDENCE_MATCH_THRESHOLD).toBe(0.8);
    expect(evidenceScore("Lily's recital went wonderfully", turns[1].text)).toBe(1);
    expect(
      evidenceScore("lilys recital went so wonderfully", turns[1].text),
    ).toBeGreaterThanOrEqual(0.8);
    expect(evidenceScore("I went on a trip to Paris", turns[1].text)).toBeLessThan(0.8);
    // The agent's words never count as the caller's evidence.
    const result = validateWrite(
      {
        ...empty,
        facts_add: [
          { text: "Recital went well", category: "event", evidence: "How did Lily's recital go?" },
          { text: "Went to Paris", category: "event", evidence: "I loved my trip to Paris" },
          { text: "Lily's recital went well", category: "event", evidence: "Lily's recital went wonderfully" },
        ],
      },
      {
        turns,
        facts: [],
        followups: [],
        quarantined: false,
        timezone: "America/Los_Angeles",
        now: Date.now(),
        moodNotesShared: false,
      },
    );
    expect(result.factsAdd.map((f) => f.text)).toEqual(["Lily's recital went well"]);
    expect(result.dropped).toHaveLength(2);
  });

  test("never more than 10 facts per call; scam-flagged turns back no fact", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      idx: i,
      speaker: "user" as const,
      text: `My neighbor number ${i} grows roses and lilies.`,
      redacted: false,
      scamScore: i === 0 ? 0.9 : 0,
    }));
    const result = validateWrite(
      {
        ...empty,
        facts_add: many.map((t) => ({
          text: `Neighbor ${t.idx} grows roses`,
          category: "person",
          evidence: t.text,
        })),
      },
      {
        turns: many,
        facts: [],
        followups: [],
        quarantined: true,
        timezone: "America/Los_Angeles",
        now: Date.now(),
        moodNotesShared: false,
      },
    );
    expect(result.factsAdd).toHaveLength(MAX_FACTS_PER_CALL);
    expect(result.factsAdd.some((f) => f.turnIdx === 0)).toBe(false);
    expect(result.dropped.some((d) => d.includes("scam-flagged"))).toBe(true);
  });

  test("consent: only a clear yes right after an offer", () => {
    const offer = { speaker: "assistant", text: "Would you like me to let Dana know you'd love a call?" };
    expect(consentGiven([offer, { speaker: "user", text: "Yes, please." }])).toBe(true);
    expect(consentGiven([offer, { speaker: "user", text: "Oh that would be lovely." }])).toBe(true);
    expect(consentGiven([offer, { speaker: "user", text: "No, don't bother her." }])).toBe(false);
    expect(consentGiven([offer, { speaker: "user", text: "Yes, but don't tell her." }])).toBe(false);
    expect(
      consentGiven([
        { speaker: "assistant", text: "How are the tomatoes?" },
        { speaker: "user", text: "Yes, they're fine." },
      ]),
    ).toBe(false);
    expect(consentGiven([{ speaker: "user", text: "Yes" }])).toBe(false);
  });

  test("forget matching uses content words", () => {
    const facts = [
      { text: "Margaret planted tomatoes last month.", evidence: "I planted tomatoes last month." },
      { text: "Grandson Tyler is at college in Ohio.", evidence: "Tyler is at college in Ohio." },
    ];
    expect(factsToForget("forget what I said about my tomatoes", facts)).toEqual([facts[0]]);
    expect(factsToForget("forget that", facts)).toEqual([]);
  });
});

describe("memory writer (#32 #42 #76 #69)", () => {
  test("Call 1: new fact with evidence, recital follow-up closed, next lookup reflects it", async () => {
    const { t } = await setup();
    const { callId, context } = await startCall(t, "call-1", [
      ["assistant", "Hi Margaret, it's Errand Line, your AI assistant. How did Lily's recital go on Saturday?"],
      ["user", "Oh, Lily's recital went beautifully, she played Chopin."],
      ["assistant", "That's wonderful. What can I do for you today?"],
    ]);
    const followupId = context.followups[0]._id;
    await post(t, "/agent/followup", { callId, followupId });
    const end = await (await post(t, "/agent/call-end", { callId, kind: "chat" })).json();
    expect(end.memoryStatus).toBe("scheduled");

    const result = await t.mutation(internal.memory.applyWrite, {
      callId,
      startedAt: Date.now() - 5000,
      output: {
        ...empty,
        summary: "Margaret said Lily's recital went beautifully.",
        facts_add: [
          {
            text: "Lily's recital went well; she played Chopin.",
            category: "event",
            evidence: "Lily's recital went beautifully, she played Chopin.",
          },
        ],
        followups_close: [followupId],
      },
    });
    expect(result.added).toBe(1);
    expect(result.followupsClosed).toBe(1);

    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call!.summary).toContain("recital");
    expect(call!.memoryWrite!.status).toBe("written");
    expect(call!.memoryWrite!.ms).toBeLessThan(60_000);
    const next = await lookup(t);
    expect(next!.facts.map((f) => f.text)).toContain(
      "Lily's recital went well; she played Chopin.",
    );
    expect(next!.followups).toHaveLength(0);
    const fact = next!.facts.find((f) => f.text.includes("Chopin"))!;
    expect(fact.sourceCallId).toBe(callId);
    // Idempotent: a second run writes nothing.
    const again = await t.mutation(internal.memory.applyWrite, {
      callId,
      startedAt: Date.now(),
      output: { ...empty, facts_add: [] },
    });
    expect(again.alreadyWritten).toBe(true);
  });

  test("M7: a correction supersedes the old fact and reschedules the follow-up", async () => {
    const { t, householdId } = await setup();
    const before = await lookup(t);
    const recital = before!.facts.find((f) => f.text.includes("recital"))!;
    const followupId = before!.followups[0]._id;
    const { callId } = await startCall(t, "call-m7", [
      ["user", "Lily's recital moved to next Saturday, the 31st."],
    ]);
    await post(t, "/agent/call-end", { callId });
    await t.mutation(internal.memory.applyWrite, {
      callId,
      startedAt: Date.now(),
      output: {
        ...empty,
        summary: "The recital moved.",
        facts_supersede: [
          {
            factId: recital._id,
            newText: "Lily's recital moved to Saturday the 31st.",
            evidence: "Lily's recital moved to next Saturday, the 31st.",
          },
        ],
        followups_reschedule: [{ followupId, notBefore: "2099-11-01" }],
      },
    });
    const next = await lookup(t);
    expect(next!.facts.map((f) => f.text)).not.toContain(recital.text);
    expect(next!.facts.map((f) => f.text)).toContain(
      "Lily's recital moved to Saturday the 31st.",
    );
    expect(next!.followups).toHaveLength(0); // not due until the new date
    const old = await t.run((ctx) => ctx.db.get(recital._id));
    expect(old!.status).toBe("superseded");
    expect(old!.supersededBy).toBeDefined();
    const moved = await t.run((ctx) => ctx.db.get(followupId));
    expect(moved!.status).toBe("open");
    expect(moved!.notBefore).toBeGreaterThan(Date.now());
    const all = await t.run((ctx) =>
      ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) => q.eq("householdId", householdId))
        .collect(),
    );
    expect(all.filter((f) => f.status === "active")).toHaveLength(5);
  });

  test("mood note is stored only when the caller shares mood notes (#76)", async () => {
    const { t, householdId } = await setup();
    const lines: [("user" | "assistant"), string][] = [
      ["user", "I've been feeling a bit lonely since my sister moved away."],
    ];
    const output = {
      ...empty,
      summary: "A chat.",
      mood_note: "Said she has felt lonely since her sister moved.",
      mood_evidence: "I've been feeling a bit lonely since my sister moved away.",
    };
    const off = await startCall(t, "call-mood-off", lines);
    await post(t, "/agent/call-end", { callId: off.callId });
    await t.mutation(internal.memory.applyWrite, { callId: off.callId, startedAt: Date.now(), output });
    expect((await t.run((ctx) => ctx.db.get(off.callId)))!.moodNote).toBeUndefined();

    await t.run((ctx) =>
      ctx.db.patch(householdId, { sharing: { chatTranscripts: false, moodNotes: true } }),
    );
    const on = await startCall(t, "call-mood-on", lines);
    await post(t, "/agent/call-end", { callId: on.callId });
    await t.mutation(internal.memory.applyWrite, { callId: on.callId, startedAt: Date.now(), output });
    expect((await t.run((ctx) => ctx.db.get(on.callId)))!.moodNote).toBe(output.mood_note);
  });

  test("first call: settings come from the caller's words and introducedAt is set (#69)", async () => {
    const { t, householdId } = await setup();
    await t.run((ctx) => ctx.db.patch(householdId, { introducedAt: undefined }));
    expect((await lookup(t))!.household.introduced).toBe(false);
    const { callId } = await startCall(t, "call-intro", [
      ["assistant", "What would you like me to call you?"],
      ["user", "Call me Maggie."],
      ["assistant", "May Dana also read the full transcripts of our chats?"],
      ["user", "Yes, that's fine, Dana can read them."],
    ]);
    await post(t, "/agent/call-end", { callId });
    await t.mutation(internal.memory.applyWrite, {
      callId,
      startedAt: Date.now(),
      output: {
        ...empty,
        summary: "Introductions.",
        settings: {
          preferredName: "Maggie",
          chatTranscripts: true,
          moodNotes: null,
          evidence: "Yes, that's fine, Dana can read them.",
        },
      },
    });
    const h = await t.run((ctx) => ctx.db.get(householdId));
    expect(h!.sharing.chatTranscripts).toBe(true);
    expect(h!.sharing.moodNotes).toBe(false);
    expect(h!.introducedAt).toBeDefined();
    expect((await lookup(t))!.household.introduced).toBe(true);
  });

  test("without an API key the writer records 'skipped' and writes nothing", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const { callId } = await startCall(t, "call-nokey", [["user", "Hello there."]]);
    await post(t, "/agent/call-end", { callId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call!.memoryWrite!.status).toBe("skipped");
    expect(call!.summary).toBeUndefined();
  });

  test("the action parses Haiku's structured output and handles a refusal", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.useFakeTimers();
    const reply = (stop_reason: string, text: string) =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text }],
          stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 900, output_tokens: 120 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const requests: Record<string, unknown>[] = [];
    let next = () =>
      reply("end_turn", JSON.stringify({ ...empty, summary: "Margaret ordered nothing and chatted." }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return next();
      }),
    );
    const { t } = await setup();
    const a = await startCall(t, "call-model", [["user", "Just calling to chat."]]);
    // calls.end scheduled internal.memory.write; let it run.
    await post(t, "/agent/call-end", { callId: a.callId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(a.callId)))!.summary).toBe(
      "Margaret ordered nothing and chatted.",
    );
    expect(requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(requests[0]).not.toHaveProperty("temperature");

    next = () => reply("refusal", "");
    const b = await startCall(t, "call-refused", [["user", "Just calling to chat."]]);
    await post(t, "/agent/call-end", { callId: b.callId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const refused = await t.run((ctx) => ctx.db.get(b.callId));
    expect(refused!.memoryWrite!.status).toBe("refused");
    expect(refused!.summary).toBeUndefined();
  });
});

describe("forget flow (#47)", () => {
  test("M3: forget_fact forgets, redacts the evidence turn, regenerates the summary", async () => {
    const { t } = await setup();
    const { callId } = await startCall(t, "call-forget", [
      ["user", "Please forget what I said about my tomatoes."],
    ]);
    const res = await (
      await post(t, "/agent/forget", {
        callId,
        description: "what I said about my tomatoes",
      })
    ).json();
    expect(res.status).toBe("forgotten");
    expect(res.forgotten).toEqual(["Margaret planted tomatoes last month."]);
    const next = await lookup(t);
    expect(next!.facts.some((f) => f.text.includes("tomatoes"))).toBe(false);
    const fact = await t.run((ctx) =>
      ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", next!.facts[0].householdId).eq("status", "forgotten"),
        )
        .first(),
    );
    expect(fact!.forgottenBy).toBe("caller");
    const sourceTurns = await t.run((ctx) =>
      ctx.db
        .query("turns")
        .withIndex("by_call", (q) => q.eq("callId", fact!.sourceCallId))
        .collect(),
    );
    const redacted = sourceTurns.filter((x) => x.redacted);
    expect(redacted).toHaveLength(1);
    expect(redacted[0].text).toBe(REDACTED_BY_CALLER);
    expect(JSON.stringify(sourceTurns)).not.toContain("tomatoes");
    // The forget request turn itself is kept.
    const live = await t.run((ctx) =>
      ctx.db.query("turns").withIndex("by_call", (q) => q.eq("callId", callId)).collect(),
    );
    expect(live[0].redacted).toBe(false);
    // Summary regeneration (scheduled); without a model key the summary is neutralized.
    await t.action(internal.memory.regenerateSummary, { callId: fact!.sourceCallId });
    expect((await t.run((ctx) => ctx.db.get(fact!.sourceCallId)))!.summary).toBe(
      REGENERATE_FALLBACK,
    );
    // The writer never re-learns it.
    await post(t, "/agent/call-end", { callId });
    const write = await t.mutation(internal.memory.applyWrite, {
      callId,
      startedAt: Date.now(),
      output: {
        ...empty,
        facts_add: [
          {
            text: "Margaret planted tomatoes last month.",
            category: "interest",
            evidence: "Please forget what I said about my tomatoes.",
          },
        ],
      },
    });
    expect(write.added).toBe(0);
  });

  test("forgetting something said earlier in this call redacts it before the writer runs", async () => {
    const { t } = await setup();
    const { callId } = await startCall(t, "call-forget-live", [
      ["user", "My neighbor Joan borrowed money from me."],
      ["user", "Actually, forget what I said about Joan."],
    ]);
    const res = await (
      await post(t, "/agent/forget", { callId, description: "what I said about Joan" })
    ).json();
    expect(res).toMatchObject({ status: "forgotten", redactedTurns: 1 });
    const turns = await t.run((ctx) =>
      ctx.db.query("turns").withIndex("by_call", (q) => q.eq("callId", callId)).collect(),
    );
    expect(turns[0].text).toBe(REDACTED_BY_CALLER);
  });
});

describe("connect_family and wellbeing alerts (#63 #73 #76)", () => {
  test("connect nudge only after the caller's yes; one per call", async () => {
    const { t } = await setup();
    const { callId } = await startCall(t, "call-connect", [
      ["user", "I miss Dana, she's been so busy."],
    ]);
    const noOffer = await (
      await post(t, "/agent/connect", { callId, contact: "Dana", message: "Call me" })
    ).json();
    expect(noOffer.status).toBe("needs_consent");
    for (const [idx, [speaker, text]] of [
      ["assistant", "Would you like me to let Dana know you'd love a call this week?"],
      ["user", "No, I don't want to bother her."],
    ].entries())
      await post(t, "/agent/turn", {
        callId, idx: idx + 1, speaker, text, at: Date.now(), timings: {},
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    const no = await (
      await post(t, "/agent/connect", { callId, contact: "Dana", message: "" })
    ).json();
    expect(no.status).toBe("needs_consent");
    for (const [idx, [speaker, text]] of [
      ["assistant", "Shall I let Dana know you'd love to hear from her?"],
      ["user", "Yes, please do."],
    ].entries())
      await post(t, "/agent/turn", {
        callId, idx: idx + 3, speaker, text, at: Date.now(), timings: {},
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    const yes = await (
      await post(t, "/agent/connect", { callId, contact: "my daughter", message: "" })
    ).json();
    expect(yes).toMatchObject({ status: "sent", contact: "Dana" });
    const alerts = await t.run((ctx) =>
      ctx.db.query("alerts").withIndex("by_callId", (q) => q.eq("callId", callId)).collect(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("connect_nudge");
    expect(alerts[0].message).toContain("Margaret called Errand Line to chat today");
    const again = await (
      await post(t, "/agent/connect", { callId, contact: "Dana", message: "" })
    ).json();
    expect(again.status).toBe("already_sent");
  });

  test("W1: an emergency alerts family at once, without consent, once per call", async () => {
    const { t } = await setup();
    const { callId } = await startCall(t, "call-w1", [["user", "I fell and I can't get up."]]);
    const body = { callId, level: "emergency", summary: "Said she fell and can't get up.", source: "classifier" };
    const first = await (await post(t, "/agent/wellbeing", body)).json();
    expect(first).toMatchObject({ status: "sent", contact: "Dana" });
    const second = await (await post(t, "/agent/wellbeing", { ...body, source: "model" })).json();
    expect(second.status).toBe("already_sent");
    const alerts = await t.run((ctx) =>
      ctx.db.query("alerts").withIndex("by_callId", (q) => q.eq("callId", callId)).collect(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("wellbeing");
    expect(alerts[0].message).toMatch(/^Wellbeing emergency: .*911/);
  });

  test("a non-urgent concern needs the caller's yes", async () => {
    const { t } = await setup();
    const { callId } = await startCall(t, "call-concern", [
      ["user", "I haven't been eating much lately."],
    ]);
    const res = await (
      await post(t, "/agent/wellbeing", { callId, level: "concern", summary: "Not eating much." })
    ).json();
    expect(res.status).toBe("needs_consent");
  });
});
