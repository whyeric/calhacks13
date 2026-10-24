import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const pinKind = v.union(
  v.literal("hacking"),
  v.literal("area"),
  v.literal("food"),
  v.literal("workshop"),
  v.literal("sponsor"),
  v.literal("stage"),
  v.literal("help"),
  v.literal("hardware"),
  v.literal("quiet"),
  v.literal("restroom"),
);

export default defineSchema({
  pins: defineTable({
    venueId: v.string(),
    slug: v.string(),
    name: v.string(),
    kind: pinKind,
    x: v.number(),
    y: v.number(),
    description: v.optional(v.string()),
    // "seed" = hand-placed, "ai" = extracted from schedule/announcements (step 3), "user" = posted
    source: v.union(v.literal("seed"), v.literal("ai"), v.literal("user")),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
  })
    .index("by_venue", ["venueId"])
    .index("by_venue_slug", ["venueId", "slug"]),
});
