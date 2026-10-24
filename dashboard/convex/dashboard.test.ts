/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const KEY = "dashboard-test-access-key-".padEnd(48, "k");
const PHONE = "+14155550100";

beforeEach(() => {
  vi.stubEnv("DASHBOARD_ACCESS_KEY", KEY);
  vi.stubEnv("DASHBOARD_HOUSEHOLD_PHONE", PHONE);
});
afterEach(() => vi.unstubAllEnvs());

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const call = (householdId: Id<"households">, startedAt: number) => ({
  householdId,
  callerPhone: PHONE,
  startedAt,
  kind: "chat" as const,
  outcome: "no_order" as const,
  scamScore: 0,
  scamSignals: [],
  scamReasons: [],
  scamHold: { active: false },
});

async function setup(chatTranscripts = false) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const householdId = await ctx.db.insert("households", {
      callerName: "Margaret",
      preferredName: "Margaret",
      callerPhone: PHONE,
      timezone: "America/Los_Angeles",
      deliveryAddress: "fictional",
      familyContacts: [
        {
          name: "Dana",
          phone: "+14155550101",
          relation: "daughter",
          authSubject: "dana",
        },
      ],
      sharing: { chatTranscripts, moodNotes: false },
    });
    await ctx.db.insert("limits", {
      householdId,
      perOrderCapCents: 5000,
      monthlyBudgetCents: 20000,
      approvedStores: ["Walmart"],
    });
    const chatCallId = await ctx.db.insert("calls", call(householdId, 1000));
    await ctx.db.insert("turns", {
      callId: chatCallId,
      idx: 0,
      speaker: "user",
      text: "private chat",
      at: 1000,
      timings: {},
      usage,
      redacted: false,
    });
    return { householdId, chatCallId };
  });
  return { t, ...ids };
}

describe("dashboard access", () => {
  test("requires a key or a family identity, and rejects wrong keys", async () => {
    const { t, householdId } = await setup();
    await expect(t.query(api.dashboard.household, {})).rejects.toThrow(
      /Unauthenticated/,
    );
    for (const accessKey of ["", "wrong", KEY.slice(0, -1) + "x"]) {
      await expect(
        t.query(api.dashboard.household, { accessKey }),
      ).rejects.toThrow(/Invalid access key/);
    }
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .query(api.dashboard.household, { householdId }),
    ).rejects.toThrow(/Forbidden/);
    const viaFamily = await t
      .withIdentity({ subject: "dana" })
      .query(api.dashboard.household, { householdId });
    expect(viaFamily.preferredName).toBe("Margaret");
  });

  test("a valid key unlocks the demo household without exposing phones", async () => {
    const { t } = await setup();
    const household = await t.query(api.dashboard.household, {
      accessKey: KEY,
    });
    expect(household.limits?.monthlyBudgetCents).toBe(20000);
    expect(JSON.stringify(household)).not.toContain("+1415");
  });

  test("short or missing configured key disables the key path", async () => {
    const { t } = await setup();
    for (const value of ["", "short"]) {
      vi.stubEnv("DASHBOARD_ACCESS_KEY", value);
      for (const accessKey of [value, KEY]) {
        await expect(
          t.query(api.dashboard.household, { accessKey }),
        ).rejects.toThrow(/Dashboard access is not configured/);
      }
    }
  });
});

describe("transcript sharing", () => {
  test("chat-only transcripts are hidden unless sharing allows", async () => {
    const { t } = await setup(false);
    const live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(live?.call.transcriptVisible).toBe(false);
    expect(live?.turns).toEqual([]);
    const recent = await t.query(api.dashboard.recentCalls, {
      accessKey: KEY,
    });
    expect(recent).toHaveLength(1);
  });

  test("chat transcripts show when shared", async () => {
    const { t } = await setup(true);
    const live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(live?.turns.map((turn) => turn.text)).toEqual(["private chat"]);
  });

  test("calls with an order are visible; redacted text and latency", async () => {
    const { t, householdId } = await setup(false);
    await t.run(async (ctx) => {
      const callId = await ctx.db.insert("calls", call(householdId, 2000));
      await ctx.db.insert("orders", {
        householdId,
        callId,
        idempotencyKey: `${callId}:tool-1`,
        items: [],
        totalCents: 0,
        store: "Walmart",
        status: "pending",
        createdAt: 2000,
      });
      await ctx.db.insert("turns", {
        callId,
        idx: 0,
        speaker: "user",
        text: "secret words",
        at: 2000,
        timings: {},
        usage,
        redacted: true,
      });
      await ctx.db.insert("turns", {
        callId,
        idx: 1,
        speaker: "assistant",
        text: "Your usual medium roast?",
        at: 2001,
        timings: {
          speechEndAt: 10_000,
          sttFinalAt: 10_150,
          llmRequestAt: 10_160,
          llmFirstTokenAt: 10_500,
          ttsFirstAudioAt: 10_720,
        },
        usage,
        redacted: false,
      });
    });
    const live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(live?.call.transcriptVisible).toBe(true);
    expect(live?.turns[0]).toMatchObject({ redacted: true, text: null });
    expect(JSON.stringify(live)).not.toContain("secret words");
    expect(live?.turns[1].latency).toEqual({
      sttMs: 150,
      llmMs: 340,
      replyMs: 350,
      ttsMs: 220,
      voiceToVoiceMs: 720,
    });
    expect(live?.turns[1]).toMatchObject({ refused: false, tools: [] });
  });

  test("#36/#80: refusals and tool calls logged by the agent reach the transcript", async () => {
    const { t, householdId } = await setup(true);
    const callId = await t.run((ctx) =>
      ctx.db.insert("calls", call(householdId, 3000)),
    );
    const base = { callId, at: 3000, timings: {}, usage };
    await t.mutation(internal.calls.logTurn, {
      ...base,
      idx: 0,
      speaker: "assistant",
      text: "Two options: six rolls or twelve.",
      tools: [{ name: "search_items", result: "ok" }],
    });
    await t.mutation(internal.calls.logTurn, {
      ...base,
      idx: 1,
      speaker: "assistant",
      text: "Sorry, could you say that another way?",
      refused: true,
    });
    await expect(
      t.mutation(internal.calls.logTurn, {
        ...base,
        idx: 2,
        speaker: "assistant",
        text: "x",
        tools: Array.from({ length: 11 }, () => ({ name: "search_items" })),
      }),
    ).rejects.toThrow(/Invalid turn/);
    const live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(
      live?.turns.map(({ refused, tools }) => ({ refused, tools })),
    ).toEqual([
      { refused: false, tools: [{ name: "search_items", result: "ok" }] },
      { refused: true, tools: [] },
    ]);
  });
});

