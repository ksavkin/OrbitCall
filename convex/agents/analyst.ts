"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { buildPrompt, checkAndRenderSummary } from "../lib/analyst";
import { callClaude, claudeConfig, safeFailure } from "../lib/claude";
import { orbitConfigured } from "../lib/orbit";

// Stable integration entry point for the event-ingestion pipeline.
export const start = internalAction({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }): Promise<null> => {
    const claimed = await ctx.runMutation(internal.agentRuns.begin, { eventId });
    if (!claimed) return null;
    const { runId, input } = claimed;
    try {
      const { model } = claudeConfig();
      await ctx.runMutation(internal.agentRuns.progress, { runId, stage: "calling_model", model });
      const result = await callClaude(buildPrompt(input));
      await ctx.runMutation(internal.agentRuns.progress, { runId, stage: "checking" });
      checkAndRenderSummary(result.raw, input);
      await ctx.runMutation(internal.agentRuns.finish, { runId, ...result });
    } catch (error) {
      await ctx.runMutation(internal.agentRuns.fail, { runId, ...safeFailure(error) });
    }
    // The maneuver grid comes from the orbital service, independent of the summary's outcome [AGT-2].
    if (orbitConfigured()) await ctx.scheduler.runAfter(0, internal.orbit.computeCandidates, { eventId });
    return null;
  },
});
