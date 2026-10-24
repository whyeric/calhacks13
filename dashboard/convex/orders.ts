import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { orderItem } from "./schema";
import { requireFamily } from "./auth";
import { actorArgs, resolveActor, resolveHousehold } from "./access";
import { catalogItem, liveItemPricesAllowed } from "./catalog";
import { armHold } from "./scam";

export type OrderStatus = Doc<"orders">["status"];
export type OrderItem = Doc<"orders">["items"][number];
export type OrderResult =
  | {
      status: "paid";
      orderId: Id<"orders">;
      totalCents: number;
      paymentRef: string;
    }
  | {
      status: "needs_approval";
      orderId: Id<"orders">;
      totalCents: number;
      reason: string;
    }
  | { status: "blocked"; reason: string; orderId?: Id<"orders"> }
  | { status: "failed"; orderId: Id<"orders">; reason: string }
  // A payment for this order is already in flight (or its outcome is unknown). Never pay again.
  | { status: "processing"; orderId: Id<"orders">; totalCents: number };

export const MAX_ITEMS = 20;
export const MAX_QTY = 20;
const MAX_PRICE_CENTS = 10_000_000; // $100,000: well beyond any grocery line; keeps totals safe integers.
const RECENT_WINDOW_MS = 90 * 86_400_000;

// SPEC §13: pending -> awaiting_approval -> approved/declined -> paid/failed.
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["awaiting_approval", "paid", "failed"],
  awaiting_approval: ["approved", "declined"],
  approved: ["paid", "failed"],
  declined: [],
  paid: [],
  failed: [],
};
export function canTransition(from: OrderStatus, to: OrderStatus) {
  return TRANSITIONS[from].includes(to);
}

// SCM-2 hard rule. Deterministic; nothing the model or caller says changes it.
const HARD_RULE = [
  /\be ?gift ?cards?\b/,
  /\bgift ?cards?\b/,
  /\bgiftcards?\b/,
  /\bgift ?certificates?\b/,
  /\bprepaid\b/,
  /\bre ?loadable\b/,
  /\breload ?(card|pack)s?\b/,
  /\b(itunes|google play|steam|app store|xbox|playstation|psn|razer gold|amazon|apple|target|walmart|ebay|visa|mastercard|amex) (card|cards|code|codes|credit)\b/,
  /\bsteam wallet\b/,
  /\bvanilla (visa|mastercard|gift|prepaid|reload)\b/,
  /\b(green ?dot|netspend|paysafe ?card|moneypak|money ?pak)\b/,
  /\b(wire transfers?|wire money|wiring money|bank wires?|money wires?)\b/,
  /\bmoney (transfer|transfers|order|orders|gram)\b/,
  /\bwestern ?union\b/,
  /\bmoneygram\b/,
  /\b(crypto|cryptocurrency|cryptocurrencies|bitcoin|bitcoins|btc|ethereum|ether|litecoin|dogecoin|usdt|usdc|tether|stablecoin)\b/,
  /\bbitcoin atm\b/,
  /\b(zelle|venmo|cash ?app|paypal) (transfer|payment|card|cash)\b/,
];
// Common Cyrillic/Greek/Latin look-alikes of ASCII letters (after NFKD and lowercasing).
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ӏ: "l",
  ү: "y",
  һ: "h",
  ҫ: "c",
  // Greek
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  ς: "c",
  τ: "t",
  υ: "u",
  χ: "x",
  ϲ: "c",
  ϳ: "j",
  // Latin letters NFKD leaves alone
  ı: "i",
  ȷ: "j",
  ł: "l",
  ø: "o",
  đ: "d",
  ħ: "h",
  ɡ: "g",
  ɑ: "a",
  ɩ: "i",
  ß: "ss",
  æ: "ae",
  œ: "oe",
};

/**
 * Fold text to ASCII so look-alike characters cannot slip past the hard rule:
 * NFKD (full-width, ligatures, accents), drop combining marks and invisible format
 * characters, lowercase, then map Cyrillic/Greek confusables. Returns null if any
 * non-ASCII letter survives (an unexpected script is rejected, not guessed at).
 */
