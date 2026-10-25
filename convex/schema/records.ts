import { defineTable } from "convex/server";
import { v } from "convex/values";
import { sourceRef } from "../lib/validators";

// Per-person inbox, verification results and the observation history copied to Tiger Data (spec §2.5 InboxItem,
// Verification, §3.4 history.series, roadmap §10). Tiger is an analytics copy: these rows never change an approval.

export const verificationResult = v.union(v.literal("awaiting_data"), v.literal("consistent"), v.literal("mismatch"));
export const exportState = v.union(v.literal("pending"), v.literal("exported"), v.literal("failed"));

export const recordTables = {
  // Title, color, status and TCA are read from the event; the row holds what is personal to the reader.
  inbox: defineTable({
    userId: v.id("users"), eventId: v.id("events"),
    unread: v.boolean(), lastUpdateAt: v.number(), lastUpdateSummary: v.string(),
    demoRunId: v.union(v.id("demoRuns"), v.null()), simulated: v.boolean(),
  }).index("by_user_updated", ["userId", "lastUpdateAt"]).index("by_user_event", ["userId", "eventId"]),
  // Stored apart from the schedule file: a committed schedule is not evidence of execution [VER-1..VER-4].
  verifications: defineTable({
    eventId: v.union(v.id("events"), v.null()),   // null for the labeled historical replay
    kind: v.union(v.literal("live"), v.literal("replay")),
    result: verificationResult, label: v.string(),
    expected: v.object({ deltaAKm: v.number(), sign: v.union(v.literal(1), v.literal(-1)) }),
    observed: v.union(v.object({ deltaAKm: v.number(), z: v.number(), epochUtc: v.string() }), v.null()),
    elementSetCount: v.number(),
    series: v.array(v.object({ epochUtc: v.string(), smaKm: v.number() })),
    thresholds: v.object({ z: v.number(), minDeltaAKm: v.number(), sizeTolerance: v.number(), minSets: v.number() }),
    method: v.string(), limitations: v.array(v.string()), missing: v.array(v.string()), sources: v.array(sourceRef),
    simulated: v.boolean(), createdAt: v.number(),
  }).index("by_event", ["eventId"]).index("by_kind", ["kind"]),
  // One observation queued for the Tiger hypertable. `observationKey` includes the observation time, so a
  // repeated export of the same point is a no-op on both sides.
  observationExports: defineTable({
    observationKey: v.string(), eventId: v.id("events"),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    observedAtMs: v.number(), source: v.string(), metric: v.string(),
    value: v.union(v.number(), v.null()), evidenceVersion: v.string(), simulated: v.boolean(),
    exportState, attempts: v.number(), lastError: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  }).index("by_key", ["observationKey"]).index("by_event", ["eventId"]).index("by_state", ["exportState"]),
  // Versioned cache of the Tiger series that history.series reads. Real and simulated points stay apart.
  historySeries: defineTable({
    eventId: v.id("events"), seriesVersion: v.number(),
    points: v.array(v.object({
      atUtc: v.string(), pc: v.union(v.number(), v.null()), missKm: v.union(v.number(), v.null()),
      source: v.string(), simulated: v.boolean(),
    })),
    stale: v.boolean(), error: v.union(v.string(), v.null()), fetchedAt: v.number(),
  }).index("by_event", ["eventId"]),
};
