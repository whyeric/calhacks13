import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authorized } from "./auth";
import { ConvexError } from "convex/values";

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
  "/agent/forget",
  "/agent/alert",
  "/agent/call-end",
  "/alert/decision",
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
          case "/agent/alert":
            return json(await ctx.runAction(internal.alerts.call, body));
          case "/alert/decision":
            return json(
              await ctx.runMutation(internal.alerts.recordDecision, body),
            );
          // Implementations belong to #23 and #47; neither can silently claim success.
          case "/agent/order":
          case "/agent/forget":
            return json({ error: "Not implemented in Foundations" }, 501);
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
