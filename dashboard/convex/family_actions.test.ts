/// <reference types="vite/client" />
// Milestone 3/4 dashboard actions: approvals (#92, #93), alerts (#94), scam override (#95),
// settings (#97), developer stats (#98), sharing (#99) and the access gate on mutations (#100).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mockRail } from "./payments";
import { approvalDeadline, decide } from "./orders";
import { developerStats, percentile, turnCostUsd } from "./dashboard";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
const ALERT = "alert-test-secret-".padEnd(48, "b");
const KEY = "dashboard-test-access-key-".padEnd(48, "k");
const seed = {
  callerPhone: "+14155550100",
  familyPhone: "+14155550101",
  familyAuthSubject: "dana",
};
const coffee = {
  name: "Medium-roast coffee, big can",
  storeItemId: "demo-coffee-big",
  qty: 1,
  priceCents: 1248,
};
const giftCard = {
  name: "Apple gift card",
  storeItemId: "demo-gift-card",
  qty: 1,
  priceCents: 10000,
};
const dana = { accessKey: KEY, actor: "Dana" };

beforeEach(() => {
  vi.stubEnv("AGENT_SECRET", AGENT);
  vi.stubEnv("ALERT_SECRET", ALERT);
  vi.stubEnv("DASHBOARD_ACCESS_KEY", KEY);
  vi.stubEnv("DASHBOARD_HOUSEHOLD_PHONE", seed.callerPhone);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function post(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: unknown,
  secret = AGENT,
) {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

async function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { householdId } = await t.mutation(internal.seed.demo, seed);
  const { callId } = await (
    await post(t, "/agent/household", {
      callerPhone: seed.callerPhone,
      providerCallId: "call-1",
    })
  ).json();
  let n = 0;
  const order = async (items: unknown[], store = "Walmart") =>
    (
      await post(t, "/agent/order", {
        callId,
        idempotencyKey: `${callId}:toolu_${++n}`,
        store,
        items,
      })
    ).json();
  const run = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  const get = <T extends "orders" | "calls" | "alerts" | "households">(
    id: Id<T>,
  ) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<T> | null>;
  return { t, householdId, callId: callId as Id<"calls">, order, run, get };
}

/** A second household the demo access key must never reach. */
async function otherHousehold(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const householdId = await ctx.db.insert("households", {
      callerName: "Other",
      preferredName: "Other",
      callerPhone: "+14155550900",
      timezone: "UTC",
      deliveryAddress: "elsewhere",
      familyContacts: [
        { name: "Dana", phone: "+14155550901", relation: "daughter" },
      ],
      sharing: { chatTranscripts: false, moodNotes: false },
    });
    const callId = await ctx.db.insert("calls", {
      householdId,
      callerPhone: "+14155550900",
      startedAt: 1,
      kind: "order",
      outcome: "awaiting_approval",
      scamScore: 0,
      scamSignals: [],
      scamReasons: [],
      scamHold: { active: true, reason: "test" },
    });
    const orderId = await ctx.db.insert("orders", {
      householdId,
      callId,
      idempotencyKey: `${callId}:x`,
      items: [{ ...coffee, qty: 5 }],
      totalCents: 6240,
      store: "Walmart",
      status: "awaiting_approval",
      createdAt: 1,
    });
    const alertId = await ctx.db.insert("alerts", {
      householdId,
      callId,
      type: "scam",
      channel: "dashboard",
      delivery: "sent",
      message: "other",
      recipient: "dashboard",
      sentAt: 1,
    });
    return { householdId, callId, orderId, alertId };
  });
}

