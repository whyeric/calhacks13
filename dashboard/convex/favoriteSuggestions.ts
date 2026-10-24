import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  accessArgs,
  actorArgs,
  resolveActor,
  resolveHousehold,
} from "./access";

/**
 * #71 (FAV-4): suggest new favorites from repeat orders. Suggestions go to the family on the
 * dashboard, never to the caller; a favorite is only created when a family member accepts.
 */

/** An item paid for in at least this many separate orders is suggested. */
export const REPEAT_THRESHOLD = 3;
const ORDER_SCAN = 200;
const MAX_SUGGESTIONS = 10;
const MAX_FAVORITES = 50;

const FILLER = new Set(["pack", "can", "big", "large", "small", "one", "the"]);

/** Spoken-style aliases from an item name: "Paper towels, 6-roll pack" -> "paper towels". */
export function suggestedAliases(name: string): string[] {
  const head = name.split(/[,(]/)[0].trim().toLowerCase();
  const words = head
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  const base = words.join(" ");
  const out = new Set<string>();
  if (base) {
    out.add(base);
    out.add(`my ${base}`);
    out.add(`usual ${base}`);
  }
  return [...out].slice(0, 5);
}

type Suggestion = {
  storeItemId: string;
  name: string;
  store: string;
  orders: number;
  usualQty: number;
  lastOrderedAt: number;
  aliases: string[];
};

async function computeSuggestions(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Suggestion[]> {
  const [orders, favorites] = await Promise.all([
    ctx.db
      .query("orders")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .order("desc")
      .take(ORDER_SCAN),
    ctx.db
      .query("favorites")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .take(MAX_FAVORITES),
  ]);
  const already = new Set(favorites.map((f) => f.storeItemId));
  const byItem = new Map<
    string,
    {
      name: string;
      store: string;
      orders: number;
      qty: Map<number, number>;
      last: number;
    }
  >();
  for (const order of orders as Doc<"orders">[]) {
    if (order.status !== "paid") continue;
    const seen = new Set<string>();
    for (const item of order.items) {
      if (already.has(item.storeItemId) || seen.has(item.storeItemId)) continue;
      seen.add(item.storeItemId);
      const entry = byItem.get(item.storeItemId) ?? {
        name: item.name,
        store: order.store,
        orders: 0,
        qty: new Map<number, number>(),
        last: 0,
      };
      entry.orders += 1;
      entry.qty.set(item.qty, (entry.qty.get(item.qty) ?? 0) + 1);
      entry.last = Math.max(entry.last, order.createdAt);
      byItem.set(item.storeItemId, entry);
    }
  }
  return [...byItem.entries()]
    .filter(([, e]) => e.orders >= REPEAT_THRESHOLD)
    .map(([storeItemId, e]) => ({
      storeItemId,
      name: e.name,
      store: e.store,
      orders: e.orders,
      // Most common quantity; ties go to the smaller one.
      usualQty: [...e.qty.entries()].sort(
        (a, b) => b[1] - a[1] || a[0] - b[0],
      )[0][0],
      lastOrderedAt: e.last,
      aliases: suggestedAliases(e.name),
    }))
    .sort(
      (a, b) =>
        b.orders - a.orders ||
        b.lastOrderedAt - a.lastOrderedAt ||
        a.storeItemId.localeCompare(b.storeItemId),
    )
    .slice(0, MAX_SUGGESTIONS);
}

export const list = query({
  args: accessArgs,
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    return computeSuggestions(ctx, household._id);
  },
});

/** Accept a suggestion: creates the favorite with aliases and the usual quantity. */
export const accept = mutation({
  args: {
    ...actorArgs,
    storeItemId: v.string(),
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const household = await resolveHousehold(ctx, args);
    await resolveActor(ctx, household, args);
    const suggestion = (await computeSuggestions(ctx, household._id)).find(
      (s) => s.storeItemId === args.storeItemId,
    );
    if (!suggestion) throw new ConvexError("That suggestion is no longer open");
    const aliases = [
      ...new Set(
        (args.aliases ?? suggestion.aliases)
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (aliases.length > 20 || aliases.some((a) => a.length > 100))
      throw new ConvexError("Invalid aliases");
    const count = (
      await ctx.db
        .query("favorites")
        .withIndex("by_household", (q) => q.eq("householdId", household._id))
        .take(MAX_FAVORITES)
    ).length;
    if (count >= MAX_FAVORITES) throw new ConvexError("Too many favorites");
    return ctx.db.insert("favorites", {
      householdId: household._id,
      name: suggestion.name,
      aliases,
      store: suggestion.store,
      storeItemId: suggestion.storeItemId,
      usualQty: Math.min(Math.max(suggestion.usualQty, 1), 20),
    });
  },
});
