import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { orderItem } from "./schema";
import type { OrderResult } from "./orders";
import type { Id } from "./_generated/dataModel";

export type PaymentRequest = {
  orderId: string;
  amountCents: number;
  idempotencyKey: string;
  merchantName?: string;
};
export type PaymentResult =
  | { ok: true; tokenRef: string }
  | { ok: false; error: string };

/**
 * #44 fallback rail. Moves no money; returns an opaque token reference.
 * Set Convex env MOCK_PAYMENT_FAIL=1 to force a decline (tests, demo rehearsal).
 * Exported as an object so tests can observe invocations.
 */
export const mockRail = {
  async pay(_request: PaymentRequest): Promise<PaymentResult> {
    if (process.env.MOCK_PAYMENT_FAIL === "1")
      return { ok: false, error: "Mock rail declined (MOCK_PAYMENT_FAIL=1)" };
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return {
      ok: true,
      tokenRef: `mock_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    };
  },
};

async function pay(
  ctx: ActionCtx,
  request: PaymentRequest,
): Promise<PaymentResult> {
  const rail = (process.env.PAYMENT_RAIL || "mock").trim().toLowerCase();
  try {
    if (rail === "mock") return await mockRail.pay(request);
    // Contract with the VISA agent (visaRail.ts): {ok:true,tokenRef} | {ok:false,error}.
    if (rail === "visa")
      return await ctx.runAction(internal.visaRail.pay, request);
    return { ok: false, error: `Unknown PAYMENT_RAIL "${rail.slice(0, 20)}"` };
  } catch (error) {
    // A thrown rail is a failed payment, never a silent success.
    console.warn(`payments: rail "${rail}" threw for order ${request.orderId}`);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Payment rail error",
    };
  }
}

/**
 * place_order (SPEC §10.3, §10.6): reserve (hard rule, scam hold, limits) -> rail -> settle.
 * The only path that moves money. Limits live in reserve, never in a rail.
 */
export const placeOrder = internalAction({
  args: {
    callId: v.id("calls"),
    idempotencyKey: v.string(),
    store: v.string(),
    items: v.array(orderItem),
  },
  handler: async (ctx, args): Promise<OrderResult> => {
    const reserved = await ctx.runMutation(internal.orders.reserve, args);
    const result = reserved.result as OrderResult;
    // Only the request that created the pending order holds the payment claim. Retries
    // (including after a crash between rail and settle) get `processing`, never a second charge.
    if (!reserved.claimed || result.status !== "processing") return result;
    const orderId = result.orderId as Id<"orders">;
    const payment = await pay(ctx, {
      orderId,
      amountCents: result.totalCents,
      idempotencyKey: args.idempotencyKey,
      merchantName: args.store.trim(), // reserve validated it
    });
    if (!payment.ok)
      console.warn(
        `payments: order ${orderId} failed: ${payment.error.slice(0, 200)}`,
      );
    const settled: OrderResult = await ctx.runMutation(internal.orders.settle, {
      orderId,
      payment,
    });
    if (!settled) throw new ConvexError("Order could not be settled");
    return settled;
  },
});

/**
 * #92 APR-4: pay an order the family approved. Scheduled once by the approval; the claim
 * mutation makes a second run (or a race) a no-op, so an approval never pays twice.
 */
export const payApproved = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<OrderResult | null> => {
    const claim = await ctx.runMutation(internal.orders.claimApproved, {
      orderId,
    });
    if (!claim) return null;
    const payment = await pay(ctx, {
      orderId,
      amountCents: claim.totalCents,
      idempotencyKey: claim.idempotencyKey,
      merchantName: claim.store,
    });
    if (!payment.ok)
      console.warn(
        `payments: approved order ${orderId} failed: ${payment.error.slice(0, 200)}`,
      );
    return await ctx.runMutation(internal.orders.settleApproved, {
      orderId,
      payment,
    });
  },
});