describe("#92/#93 approval flow", () => {
  test("T3: over cap -> awaiting_approval, alert calls queued, dashboard Approve -> paid and recorded", async () => {
    const { t, order, run, get, callId } = await setup();
    const pay = vi.spyOn(mockRail, "pay");
    const placed = await order([{ ...coffee, qty: 5 }]);
    expect(placed.status).toBe("needs_approval");
    const orderId = placed.orderId as Id<"orders">;

    const screen = await t.query(api.dashboard.approvals, { accessKey: KEY });
    expect(screen.pending).toHaveLength(1);
    expect(screen.pending[0]).toMatchObject({
      totalCents: 6240,
      store: "Walmart",
      status: "awaiting_approval",
    });
    expect(screen.pending[0].reason).toMatch(/per-order limit/);

    const first = await t.mutation(api.orders.familyApprove, {
      ...dana,
      orderId,
    });
    expect(first).toMatchObject({
      status: "approved",
      decidedBy: "Dana (dashboard)",
      alreadyResolved: false,
    });
    await run();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await get(orderId)).toMatchObject({
      status: "paid",
      approvedBy: "Dana (dashboard)",
    });
    // The agent polling for the holding caller learns the outcome.
    const status = await (
      await post(t, "/agent/order-status", { callId, orderId })
    ).json();
    expect(status).toMatchObject({ status: "paid", decidedBy: "Dana" });
    // One alert-call row per family contact (Cartesia not configured here -> failed).
    const after = await t.query(api.dashboard.approvals, { accessKey: KEY });
    expect(after.pending).toHaveLength(0);
    expect(after.resolved[0]).toMatchObject({
      decision: "approved",
      decidedBy: "Dana (dashboard)",
    });
    expect(after.resolved[0].alertCalls).toHaveLength(1);
    expect(after.resolved[0].alertCalls[0].recipient).toBe("Dana");
    // A second response, and a repeat of the scheduled payment, never pay again.
    const second = await t.mutation(api.orders.familyDecline, {
      ...dana,
      orderId,
    });
    expect(second).toMatchObject({ alreadyResolved: true, status: "paid" });
    await t.action(internal.payments.payApproved, { orderId });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  test("a spoken yes on the alert call wins; the dashboard buttons then report it", async () => {
    const { t, order, run, get } = await setup();
    const placed = await order([{ ...coffee, qty: 5 }]);
    const orderId = placed.orderId as Id<"orders">;
    const alertId = await t.mutation(internal.alerts.create, {
      householdId: (await get(orderId))!.householdId,
      orderId,
      type: "approval_needed",
      message: "Approve?",
      recipient: seed.familyPhone,
    });
    const spoken = await (
      await post(t, "/alert/decision", { alertId, decision: "approved" }, ALERT)
    ).json();
    expect(spoken).toMatchObject({
      decision: "approved",
      alreadyResolved: false,
    });
    const late = await t.mutation(api.orders.familyDecline, {
      ...dana,
      orderId,
    });
    expect(late).toMatchObject({
      alreadyResolved: true,
      decidedBy: "Dana (alert call)",
    });
    await run();
    expect(await get(orderId)).toMatchObject({
      status: "paid",
      approvedBy: "Dana (alert call)",
    });
  });

  test("T5 decline: unapproved store -> Decline -> declined, follow-up for the next call", async () => {
    const { t, order, get, callId } = await setup();
    const placed = await order([coffee], "Target");
    expect(placed.status).toBe("needs_approval");
    await post(t, "/agent/call-end", { callId });
    const pay = vi.spyOn(mockRail, "pay");
    await t.mutation(api.orders.familyDecline, {
      ...dana,
      orderId: placed.orderId,
    });
    expect(await get(placed.orderId)).toMatchObject({
      status: "declined",
      declinedBy: "Dana (dashboard)",
    });
    expect(pay).not.toHaveBeenCalled();
    const followups = await t.run((ctx) => ctx.db.query("followups").collect());
    expect(followups.map((f) => f.speakable)).toContainEqual(
      expect.stringMatching(/^Dana decided to hold off/),
    );
  });

  test("an approval nobody answers expires as a system decline", async () => {
    const { t, order, run, get } = await setup();
    const placed = await order([{ ...coffee, qty: 5 }]);
    await run();
    expect(await get(placed.orderId)).toMatchObject({
      status: "declined",
      declinedBy: "system:expired",
    });
    const screen = await t.query(api.dashboard.approvals, { accessKey: KEY });
    expect(screen.resolved[0].decidedBy).toBe("No answer in time");
  });

  test("approval deadline: before 9 pm local, at most 12 h, at least 30 min", () => {
    const at = (iso: string) => Date.parse(iso);
    // 10:00 in Los Angeles (17:00Z) -> 21:00 local is 11 h away.
    expect(
      approvalDeadline(at("2026-10-24T17:00:00Z"), "America/Los_Angeles") -
        at("2026-10-24T17:00:00Z"),
    ).toBe(11 * 3_600_000);
    // 20:50 local -> 30 min floor.
    expect(
      approvalDeadline(at("2026-10-25T03:50:00Z"), "America/Los_Angeles") -
        at("2026-10-25T03:50:00Z"),
    ).toBe(30 * 60_000);
    // 22:00 local -> 12 h cap.
    expect(
      approvalDeadline(at("2026-10-25T05:00:00Z"), "America/Los_Angeles") -
        at("2026-10-25T05:00:00Z"),
    ).toBe(12 * 3_600_000);
  });

  test("authz: wrong key, no actor, a stranger as actor, and another household's order are refused", async () => {
    const { t, order } = await setup();
    const placed = await order([{ ...coffee, qty: 5 }]);
    const other = await otherHousehold(t);
    await expect(
      t.mutation(api.orders.familyApprove, {
        accessKey: "x".repeat(48),
        actor: "Dana",
        orderId: placed.orderId,
      }),
    ).rejects.toThrow(/Invalid access key/);
    await expect(
      t.mutation(api.orders.familyApprove, {
        orderId: placed.orderId,
        actor: "Dana",
      }),
    ).rejects.toThrow(/Unauthenticated/);
    await expect(
      t.mutation(api.orders.familyApprove, {
        accessKey: KEY,
        orderId: placed.orderId,
      }),
    ).rejects.toThrow(/Choose which family member/);
    await expect(
      t.mutation(api.orders.familyApprove, {
        accessKey: KEY,
        actor: "Mallory",
        orderId: placed.orderId,
      }),
    ).rejects.toThrow(/Choose which family member/);
    await expect(
      t.mutation(api.orders.familyApprove, { ...dana, orderId: other.orderId }),
    ).rejects.toThrow(/Order not found/);
    // A signed-in user who is not this household's family is refused too.
    await expect(
      t
        .withIdentity({ subject: "mallory" })
        .mutation(api.orders.familyApprove, {
          householdId: other.householdId,
          orderId: other.orderId,
        }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a Clerk family identity decides as its contact name", async () => {
    const { t, order, householdId } = await setup();
    const placed = await order([{ ...coffee, qty: 5 }]);
    const result = await t
      .withIdentity({ subject: "dana" })
      .mutation(api.orders.familyDecline, {
        householdId,
        orderId: placed.orderId,
      });
    expect(result).toMatchObject({ status: "declined", decidedBy: "Dana" });
  });

  test("decide() exported for the alert path is the same first-wins rule", async () => {
    const { t, order } = await setup();
    const placed = await order([{ ...coffee, qty: 5 }]);
    const [a, b] = await t.run(async (ctx) => [
      await decide(ctx, placed.orderId, "Dana", "declined"),
      await decide(ctx, placed.orderId, "Sam", "approved"),
    ]);
    expect(a.alreadyResolved).toBe(false);
    expect(b).toMatchObject({ alreadyResolved: true, status: "declined" });
  });
});

describe("#94 alerts", () => {
  test("lists every alert type with excerpt and acknowledges live", async () => {
    const { t, householdId, callId } = await setup();
    const types = [
      "scam",
      "approval_needed",
      "order_placed",
      "payment_failed",
      "wellbeing",
      "connect_nudge",
    ] as const;
    for (const type of types)
      await t.run((ctx) =>
        ctx.db.insert("alerts", {
          householdId,
          callId,
          type,
          channel: "call",
          delivery: "answered",
          message: `${type} message`,
          transcriptExcerpt:
            type === "scam" ? "Caller: buy gift cards" : undefined,
          recipient: seed.familyPhone,
          sentAt: 1,
        }),
      );
    const rows = await t.query(api.dashboard.alerts, { accessKey: KEY });
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(types));
    const scam = rows.find((r) => r.type === "scam")!;
    // Chat sharing is off, but scam excerpts are always visible (§14.2).
    expect(scam.transcriptExcerpt).toBe("Caller: buy gift cards");
    expect(scam.recipient).toBe("Dana");
    expect(JSON.stringify(rows)).not.toContain(seed.familyPhone);
    const before = await t.query(api.dashboard.counts, { accessKey: KEY });
    await t.mutation(api.alerts.acknowledge, { ...dana, alertId: scam._id });
    const again = await t.mutation(api.alerts.acknowledge, {
      ...dana,
      alertId: scam._id,
    });
    expect(again.alreadyAcknowledged).toBe(true);
    const after = await t.query(api.dashboard.alerts, { accessKey: KEY });
    expect(after.find((r) => r._id === scam._id)).toMatchObject({
      acknowledgedBy: "Dana (dashboard)",
    });
    expect(
      (await t.query(api.dashboard.counts, { accessKey: KEY }))
        .unacknowledgedAlerts,
    ).toBe(before.unacknowledgedAlerts - 1);
  });

  test("authz: cannot acknowledge another household's alert or without a key", async () => {
    const { t } = await setup();
    const other = await otherHousehold(t);
    await expect(
      t.mutation(api.alerts.acknowledge, { ...dana, alertId: other.alertId }),
    ).rejects.toThrow(/Alert not found/);
    await expect(
      t.mutation(api.alerts.acknowledge, {
        actor: "Dana",
        alertId: other.alertId,
      }),
    ).rejects.toThrow(/Unauthenticated/);
  });
});

describe("#95 scam override", () => {
  test("S2: override lifts the hold and is logged; the hard rule still blocks gift cards", async () => {
    const { t, callId, order, get } = await setup();
    const blocked = await order([giftCard]);
    expect(blocked.status).toBe("blocked");
    expect((await get(callId))?.scamHold.active).toBe(true);
    const held = await order([coffee]);
    expect(held.status).toBe("blocked");

    const result = await t.mutation(api.orders.overrideScamHold, {
      ...dana,
      callId,
      note: "It's really her",
    });
    expect(result).toMatchObject({ overridden: true });
    const call = await get(callId);
    expect(call?.scamHold.active).toBe(false);
    expect(call?.scamOverrides).toEqual([
      expect.objectContaining({
        by: "Dana (dashboard)",
        note: "It's really her",
      }),
    ]);
    // Visible in the call history on the dashboard.
    const recent = await t.query(api.dashboard.recentCalls, { accessKey: KEY });
    expect(recent[0].scamOverrides[0].by).toBe("Dana (dashboard)");
    // The hold is gone, so an ordinary order reaches the limits check and pays...
    expect((await order([coffee])).status).toBe("paid");
    // ...but the hard rule blocks no matter what the family said.
    expect((await order([giftCard])).status).toBe("blocked");
  });

  test("authz: another household's call cannot be overridden", async () => {
    const { t } = await setup();
    const other = await otherHousehold(t);
    await expect(
      t.mutation(api.orders.overrideScamHold, {
        ...dana,
        callId: other.callId,
      }),
    ).rejects.toThrow(/Call not found/);
    expect(
      (await t.run((ctx) => ctx.db.get(other.callId)))?.scamHold.active,
    ).toBe(true);
  });
});

describe("#97 settings", () => {
  test("LIM-3/T5: lowering the cap and editing stores apply to the next order", async () => {
    const { t, order } = await setup();
    expect((await order([coffee])).status).toBe("paid");
    await t.mutation(api.households.updateLimits, {
      ...dana,
      perOrderCapCents: 1000,
    });
    const capped = await order([coffee]);
    expect(capped.status).toBe("needs_approval");
    expect(capped.reason).toMatch(/\$10\.00 per-order limit/);
    await t.mutation(api.households.updateLimits, {
      ...dana,
      perOrderCapCents: 5000,
      approvedStores: ["Walmart", "Target"],
    });
    expect((await order([coffee], "Target")).status).toBe("paid");
    await expect(
      t.mutation(api.households.updateLimits, {
        ...dana,
        perOrderCapCents: 10.5,
      }),
    ).rejects.toThrow(/whole/);
  });

  test("favorites, contacts and sharing edits persist and validate", async () => {
    const { t, householdId } = await setup();
    const id = await t.mutation(api.households.saveFavorite, {
      ...dana,
      name: "Paper towels",
      aliases: ["the towels", " the towels ", "kitchen roll"],
      store: "Walmart",
      storeItemId: "demo-paper-towels-6",
      usualQty: 2,
    });
    let h = await t.query(api.dashboard.household, { accessKey: KEY });
    expect(h.favorites.find((f) => f._id === id)?.aliases).toEqual([
      "the towels",
      "kitchen roll",
    ]);
    // The agent's household lookup (match_favorite) sees the new alias.
    const ctxForAgent = await t.query(internal.households.lookup, {
      callerPhone: seed.callerPhone,
    });
    expect(
      ctxForAgent?.favorites.some((f) => f.aliases.includes("kitchen roll")),
    ).toBe(true);
    await t.mutation(api.households.removeFavorite, {
      ...dana,
      favoriteId: id,
    });

    await expect(
      t.mutation(api.households.saveContact, {
        ...dana,
        name: "Sam",
        relation: "son",
        phone: "555-0102",
      }),
    ).rejects.toThrow(/E\.164/);
    await t.mutation(api.households.saveContact, {
      ...dana,
      name: "Sam",
      relation: "son",
      phone: "+1 (415) 555-0102",
    });
    h = await t.query(api.dashboard.household, { accessKey: KEY });
    expect(h.familyContacts).toEqual([
      { name: "Dana", relation: "daughter", phoneLast4: "0101" },
      { name: "Sam", relation: "son", phoneLast4: "0102" },
    ]);
    // Editing keeps Dana's sign-in link and phone.
    await t.mutation(api.households.saveContact, {
      ...dana,
      index: 0,
      currentName: "Dana",
      name: "Dana",
      relation: "daughter (primary)",
    });
    const stored = (await t.run((ctx) => ctx.db.get(householdId)))!;
    expect(stored.familyContacts[0]).toMatchObject({
      phone: seed.familyPhone,
      authSubject: "dana",
      relation: "daughter (primary)",
    });
    await expect(
      t.mutation(api.households.removeContact, {
        ...dana,
        index: 1,
        currentName: "Dana",
      }),
    ).rejects.toThrow(/reload/);
    await t.mutation(api.households.removeContact, {
      ...dana,
      index: 1,
      currentName: "Sam",
    });

    const sharing = await t.mutation(api.households.setSharing, {
      ...dana,
      chatTranscripts: true,
    });
    expect(sharing).toEqual({ chatTranscripts: true, moodNotes: false });
  });

  test("authz: settings mutations need the key and a family actor", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(api.households.setSharing, { chatTranscripts: true }),
    ).rejects.toThrow(/Unauthenticated/);
    await expect(
      t.mutation(api.households.updateLimits, {
        accessKey: KEY,
        perOrderCapCents: 1,
      }),
    ).rejects.toThrow(/Choose which family member/);
    await expect(
      t.mutation(api.households.updateLimits, {
        accessKey: "nope".padEnd(40, "x"),
        actor: "Dana",
        perOrderCapCents: 1,
      }),
    ).rejects.toThrow(/Invalid access key/);
  });
});

