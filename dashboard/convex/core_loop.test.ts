/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockRail } from "./payments";
import {
  foldToAscii,
  hardRuleViolation,
  monthStart,
  outOfPattern,
} from "./orders";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
const ALERT = "alert-test-secret-".padEnd(48, "b");
const seed = {
  callerPhone: "+14155550100",
  familyPhone: "+14155550101",
  familyAuthSubject: "dana",
};
const towels6 = {
  name: "Paper towels, 6-roll pack",
  storeItemId: "demo-paper-towels-6",
  qty: 1,
  priceCents: 897,
};
const coffee = {
  name: "Medium-roast coffee, big can",
  storeItemId: "demo-coffee-big",
  qty: 1,
  priceCents: 1248,
};

beforeEach(() => {
  vi.stubEnv("AGENT_SECRET", AGENT);
  vi.stubEnv("ALERT_SECRET", ALERT);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

async function setup(providerCallId = "call-1") {
  const t = convexTest(schema, modules);
  const { householdId } = await t.mutation(internal.seed.demo, seed);
  const res = await post(t, "/agent/household", {
    callerPhone: seed.callerPhone,
    providerCallId,
  });
  const { callId, context } = await res.json();
  let n = 0;
  const order = async (
    items: unknown[],
    store = "Walmart",
    key = `${callId}:toolu_${++n}`,
  ) => {
    const response = await post(t, "/agent/order", {
      callId,
      idempotencyKey: key,
      store,
      items,
    });
    return { httpStatus: response.status, body: await response.json(), key };
  };
  return {
    t,
    householdId,
    callId: callId as Id<"calls">,
    context,
    order,
  };
}

const allOrders = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("orders").collect());
const allAlerts = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("alerts").collect());