export function foldToAscii(text: string): string | null {
  const folded = Array.from(
    text
      .normalize("NFKD")
      .replace(/[\p{M}\p{Cf}]/gu, "")
      .toLowerCase(),
    (ch) => CONFUSABLES[ch] ?? ch,
  ).join("");
  return /(?![\x00-\x7f])\p{L}/u.test(folded) ? null : folded;
}

const normalize = (text: string) =>
  (foldToAscii(text) ?? text.normalize("NFKD").toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function hardRuleViolation(
  items: { name: string; storeItemId: string }[],
) {
  for (const item of items) {
    for (const text of [item.name, item.storeItemId]) {
      const normalized = normalize(text);
      if (HARD_RULE.some((re) => re.test(normalized))) return item.name;
    }
  }
  return null;
}

export const dollars = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

/** Epoch ms of the first instant of the current calendar month in `timeZone` (UTC on a bad zone). */
export function monthStart(now: number, timeZone: string) {
  const partsAt = (t: number) => {
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    }
    const p = Object.fromEntries(
      fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]),
    );
    return p as Record<string, number>;
  };
  const offsetAt = (t: number) => {
    const p = partsAt(t);
    const asUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour % 24,
      p.minute,
      p.second,
    );
    return asUtc - Math.floor(t / 1000) * 1000;
  };
  const local = partsAt(now);
  const wallStart = Date.UTC(local.year, local.month - 1, 1);
  let guess = wallStart - offsetAt(wallStart);
  guess = wallStart - offsetAt(guess);
  return guess;
}

function validateRequest(args: {
  callId: string;
  idempotencyKey: string;
  store: string;
  items: OrderItem[];
}) {
  const bad = (message: string) => {
    throw new ConvexError(message);
  };
  if (
    args.idempotencyKey.length > 300 ||
    !args.idempotencyKey.startsWith(`${args.callId}:`) ||
    args.idempotencyKey.length <= args.callId.length + 1
  )
    bad("idempotencyKey must be '<callId>:<toolUseId>'");
  const store = args.store.trim();
  if (!store || store.length > 100) bad("Invalid store");
  if (args.items.length < 1 || args.items.length > MAX_ITEMS)
    bad(`An order needs 1 to ${MAX_ITEMS} items`);
  let total = 0;
  const items = args.items.map((item) => {
    const name = item.name.trim();
    const storeItemId = item.storeItemId.trim();
    if (!name || name.length > 200 || foldToAscii(name) === null)
      bad("Invalid item name");
    if (
      !storeItemId ||
      storeItemId.length > 200 ||
      foldToAscii(storeItemId) === null
    )
      bad("Invalid storeItemId");
    if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > MAX_QTY)
      bad(`qty must be a whole number from 1 to ${MAX_QTY}`);
    if (
      !Number.isSafeInteger(item.priceCents) ||
      item.priceCents < 0 ||
      item.priceCents > MAX_PRICE_CENTS
    )
      bad("priceCents must be a whole number of cents");
    return { name, storeItemId, qty: item.qty, priceCents: item.priceCents };
  });
  return { store, items };
}

/**
 * Price the order server-side. Catalog items take the catalog's name and price; the
 * agent's are ignored. Unknown ids are rejected unless live prices are enabled.
 */
function priceItems(items: OrderItem[]) {
  let total = 0;
  const priced = items.map((item) => {
    const known = catalogItem(item.storeItemId);
    if (!known && !liveItemPricesAllowed(item.storeItemId))
      throw new ConvexError("Unknown item");
    const line = known
      ? { ...item, name: known.name, priceCents: known.priceCents }
      : item;
    total += line.qty * line.priceCents;
    return line;
  });
  if (!Number.isSafeInteger(total) || total <= 0)
    throw new ConvexError("Order total must be more than zero");
  return { items: priced, totalCents: total };
}

export const OUTCOME_RANK: Record<Doc<"calls">["outcome"], number> = {
  unknown_caller: -1,
  no_order: 0,
  ordered: 1,
  awaiting_approval: 2,
  declined_scam: 3,
};
async function noteCallOutcome(
  ctx: MutationCtx,
  call: Doc<"calls">,
  outcome: "ordered" | "awaiting_approval" | "declined_scam",
  extra: Partial<Doc<"calls">> = {},
) {
  const fresh = (await ctx.db.get(call._id)) ?? call;
  await ctx.db.patch(call._id, {
    ...extra,
    ...(fresh.kind === "chat" ? { kind: "order" as const } : {}),
    ...(OUTCOME_RANK[outcome] > OUTCOME_RANK[fresh.outcome] ? { outcome } : {}),
  });
}