describe("#99 sharing", () => {
  test("Call 3: chat transcript hidden until sharing is on; mood notes only when allowed", async () => {
    const { t, callId } = await setup();
    await post(t, "/agent/turn", {
      callId,
      idx: 0,
      speaker: "user",
      text: "I've been feeling a bit low",
      at: 1,
      timings: {},
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    await t.run((ctx) => ctx.db.patch(callId, { moodNote: "Feeling low" }));
    let live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(live?.call.transcriptVisible).toBe(false);
    expect(live?.turns).toEqual([]);
    expect(live?.call.moodNote).toBeNull();
    await t.mutation(api.households.setSharing, {
      ...dana,
      chatTranscripts: true,
      moodNotes: true,
    });
    live = await t.query(api.dashboard.liveCall, { accessKey: KEY });
    expect(live?.turns.map((x) => x.text)).toEqual([
      "I've been feeling a bit low",
    ]);
    expect(live?.call.moodNote).toBe("Feeling low");
  });
});

describe("#98 developer stats", () => {
  const usage = (input: number, cacheRead: number, output = 100) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  });

  test("percentiles, first-turn cache hit rate and cost per call", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([], 50)).toBeNull();
    // 1M cached tokens read = $0.01, 1M output = $0.50 (≤100K tier per turn).
    expect(turnCostUsd(usage(0, 50_000, 0))).toBeCloseTo(0.0005, 10);
    expect(turnCostUsd(usage(200_000, 0, 0))).toBeCloseTo(0.1, 10); // >100K tier
    const call = (id: string) =>
      ({
        _id: id,
        startedAt: 1,
        outcome: "no_order",
      }) as unknown as Doc<"calls">;
    const turn = (idx: number, u: ReturnType<typeof usage>, v2v: number) =>
      ({
        idx,
        speaker: "assistant",
        usage: u,
        timings: {
          speechEndAt: 1000,
          sttFinalAt: 1100,
          llmRequestAt: 1150,
          llmFirstTokenAt: 1400,
          ttsFirstAudioAt: 1000 + v2v,
        },
      }) as unknown as Doc<"turns">;
    const stats = developerStats([
      {
        call: call("a"),
        turns: [
          // A templated greeting (no Claude request) is ignored.
          { ...turn(0, usage(0, 0, 0), 9999) },
          turn(1, usage(1000, 40_000), 700),
          turn(2, usage(500, 40_000), 900),
        ],
      },
      { call: call("b"), turns: [turn(0, usage(41_000, 0), 1100)] },
    ]);
    expect(stats.modelTurns).toBe(3);
    const v2v = stats.stages.find((s) => s.key === "voiceToVoice")!;
    expect(v2v).toMatchObject({ n: 3, p50: 900 });
    expect(stats.stages.find((s) => s.key === "llm")?.p50).toBe(250);
    expect(stats.cache).toEqual({ hits: 1, known: 2, rate: 0.5 });
    expect(stats.perCall[0].costUsd).toBeCloseTo(
      (1500 * 0.1 + 80_000 * 0.01 + 200 * 0.5) / 1e6,
      12,
    );
  });

  test("developer query is gated and never returns transcript text", async () => {
    const { t, callId } = await setup();
    await post(t, "/agent/turn", {
      callId,
      idx: 1,
      speaker: "assistant",
      text: "secret words",
      at: 1,
      timings: { sttFinalAt: 1, llmRequestAt: 2, llmFirstTokenAt: 300 },
      usage: usage(100, 30_000),
    });
    await expect(t.query(api.dashboard.developer, {})).rejects.toThrow(
      /Unauthenticated/,
    );
    const stats = await t.query(api.dashboard.developer, { accessKey: KEY });
    expect(stats.cache.rate).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("secret words");
  });
});

