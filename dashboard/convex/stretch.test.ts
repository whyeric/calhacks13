/// <reference types="vite/client" />
// Milestone 7 stretch features: #55 order status, #71 favorite suggestions, #66 second store,
// #60 outbound check-ins and #65 spoken PIN.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { checkinLines } from "./checkins";
import { suggestedAliases } from "./favoriteSuggestions";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
const KEY = "dashboard-test-access-key-".padEnd(48, "k");
const seed = {
  callerPhone: "+14155550100",
  familyPhone: "+14155550101",
  familyAuthSubject: "dana",
};
const NEW_NUMBER = "+14155550177";
const towels = {
  name: "Paper towels, 6-roll pack",
  storeItemId: "demo-paper-towels-6",
  qty: 2,
  priceCents: 897,
};
const dana = { accessKey: KEY, actor: "Dana" };
const view = { accessKey: KEY };

beforeEach(() => {
  vi.stubEnv("AGENT_SECRET", AGENT);
  vi.stubEnv("DASHBOARD_ACCESS_KEY", KEY);
  vi.stubEnv("DASHBOARD_HOUSEHOLD_PHONE", seed.callerPhone);
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

async function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { householdId } = await t.mutation(internal.seed.demo, seed);
  const startCall = async (callerPhone: string, providerCallId: string) =>
    (
      await (
        await post(t, "/agent/household", { callerPhone, providerCallId })
      ).json()
    ).callId as Id<"calls">;
  const callId = await startCall(seed.callerPhone, "call-1");
  let n = 0;
  const order = async (
    items: unknown[],
    store = "Walmart",
    onCall: Id<"calls"> = callId,
  ) => {
    const response = await post(t, "/agent/order", {
      callId: onCall,
      idempotencyKey: `${onCall}:toolu_${++n}`,
      store,
      items,
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    t,
    householdId: householdId as Id<"households">,
    callId,
    startCall,
    order,
  };
}

describe("#55 order status by phone", () => {
  test("no recent orders, then paid and awaiting-approval orders, newest first", async () => {
    const { t, callId, order } = await setup();
    const empty = await (
      await post(t, "/agent/recent-orders", { callId })
    ).json();
    expect(empty).toEqual({ orders: [] });

    expect((await order([towels])).body.status).toBe("paid");
    const big = { ...towels, qty: 6 }; // 53.82 > the 50.00 per-order cap
    expect((await order([big])).body.status).toBe("needs_approval");

    const { orders } = await (
      await post(t, "/agent/recent-orders", { callId })
    ).json();
    expect(orders.map((o: { status: string }) => o.status)).toEqual([
      "awaiting_approval",
      "paid",
    ]);
    expect(orders[0]).toMatchObject({
      store: "Walmart",
      totalCents: 5382,
      items: [{ name: towels.name, qty: 6 }],
      thisCall: true,
    });
    expect(orders[0].reason).toMatch(/limit|cap|\$50/i);
    // Read-only and no payment identifiers.
    expect(JSON.stringify(orders)).not.toMatch(
      /paymentTokenRef|idempotencyKey/,
    );
  });

  test("an unknown caller's call sees no orders", async () => {
    const { t, startCall, order } = await setup();
    await order([towels]);
    const stranger = await startCall("+14155550999", "call-x");
    const result = await (
      await post(t, "/agent/recent-orders", { callId: stranger })
    ).json();
    expect(result).toEqual({ orders: [] });
  });
});

describe("#71 favorite suggestions from repeat orders", () => {
  test("an item paid for three times is suggested; accepting creates a favorite", async () => {
    const { t, householdId, order } = await setup();
    await order([towels]);
    await order([towels]);
    expect(await t.query(api.favoriteSuggestions.list, view)).toEqual([]);
    await order([{ ...towels, qty: 1 }]);
    await order([{ ...towels, qty: 2 }]);
    const [suggestion, ...rest] = await t.query(
      api.favoriteSuggestions.list,
      view,
    );
    expect(rest).toEqual([]);
    expect(suggestion).toMatchObject({
      storeItemId: "demo-paper-towels-6",
      store: "Walmart",
      orders: 4,
      usualQty: 2,
      aliases: ["paper towels", "my paper towels", "usual paper towels"],
    });

    await t.mutation(api.favoriteSuggestions.accept, {
      ...dana,
      storeItemId: "demo-paper-towels-6",
    });
    const favorite = await t.run((ctx) =>
      ctx.db
        .query("favorites")
        .withIndex("by_household", (q) => q.eq("householdId", householdId))
        .filter((q) => q.eq(q.field("storeItemId"), "demo-paper-towels-6"))
        .unique(),
    );
    expect(favorite).toMatchObject({
      name: towels.name,
      usualQty: 2,
      aliases: ["paper towels", "my paper towels", "usual paper towels"],
    });
    expect(await t.query(api.favoriteSuggestions.list, view)).toEqual([]);
    await expect(
      t.mutation(api.favoriteSuggestions.accept, {
        ...dana,
        storeItemId: "demo-paper-towels-6",
      }),
    ).rejects.toThrow(/no longer open/);
  });

  test("existing favorites are never suggested, and aliases read naturally", async () => {
    const { t, order } = await setup();
    const coffee = {
      name: "Medium-roast coffee, big can",
      storeItemId: "demo-coffee-big",
      qty: 1,
      priceCents: 1248,
    };
    for (let i = 0; i < 3; i++) await order([coffee]);
    expect(await t.query(api.favoriteSuggestions.list, view)).toEqual([]);
    expect(suggestedAliases("Whole milk, one gallon")).toEqual([
      "whole milk",
      "my whole milk",
      "usual whole milk",
    ]);
  });
});

describe("#66 second store", () => {
  test("a second-store item is priced server-side and goes to approval when the store isn't approved", async () => {
    const { order } = await setup();
    const result = await order(
      [
        {
          name: "anything",
          storeItemId: "demo-target-paper-towels-6",
          qty: 1,
          priceCents: 1,
        },
      ],
      "Target",
    );
    expect(result.body).toMatchObject({
      status: "needs_approval",
      totalCents: 849,
    });
    expect(result.body.reason).toMatch(
      /Target isn't one of your approved stores/,
    );
  });
});

describe("#60 outbound check-in calls", () => {
  test("opener is voicemail-safe; the memory line has the usual item and at most one follow-up", () => {
    const lines = checkinLines(
      "Margaret",
      "Medium-roast coffee, big can",
      "How did the tomatoes do?",
    );
    expect(lines.opener).toBe(
      "Hi Margaret, it's Errand Line, your AI assistant, calling to check in. Is now a good time?",
    );
    expect(lines.opener).not.toMatch(/coffee|tomato/);
    expect(lines.memoryLine).toBe(
      "Would you like me to order your usual medium-roast coffee this week? And how did the tomatoes do?",
    );
  });

  test("manual check-in rings the caller, the agent opens it as an outbound call, and the caller can stop them", async () => {
    const { t, householdId, callId } = await setup();
    const followupId = await t.run((ctx) =>
      ctx.db.insert("followups", {
        householdId,
        speakable: "How did the tomatoes do?",
        sourceCallId: callId,
        notBefore: 0,
        status: "open",
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("followups", {
        householdId,
        speakable: "Did Dana visit?",
        sourceCallId: callId,
        notBefore: 5,
        status: "open",
      }),
    );
    vi.stubEnv("CARTESIA_API_KEY", "test-key");
    vi.stubEnv("CHECKIN_AGENT_ID", "agent_errand");
    vi.stubEnv("ALERT_FROM_NUMBER_ID", "num_1");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json({
          outbound_calls: [{ agent_call_id: "out-1" }],
        });
      void url;
      return Response.json({ status: "active" });
    });
    vi.stubGlobal("fetch", fetch);

    const checkinId = await t.mutation(api.checkins.requestNow, dana);
    await expect(t.mutation(api.checkins.requestNow, dana)).rejects.toThrow(
      /already in progress/,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({
      agent_id: "agent_errand",
      outbound_calls: [
        {
          to_number: seed.callerPhone,
          from_number_id: "num_1",
          dynamic_variables: { checkinId },
        },
      ],
    });

    const started = await (
      await post(t, "/agent/checkin-start", {
        providerCallId: "out-1",
        calledPhone: seed.callerPhone,
      })
    ).json();
    expect(started.context.household.preferredName).toBe("Margaret");
    expect(started.checkin).toMatchObject({
      checkinId,
      followupId,
      memoryLine:
        "Would you like me to order your usual medium-roast coffee this week? And how did the tomatoes do?",
    });
    // Only one follow-up is raised (MEM-2).
    expect(started.checkin.memoryLine).not.toMatch(/Dana/);
    const call = await t.run((ctx) =>
      ctx.db.get(started.callId as Id<"calls">),
    );
    expect(call).toMatchObject({
      kind: "checkin",
      outbound: true,
      checkinId,
    });
    const checkin = await t.run((ctx) => ctx.db.get(checkinId));
    expect(checkin).toMatchObject({ status: "answered", callId: call!._id });

    // Logged like other calls; a chat check-in keeps its kind at call end.
    await post(t, "/agent/call-end", {
      callId: started.callId,
      kind: "chat",
      outcome: "no_order",
    });
    expect(
      await t.run((ctx) => ctx.db.get(started.callId as Id<"calls">)),
    ).toMatchObject({ kind: "checkin" });

    const overview = await t.query(api.checkins.overview, view);
    expect(overview.recent[0]).toMatchObject({
      status: "answered",
      trigger: "manual",
      requestedBy: "Dana (dashboard)",
    });

    // The caller declines further check-ins.
    expect(
      await (
        await post(t, "/agent/checkins-stop", { callId: started.callId })
      ).json(),
    ).toEqual({ status: "stopped" });
    await expect(t.mutation(api.checkins.requestNow, dana)).rejects.toThrow(
      /asked not to get check-in calls/,
    );
    await expect(
      t.mutation(api.checkins.configure, { ...dana, enabled: true }),
    ).rejects.toThrow(/asked not to/);
    expect((await t.query(api.checkins.overview, view)).optedOutBy).toBe(
      "caller",
    );
  });

  test("no answer is recorded and a missing configuration fails without calling", async () => {
    const { t } = await setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const checkinId = await t.mutation(api.checkins.requestNow, dana);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.get(checkinId))).toMatchObject({
      status: "failed",
    });

    vi.stubEnv("CARTESIA_API_KEY", "test-key");
    vi.stubEnv("CHECKIN_AGENT_ID", "agent_errand");
    vi.stubEnv("ALERT_FROM_NUMBER_ID", "num_1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ outbound_calls: [{ agent_call_id: "out-2" }] })
          : Response.json({ status: "no_answer" }),
      ),
    );
    const second = await t.mutation(api.checkins.requestNow, dana);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(second))).toMatchObject({
      status: "no_answer",
      providerCallId: "out-2",
    });
  });

  test("the schedule places due check-ins and moves the next one forward", async () => {
    const { t } = await setup();
    await t.mutation(api.checkins.configure, {
      ...dana,
      enabled: true,
      everyDays: 7,
    });
    expect((await t.mutation(internal.checkins.tick, {})).placed).toBe(0);
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect((await t.mutation(internal.checkins.tick, {})).placed).toBe(1);
    const overview = await t.query(api.checkins.overview, view);
    expect(overview.recent[0].trigger).toBe("schedule");
    expect(overview.nextAt).toBeGreaterThan(Date.now());
  });
});