async function dashboardAlert(
  ctx: MutationCtx,
  order: Doc<"orders">,
  type: "approval_needed" | "order_placed" | "payment_failed",
  message: string,
) {
  await ctx.db.insert("alerts", {
    householdId: order.householdId,
    callId: order.callId,
    orderId: order._id,
    type,
    channel: "dashboard",
    delivery: "sent",
    message: message.slice(0, 4000),
    recipient: "dashboard",
    sentAt: Date.now(),
  });
}

const describeItems = (items: OrderItem[]) =>
  items.map((i) => (i.qty > 1 ? `${i.qty} x ${i.name}` : i.name)).join(", ");

/** Rebuild the agent-facing result from a stored order (used for idempotent retries). */
export function resultFor(order: Doc<"orders">): OrderResult {
  switch (order.status) {
    case "paid":
      return {
        status: "paid",
        orderId: order._id,
        totalCents: order.totalCents,
        paymentRef: order.paymentTokenRef ?? "",
      };
    case "awaiting_approval":
    case "approved":
      return {
        status: "needs_approval",
        orderId: order._id,
        totalCents: order.totalCents,
        reason:
          order.status === "approved"
            ? "Your family approved this order; it is waiting to be paid."
            : (order.reason ?? "This order needs your family's approval."),
      };
    case "declined":
      return {
        status: "blocked",
        orderId: order._id,
        reason: "Your family declined this order, so I won't place it.",
      };
    case "failed":
      return {
        status: "failed",
        orderId: order._id,
        reason:
          order.reason ??
          "The payment didn't go through, so nothing was charged.",
      };
    case "pending":
      // Every pending order was claimed for payment by the request that created it.
      return {
        status: "processing",
        orderId: order._id,
        totalCents: order.totalCents,
      };
  }
}

const SCAM_HOLD_REASON =
  "This call is on a scam hold, so I can't place orders right now.";

/**
 * Step 1 of place_order (SPEC §10.6). In one transaction: idempotency, hard scam rule,
 * scam hold, server-side pricing, limits, then insert `pending` (to pay) or
 * `awaiting_approval`.
 *
 * Only the request that inserts a `pending` order gets `claimed: true`, and only a
 * claimed request may call the payment rail. Convex mutations are serializable, so two
 * concurrent requests with one idempotency key cannot both insert. A retry that finds a
 * pending (claimed, unsettled) order gets `processing` and never pays, even if the first
 * attempt crashed after the rail charged.
 */