describe("#96 memory delete", () => {
  test("M3: deleting a fact makes it forgotten and drops it from the active list", async () => {
    const { t } = await setup();
    const before = await t.query(api.dashboard.memory, { accessKey: KEY });
    const fact = before.facts[0];
    const result = await t.mutation(api.dashboard.forgetFact, {
      ...dana,
      factId: fact._id,
    });
    expect(result.forgotten).toBe(true);
    const after = await t.query(api.dashboard.memory, { accessKey: KEY });
    expect(after.facts.map((f) => f._id)).not.toContain(fact._id);
    const row = await t.run((ctx) => ctx.db.get(fact._id));
    expect(row).toMatchObject({
      status: "forgotten",
      forgottenBy: "Dana (dashboard)",
    });
  });

  test("authz: no key, no actor, or another household's fact is refused", async () => {
    const { t } = await setup();
    const other = await otherHousehold(t);
    const otherFact = await t.run((ctx) =>
      ctx.db.insert("memory_facts", {
        householdId: other.householdId,
        text: "x",
        category: "other",
        evidence: "x",
        sourceCallId: other.callId,
        createdAt: 1,
        status: "active",
      }),
    );
    await expect(
      t.mutation(api.dashboard.forgetFact, { ...dana, factId: otherFact }),
    ).rejects.toThrow(/Fact not found/);
    const mine = (await t.query(api.dashboard.memory, { accessKey: KEY }))
      .facts[0]._id;
    await expect(
      t.mutation(api.dashboard.forgetFact, { accessKey: KEY, factId: mine }),
    ).rejects.toThrow(/Choose which family member/);
    await expect(
      t.mutation(api.dashboard.forgetFact, { actor: "Dana", factId: mine }),
    ).rejects.toThrow(/Unauthenticated/);
  });
});
