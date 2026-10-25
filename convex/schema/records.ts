import { defineTable } from "convex/server";
import { v } from "convex/values";
import { sourceRef } from "../lib/validators";
import { side } from "../lib/policyValidators";
import { translations } from "./call";
import { agentRole } from "./rooms";

// Per-person inbox, verification results, the shared audit log and the observation history copied to Tiger Data
// (spec §2.5 InboxItem, Verification, LogEntry, §3.4 history.series, roadmap §10). Tiger is an analytics copy:
// these rows never change an approval.

export const verificationResult = v.union(v.literal("awaiting_data"), v.literal("consistent"), v.literal("mismatch"));
export const exportState = v.union(v.literal("pending"), v.literal("exported"), v.literal("failed"));
export const logAction = v.union(
  v.literal("event_created"), v.literal("status_changed"), v.literal("message"), v.literal("negotiation"),
  v.literal("proposal_revised"), v.literal("selected"), v.literal("approved"), v.literal("vetoed"),
  // A conversation audit action, not an approval state.
  v.literal("countered"),
  v.literal("approvals_reset"), v.literal("rescreened"), v.literal("refused"), v.literal("schedule_committed"),
  v.literal("schedule_failed"), v.literal("verified"), v.literal("policy_changed"), v.literal("no_action_needed"),
  v.literal("agents_rerun"), v.literal("summary_posted"),
);
// Like a message author, plus the event side the actor acted for (null when not side-specific).
export const logActor = v.union(
  v.object({
    kind: v.literal("human"), userId: v.id("users"), companyId: v.id("companies"), name: v.string(), side: v.union(side, v.null()),
  }),
  v.object({ kind: v.literal("agent"), role: agentRole, companyId: v.union(v.id("companies"), v.null()), side: v.union(side, v.null()) }),
  v.object({ kind: v.literal("system") }),
);
const logValues = v.union(v.record(v.string(), v.union(v.number(), v.string(), v.null())), v.null());

export const recordTables = {
  // Shared audit history (LOG-1..LOG-6). Rows are immutable by convention: insert only, never patch or delete, so
  // vetoes, resets and superseded approvals stay on record after the selection moves on, and demo.reset keeps a
  // closed run's entries under its demoRunId. Policy changes appear only as categories, never values (POL-2).
  log: defineTable({
    eventId: v.union(v.id("events"), v.null()),
    actor: logActor, action: logAction,
    summary: v.string(),
    // Every language version of a human line [LANG-5].
    texts: v.union(translations, v.null()),
    before: logValues, after: logValues,
    proposalId: v.union(v.id("proposals"), v.null()), revision: v.union(v.number(), v.null()),
    roomId: v.union(v.id("rooms"), v.null()),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    simulated: v.boolean(),
    at: v.number(),
  }).index("by_event_at", ["eventId", "at"]).index("by_at", ["at"]).index("by_demo_run", ["demoRunId"]),
  // Title, color, status and TCA are read from the event; the row holds what is personal to the reader.
  inbox: defineTable({
    userId: v.id("users"), eventId: v.id("events"),
    unread: v.boolean(), lastUpdateAt: v.number(), lastUpdateSummary: v.string(),
    demoRunId: v.union(v.id("demoRuns"), v.null()), simulated: v.boolean(),
  }).index("by_user_updated", ["userId", "lastUpdateAt"]).index("by_user_event", ["userId", "eventId"])
    .index("by_demo_run", ["demoRunId"]),
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
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    simulated: v.boolean(), createdAt: v.number(),
  }).index("by_event", ["eventId"]).index("by_kind", ["kind"]).index("by_demo_run", ["demoRunId"]),
  // One observation queued for the Tiger hypertable. `observationKey` includes the observation time, so a
  // repeated export of the same point is a no-op on both sides.
  observationExports: defineTable({
    observationKey: v.string(), eventId: v.id("events"),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    observedAtMs: v.number(), source: v.string(), metric: v.string(),
    value: v.union(v.number(), v.null()), evidenceVersion: v.string(), simulated: v.boolean(),
    exportState, attempts: v.number(), lastError: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  }).index("by_key", ["observationKey"]).index("by_event", ["eventId"]).index("by_state", ["exportState"])
    .index("by_demo_run", ["demoRunId"]),
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