export const reserve = internalMutation({
  args: {
    callId: v.id("calls"),
    idempotencyKey: v.string(),
    store: v.string(),
    items: v.array(orderItem),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_idempotencyKey", (q) =>
        q.eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) {
      if (existing.callId !== args.callId)
        throw new ConvexError("Idempotency key conflict");
      if (existing.status === "pending") {
        const call = await ctx.db.get(existing.callId);
        if (call?.scamHold.active)
          return {
            claimed: false,
            result: {
              status: "blocked",
              orderId: existing._id,
              reason: SCAM_HOLD_REASON,
            } as OrderResult,
          };
      }
      return { claimed: false, result: resultFor(existing) };
    }
    const { store, items: requested } = validateRequest(args);
    const call = await ctx.db.get(args.callId);
    if (!call) throw new ConvexError("Call not found");
    if (call.endedAt !== undefined) throw new ConvexError("Call has ended");
    if (!call.householdId)
      throw new ConvexError("Ordering needs a registered household");
    const household = await ctx.db.get(call.householdId);
    if (!household)
      throw new ConvexError("Ordering needs a registered household");

    // 1. Hard scam rule (SCM-2): gift cards, prepaid cards, wires, crypto.
    const flagged = hardRuleViolation(requested);
    if (flagged) {
      const reason = `I can't buy gift cards, prepaid cards, money transfers or cryptocurrency, so I won't order "${flagged}".`;
      await noteCallOutcome(ctx, call, "declined_scam");
      // #54/#24: arm the hold once and alert family, even if the agent's own check missed it.
      await armHold(ctx, call._id, {
        reason:
          "Hard rule: gift card, prepaid card, money transfer or crypto requested",
        hardRule: true,
        what: `an order for "${flagged.slice(0, 80)}"`,
      });
      return {
        claimed: false,
        result: { status: "blocked", reason } as OrderResult,
      };
    }
    // 2. Scam hold on this call.
    if (call.scamHold.active) {
      await noteCallOutcome(ctx, call, "declined_scam");
      return {
        claimed: false,
        result: { status: "blocked", reason: SCAM_HOLD_REASON } as OrderResult,
      };
    }
    // 3. Price from the server catalog; the agent's names and prices are ignored.
    const { items, totalCents } = priceItems(requested);
    // 4. Limits, read now so dashboard edits apply to the next order (LIM-3). Never from memory facts.
    const limits = await ctx.db
      .query("limits")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .unique();
    const reasons: string[] = [];
    const now = Date.now();
    if (!limits) {
      reasons.push(
        "No spending limits are set up yet, so your family needs to approve this order.",
      );
    } else {
      if (totalCents > limits.perOrderCapCents)
        reasons.push(
          `This order is ${dollars(totalCents)}, which is over your ${dollars(limits.perOrderCapCents)} per-order limit.`,
        );
      if (
        !limits.approvedStores.some(
          (s) => s.trim().toLowerCase() === store.toLowerCase(),
        )
      )
        reasons.push(`${store} isn't one of your approved stores.`);
      const start = monthStart(now, household.timezone);
      let spent = 0;
      for await (const order of ctx.db
        .query("orders")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .order("desc")) {
        if (order._creationTime < start && order.createdAt < start) break;
        // Paid plus in-flight money (pending reservations, approved-unpaid) counts against the budget.
        if (
          order.createdAt >= start &&
          ["paid", "pending", "approved"].includes(order.status)
        )
          spent += order.totalCents;
      }
      if (spent + totalCents > limits.monthlyBudgetCents)
        reasons.push(
          `This order would bring this month's spending to ${dollars(spent + totalCents)}, which is over your ${dollars(limits.monthlyBudgetCents)} monthly budget.`,
        );
    }
    const needsApproval = reasons.length > 0;
    const reason = needsApproval ? reasons.join(" ") : undefined;
    const orderId = await ctx.db.insert("orders", {
      householdId: household._id,
      callId: call._id,
      idempotencyKey: args.idempotencyKey,
      items,
      totalCents,
      store,
      status: needsApproval ? "awaiting_approval" : "pending",
      createdAt: now,
      ...(reason ? { reason } : { paymentClaimedAt: now }),
    });
    if (needsApproval) {
      const order = (await ctx.db.get(orderId))!;
      const summary = `${household.preferredName} asked for ${describeItems(items)} from ${store}, ${dollars(totalCents)} in total. ${reason}`;
      await dashboardAlert(ctx, order, "approval_needed", summary);
      // #92 APR-2: ring every family contact at once; the first spoken yes/no (or dashboard
      // button) wins. Each call gets its own `approval_needed` alert row with delivery status.
      for (const contact of household.familyContacts)
        await ctx.scheduler.runAfter(0, internal.alerts.call, {
          householdId: household._id,
          callId: call._id,
          orderId,
          type: "approval_needed",
          message: `${summary} Do you approve this order? Please say yes or no.`,
          recipient: contact.phone,
        });
      // docs/decisions/approval-wait.md: an open approval expires (declined, "system:expired").
      await ctx.scheduler.runAt(
        approvalDeadline(now, household.timezone),
        internal.orders.expireApproval,
        { orderId },
      );
      await noteCallOutcome(ctx, call, "awaiting_approval");
      return {
        claimed: false,
        result: {
          status: "needs_approval",
          orderId,
          totalCents,
          reason: reason!,
        } as OrderResult,
      };
    }
    return {
      claimed: true,
      result: { status: "processing", orderId, totalCents } as OrderResult,
    };
  },
});

/** Step 3 of place_order: first settlement wins; never regresses a terminal order. */
const paymentArg = v.union(
  v.object({ ok: v.literal(true), tokenRef: v.string() }),
  v.object({ ok: v.literal(false), error: v.string() }),
);

