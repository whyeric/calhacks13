import search from "../../fixtures/walmart/search.json";
// #66 price compare: the second store's cached fixture prices its items the same way.
import secondStore from "../../fixtures/target/search.json";

/**
 * Server-side price list. The agent's names and prices are never trusted for
 * catalog items: orders are priced from this table (built from the same cached
 * fixture the agent's search_items tool reads).
 */
export type CatalogItem = { name: string; priceCents: number };

const CATALOG: ReadonlyMap<string, CatalogItem> = new Map(
  [...search.entries, ...secondStore.entries].flatMap((entry) =>
    entry.results.map(
      (r) =>
        [r.storeItemId, { name: r.name, priceCents: r.priceCents }] as const,
    ),
  ),
);

export function catalogItem(storeItemId: string): CatalogItem | null {
  return CATALOG.get(storeItemId) ?? null;
}

/**
 * Live (Apify) search results are not in the fixture. Off by default; set Convex
 * env ALLOW_LIVE_ITEM_PRICES=1 to accept "walmart-*" ids at the agent's price.
 */
export function liveItemPricesAllowed(storeItemId: string) {
  return (
    process.env.ALLOW_LIVE_ITEM_PRICES === "1" &&
    storeItemId.startsWith("walmart-")
  );
}
