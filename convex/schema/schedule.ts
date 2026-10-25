import { defineTable } from "convex/server";
import { v } from "convex/values";
import { side } from "../lib/policyValidators";

// Proposals, the shared selection, approvals and schedule artifacts (spec §2.3, §2.5 Maneuver, §4.1).
// A proposal revision points at the immutable computed candidate in candidateRevisions; the numbers live there only.
// Selection is not approval: an approval names the exact proposal, revision and selection generation it signs.

export const approvalStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("vetoed"));
export const maneuverStatus = v.union(
  v.literal("preview"), v.literal("rescreening"), v.literal("refused"),
  v.literal("committing"), v.literal("committed"), v.literal("failed"),
);
// The exact selection a schedule write signs for one event.
export const eventRef = v.object({
  eventId: v.id("events"), proposalId: v.id("proposals"), revision: v.number(), selectionGeneration: v.number(),
});
const evidenceKeys = v.array(v.object({ eventId: v.id("events"), evidenceKey: v.string() }));
// The inputs a schedule write was authorized on (spec §4.1). The scheduler compares them with the current values
// before commit; any difference flags the plan for review instead of silently replacing it.
export const pinnedInputs = v.object({
  snapshotId: v.string(), evidenceKeys,
  policyRevisions: v.array(v.object({ companyId: v.id("companies"), revision: v.number() })),
  assignmentVersions: v.array(v.object({ userId: v.id("users"), version: v.number() })),
});
// The orbital service echoes the snapshot and evidence it re-screened, so a result from S is never taken as S'.
export const rescreen = v.object({
  snapshotId: v.string(), evidenceKeys,
  passed: v.boolean(), objectsChecked: v.number(), horizonH: v.number(),
  originalMissAfterKm: v.union(v.number(), v.null()),
  newConjunctions: v.array(v.object({ objectId: v.string(), name: v.string(), tcaUtc: v.string(), missKm: v.number() })),
  refusalReason: v.union(v.string(), v.null()),
});

export const scheduleTables = {
  // One card per event and candidate ("P1".."P4"); revisions are its history.
  proposals: defineTable({
    eventId: v.id("events"), candidateId: v.string(), label: v.string(),
    latestRevision: v.number(), createdAt: v.number(),
  }).index("by_event", ["eventId"]).index("by_event_candidate", ["eventId", "candidateId"]),
  proposalRevisions: defineTable({
    proposalId: v.id("proposals"), eventId: v.id("events"), revision: v.number(),
    candidateRevisionId: v.id("candidateRevisions"),
    // What changed from the previous revision and the messages that caused it [AGT-12].
    changeSummary: v.union(v.string(), v.null()), sourceMessageIds: v.array(v.id("messages")),
    rationale: v.union(v.object({
      text: v.string(), numbersChecked: v.boolean(),
      secondModel: v.union(v.object({ agrees: v.boolean(), note: v.string() }), v.null()),
    }), v.null()),
    // Factory's prepared diff for this exact revision and its content hash [EXE-4, ROOM-9].
    schedulePreviewDiff: v.union(v.string(), v.null()), schedulePreviewHash: v.union(v.string(), v.null()),
    simulated: v.boolean(), createdAt: v.number(),
  }).index("by_proposal_revision", ["proposalId", "revision"]).index("by_event", ["eventId"]),
  // The event's current shared selection. Every change advances `generation` and resets required approvals.
  selections: defineTable({
    eventId: v.id("events"),
    proposalId: v.union(v.id("proposals"), v.null()), revision: v.union(v.number(), v.null()),
    generation: v.number(),
    by: v.union(v.object({ kind: v.literal("human"), userId: v.id("users") }), v.object({ kind: v.literal("agents") })),
    at: v.number(),
    lastReset: v.union(v.object({ at: v.number(), reason: v.string() }), v.null()),
  }).index("by_event", ["eventId"]),
  // One row per decision. A reset marks rows not current; old approvals stay as history and never come back.
  // Debris events have one required side and no row for the missing one.
  approvals: defineTable({
    eventId: v.id("events"), side, status: approvalStatus,
    userId: v.id("users"), companyId: v.id("companies"),
    proposalId: v.id("proposals"), revision: v.number(), selectionGeneration: v.number(), approvalRuleVersion: v.number(),
    // The trajectory plan version this approval also signs when the maneuver spans several pair events.
    trajectoryPlanId: v.union(v.id("trajectoryPlans"), v.null()), trajectoryPlanVersion: v.union(v.number(), v.null()),
    reason: v.union(v.string(), v.null()),
    current: v.boolean(), at: v.number(),
  }).index("by_event_current", ["eventId", "current"]).index("by_event_generation", ["eventId", "selectionGeneration"]),
  // A reserved schedule-write intent and its result: one row per physical schedule write. `refs` has one entry for a
  // single-event maneuver and one per affected event for a trajectory plan; maneuverEvents indexes them by event.
  // `intentKey` is the plan id and version for a plan, or event, proposal, revision and selection generation for a
  // single event, so a retry returns the existing result instead of writing a second entry. A file is not an execution.
  maneuvers: defineTable({
    refs: v.array(eventRef),
    trajectoryPlanId: v.union(v.id("trajectoryPlans"), v.null()),
    trajectoryPlanVersion: v.union(v.number(), v.null()),
    pinned: pinnedInputs,
    intentKey: v.string(), status: maneuverStatus,
    filePath: v.string(), diff: v.union(v.string(), v.null()), commitSha: v.union(v.string(), v.null()),
    writtenBy: v.union(v.literal("droid"), v.literal("backend")),
    rescreenJobId: v.union(v.string(), v.null()), rescreen: v.union(rescreen, v.null()),
    error: v.union(v.string(), v.null()), reviewRequired: v.boolean(),
    updatedAt: v.number(),
  }).index("by_intent", ["intentKey"]),
  // One row per event a maneuver touches, written with the maneuver from its refs, so maneuvers.get({ eventId }) is indexed.
  maneuverEvents: defineTable({ maneuverId: v.id("maneuvers"), eventId: v.id("events") })
    .index("by_event", ["eventId"]).index("by_maneuver", ["maneuverId"]),
  // One spacecraft's planned maneuver and every pair event it affects. A conjunction event stays a pair; a maneuver
  // can touch several. Authorization needs every affected event's required approvals on the same planVersion, and
  // any material change advances planVersion, which invalidates approvals of the affected events only.
  trajectoryPlans: defineTable({
    objectId: v.string(), planVersion: v.number(),
    state: v.union(
      v.literal("draft"), v.literal("authorizing"), v.literal("scheduled"), v.literal("superseded"), v.literal("review_required"),
    ),
    affectedEventIds: v.array(v.id("events")),
    eventRefs: v.array(eventRef),
    // Scalar on purpose: a plan is one physical schedule write, so it has at most one maneuvers row.
    maneuverId: v.union(v.id("maneuvers"), v.null()),
    demoRunId: v.union(v.id("demoRuns"), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_object_state", ["objectId", "state"]).index("by_object_version", ["objectId", "planVersion"]),
};
