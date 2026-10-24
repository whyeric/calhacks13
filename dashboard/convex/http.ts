import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authorized } from "./auth";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

for (const path of [
  "/agent/household",
  "/agent/turn",
  "/agent/order",
  "/agent/order-status",
  "/agent/followup",
  "/agent/forget",
  "/agent/connect",
  "/agent/wellbeing",
  "/agent/alert",
  "/agent/call-end",
  "/agent/scam",
  "/alert/decision",
  // Milestone 7 stretch: #55 order status, #60 check-ins, #65 spoken PIN.
  "/agent/recent-orders",
  "/agent/checkin-start",
  "/agent/checkins-stop",
  "/agent/pin-check",
  "/agent/pin-verify",
]) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (
        !(await authorized(
          request,
          path === "/alert/decision" ? "alert" : "agent",
        ))
      )
        return json({ error: "Unauthorized" }, 401);
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 65536)
          return json({ error: "Request too large" }, 413);
        body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error();
      } catch {
        return json({ error: "Expected a JSON object" }, 400);
      }
      try {
        switch (path) {
          case "/agent/household": {
            const { callerPhone, providerCallId } = body;
            if (
              typeof callerPhone !== "string" ||
              !/^\+[1-9]\d{7,14}$/.test(callerPhone)
            )
              return json({ error: "Invalid callerPhone" }, 400);
            const context = await ctx.runQuery(internal.households.lookup, {
              callerPhone,
              now: Date.now(),
            });
            const callId =
              providerCallId === undefined
                ? null
                : await ctx.runMutation(internal.households.startCall, {
                    callerPhone,
                    providerCallId,
                  });
            return json({ context, callId });
          }
          case "/agent/turn":
            return json({
              turnId: await ctx.runMutation(internal.calls.logTurn, body),
            });
          case "/agent/call-end":
            return json(await ctx.runMutation(internal.calls.end, body));
          // #5/#10/#24: per-turn scam scores and guard holds (validated by scam.record).
          case "/agent/scam":
            return json(await ctx.runMutation(internal.scam.record, body));
          case "/agent/alert":
            return json(await ctx.runAction(internal.alerts.call, body));
          case "/alert/decision":
            return json(
              await ctx.runMutation(internal.alerts.recordDecision, body),
            );
          case "/agent/order": {
            const { callId, idempotencyKey, store, items } = body;
            if (
              typeof callId !== "string" ||
              typeof idempotencyKey !== "string" ||
              typeof store !== "string" ||
              !Array.isArray(items) ||
              items.length > 20 ||
              !items.every(
                (item: unknown) =>
                  !!item &&
                  typeof item === "object" &&
                  typeof (item as Record<string, unknown>).name === "string" &&
                  typeof (item as Record<string, unknown>).storeItemId ===
                    "string" &&
                  typeof (item as Record<string, unknown>).qty === "number" &&
                  typeof (item as Record<string, unknown>).priceCents ===
                    "number",
              )
            )
              return json({ error: "Invalid order request" }, 400);
            // Only the four contract fields per item reach the money path; a client total is ignored.
            return json(
              await ctx.runAction(internal.payments.placeOrder, {
                // Validated as an Id by the internal function's validator.
                callId: callId as Id<"calls">,
                idempotencyKey,
                store,
                items: items.map((item: Record<string, unknown>) => ({
                  name: item.name as string,
                  storeItemId: item.storeItemId as string,
                  qty: item.qty as number,
                  priceCents: item.priceCents as number,
                })),
              }),
            );
          }
          // #92: polled by the agent while the caller holds for a family decision.
          case "/agent/order-status": {
            const { callId, orderId } = body;
            if (typeof callId !== "string" || typeof orderId !== "string")
              return json({ error: "Invalid order-status request" }, 400);
            return json(
              await ctx.runQuery(internal.orders.statusForAgent, {
                callId: callId as Id<"calls">,
                orderId: orderId as Id<"orders">,
              }),
            );
          }
          // #55 order_status: the household's newest orders, read fresh (read-only).
          case "/agent/recent-orders": {
            const { callId } = body;
            if (typeof callId !== "string")
              return json({ error: "Invalid recent-orders request" }, 400);
            return json(
              await ctx.runQuery(internal.orderStatus.recentForCall, {
                callId: callId as Id<"calls">,
              }),
            );
          }
          // #60: the agent answered an outbound check-in call it placed.
          case "/agent/checkin-start": {
            const { providerCallId, calledPhone, checkinId } = body;
            if (
              typeof providerCallId !== "string" ||
              typeof calledPhone !== "string" ||
              !/^\+[1-9]\d{7,14}$/.test(calledPhone) ||
              (checkinId !== undefined && typeof checkinId !== "string")
            )
              return json({ error: "Invalid checkin-start request" }, 400);
            const started = await ctx.runMutation(
              internal.checkins.startForAgent,
              { providerCallId, calledPhone, checkinId },
            );
            if (!started) return json({ context: null, callId: null });
            const context = await ctx.runQuery(internal.households.lookup, {
              callerPhone: started.callerPhone,
              now: Date.now(),
            });
            return json({
              context,
              callId: started.callId,
              checkin: started.checkin,
            });
          }
          // #60 stop_checkins: the caller asked for no more check-in calls.
          case "/agent/checkins-stop": {
            const { callId } = body;
            if (typeof callId !== "string")
              return json({ error: "Invalid checkins-stop request" }, 400);
            return json(
              await ctx.runMutation(internal.checkins.stopForCall, {
                callId: callId as Id<"calls">,
              }),
            );
          }
          // #65: should an unknown number be asked for a spoken PIN?
          case "/agent/pin-check": {
            const { callerPhone } = body;
            if (
              typeof callerPhone !== "string" ||
              !/^\+[1-9]\d{7,14}$/.test(callerPhone)
            )
              return json({ error: "Invalid callerPhone" }, 400);
            return json(
              await ctx.runMutation(internal.pin.check, { callerPhone }),
            );
          }
          // #65: check the spoken PIN; on success return the household context.
          case "/agent/pin-verify": {
            const { callId, pin } = body;
            if (
              typeof callId !== "string" ||
              typeof pin !== "string" ||
              pin.length > 32
            )
              return json({ error: "Invalid pin-verify request" }, 400);
            const result = await ctx.runMutation(internal.pin.verify, {
              callId: callId as Id<"calls">,
              pin,
            });
            if (result.status !== "ok") return json(result);
            const context = await ctx.runQuery(internal.households.lookup, {
              callerPhone: result.callerPhone,
              now: Date.now(),
            });
            return json({ status: "ok", context });
          }
          case "/agent/followup": {
            const { callId, followupId } = body;
            if (typeof callId !== "string" || typeof followupId !== "string")
              return json({ error: "Invalid followup request" }, 400);
            return json(
              await ctx.runMutation(internal.memory.followupAsked, {
                callId: callId as Id<"calls">,
                followupId: followupId as Id<"followups">,
              }),
            );
          }
          // Implementation belongs to #47 (Phase 2); it cannot silently claim success.
          // #47 forget_fact (MEM-5).
          case "/agent/forget": {
            const { callId, description } = body;
            if (typeof callId !== "string" || typeof description !== "string")
              return json({ error: "Invalid forget request" }, 400);
            return json(
              await ctx.runMutation(internal.memory.forgetForCall, {
                callId: callId as Id<"calls">,
                description,
              }),
            );
          }
          // #63 connect_family (CMP-4); consent is checked from the logged transcript.
          case "/agent/connect": {
            const { callId, contact, message } = body;
            if (
              typeof callId !== "string" ||
              typeof contact !== "string" ||
              typeof message !== "string"
            )
              return json({ error: "Invalid connect request" }, 400);
            return json(
              await ctx.runAction(internal.companion.connect, {
                callId: callId as Id<"calls">,
                contact: contact.slice(0, 100),
                message: message.slice(0, 500),
              }),
            );
          }
          // #73 #76 raise_wellbeing_alert, from the model, the classifier or a refusal.
          case "/agent/wellbeing": {
            const { callId, level, summary, source } = body;
            if (
              typeof callId !== "string" ||
              !["emergency", "crisis", "concern"].includes(level) ||
              typeof summary !== "string" ||
              (source !== undefined &&
                !["model", "classifier", "refusal"].includes(source))
            )
              return json({ error: "Invalid wellbeing request" }, 400);
            return json(
              await ctx.runAction(internal.companion.wellbeing, {
                callId: callId as Id<"calls">,
                level,
                summary: summary.slice(0, 1000),
                ...(source ? { source } : {}),
              }),
            );
          }
        }
      } catch (error) {
        if (error instanceof ConvexError)
          return json({ error: String(error.data) }, 400);
        // Do not return provider responses, credentials or transcripts in errors.
        return json({ error: "Request could not be processed" }, 400);
      }
      return json({ error: "Not found" }, 404);
    }),
  });
}

export default http;
