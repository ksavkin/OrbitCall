import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { redEvent, missingProbability, missingMetadata } from "../fixtures/events";

// Internal, opt-in development seeding. Never seeds private policies or real operator data.
export const seed = internalMutation({
  args: {
    scenario: v.optional(v.union(v.literal("red"), v.literal("missing_pc"), v.literal("missing_metadata"))),
  },
  handler: async (ctx, { scenario = "red" }) => {
    if (process.env.ENABLE_DEV_FIXTURES !== "true") {
      throw new ConvexError({ code: "FEATURE_DISABLED", message: "Set ENABLE_DEV_FIXTURES=true in a development deployment." });
    }
    const sourceKey = `fixture:${scenario}`;
    const previous = await ctx.db.query("events").withIndex("by_source_key", q => q.eq("sourceKey", sourceKey)).unique();
    if (previous) return { eventId: previous._id, simulated: true };
    const facts = scenario === "missing_pc" ? missingProbability : scenario === "missing_metadata" ? missingMetadata : redEvent;
    const eventId = await ctx.db.insert("events", {
      ...facts, sourceKey, color: scenario === "missing_pc" ? "none" : "red",
      status: "new", agentsWorking: false, agentsStalled: false, updatedAt: new Date().toISOString(),
    });
    return { eventId, simulated: true };
  },
});
