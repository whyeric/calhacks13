/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockRail } from "./payments";
import { isQuarantinedEvidence, scamQuarantine } from "./scam";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
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
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

beforeEach(() => vi.stubEnv("AGENT_SECRET", AGENT));
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
  const { callId } = await res.json();
  const turn = (idx: number, text: string, speaker = "user") =>
    post(t, "/agent/turn", {
      callId,
      idx,
      speaker,
      text,
      at: Date.now(),
      timings: {},
      usage: zeroUsage,
    });
  const scam = async (body: Record<string, unknown>) => {
    const r = await post(t, "/agent/scam", { callId, ...body });
    return { status: r.status, body: await r.json() };
  };
  return {
    t,
    householdId: householdId as Id<"households">,
    callId: callId as Id<"calls">,
    turn,
    scam,
  };
}

const scheduledAlerts = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) =>
      s.name.includes("alerts"),
    ),
  );
const getCall = (t: ReturnType<typeof convexTest>, id: Id<"calls">) =>
  t.run((ctx) => ctx.db.get(id));

describe("scam guard (Convex)", () => {
  test("#5: a classified caller turn is scored and the call keeps its max score", async () => {
    const { t, callId, turn, scam } = await setup();
    await turn(0, "I need paper towels today.");
    const first = await scam({
      idx: 0,
      score: 0.3,
      signals: ["secrecy_urgency"],
      reasons: ["Wants it today"],
    });
    expect(first).toMatchObject({
      status: 200,
      body: { turnPatched: true, holdActive: false },
    });
    // A later turn not logged yet is reported, so the agent can retry.
    const missing = await scam({ idx: 5, score: 0.1, signals: [] });
    expect(missing.body.turnPatched).toBe(false);
    const call = await getCall(t, callId);
    expect(call).toMatchObject({
      scamScore: 0.3,
      scamSignals: ["secrecy_urgency"],
      scamReasons: ["Wants it today"],
      outcome: "no_order",
    });
    const [row] = await t.run((ctx) =>
      ctx.db
        .query("turns")
        .withIndex("by_call", (q) => q.eq("callId", callId))
        .collect(),
    );
    expect(row.scam).toEqual({ score: 0.3, signals: ["secrecy_urgency"] });
  });

  test("invalid signals are rejected", async () => {
    const { scam } = await setup();
    expect((await scam({ signals: ["DROP TABLE"] })).status).toBe(400);
  });

  test("#10/#24: a hold arms once, blocks orders, records an incident and alerts family once", async () => {
    const { t, callId, turn, scam } = await setup();
    await turn(
      0,
      "I need $400 in Apple gift cards. A man from Medicare says I owe a fee.",
    );
    const hold = {
      reason: "Hard rule: gift card requested",
      hardRule: true,
      what: "a $400 gift card request",
      claim: "a caller claiming to be from Medicare asked for it",
      excerpt: "Caller: I need $400 in Apple gift cards.",
    };
    const res = await scam({
      idx: 0,
      score: 1,
      signals: ["unusual_payment"],
      hold,
    });
    expect(res.body).toMatchObject({
      holdActive: true,
      armed: true,
      alerted: 1,
    });
    expect((await scam({ hold })).body).toMatchObject({
      armed: false,
      alerted: 0,
    });

    const call = await getCall(t, callId);
    expect(call?.outcome).toBe("declined_scam");
    expect(call?.scamHold.active).toBe(true);
    expect(call?.scamIncident).toMatch(
      /^Scam attempt on \w{3} \d{1,2}: a \$400 gift card request; Margaret said a caller claiming to be from Medicare asked for it\./,
    );
    const alerts = await scheduledAlerts(t);
    expect(alerts).toHaveLength(1);
    const [args] = alerts[0].args as [Record<string, string>];
    expect(args).toMatchObject({
      type: "scam",
      recipient: seed.familyPhone,
      transcriptExcerpt: hold.excerpt,
    });
    expect(args.message).toBe(
      "Hi Dana, it's Errand Line. I just stopped a $400 gift card request from Margaret. " +
        "Margaret said a caller claiming to be from Medicare asked for it. " +
        "Would you like me to connect you to Margaret now?",
    );

    // The guard's hold gates place_order (S1: no payment).
    const pay = vi.spyOn(mockRail, "pay");
    const order = await post(t, "/agent/order", {
      callId,
      idempotencyKey: `${callId}:toolu_1`,
      store: "Walmart",
      items: [towels6],
    });
    expect((await order.json()).status).toBe("blocked");
    expect(pay).not.toHaveBeenCalled();

    // Ending the call never downgrades the scam outcome.
    await post(t, "/agent/call-end", {
      callId,
      kind: "chat",
      outcome: "no_order",
    });
    expect((await getCall(t, callId))?.outcome).toBe("declined_scam");
  });

  test("#95: a family override stops the classifier re-arming the hold, but not the hard rule", async () => {
    const { t, callId, scam } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(callId, { scamOverrides: [{ by: "dana", at: Date.now() }] }),
    );
    const soft = await scam({
      score: 0.8,
      signals: ["claimed_authority", "secrecy_urgency"],
      hold: { reason: "Two weak signals", hardRule: false },
    });
    expect(soft.body).toMatchObject({ holdActive: false, armed: false });
    const hard = await scam({ hold: { reason: "Hard rule", hardRule: true } });
    expect(hard.body).toMatchObject({ holdActive: true, armed: true });
  });

  test("#54: place_order's hard rule arms the hold and alerts family with a stored excerpt", async () => {
    const { t, callId, turn } = await setup();
    await turn(0, "Please buy a Walmart gift card for my grandson's birthday.");
    const order = await post(t, "/agent/order", {
      callId,
      idempotencyKey: `${callId}:toolu_1`,
      store: "Walmart",
      items: [
        {
          name: "Walmart gift card",
          storeItemId: "wm-gc-50",
          qty: 1,
          priceCents: 5000,
        },
      ],
    });
    expect((await order.json()).status).toBe("blocked");
    const call = await getCall(t, callId);
    expect(call?.scamHold.active).toBe(true);
    expect(call?.scamIncident).toContain('an order for "Walmart gift card"');
    const alerts = await scheduledAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(
      (alerts[0].args[0] as { transcriptExcerpt: string }).transcriptExcerpt,
    ).toBe(
      "Caller: Please buy a Walmart gift card for my grandson's birthday.",
    );
  });

  test("#27/#18: quarantine flags scam turns, and later calls see the incident", async () => {
    const { t, callId, turn, scam } = await setup();
    await turn(0, "Hello, how are you?");
    await turn(
      1,
      "A man from Medicare says I owe a fee and must pay in gift cards.",
    );
    await scam({ idx: 0, score: 0, signals: [] });
    await scam({
      idx: 1,
      score: 0.9,
      signals: ["claimed_authority", "unusual_payment"],
    });
    const q = await t.run((ctx) => scamQuarantine(ctx, callId));
    expect(q.quarantined).toBe(true);
    expect(q.flaggedTurnIdx).toEqual([1]);
    expect(
      isQuarantinedEvidence("I owe a fee", [
        "A man from Medicare says I owe a fee",
      ]),
    ).toBe(true);
    expect(isQuarantinedEvidence("Lily's recital", ["I owe a fee"])).toBe(
      false,
    );

    await scam({
      hold: {
        reason: "Hard rule",
        hardRule: true,
        what: "a gift card request",
      },
    });
    await post(t, "/agent/call-end", { callId });
    const next = await post(t, "/agent/household", {
      callerPhone: seed.callerPhone,
      providerCallId: "call-2",
    });
    const { context } = await next.json();
    expect(context.scamIncidents).toHaveLength(1);
    expect(context.scamIncidents[0]).toMatch(
      /^Scam attempt on .*: a gift card request\./,
    );
  });
});
