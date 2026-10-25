import { defineTable } from "convex/server";
import { v } from "convex/values";
import { color, sourceRef } from "../lib/validators";

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
  // One encounter. Pc metric, source and epoch come from the snapshot; status is "new" in Phase 1;
  // agentsWorking/agentsStalled come from agentRuns.
  events: defineTable({
    objectAId: v.id("spaceObjects"), objectBId: v.id("spaceObjects"),
    snapshotId: v.id("snapshots"),
    tcaMs: v.number(), missKm: v.number(), relSpeedKmS: v.number(),
    pcValue: v.union(v.number(), v.null()),
    simulated: v.boolean(),
    color, active: v.boolean(),
    updatedAt: v.number(),
  }).index("by_pair_tca", ["objectAId", "objectBId", "tcaMs"]).index("by_active", ["active"]),
};