describe("orders", () => {
  test("newest first, monthly paid spend in household timezone, badge counts", async () => {
    const { t, householdId, chatCallId } = await setup();
    // 2026-10-01T06:00Z is 2026-09-30 23:00 in Los Angeles (previous month).
    const order = (
      totalCents: number,
      status: "paid" | "awaiting_approval" | "declined",
      createdAt: number,
      key: string,
    ) =>
      t.run((ctx) =>
        ctx.db.insert("orders", {
          householdId,
          callId: chatCallId as Id<"calls">,
          idempotencyKey: key,
          items: [
            {
              name: "Paper towels",
              storeItemId: "x",
              qty: 1,
              priceCents: totalCents,
            },
          ],
          totalCents,
          store: "Walmart",
          status,
          createdAt,
        }),
      );
    await order(999, "paid", Date.UTC(2026, 9, 1, 6), "a");
    await order(2145, "paid", Date.UTC(2026, 9, 20, 18), "b");
    await order(6200, "awaiting_approval", Date.UTC(2026, 9, 21, 18), "c");
    await order(1000, "declined", Date.UTC(2026, 9, 22, 18), "d");
    const result = await t.query(api.dashboard.orders, {
      accessKey: KEY,
      month: "2026-10",
    });
    expect(result.orders.map((o) => o.totalCents)).toEqual([
      1000, 6200, 2145, 999,
    ]);
    expect(result.monthly).toEqual({
      month: "2026-10",
      spentCents: 2145,
      paidCount: 1,
      budgetCents: 20000,
    });
    await expect(
      t.query(api.dashboard.orders, { accessKey: KEY, month: "2026-13" }),
    ).rejects.toThrow(/Invalid month/);
    const counts = await t.query(api.dashboard.counts, { accessKey: KEY });
    expect(counts).toEqual({ openApprovals: 1, unacknowledgedAlerts: 0 });
    const without = await t.query(api.dashboard.orders, { accessKey: KEY });
    expect(without.monthly).toBeNull();
  });

  test("decision and failure details reach the dashboard; tokens do not", async () => {
    const { t, householdId, chatCallId } = await setup();
    await t.run(async (ctx) => {
      const base = {
        householdId,
        callId: chatCallId,
        items: [],
        totalCents: 6192,
        store: "Walmart",
      };
      await ctx.db.insert("orders", {
        ...base,
        idempotencyKey: "r1",
        status: "awaiting_approval",
        createdAt: 1,
        reason:
          "This order is $61.92, which is over your $50.00 per-order limit.",
      });
      await ctx.db.insert("orders", {
        ...base,
        idempotencyKey: "r2",
        status: "declined",
        createdAt: 2,
        declinedBy: "Dana",
        decidedAt: 3,
      });
      await ctx.db.insert("orders", {
        ...base,
        idempotencyKey: "r3",
        status: "paid",
        createdAt: 4,
        paidAt: 5,
        paymentTokenRef: "tok_secret_reference_123456",
      });
    });
    const { orders } = await t.query(api.dashboard.orders, { accessKey: KEY });
    expect(
      orders.map((o) => [
        o.status,
        o.reason,
        o.declinedBy,
        o.decidedAt,
        o.paidAt,
        o.paymentRef,
      ]),
    ).toEqual([
      ["paid", null, null, null, 5, "123456"],
      ["declined", null, "Dana", 3, null, null],
      [
        "awaiting_approval",
        "This order is $61.92, which is over your $50.00 per-order limit.",
        null,
        null,
        null,
        null,
      ],
    ]);
    expect(JSON.stringify(orders)).not.toContain("tok_secret");
  });

  test("an invalid household timezone falls back to UTC instead of failing", async () => {
    const { t, householdId } = await setup();
    await t.run((ctx) => ctx.db.patch(householdId, { timezone: "Not/AZone" }));
    const result = await t.query(api.dashboard.orders, {
      accessKey: KEY,
      month: "2026-10",
    });
    expect(result.monthly?.spentCents).toBe(0);
  });
});

describe("memory", () => {
  test("facts carry their source call's start time", async () => {
    const { t, householdId, chatCallId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("memory_facts", {
        householdId,
        text: "Tyler is at college in Ohio.",
        category: "family",
        evidence: "Tyler is at college in Ohio.",
        sourceCallId: chatCallId,
        createdAt: 1500,
        status: "active",
      }),
    );
    const memory = await t.query(api.dashboard.memory, { accessKey: KEY });
    expect(memory.facts[0]).toMatchObject({ sourceCallStartedAt: 1000 });
  });
});