describe("place_order", () => {
  test("T1: Call 1 is paid at 2145 cents via the mock rail", async () => {
    const { t, callId, order } = await setup();
    const { httpStatus, body } = await order([towels6, coffee]);
    expect(httpStatus).toBe(200);
    expect(body).toMatchObject({ status: "paid", totalCents: 2145 });
    expect(body.paymentRef).toMatch(/^mock_[0-9a-f]{24}$/);
    const [row] = await allOrders(t);
    expect(row).toMatchObject({
      _id: body.orderId,
      status: "paid",
      totalCents: 2145,
      store: "Walmart",
      callId,
      paymentTokenRef: body.paymentRef,
    });
    const alerts = await allAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "order_placed",
      channel: "dashboard",
      delivery: "sent",
      orderId: body.orderId,
    });
    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call).toMatchObject({ outcome: "ordered", kind: "order" });
  });

  test("the server recomputes the total and ignores a client total", async () => {
    const { t, order } = await setup();
    const { body } = await order([{ ...towels6, qty: 2, totalCents: 1 }]);
    expect(body).toMatchObject({ status: "paid", totalCents: 1794 });
    expect((await allOrders(t))[0].items[0]).not.toHaveProperty("totalCents");
  });

  test("invalid quantities, prices and item counts are rejected without an order", async () => {
    const { t, order } = await setup();
    for (const items of [
      [],
      [{ ...towels6, qty: 0 }],
      [{ ...towels6, qty: 21 }],
      [{ ...towels6, qty: 1.5 }],
      [{ ...towels6, priceCents: -1 }],
      [{ ...towels6, priceCents: 8.97 }],
      Array.from({ length: 21 }, () => towels6),
      [{ ...towels6, name: "  " }],
    ])
      expect((await order(items)).httpStatus).toBe(400);
    // Key must belong to the call.
    expect(
      (await order([towels6], "Walmart", "other-call:toolu_1")).httpStatus,
    ).toBe(400);
    expect(await allOrders(t)).toEqual([]);
  });

  test("T3: over the per-order cap needs approval with a reason naming the limit", async () => {
    const { t, callId, order } = await setup();
    const { body } = await order([{ ...coffee, qty: 5 }]); // 6240
    expect(body.status).toBe("needs_approval");
    expect(body.totalCents).toBe(6240);
    expect(body.reason).toBe(
      "This order is $62.40, which is over your $50.00 per-order limit.",
    );
    const [row] = await allOrders(t);
    expect(row.status).toBe("awaiting_approval");
    expect(row.paymentTokenRef).toBeUndefined();
    const alerts = await allAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "approval_needed",
      channel: "dashboard",
      orderId: body.orderId,
    });
    expect(alerts[0].message).toContain("per-order limit");
    expect((await t.run((ctx) => ctx.db.get(callId)))?.outcome).toBe(
      "awaiting_approval",
    );
  });

  test("T5: an unapproved store needs approval", async () => {
    const { order } = await setup();
    const { body } = await order([towels6], "Target");
    expect(body.status).toBe("needs_approval");
    expect(body.reason).toBe("Target isn't one of your approved stores.");
  });

  test("T5: the calendar-month budget counts paid orders plus this one", async () => {
    const { t, householdId, callId, order } = await setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      const base = {
        householdId,
        callId,
        items: [coffee],
        store: "Walmart",
      };
      // 4800 + 4800 + 4800 paid this month, plus excluded rows.
      for (const [i, status] of (
        [
          "paid",
          "paid",
          "paid",
          "declined",
          "failed",
          "awaiting_approval",
        ] as const
      ).entries())
        await ctx.db.insert("orders", {
          ...base,
          idempotencyKey: `seeded:${i}`,
          totalCents: 4800,
          status,
          createdAt: now,
        });
      // Last month's spend does not count.
      await ctx.db.insert("orders", {
        ...base,
        idempotencyKey: "seeded:old",
        totalCents: 4800,
        status: "paid",
        createdAt: monthStart(now, "America/Los_Angeles") - 1,
      });
    });
    const ok = await order([towels6, coffee]); // 14400 + 2145 = 16545
    expect(ok.body.status).toBe("paid");
    const over = await order([{ ...coffee, qty: 3 }]); // +3744 = 20289
    expect(over.body.status).toBe("needs_approval");
    expect(over.body.reason).toBe(
      "This order would bring this month's spending to $202.89, which is over your $200.00 monthly budget.",
    );
  });

  test("LIM-3: a limit change applies to the next order", async () => {
    const { t, householdId, order } = await setup();
    expect((await order([{ ...coffee, qty: 5 }])).body.status).toBe(
      "needs_approval",
    );
    await t.run(async (ctx) => {
      const limits = await ctx.db
        .query("limits")
        .withIndex("by_household", (q) => q.eq("householdId", householdId))
        .unique();
      await ctx.db.patch(limits!._id, { perOrderCapCents: 10000 });
    });
    expect((await order([{ ...coffee, qty: 5 }])).body.status).toBe("paid");
  });

  test("Gate 2.3: setLimits drops the budget below this month's spend; the usual coffee waits", async () => {
    const { t, order } = await setup();
    vi.stubEnv("DEMO_CALLER_PHONE", seed.callerPhone);
    expect((await order([towels6, coffee])).body.status).toBe("paid"); // 2145
    await expect(
      t.mutation(internal.households.setLimits, { monthlyBudgetCents: -1 }),
    ).rejects.toThrow(/whole, non-negative/);
    expect(
      await t.mutation(internal.households.setLimits, {
        monthlyBudgetCents: 2000,
      }),
    ).toEqual({
      perOrderCapCents: 5000,
      monthlyBudgetCents: 2000,
      approvedStores: ["Walmart"],
    });
    const pay = vi.spyOn(mockRail, "pay");
    const { body } = await order([coffee]);
    expect(body.status).toBe("needs_approval");
    expect(body.reason).toMatch(/monthly budget/);
    expect(pay).not.toHaveBeenCalled();
  });

  test("S1: the hard rule blocks gift cards before any limit or payment", async () => {
    const { t, callId, order } = await setup();
    const pay = vi.spyOn(mockRail, "pay");
    const { body } = await order([
      {
        name: "Apple Gift Card $100",
        storeItemId: "apple-100",
        qty: 4,
        priceCents: 10000,
      },
    ]);
    expect(body.status).toBe("blocked");
    expect(body.reason).toContain("gift cards");
    expect(body.orderId).toBeUndefined();
    expect(pay).not.toHaveBeenCalled();
    expect(await allOrders(t)).toEqual([]);
    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call?.outcome).toBe("declined_scam");
    expect(call?.scamHold.active).toBe(true);
    // The hold now blocks even an ordinary order on the same call.
    expect((await order([towels6])).body.status).toBe("blocked");
  });

  test("the hard rule matches item ids and other unusual payment methods", () => {
    for (const name of [
      "Google Play card",
      "Prepaid Visa",
      "Reloadable debit card",
      "Western Union money transfer",
      "MoneyGram",
      "Bitcoin voucher",
      "crypto",
      "Wire transfer",
      "Steam wallet code",
    ])
      expect(hardRuleViolation([{ name, storeItemId: "x" }])).toBe(name);
    expect(
      hardRuleViolation([
        { name: "Card", storeItemId: "walmart-gift-card-50" },
      ]),
    ).toBe("Card");
    for (const name of [
      "Paper towels, 6 rolls",
      "Medium-roast coffee, big can",
      "Birthday card",
      "Wire hangers",
      "Vanilla extract",
    ])
      expect(hardRuleViolation([{ name, storeItemId: "x" }])).toBeNull();
  });

  test("an active scam hold blocks ordering", async () => {
    const { t, callId, order } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(callId, {
        scamHold: { active: true, reason: "test", at: Date.now() },
      }),
    );
    const { body } = await order([towels6]);
    expect(body).toEqual({
      status: "blocked",
      reason: "This call is on a scam hold, so I can't place orders right now.",
    });
    expect(await allOrders(t)).toEqual([]);
  });

  test("Gate 2.4: retrying an idempotency key returns the same order and pays once", async () => {
    const { t, order } = await setup();
    const pay = vi.spyOn(mockRail, "pay");
    const first = await order([towels6, coffee], "Walmart", "will-be-replaced");
    expect(first.httpStatus).toBe(400); // key must start with the callId
    const a = await order([towels6, coffee]);
    const b = await order([towels6, coffee], "Walmart", a.key);
    expect(b.body).toEqual(a.body);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(await allOrders(t)).toHaveLength(1);
    expect(
      (await allAlerts(t)).filter((x) => x.type === "order_placed"),
    ).toHaveLength(1);
  });

  test("a payment failure marks the order failed and alerts the dashboard", async () => {
    const { t, callId, order } = await setup();
    vi.stubEnv("MOCK_PAYMENT_FAIL", "1");
    const { body } = await order([towels6, coffee]);
    expect(body).toMatchObject({ status: "failed" });
    expect(body.reason).toContain("nothing was charged");
    const [row] = await allOrders(t);
    expect(row.status).toBe("failed");
    const alerts = await allAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "payment_failed",
      channel: "dashboard",
      orderId: body.orderId,
    });
    expect((await t.run((ctx) => ctx.db.get(callId)))?.outcome).toBe(
      "no_order",
    );
  });

  test("an unknown PAYMENT_RAIL fails closed rather than paying", async () => {
    const { t, order } = await setup();
    vi.stubEnv("PAYMENT_RAIL", "nonsense");
    const { body } = await order([towels6]);
    expect(body.status).toBe("failed");
    expect((await allOrders(t))[0].paymentTokenRef).toBeUndefined();
  });

  test("PAYMENT_RAIL=visa without sandbox credentials fails without paying", async () => {
    const { t, order } = await setup();
    vi.stubEnv("PAYMENT_RAIL", "visa");
    const pay = vi.spyOn(mockRail, "pay");
    const { body } = await order([towels6, coffee]);
    expect(body.status).toBe("failed");
    expect(pay).not.toHaveBeenCalled();
    const alert = (await allAlerts(t)).find((a) => a.type === "payment_failed");
    expect(alert?.message).toContain("Nothing was charged");
    // Raw rail errors never reach the dashboard.
    expect(alert?.message).not.toContain("Visa sandbox not configured");
  });

  test("prices and names come from the server catalog, not the agent", async () => {
    const { t, order } = await setup();
    const { body } = await order([
      { ...towels6, name: "Cheap towels", priceCents: 1 },
      { ...coffee, priceCents: 0 },
    ]);
    expect(body).toMatchObject({ status: "paid", totalCents: 2145 });
    const [row] = await allOrders(t);
    expect(
      row.items.map((i: { name: string; priceCents: number }) => [
        i.name,
        i.priceCents,
      ]),
    ).toEqual([
      ["Paper towels, 6-roll pack", 897],
      ["Medium-roast coffee, big can", 1248],
    ]);
  });

  test("unknown item ids are rejected unless live prices are enabled", async () => {
    const { t, order } = await setup();
    const live = {
      name: "Paper towels, 8 rolls",
      storeItemId: "walmart-123456",
      qty: 1,
      priceCents: 1099,
    };
    for (const items of [
      [{ ...towels6, storeItemId: "demo-made-up" }],
      [live],
    ]) {
      const { httpStatus, body } = await order(items);
      expect(httpStatus).toBe(400);
      expect(body.error).toBe("Unknown item");
    }
    expect(await allOrders(t)).toEqual([]);
    vi.stubEnv("ALLOW_LIVE_ITEM_PRICES", "1");
    expect((await order([live])).body).toMatchObject({
      status: "paid",
      totalCents: 1099,
    });
    // Live ids still need the walmart- prefix, and a zero total is refused.
    expect(
      (await order([{ ...live, storeItemId: "made-up" }])).body.error,
    ).toBe("Unknown item");
    const free = await order([{ ...live, priceCents: 0 }]);
    expect(free.httpStatus).toBe(400);
    expect(free.body.error).toBe("Order total must be more than zero");
  });

  test("look-alike Unicode cannot bypass the hard rule", async () => {
    for (const name of [
      "g\u0456ft card", // Cyrillic і
      "\uff47\uff49\uff46\uff54 \uff43\uff41\uff52\uff44", // full-width
      "gi\u200bft card", // zero-width space
      "G\u0130FT CARD",
      "Вitcoin", // Cyrillic В
    ])
      expect(hardRuleViolation([{ name, storeItemId: "x" }])).toBe(name);
    expect(foldToAscii("Caf\u00e9 au lait")).toBe("cafe au lait");
    expect(foldToAscii("\u6c34")).toBeNull();
    const { t, callId, order } = await setup();
    const pay = vi.spyOn(mockRail, "pay");
    const blocked = await order([{ ...towels6, name: "g\u0456ft card" }]);
    expect(blocked.body.status).toBe("blocked");
    const fullWidth = await setup("call-fw");
    expect(
      (
        await fullWidth.order([
          {
            ...towels6,
            name: "\uff47\uff49\uff46\uff54 \uff43\uff41\uff52\uff44",
          },
        ])
      ).body.status,
    ).toBe("blocked");
    expect(pay).not.toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get(callId)))?.scamHold.active).toBe(
      true,
    );
    // Letters from other scripts that do not fold to ASCII are refused outright.
    const other = await setup("call-other");
    const refused = await other.order([
      { ...towels6, name: "\u0433\u0438\u0444\u0442 card" },
    ]);
    expect(refused.httpStatus).toBe(400);
    expect(refused.body.error).toBe("Invalid item name");
  });

  test("an ended call cannot place a new order", async () => {
    const { t, callId, order } = await setup();
    expect((await post(t, "/agent/call-end", { callId })).status).toBe(200);
    const { httpStatus, body } = await order([towels6]);
    expect(httpStatus).toBe(400);
    expect(body).toEqual({ error: "Call has ended" });
    expect(await allOrders(t)).toEqual([]);
  });

  test("a retry while the first payment is in flight returns processing and never pays", async () => {
    const { t, callId, order } = await setup();
    const key = `${callId}:toolu_inflight`;
    // The first request reserved (and claimed) the order but has not settled yet.
    const first = await t.mutation(internal.orders.reserve, {
      callId,
      idempotencyKey: key,
      store: "Walmart",
      items: [towels6, coffee],
    });
    expect(first.claimed).toBe(true);
    const pay = vi.spyOn(mockRail, "pay");
    const retry = await order([towels6, coffee], "Walmart", key);
    expect(retry.httpStatus).toBe(200);
    expect(retry.body).toEqual({
      status: "processing",
      orderId: first.result.orderId,
      totalCents: 2145,
    });
    expect(pay).not.toHaveBeenCalled();
    const [row] = await allOrders(t);
    expect(row.status).toBe("pending");
    expect(row.paymentClaimedAt).toEqual(expect.any(Number));
    // A scam hold raised meanwhile is reported on the retry.
    await t.run((ctx) =>
      ctx.db.patch(callId, {
        scamHold: { active: true, reason: "test", at: Date.now() },
      }),
    );
    expect((await order([towels6, coffee], "Walmart", key)).body).toEqual({
      status: "blocked",
      orderId: first.result.orderId,
      reason: "This call is on a scam hold, so I can't place orders right now.",
    });
    expect(pay).not.toHaveBeenCalled();
  });

  test("a crash after the rail charged but before settle never pays twice", async () => {
    const { t, order } = await setup();
    // The rail succeeds, then the action dies before settle can record it.
    const pay = vi.spyOn(mockRail, "pay").mockImplementation(async () => ({
      ok: true as const,
      get tokenRef(): string {
        throw new Error("simulated crash after rail success");
      },
    }));
    const first = await order([towels6, coffee]);
    expect(first.httpStatus).toBe(400);
    expect(pay).toHaveBeenCalledTimes(1);
    pay.mockRestore();
    const pay2 = vi.spyOn(mockRail, "pay");
    for (let i = 0; i < 2; i++) {
      const retry = await order([towels6, coffee], "Walmart", first.key);
      expect(retry.body).toMatchObject({
        status: "processing",
        totalCents: 2145,
      });
    }
    expect(pay2).not.toHaveBeenCalled();
    const rows = await allOrders(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  test("an unknown caller's call cannot order", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.demo, seed);
    const { callId, context } = await (
      await post(t, "/agent/household", {
        callerPhone: "+14155550199",
        providerCallId: "stranger-1",
      })
    ).json();
    expect(context).toBeNull();
    const response = await post(t, "/agent/order", {
      callId,
      idempotencyKey: `${callId}:toolu_1`,
      store: "Walmart",
      items: [towels6],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Ordering needs a registered household",
    );
    expect(await allOrders(t)).toEqual([]);
  });
});