export const settle = internalMutation({
  args: { orderId: v.id("orders"), payment: paymentArg },
  handler: (ctx, { orderId, payment }) => settleOrder(ctx, orderId, payment),
});

async function settleOrder(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  payment: { ok: true; tokenRef: string } | { ok: false; error: string },
): Promise<OrderResult> {
  {
    const order = await ctx.db.get(orderId);
    if (!order) throw new ConvexError("Order not found");
    const next = payment.ok ? "paid" : "failed";
    if (!canTransition(order.status, next)) {
      const current = resultFor(order);
      if (current.status === "processing")
        throw new ConvexError("Invalid order transition");
      return current;
    }
    const household = await ctx.db.get(order.householdId);
    const name = household?.preferredName ?? "The caller";
    if (payment.ok) {
      await ctx.db.patch(orderId, {
        status: "paid",
        paymentTokenRef: payment.tokenRef.slice(0, 200),
        paidAt: Date.now(),
      });
      await dashboardAlert(
        ctx,
        order,
        "order_placed",
        `${name} ordered ${describeItems(order.items)} from ${order.store}, ${dollars(order.totalCents)} in total.`,
      );
      const call = await ctx.db.get(order.callId);
      if (call) await noteCallOutcome(ctx, call, "ordered");
      return {
        status: "paid",
        orderId,
        totalCents: order.totalCents,
        paymentRef: payment.tokenRef.slice(0, 200),
      };
    }
    const reason = "The payment didn't go through, so nothing was charged.";
    await ctx.db.patch(orderId, { status: "failed", reason });
    await dashboardAlert(
      ctx,
      order,
      "payment_failed",
      // Fixed text: raw rail errors can carry provider details and stay in server logs.
      `Payment failed for ${name}'s order from ${order.store} (${describeItems(order.items)}, ${dollars(order.totalCents)}). Nothing was charged. The payment service declined or could not be reached.`,
    );
    return { status: "failed", orderId, reason };
  }
}

/** The person's first name from an audit string ("Dana (dashboard)" -> "Dana"). */
function firstName(by: string) {
  return (
    by
      .replace(/\s*\(.*\)\s*$/, "")
      .trim()
      .split(/\s+/)[0] || "Your family"
  );
}

/**
 * Next-call opener with the approval outcome (docs/decisions/approval-wait.md, step 5).
 * Only when the call has ended: a caller still holding hears the outcome live.
 */
async function approvalFollowup(
  ctx: MutationCtx,
  order: Doc<"orders">,
  outcome: "paid" | "failed" | "declined" | "expired",
  by: string | null,
) {
  const call = await ctx.db.get(order.callId);
  if (!call || call.endedAt === undefined) return;
  const who = by ? firstName(by) : "your family";
  const what = `your order of ${describeItems(order.items)}`;
  const speakable = {
    paid: `${who} said yes to ${what}, and it's on its way.`,
    failed: `${who} said yes to ${what}, but the payment didn't go through, so nothing was charged.`,
    declined: `${who} decided to hold off on ${what}, so nothing was ordered or charged.`,
    expired: `Nobody approved ${what} in time, so nothing was ordered or charged.`,
  }[outcome];
  await ctx.db.insert("followups", {
    householdId: order.householdId,
    speakable: speakable.charAt(0).toUpperCase() + speakable.slice(1),
    sourceCallId: order.callId,
    notBefore: Date.now(),
    status: "open",
  });
}

/**
 * When an open approval lapses: the shorter of 12 hours and the next 9 pm in the household's
 * timezone, but never sooner than 30 minutes (docs/decisions/approval-wait.md).
 */
export function approvalDeadline(now: number, timeZone: string) {
  const HOUR = 3_600_000;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(now));
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(now));
  }
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight =
    ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  let untilNine = 21 * HOUR - sinceMidnight;
  if (untilNine <= 0) untilNine += 24 * HOUR;
  return now + Math.min(12 * HOUR, Math.max(HOUR / 2, untilNine));
}

