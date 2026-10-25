import { defineTable } from "convex/server";
import { v } from "convex/values";
import { color, eventStatus, situation, sourceRef, workflow } from "../lib/validators";
import { side } from "../lib/policyValidators";

// Kostya owns these tables. Phase 1 stores only what a query cannot derive:
// object metadata once per object, provenance once per snapshot, measurements per event.
export const dataTables = {
  // Provenance of one pinned snapshot (or one fixture); the catalog files stay in the repo.
  // `ommUrl` is where the browser loads the pinned OMM catalog (served by the web app); absent before one exists.
  snapshots: defineTable({
    snapshotId: v.string(), sources: v.array(sourceRef), ommUrl: v.optional(v.string()),
  }).index("by_snapshot_id", ["snapshotId"]),
  // Metadata for objects that appear in loaded events. `simulated` and `celestrakUrl`
  // follow from `objectId`; owner, owner company and purpose are unknown in Phase 1.
  spaceObjects: defineTable({
    objectId: v.string(), name: v.string(),
    country: v.union(v.string(), v.null()),
    launchDate: v.union(v.string(), v.null()),
  }).index("by_object_id", ["objectId"]),
  // One encounter. Pc metric, source and epoch come from the snapshot; agentsWorking/agentsStalled come from agentRuns.
  // The lifecycle fields were added after rows existed on prod: a missing status reads as "new", a missing
  // situation as null, and a missing workflow as unclassified, which authorizes no scheduling (spec §4.1).
  events: defineTable({
    objectAId: v.id("spaceObjects"), objectBId: v.id("spaceObjects"),
    snapshotId: v.id("snapshots"),
    tcaMs: v.number(), missKm: v.number(), relSpeedKmS: v.number(),
    pcValue: v.union(v.number(), v.null()),
    simulated: v.boolean(),
    color, active: v.boolean(),
    updatedAt: v.number(),
    status: v.optional(eventStatus),
    // Set only while status is "communication" (spec §4.3).
    situation: v.optional(situation),
    workflow: v.optional(workflow),
    // A+B bilateral, the active side only for confirmed debris, [] for internal review.
    requiredApprovalSides: v.optional(v.array(side)),
    // Server-owned; a classification change advances it, which invalidates approvals signed on the old one.
    approvalRuleVersion: v.optional(v.number()),
    demoRunId: v.optional(v.id("demoRuns")),
  }).index("by_pair_tca", ["objectAId", "objectBId", "tcaMs"]).index("by_active", ["active"])
    // by_pair_tca already serves objectA-first lookups; this one finds events where an object is side B.
    .index("by_object_b_tca", ["objectBId", "tcaMs"]).index("by_demo_run", ["demoRunId"]),
};