describe("order transitions", () => {
  test("APR-3: the first approval or decline wins and records who decided", async () => {
    const { t, order } = await setup();
    const { body } = await order([{ ...coffee, qty: 5 }]);
    const orderId = body.orderId as Id<"orders">;
    const first = await t.mutation(internal.orders.approve, {
      orderId,
      by: "Dana",
    });
    expect(first).toMatchObject({ status: "approved", alreadyResolved: false });
    const second = await t.mutation(internal.orders.decline, {
      orderId,
      by: "Sam",
    });
    expect(second).toMatchObject({
      status: "approved",
      decidedBy: "Dana",
      alreadyResolved: true,
    });
    const row = await t.run((ctx) => ctx.db.get(orderId));
    expect(row).toMatchObject({ status: "approved", approvedBy: "Dana" });
    expect(row?.paymentTokenRef).toBeUndefined(); // approval alone never pays
    const alert = (await allAlerts(t)).find(
      (a) => a.type === "approval_needed",
    );
    expect(alert).toMatchObject({ decision: "approved", decidedBy: "Dana" });
  });

  test("decline is final and later approval cannot revive it", async () => {
    const { t, order } = await setup();
    const { body, key } = await order([towels6], "Target");
    const orderId = body.orderId as Id<"orders">;
    await t.mutation(internal.orders.decline, { orderId, by: "Dana" });
    expect(
      await t.mutation(internal.orders.approve, { orderId, by: "Sam" }),
    ).toMatchObject({ status: "declined", alreadyResolved: true });
    const row = await t.run((ctx) => ctx.db.get(orderId));
    expect(row).toMatchObject({ status: "declined", declinedBy: "Dana" });
    // A retry of the same request reports the decline, not a new order.
    const retry = await order([towels6], "Target", key);
    expect(retry.body).toMatchObject({ status: "blocked", orderId });
  });

  test("settle never regresses a paid order and cannot pay an awaiting one", async () => {
    const { t, order } = await setup();
    const paid = await order([towels6]);
    const again = await t.mutation(internal.orders.settle, {
      orderId: paid.body.orderId,
      payment: { ok: false, error: "late" },
    });
    expect(again).toEqual(paid.body);
    const waiting = await order([{ ...coffee, qty: 5 }]);
    expect(
      await t.mutation(internal.orders.settle, {
        orderId: waiting.body.orderId,
        payment: { ok: true, tokenRef: "mock_x" },
      }),
    ).toMatchObject({ status: "needs_approval" });
  });
});