export async function decide(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  by: string,
  outcome: "approved" | "declined",
  options: { reason?: string; expired?: boolean } = {},
) {
  const who = by.trim();
  if (!who || who.length > 200) throw new ConvexError("Invalid decider");
  const order = await ctx.db.get(orderId);
  if (!order) throw new ConvexError("Order not found");
  if (!canTransition(order.status, outcome)) {
    // APR-3: the first decision wins; later ones report what happened.
    return {
      orderId,
      status: order.status,
      decidedBy: order.approvedBy ?? order.declinedBy ?? null,
      alreadyResolved: true,
    };
  }
  const decidedAt = Date.now();
  await ctx.db.patch(orderId, {
    status: outcome,
    decidedAt,
    ...(outcome === "approved" ? { approvedBy: who } : { declinedBy: who }),
    ...(options.reason ? { reason: options.reason } : {}),
  });
  for await (const alert of ctx.db
    .query("alerts")
    .withIndex("by_orderId", (q) => q.eq("orderId", orderId))) {
    if (alert.type === "approval_needed" && !alert.decision)
      await ctx.db.patch(alert._id, {
        decision: outcome,
        decidedAt,
        decidedBy: who,
      });
  }
  if (outcome === "approved")
    // APR-4: pay after approval. Scheduled once (this transition happens once), and the
    // action claims the order atomically before calling the rail.
    await ctx.scheduler.runAfter(0, internal.payments.payApproved, { orderId });
  else
    await approvalFollowup(
      ctx,
      order,
      options.expired ? "expired" : "declined",
      who,
    );
  return { orderId, status: outcome, decidedBy: who, alreadyResolved: false };
}

/** Operator/CLI decisions (`npx convex run orders:approve`). Approval schedules payment. */
export const approve = internalMutation({
  args: { orderId: v.id("orders"), by: v.string() },
  handler: (ctx, { orderId, by }) => decide(ctx, orderId, by, "approved"),
});
export const decline = internalMutation({
  args: { orderId: v.id("orders"), by: v.string() },
  handler: (ctx, { orderId, by }) => decide(ctx, orderId, by, "declined"),
});

/** Approval validity ran out with no decision: decline as a system decision. */
export const expireApproval = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (order?.status !== "awaiting_approval") return null;
    await decide(ctx, orderId, "system:expired", "declined", {
      reason: "No one approved this order in time, so it was not placed.",
      expired: true,
    });
    return null;
  },
});

/**
 * Step 1 of paying an approved order: claim it (once) for the rail. Returns what the rail
 * needs, or null when it is not approved or another attempt already claimed it.
 */
export const claimApproved = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "approved" || order.paymentClaimedAt)
      return null;
    await ctx.db.patch(orderId, { paymentClaimedAt: Date.now() });
    return {
      totalCents: order.totalCents,
      store: order.store,
      idempotencyKey: `${order.idempotencyKey}:approved`,
    };
  },
});

/** Step 3 of paying an approved order: settle, then leave a next-call opener if needed. */
export const settleApproved = internalMutation({
  args: { orderId: v.id("orders"), payment: paymentArg },
  handler: async (ctx, { orderId, payment }) => {
    const result = await settleOrder(ctx, orderId, payment);
    const order = await ctx.db.get(orderId);
    if (order && (order.status === "paid" || order.status === "failed"))
      await approvalFollowup(
        ctx,
        order,
        order.status,
        order.approvedBy ?? null,
      );
    return result;
  },
});

/**
 * #92: what the agent tells a caller holding for approval (polled via /agent/order-status).
 * Only the call that placed the order can read it.
 */
export const statusForAgent = internalQuery({
  args: { callId: v.id("calls"), orderId: v.id("orders") },
  handler: async (ctx, { callId, orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.callId !== callId)
      throw new ConvexError("Order not found for this call");
    const by = order.approvedBy ?? order.declinedBy ?? null;
    return {
      orderId,
      status: order.status,
      totalCents: order.totalCents,
      items: describeItems(order.items),
      reason: order.reason ?? null,
      // First name of who decided, for "{family} said yes"; null for a system expiry.
      decidedBy: by && !by.startsWith("system:") ? firstName(by) : null,
      expired: by === "system:expired",
    };
  },
});

// ---------- Dashboard (family) actions, #93 / #95 ----------

const familyDecision = (outcome: "approved" | "declined") =>
  mutation({
    args: { ...actorArgs, orderId: v.id("orders") },
    handler: async (ctx, args) => {
      const household = await resolveHousehold(ctx, args);
      const order = await ctx.db.get(args.orderId);
      // Never reveal whether another household's order exists.
      if (!order || order.householdId !== household._id)
        throw new ConvexError("Order not found");
      const who = await resolveActor(ctx, household, args);
      return decide(ctx, args.orderId, who, outcome);
    },
  });

