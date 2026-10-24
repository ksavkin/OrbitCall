import { defineTable } from "convex/server";
import { v } from "convex/values";
import { runStage, runStatus } from "../lib/validators";

// Andrew owns these tables. No client receives private agent input or model responses.
export const agentTables = {
  // Incident Analyst runs. Start time is _creationTime; the attempt number is the run's position
  // for its event. A checked summary is rendered from `checkedOutput` (templates with placeholders,
  // no numbers) and the event's current facts, so it never holds a copy of the evidence.
  agentRuns: defineTable({
    eventId: v.id("events"), inputKey: v.string(), status: runStatus,
    stage: v.optional(runStage), lastProgressAt: v.number(), stalled: v.boolean(),
    finishedAt: v.optional(v.number()),
    errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()),
    model: v.optional(v.string()),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
    checkedOutput: v.optional(v.string()),
  }).index("by_event", ["eventId"]).index("by_event_status", ["eventId", "status"]),
};
