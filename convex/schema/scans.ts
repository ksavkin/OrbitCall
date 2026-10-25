import { defineTable } from "convex/server";
import { v } from "convex/values";

// Assigned-fleet screening runs (spec §2.6 ScanRun, §3.2 scans.startMine/getMine). A run pins the caller's assignment
// version, the primary object IDs resolved on the server and the snapshot; the numerical work is one orbit-service job.

export const scanStatus = v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed"));
export const scanPhase = v.union(
  v.literal("queued"), v.literal("loading"), v.literal("screening"), v.literal("matching_sources"),
  v.literal("publishing"), v.literal("done"), v.literal("failed"),
);

export const scanTables = {
  scanRuns: defineTable({
    requestedBy: v.id("users"),
    // Client-chosen idempotency key: the same request reuses its run instead of starting another job.
    requestId: v.string(),
    assignmentVersion: v.number(),
    primaryObjectIds: v.array(v.string()),
    snapshotId: v.string(),
    fromMs: v.number(), toMs: v.number(),
    status: scanStatus, phase: scanPhase,
    // Measured fraction from the service's counters; null while indeterminate.
    progress: v.union(v.number(), v.null()),
    counts: v.object({
      primaryObjects: v.number(), catalogObjects: v.number(), primariesCompleted: v.number(),
      pairsChecked: v.number(), eventsFound: v.number(),
    }),
    coverage: v.object({
      complete: v.boolean(), catalogScope: v.string(), excludedObjects: v.number(),
      reasons: v.array(v.object({ reason: v.string(), count: v.number() })),
      missingPrimaryIds: v.array(v.string()),
    }),
    // The orbit service's job (POST /screen); null until it accepts the request.
    jobId: v.union(v.string(), v.null()),
    startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()),
    error: v.union(v.object({ code: v.string(), message: v.string() }), v.null()),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    updatedAt: v.number(),
  }).index("by_user", ["requestedBy"]).index("by_user_request", ["requestedBy", "requestId"])
    .index("by_status", ["status"]).index("by_job", ["jobId"]),
};
