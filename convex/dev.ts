import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { redEvent, missingProbability, missingMetadata } from "../fixtures/events";
import { putFixture } from "./lib/events";

// Internal, opt-in development seeding. Never seeds private policies or real operator data.
// All scenarios share one encounter, so seeding a scenario switches that event to it.
export const seed = internalMutation({
  args: {
    scenario: v.optional(v.union(v.literal("red"), v.literal("missing_pc"), v.literal("missing_metadata"))),
  },
  handler: async (ctx, { scenario = "red" }) => {
    if (process.env.ENABLE_DEV_FIXTURES !== "true") {
      throw new ConvexError({ code: "FEATURE_DISABLED", message: "Set ENABLE_DEV_FIXTURES=true in a development deployment." });
    }
    const facts = scenario === "missing_pc" ? missingProbability : scenario === "missing_metadata" ? missingMetadata : redEvent;
    const eventId = await putFixture(ctx, `fixture:${scenario}`, facts, scenario === "missing_pc" ? "none" : "red");
    return { eventId, simulated: true };
  },
});
