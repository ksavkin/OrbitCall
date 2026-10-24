import { defineTable } from "convex/server";
import { v } from "convex/values";
import { agentRole, eventFacts, runStatus } from "../lib/validators";

// Andrew owns these tables. No client receives private agent input or model responses.
export const agentTables = {
  agentRuns: defineTable({
    eventId: v.id("events"), role: agentRole, inputKey: v.string(),
    input: eventFacts, status: runStatus, attempt: v.number(),
    startedAt: v.number(), lastProgressAt: v.number(), finishedAt: v.union(v.number(), v.null()),
    stalled: v.boolean(), stage: v.string(),
    errorCode: v.union(v.string(), v.null()), errorMessage: v.union(v.string(), v.null()),
    model: v.union(v.string(), v.null()),
    usage: v.union(v.object({ inputTokens: v.number(), outputTokens: v.number() }), v.null()),
  }).index("by_event_role", ["eventId", "role"]).index("by_event_status", ["eventId", "status"]),
  eventSummaries: defineTable({
    eventId: v.id("events"), runId: v.id("agentRuns"), inputKey: v.string(),
    summaryLines: v.array(v.string()), numbersChecked: v.literal(true),
    originalLang: v.literal("en"), createdAt: v.string(), simulated: v.boolean(),
  }).index("by_event", ["eventId"]),
};
