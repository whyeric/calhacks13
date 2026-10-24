/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const AGENT = "agent-test-secret-".padEnd(48, "a");
const ALERT = "alert-test-secret-".padEnd(48, "b");
const seed = {
  callerPhone: "+14155550100",
  familyPhone: "+14155550101",
  familyAuthSubject: "dana",
};
const routes = [
  "/agent/household",
  "/agent/turn",
  "/agent/order",
  "/agent/forget",
  "/agent/alert",
  "/agent/call-end",
  "/alert/decision",
];

beforeEach(() => {
  vi.stubEnv("AGENT_SECRET", AGENT);
  vi.stubEnv("ALERT_SECRET", ALERT);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function request(
  t: ReturnType<typeof convexTest>,
  path: string,
  body: unknown,
  secret?: string,
) {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("service authentication", () => {
  for (const route of routes) {
    test(`${route} rejects missing, wrong and opposite-role credentials before parsing`, async () => {
      const t = convexTest(schema, modules);
      for (const secret of [
        undefined,
        "wrong",
        route.startsWith("/alert") ? AGENT : ALERT,
      ]) {
        expect((await request(t, route, {}, secret)).status).toBe(401);
      }
    });
  }
  test("missing, short or identical configured secrets fail closed", async () => {
    const t = convexTest(schema, modules);
    for (const value of ["", "short", ALERT]) {
      vi.stubEnv("AGENT_SECRET", value);
      expect((await request(t, "/agent/household", {}, value)).status).toBe(
        401,
      );
    }
  });
  test("authenticated malformed JSON is rejected", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/agent/household", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT}` },
      body: "{",
    });
    expect(response.status).toBe(400);
  });
  test("future money and forget routes explicitly reject execution", async () => {
    const t = convexTest(schema, modules);
    for (const route of ["/agent/order", "/agent/forget"])
      expect((await request(t, route, {}, AGENT)).status).toBe(501);
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([]);
  });
});

describe("seed and call lifecycle", () => {
  test("caller-only setup never invents a family contact or allows an alert destination", async () => {
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, {
      callerPhone: seed.callerPhone,
      familyPhone: "",
    });
    const context = await t.query(internal.households.lookup, {
      callerPhone: seed.callerPhone,
    });
    expect(context?.household.familyContacts).toEqual([]);
    expect(context?.facts).toHaveLength(5);
    await expect(
      t.mutation(internal.alerts.create, {
        householdId,
        type: "scam",
        message: "Test alert",
        recipient: seed.familyPhone,
      }),
    ).rejects.toThrow("Recipient is not an approved family contact");
  });
  test("seed is repeatable and reset restores five evidenced facts without duplicates", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.seed.demo, seed);
    expect(await t.mutation(internal.seed.demo, seed)).toEqual({
      ...first,
      created: false,
    });
    const context = await t.query(internal.households.lookup, {
      callerPhone: seed.callerPhone,
    });
    expect(context?.household.sharing).toEqual({
      chatTranscripts: false,
      moodNotes: false,
    });
    expect(context?.facts).toHaveLength(5);
    expect(context?.followups[0].speakable).toBe(
      "How did Lily's recital go on Saturday?",
    );
    for (const fact of context!.facts) {
      const evidence = await t.run((ctx) =>
        ctx.db
          .query("turns")
          .withIndex("by_call", (q) => q.eq("callId", fact.sourceCallId))
          .collect(),
      );
      expect(evidence.some((turn) => turn.text === fact.evidence)).toBe(true);
    }
    await t.mutation(internal.seed.demo, { ...seed, reset: true });
    expect(
      await t.run((ctx) => ctx.db.query("households").collect()),
    ).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("turns").collect())).toHaveLength(
      5,
    );
  });
  test("caller lookup creates one call on retries; unknown numbers never get demo context", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.demo, seed);
    const body = {
      callerPhone: seed.callerPhone,
      providerCallId: "provider-1",
    };
    const first = await (
      await request(t, "/agent/household", body, AGENT)
    ).json();
    const retry = await (
      await request(t, "/agent/household", body, AGENT)
    ).json();
    expect(first.callId).toBe(retry.callId);
    expect(first.context.household.callerPhone).toBe(seed.callerPhone);
    expect(
      (
        await request(
          t,
          "/agent/household",
          { ...body, callerPhone: "+14155550199" },
          AGENT,
        )
      ).status,
    ).toBe(400);
    const unknown = await (
      await request(
        t,
        "/agent/household",
        { callerPhone: "+14155550199", providerCallId: "unknown-1" },
        AGENT,
      )
    ).json();
    expect(unknown.context).toBeNull();
  });
  test("turn writes and call-end retries are idempotent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.demo, seed);
    const { callId } = await (
      await request(
        t,
        "/agent/household",
        { callerPhone: seed.callerPhone, providerCallId: "c-1" },
        AGENT,
      )
    ).json();
    const turn = {
      callId,
      idx: 0,
      speaker: "user",
      text: "Hello",
      at: Date.now(),
      timings: {},
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const first = await (await request(t, "/agent/turn", turn, AGENT)).json();
    expect(await (await request(t, "/agent/turn", turn, AGENT)).json()).toEqual(
      first,
    );
    expect(
      (await request(t, "/agent/call-end", { callId }, AGENT)).status,
    ).toBe(200);
    const ended = await t.run((ctx) => ctx.db.get(callId as Id<"calls">));
    await request(t, "/agent/call-end", { callId }, AGENT);
    expect(
      (await t.run((ctx) => ctx.db.get(callId as Id<"calls">)))?.endedAt,
    ).toBe(ended?.endedAt);
  });
});

