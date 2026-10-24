import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireEventReader } from "./lib/access";
import { inputKey } from "./lib/analyst";
import { factsFromEvent } from "./lib/events";

// Phase 1 read contract, usable without constructing a decision room.
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const { event } = await requireEventReader(ctx, eventId);
    const summary = await ctx.db.query("eventSummaries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const run = await ctx.db.query("agentRuns").withIndex("by_event_role", q =>
      q.eq("eventId", eventId).eq("role", "incident_analyst")).order("desc").first();
    const current = summary && summary.inputKey === inputKey(factsFromEvent(event));
    const currentRun = run && run.inputKey === inputKey(factsFromEvent(event));
    return {
      eventId, summaryLines: current ? summary.summaryLines : [],
      numbersChecked: Boolean(current), originalLang: "en" as const,
      createdAt: current ? summary.createdAt : null, simulated: event.simulated,
      agentsWorking: event.agentsWorking, agentsStalled: event.agentsStalled,
      run: currentRun ? {
        status: run.status, stage: run.stage, attempt: run.attempt,
        startedAt: new Date(run.startedAt).toISOString(),
        lastProgressAt: new Date(run.lastProgressAt).toISOString(),
        errorCode: run.errorCode, errorMessage: run.errorMessage,
      } : null,
    };
  },
});