describe("#65 spoken PIN for new numbers", () => {
  test("a family-approved new number unlocks with the right PIN; wrong PINs lock it and alert the family", async () => {
    const { t, householdId, startCall, order } = await setup();
    // Not approved yet: no PIN prompt.
    expect(
      await (
        await post(t, "/agent/pin-check", { callerPhone: NEW_NUMBER })
      ).json(),
    ).toEqual({ pinRequired: false, locked: false });

    await t.mutation(api.pin.setPin, {
      ...dana,
      pin: "4821",
      numbers: [NEW_NUMBER],
    });
    const household = await t.run((ctx) => ctx.db.get(householdId));
    expect(JSON.stringify(household)).not.toContain("4821");
    expect((await t.query(api.pin.status, view)).numbers[0].label).toBe(
      "••• 0177",
    );
    expect(
      await (
        await post(t, "/agent/pin-check", { callerPhone: NEW_NUMBER })
      ).json(),
    ).toEqual({ pinRequired: true, locked: false });

    // T4: before the PIN, the new number cannot order.
    const callId = await startCall(NEW_NUMBER, "pin-call-1");
    expect((await order([towels], "Walmart", callId)).status).toBe(400);

    const wrong = await (
      await post(t, "/agent/pin-verify", { callId, pin: "1111" })
    ).json();
    expect(wrong).toEqual({ status: "wrong", attemptsLeft: 2 });

    const right = await (
      await post(t, "/agent/pin-verify", { callId, pin: "4 8 2 1" })
    ).json();
    expect(right.status).toBe("ok");
    expect(right.context.household.preferredName).toBe("Margaret");
    expect((await order([towels], "Walmart", callId)).body.status).toBe("paid");
    const attempts = await t.run((ctx) =>
      ctx.db.query("pin_attempts").take(10),
    );
    expect(attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(JSON.stringify(attempts)).not.toMatch(/4821|1111/);
  });

  test("three wrong PINs lock the number for an hour and call the family", async () => {
    const { t, startCall } = await setup();
    await t.mutation(api.pin.setPin, {
      ...dana,
      pin: "4821",
      numbers: [NEW_NUMBER],
    });
    const callId = await startCall(NEW_NUMBER, "pin-call-2");
    const tries = [];
    for (const pin of ["1111", "2222", "3333", "4821"])
      tries.push(
        await (await post(t, "/agent/pin-verify", { callId, pin })).json(),
      );
    expect(tries).toEqual([
      { status: "wrong", attemptsLeft: 2 },
      { status: "wrong", attemptsLeft: 1 },
      { status: "locked" },
      { status: "locked" },
    ]);
    expect(
      await (
        await post(t, "/agent/pin-check", { callerPhone: NEW_NUMBER })
      ).json(),
    ).toEqual({ pinRequired: true, locked: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const alerts = await t.run((ctx) => ctx.db.query("alerts").take(5));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "scam",
      recipient: seed.familyPhone,
    });
    expect(alerts[0].message).toMatch(/ending in 0177/);
    expect(alerts[0].message).not.toMatch(/1111|2222|3333|4821/);

    // After an hour the number may try again.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const later = await startCall(NEW_NUMBER, "pin-call-3");
    expect(
      (
        await (
          await post(t, "/agent/pin-verify", { callId: later, pin: "4821" })
        ).json()
      ).status,
    ).toBe("ok");
  });

  test("approved numbers can't be another household's or the caller's own", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(api.pin.setPin, { ...dana, numbers: [seed.callerPhone] }),
    ).rejects.toThrow(/caller's own number/);
    await expect(
      t.mutation(api.pin.setPin, { ...dana, pin: "12" }),
    ).rejects.toThrow(/4 to 8 digits/);
  });
});
