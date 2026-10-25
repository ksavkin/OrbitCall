import { defineTable } from "convex/server";
import { v } from "convex/values";
import { runStage, runStatus } from "../lib/validators";
import { candidate, category, satellitePolicy, sharedEvaluation, side } from "../lib/policyValidators";
import { lang, userRole } from "../lib/accounts";

// Andrew owns these tables. No client receives private agent input or model responses.
export const agentTables = {
  // Incident Analyst runs. Start time is _creationTime; the attempt number is the run's position
  // for its event. A checked summary is rendered from `checkedOutput` (templates with placeholders,
  // no numbers) and the event's current facts, so it never holds a copy of the evidence.
  agentRuns: defineTable({
    eventId: v.id("events"), inputKey: v.string(), status: runStatus,
    // Absent role denotes a legacy Analyst run. Private policy is kept out of this table.
    role: v.optional(v.union(v.literal("incident_analyst"), v.literal("operator_advocate"))),
    companyId: v.optional(v.id("companies")),
    stage: v.optional(runStage), lastProgressAt: v.number(), stalled: v.boolean(),
    finishedAt: v.optional(v.number()),
    errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()),
    model: v.optional(v.string()),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
    checkedOutput: v.optional(v.string()),
  }).index("by_event", ["eventId"]).index("by_event_status", ["eventId", "status"])
    .index("by_event_role_company", ["eventId", "role", "companyId"]),
  // Optional profile and settings fields were added after rows existed on prod; a missing value reads as null.
  // language/contact here are the company's shareable settings (spec §3.5), apart from each user's own language.
  companies: defineTable({
    key: v.string(), name: v.string(), simulated: v.boolean(),
    country: v.optional(v.string()), language: v.optional(lang), contact: v.optional(v.string()),
  }).index("by_key", ["key"]),
  // assignmentVersion is per user and changes only when the active assignment set changes (lib/accounts.ts).
  users: defineTable({
    tokenIdentifier: v.string(), companyId: v.id("companies"), role: userRole,
    name: v.optional(v.string()), language: v.optional(lang), dispatcherCountry: v.optional(v.string()),
    assignmentVersion: v.optional(v.number()),
  }).index("by_token_identifier", ["tokenIdentifier"]),
  satelliteOwners: defineTable({ objectId: v.string(), companyId: v.id("companies") })
    .index("by_object", ["objectId"]).index("by_company", ["companyId"]),
  fleetAssignments: defineTable({ userId: v.id("users"), objectId: v.string(), active: v.boolean() })
    .index("by_user_object", ["userId", "objectId"]),
  policies: defineTable({ companyId: v.id("companies"), revision: v.number(), satellites: v.array(satellitePolicy), updatedAt: v.number() })
    .index("by_company", ["companyId"]),
  // Sides keep the event's canonical object order, so confirmed debris may sit on either side: that side's company
  // is null and the other side has the one active operator and Advocate (spec §4.1). At least one is non-null;
  // candidates.publish enforces it. Widened from a required companyAId; existing rows stay valid.
  candidateSets: defineTable({
    eventId: v.id("events"),
    companyAId: v.union(v.id("companies"), v.null()), companyBId: v.union(v.id("companies"), v.null()),
    version: v.number(), evidenceKey: v.string(), candidateRevisionIds: v.array(v.id("candidateRevisions")),
    state: v.union(v.literal("open"), v.literal("scheduled"), v.literal("closed")), reviewRequired: v.boolean(),
  }).index("by_event", ["eventId"]).index("by_company_a", ["companyAId"]).index("by_company_b", ["companyBId"]),
  candidateRevisions: defineTable({ eventId: v.id("events"), ...candidate.fields })
    .index("by_event_candidate_revision", ["eventId", "candidateId", "revision"]),
  // Private references identify the policy version used by an Advocate. No public query reads this table.
  advocateContexts: defineTable({
    runId: v.id("agentRuns"), side, policyId: v.union(v.id("policies"), v.null()), policyRevision: v.number(),
    candidateSetId: v.id("candidateSets"), candidateVersion: v.number(), evidenceKey: v.string(),
  }).index("by_run", ["runId"]),
  // Only deterministic categories/outcomes enter shared history; never private/model prose.
  negotiationMessages: defineTable({
    eventId: v.id("events"), side, kind: v.union(v.literal("assessment"), v.literal("policy_changed")),
    runId: v.optional(v.id("agentRuns")), entries: v.array(sharedEvaluation), categories: v.array(category),
    candidateVersion: v.optional(v.number()), evidenceKey: v.optional(v.string()),
  }).index("by_event", ["eventId"]).index("by_run", ["runId"]),
};
