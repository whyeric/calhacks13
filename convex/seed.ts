import { internalMutation } from "./_generated/server";
import { calhacks } from "./venues/calhacks";

// Idempotent: upserts every seed pin by slug and removes seed pins no longer in the config.
// Safe to re-run after editing the config. AI- and user-created pins are never touched.
// Run with: npx convex run seed:run            (dev)
//           npx convex run --prod seed:run     (production)
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const venue = calhacks;
    let inserted = 0;
    let updated = 0;
    for (const p of venue.pins) {
      const existing = await ctx.db
        .query("pins")
        .withIndex("by_venue_slug", (q) => q.eq("venueId", venue.id).eq("slug", p.slug))
        .unique();
      const doc = { venueId: venue.id, source: "seed" as const, ...p };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
        updated++;
      } else {
        await ctx.db.insert("pins", doc);
        inserted++;
      }
    }
    // Remove seed pins that are no longer in the config (renamed or deleted slugs).
    const keep = new Set(venue.pins.map((p) => p.slug));
    let removed = 0;
    const all = await ctx.db
      .query("pins")
      .withIndex("by_venue", (q) => q.eq("venueId", venue.id))
      .collect();
    for (const doc of all) {
      if (doc.source === "seed" && !keep.has(doc.slug)) {
        await ctx.db.delete(doc._id);
        removed++;
      }
    }
    return { inserted, updated, removed };
  },
});
