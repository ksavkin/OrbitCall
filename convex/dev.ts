import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { redEvent, missingProbability, missingMetadata } from "../fixtures/events";
import { putFixture } from "./lib/events";
import { ensureAssignment } from "./lib/accounts";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";

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

// A separate synthetic fixture; never assigns a real catalog satellite to a pretend company.
export const prepareAdvocateFixture = internalMutation({
  args: {},
  handler: async ctx => {
    if (process.env.ENABLE_DEV_FIXTURES !== "true") throw new ConvexError({ code: "FEATURE_DISABLED", message: "Enable development fixtures first." });
    const eventId = await putFixture(ctx, "fixture:advocate", advocateEvent, "red");
    for (const [side, policy] of [["A", policyA], ["B", policyB]] as const) {
      const key = `advocate-fixture-${side}`;
      const existing = await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", key)).unique();
      const companyId = existing?._id ?? await ctx.db.insert("companies", { key, name: `Fixture Operator ${side}`, simulated: true });
      const ownership = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", policy.objectId)).unique();
      if (ownership && ownership.companyId !== companyId) throw new ConvexError({ code: "INVALID_STATE", message: "Fixture ownership conflicts with existing data." });
      if (!ownership) await ctx.db.insert("satelliteOwners", { objectId: policy.objectId, companyId });
      const previousPolicy = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
      if (!previousPolicy) await ctx.db.insert("policies", { companyId, revision: 1, satellites: [policy], updatedAt: Date.now() });
      const tokenIdentifier = `https://orbitcall-fixtures.invalid|operator-${side.toLowerCase()}`;
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique();
      if (user && user.companyId !== companyId) throw new ConvexError({ code: "INVALID_STATE", message: "Fixture user conflicts with existing data." });
      const userId = user?._id ?? await ctx.db.insert("users", { tokenIdentifier, companyId, role: "operator" });
      await ensureAssignment(ctx, userId, policy.objectId);
    }
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return { eventId, version: set?.version ?? null };
  },
});

// Explicit seed only: model calls begin with agents/advocate:negotiate, not with seeding.
export const seedAdvocates = internalAction({
  args: {},
  handler: async (ctx): Promise<{ eventId: import("./_generated/dataModel").Id<"events">; simulated: true }> => {
    const { eventId, version } = await ctx.runMutation(internal.dev.prepareAdvocateFixture, {});
    if (version === null) await ctx.runMutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates, start: false });
    return { eventId, simulated: true };
  },
});