/** Approve button (APR-2/3). The first response, here or on an alert call, wins. */
export const familyApprove = familyDecision("approved");
/** Decline button (APR-2/3). */
export const familyDecline = familyDecision("declined");

/**
 * SCM-6 / test S2: a family member lifts the scam hold on a call. Logged with who and when.
 * It lifts the hold only: the hard rule (gift cards, prepaid cards, wires, crypto) in
 * `reserve` still blocks those items whatever the family says (SCM-2).
 */
export const overrideScamHold = mutation({
  args: {
    ...actorArgs,
    callId: v.id("calls"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    const call = await ctx.db.get(args.callId);
    if (!call || call.householdId !== household._id)
      throw new ConvexError("Call not found");
    const who = await resolveActor(ctx, household, args);
    const note = args.note?.trim().slice(0, 500) || undefined;
    if (!call.scamHold.active)
      return { callId: call._id, overridden: false, alreadyLifted: true };
    const overrides = call.scamOverrides ?? [];
    if (overrides.length >= 20)
      throw new ConvexError("Too many overrides on this call");
    await ctx.db.patch(call._id, {
      scamHold: { ...call.scamHold, active: false },
      scamOverrides: [
        ...overrides,
        {
          by: who,
          at: Date.now(),
          ...(call.scamHold.reason ? { holdReason: call.scamHold.reason } : {}),
          ...(note ? { note } : {}),
        },
      ],
    });
    return { callId: call._id, overridden: true, alreadyLifted: false };
  },
});

/** #49: up to 10 newest orders in the last 90 days, in a fixed compact shape (cache hygiene, §11.3). */
export async function recentOrders(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
) {
  const rows = await ctx.db
    .query("orders")
    .withIndex("by_household", (q) =>
      q
        .eq("householdId", householdId)
        .gte("_creationTime", now - RECENT_WINDOW_MS),
    )
    .order("desc")
    .take(10);
  return rows.map((o) => ({
    items: o.items.map((i) => ({
      name: i.name,
      qty: i.qty,
      priceCents: i.priceCents,
      storeItemId: i.storeItemId,
    })),
    totalCents: o.totalCents,
    store: o.store,
    status: o.status,
    createdAt: o.createdAt,
  }));
}

const SPEND_SCAN = 200;

export type SpendSummary = {
  paidOrders: number;
  typicalOrderCents: number | null;
  largestOrderCents: number | null;
  stores: string[];
};

/**
 * #49: compact usual-spend digest over paid orders in the last 90 days, for the memory
 * block and the scam guard's out-of-pattern check (SCM-4). Deterministic for identical data.
 */
export async function spendSummary(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<SpendSummary> {
  const rows = await ctx.db
    .query("orders")
    .withIndex("by_household", (q) =>
      q
        .eq("householdId", householdId)
        .gte("_creationTime", now - RECENT_WINDOW_MS),
    )
    .order("desc")
    .take(SPEND_SCAN);
  const paid = rows.filter((o) => o.status === "paid");
  const totals = paid.map((o) => o.totalCents).sort((a, b) => a - b);
  return {
    paidOrders: paid.length,
    // Lower median: an integer number of cents, no rounding.
    typicalOrderCents: totals.length
      ? totals[Math.floor((totals.length - 1) / 2)]
      : null,
    largestOrderCents: totals.length ? totals[totals.length - 1] : null,
    stores: [...new Set(paid.map((o) => o.store))].sort(),
  };
}

/**
 * SCM-4: an order is out of pattern when there is no paid history to compare with, or it
 * is more than twice the largest paid order in the window. A signal only; the hard rule
 * and limits in `reserve` decide what is paid.
 */
export function outOfPattern(summary: SpendSummary, totalCents: number) {
  return (
    summary.largestOrderCents === null ||
    totalCents > 2 * summary.largestOrderCents
  );
}

export const recent = internalQuery({
  args: { householdId: v.id("households"), now: v.number() },
  handler: (ctx, { householdId, now }) => recentOrders(ctx, householdId, now),
});

export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(100);
  },
});
