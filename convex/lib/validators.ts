import { v } from "convex/values";

// Stored values. sourceName is the full spec §2.1 SourceName.
export const sourceName = v.union(
  v.literal("celestrak_gp"), v.literal("celestrak_supgp"), v.literal("socrates"), v.literal("cdm_public"),
  v.literal("gp_history"), v.literal("keeptrack"), v.literal("simulated"), v.literal("celestrak_satcat"),
);
export const sourceRef = v.object({
  name: sourceName,
  url: v.union(v.string(), v.null()),
  epochUtc: v.union(v.string(), v.null()),
  fetchedAt: v.union(v.string(), v.null()),
});
export const color = v.union(v.literal("red"), v.literal("yellow"), v.literal("none"));
// Spec §2.1 EventStatus and Situation, §2.2 EventRow.workflow.
export const eventStatus = v.union(
  v.literal("new"), v.literal("agents"), v.literal("proposal"), v.literal("communication"), v.literal("approved"),
  v.literal("scheduled"), v.literal("monitoring"), v.literal("awaiting_verification_data"),
  v.literal("verified"), v.literal("flagged"), v.literal("no_action_needed"),
);
export const situation = v.union(v.literal("needs_operator_decision"), v.literal("waiting_for_operator"), v.null());
export const workflow = v.union(v.literal("bilateral"), v.literal("unilateral_debris"), v.literal("internal_review"));
export const runStatus = v.union(
  v.literal("running"), v.literal("succeeded"),
  v.literal("failed"), v.literal("superseded"),
);
export const runStage = v.union(v.literal("loading"), v.literal("calling_model"), v.literal("checking"));
// What ingestion stores about an object; everything else in SpaceObject is derived.
export const objectInput = v.object({
  objectId: v.string(), name: v.string(),
  country: v.union(v.string(), v.null()),
  launchDate: v.union(v.string(), v.null()),
});

// Analyst input in the spec §2.2 shapes, assembled from the tables by lib/events.ts.
export const spaceObject = v.object({
  objectId: v.string(), name: v.string(),
  ownerName: v.union(v.string(), v.null()),
  ownerCompanyId: v.null(),
  country: v.union(v.string(), v.null()),
  purpose: v.union(v.string(), v.null()),
  launchDate: v.union(v.string(), v.null()),
  simulated: v.boolean(),
  celestrakUrl: v.union(v.string(), v.null()),
});
export const probability = v.object({
  value: v.union(v.number(), v.null()),
  metric: v.union(v.literal("pc"), v.literal("max_prob")),
  source: v.union(v.literal("cdm"), v.literal("socrates"), v.literal("simulated")),
  epochUtc: v.union(v.string(), v.null()),
  sourceUrl: v.union(v.string(), v.null()),
  emergencyReportable: v.union(v.boolean(), v.null()),
});
export const sourceSpread = v.object({
  gpMissKm: v.union(v.number(), v.null()),
  supgpMissKm: v.union(v.number(), v.null()),
  minKm: v.union(v.number(), v.null()),
  maxKm: v.union(v.number(), v.null()),
  gpEpochUtc: v.union(v.string(), v.null()),
  supgpEpochUtc: v.union(v.string(), v.null()),
});
export const eventFacts = v.object({
  objectA: spaceObject, objectB: spaceObject,
  tcaUtc: v.string(), missKm: v.number(), relSpeedKmS: v.number(),
  pc: probability, sources: v.array(sourceRef),
  spread: v.union(sourceSpread, v.null()), simulated: v.boolean(),
});