describe("family privacy", () => {
  test("every family query rejects unauthenticated and unrelated identities", async () => {
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    const context = await t.query(internal.households.lookup, {
      callerPhone: seed.callerPhone,
    });
    for (const client of [t, t.withIdentity({ subject: "stranger" })]) {
      await expect(
        client.query(api.households.get, { householdId }),
      ).rejects.toThrow();
      await expect(
        client.query(api.calls.list, { householdId }),
      ).rejects.toThrow();
      await expect(
        client.query(api.orders.list, { householdId }),
      ).rejects.toThrow();
      await expect(
        client.query(api.alerts.list, { householdId }),
      ).rejects.toThrow();
      await expect(
        client.query(api.memory.list, { householdId }),
      ).rejects.toThrow();
      await expect(
        client.query(api.calls.transcript, {
          callId: context!.facts[0].sourceCallId,
        }),
      ).rejects.toThrow();
    }
    const family = t.withIdentity({ subject: "dana" });
    expect(await family.query(api.memory.list, { householdId })).toHaveProperty(
      "facts",
    );
    expect(
      await family.query(api.calls.transcript, {
        callId: context!.facts[0].sourceCallId,
      }),
    ).toEqual({ shared: false, turns: [] });
    await t.run((ctx) =>
      ctx.db.patch(householdId, {
        sharing: { chatTranscripts: true, moodNotes: false },
      }),
    );
    expect(
      (
        await family.query(api.calls.transcript, {
          callId: context!.facts[0].sourceCallId,
        })
      ).turns,
    ).toHaveLength(5);
  });
});

describe("alert calls", () => {
  test("outbound request carries scoped variables; polling records answered", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    vi.stubEnv("CARTESIA_API_KEY", "cartesia-test-credential");
    vi.stubEnv("ALERT_AGENT_ID", "test-agent");
    vi.stubEnv("ALERT_FROM_NUMBER_ID", "test-number");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outbound_calls: [{ agent_call_id: "provider-alert" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "completed" })),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await t.action(internal.alerts.call, {
      householdId,
      type: "scam",
      message: "Test warning",
      recipient: seed.familyPhone,
    });
    expect(result.delivery).toBe("ringing");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/agents/calls");
    const payload = JSON.parse(options.body);
    expect(payload.outbound_calls[0]).toMatchObject({
      to_number: seed.familyPhone,
      from_number_id: "test-number",
      ringing_timeout_seconds: 30,
      dynamic_variables: {
        type: "scam",
        summary: "Test warning",
        alertId: result.alertId,
      },
    });
    expect(options.headers.Authorization).toBeUndefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const alert = await t.run((ctx) =>
      ctx.db.get(result.alertId as Id<"alerts">),
    );
    expect(alert?.delivery).toBe("answered");
  });
  test("unanswered calls remain unacknowledged and are not redialed", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    vi.stubEnv("CARTESIA_API_KEY", "cartesia-test-credential");
    vi.stubEnv("ALERT_AGENT_ID", "test-agent");
    vi.stubEnv("ALERT_FROM_NUMBER_ID", "test-number");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agent_call_id: "provider-alert" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "no_answer" })),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await t.action(internal.alerts.call, {
      householdId,
      type: "wellbeing",
      message: "Test warning",
      recipient: seed.familyPhone,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const alert = await t.run((ctx) =>
      ctx.db.get(result.alertId as Id<"alerts">),
    );
    expect(alert?.delivery).toBe("no_answer");
    expect(alert?.acknowledgedAt).toBeUndefined();
    expect(
      fetch.mock.calls.filter(([, options]) => options.method === "POST"),
    ).toHaveLength(1);
  });
  test("dashboard-only alerts never call Cartesia", async () => {
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await t.action(internal.alerts.call, {
      householdId,
      type: "order_placed",
      message: "Test order",
      recipient: seed.familyPhone,
    });
    expect(result.delivery).toBe("sent");
    expect(fetch).not.toHaveBeenCalled();
  });
  test("failure retains an unacknowledged alert; arbitrary phone destinations are rejected", async () => {
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    vi.stubEnv("CARTESIA_API_KEY", "");
    const result = await t.action(internal.alerts.call, {
      householdId,
      type: "scam",
      message: "Test warning",
      recipient: seed.familyPhone,
    });
    expect(result.delivery).toBe("failed");
    expect(
      (await t.run((ctx) => ctx.db.query("alerts").first()))?.acknowledgedAt,
    ).toBeUndefined();
    await expect(
      t.action(internal.alerts.call, {
        householdId,
        type: "scam",
        message: "Test",
        recipient: "+14155550199",
      }),
    ).rejects.toThrow();
  });
  test("first spoken approval wins; it never charges money", async () => {
    const t = convexTest(schema, modules);
    const { householdId } = await t.mutation(internal.seed.demo, seed);
    const alertId = await t.mutation(internal.alerts.create, {
      householdId,
      type: "approval_needed",
      message: "Test approval",
      recipient: seed.familyPhone,
    });
    expect(
      (
        await request(
          t,
          "/alert/decision",
          { alertId, decision: "approved" },
          ALERT,
        )
      ).status,
    ).toBe(200);
    const second = await (
      await request(
        t,
        "/alert/decision",
        { alertId, decision: "declined" },
        ALERT,
      )
    ).json();
    expect(second).toMatchObject({
      decision: "approved",
      alreadyResolved: true,
    });
    await t.mutation(internal.alerts.updateDelivery, {
      alertId,
      delivery: "ringing",
    });
    expect(
      (await t.query(internal.alerts.getInternal, { alertId }))?.delivery,
    ).toBe("answered");
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([]);
  });
});