describe("household context", () => {
  test("recentOrders appear newest first in the contract shape", async () => {
    const { t, order } = await setup();
    await order([towels6, coffee]);
    await order([{ ...coffee, qty: 5 }]);
    const { context } = await (
      await post(t, "/agent/household", {
        callerPhone: seed.callerPhone,
        providerCallId: "call-2",
      })
    ).json();
    expect(context.recentOrders).toHaveLength(2);
    expect(context.recentOrders[0]).toEqual({
      items: [{ ...coffee, qty: 5 }].map(
        ({ name, qty, priceCents, storeItemId }) => ({
          name,
          qty,
          priceCents,
          storeItemId,
        }),
      ),
      totalCents: 6240,
      store: "Walmart",
      status: "awaiting_approval",
      createdAt: expect.any(Number),
    });
    expect(context.recentOrders[1]).toMatchObject({
      totalCents: 2145,
      status: "paid",
    });
    // Convex serializes object keys in a stable order, so identical data renders identically.
    expect(Object.keys(context.recentOrders[1].items[0]).sort()).toEqual([
      "name",
      "priceCents",
      "qty",
      "storeItemId",
    ]);
  });

  test("#49: spendSummary digests paid orders; a first-ever $400 order is out of pattern", async () => {
    const { t, context, order } = await setup();
    expect(context.spendSummary).toEqual({
      paidOrders: 0,
      typicalOrderCents: null,
      largestOrderCents: null,
      stores: [],
    });
    expect(outOfPattern(context.spendSummary, 40_000)).toBe(true);
    await order([towels6, coffee]); // paid 2145
    await order([towels6]); // paid 897
    await order([{ ...coffee, qty: 5 }]); // over the cap: awaiting, not counted
    const fetchContext = async () =>
      (
        await (
          await post(t, "/agent/household", {
            callerPhone: seed.callerPhone,
            providerCallId: "call-2",
          })
        ).json()
      ).context;
    const first = await fetchContext();
    expect(first.spendSummary).toEqual({
      paidOrders: 2,
      typicalOrderCents: 897,
      largestOrderCents: 2145,
      stores: ["Walmart"],
    });
    expect(outOfPattern(first.spendSummary, 40_000)).toBe(true);
    expect(outOfPattern(first.spendSummary, 2145)).toBe(false);
    // Deterministic for identical data.
    expect(JSON.stringify((await fetchContext()).spendSummary)).toBe(
      JSON.stringify(first.spendSummary),
    );
  });

  test("M1: a due follow-up is offered, marked asked once, and not offered again", async () => {
    const { t, callId, context } = await setup();
    expect(context.followups).toHaveLength(1);
    const followupId = context.followups[0]._id;
    for (let i = 0; i < 2; i++) {
      const response = await post(t, "/agent/followup", { callId, followupId });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    const row = await t.run((ctx) => ctx.db.get(followupId as Id<"followups">));
    expect(row).toMatchObject({ status: "asked", askedInCallId: callId });
    const next = await (
      await post(t, "/agent/household", {
        callerPhone: seed.callerPhone,
        providerCallId: "call-2",
      })
    ).json();
    expect(next.context.followups).toEqual([]);
  });

  test("follow-ups that are not yet due are withheld; other households' calls cannot mark them", async () => {
    const { t, householdId, context } = await setup();
    const followupId = context.followups[0]._id;
    await t.run((ctx) =>
      ctx.db.patch(followupId as Id<"followups">, {
        notBefore: Date.now() + 86_400_000,
      }),
    );
    const later = await t.query(internal.households.lookup, {
      callerPhone: seed.callerPhone,
      now: Date.now(),
    });
    expect(later?.followups).toEqual([]);
    expect(householdId).toBeTruthy();
    const { callId: strangerCall } = await (
      await post(t, "/agent/household", {
        callerPhone: "+14155550199",
        providerCallId: "stranger-2",
      })
    ).json();
    expect(
      (await post(t, "/agent/followup", { callId: strangerCall, followupId }))
        .status,
    ).toBe(400);
  });
});

describe("helpers", () => {
  test("monthStart is local midnight on the 1st in the household timezone", () => {
    const now = Date.UTC(2026, 9, 24, 18, 0, 0); // Oct 24 2026, 11:00 PDT
    expect(monthStart(now, "America/Los_Angeles")).toBe(
      Date.UTC(2026, 9, 1, 7, 0, 0),
    );
    // Nov 1 03:00 UTC is still Oct 31 in Los Angeles.
    expect(monthStart(Date.UTC(2026, 10, 1, 3), "America/Los_Angeles")).toBe(
      Date.UTC(2026, 9, 1, 7, 0, 0),
    );
    expect(monthStart(now, "Not/AZone")).toBe(Date.UTC(2026, 9, 1));
  });
});

describe("call end", () => {
  test("the agent's call-end outcome never downgrades an outcome set by the order path", async () => {
    const { t, callId, order } = await setup();
    await order([
      {
        name: "Walmart gift card",
        storeItemId: "gc-100",
        qty: 1,
        priceCents: 5000,
      },
    ]);
    await post(t, "/agent/call-end", {
      callId,
      kind: "order",
      outcome: "ordered",
    });
    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call?.outcome).toBe("declined_scam");
    expect(call?.endedAt).toBeDefined();
  });

  test("the agent's call-end outcome can raise an outcome", async () => {
    const { t, callId } = await setup();
    await post(t, "/agent/call-end", { callId, outcome: "awaiting_approval" });
    const call = await t.run((ctx) => ctx.db.get(callId));
    expect(call?.outcome).toBe("awaiting_approval");
  });
});
