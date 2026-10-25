"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { side } from "../lib/policyValidators";
import { advocatePrompt, checkRecommendation } from "../lib/advocate";
import { callClaude, claudeConfig, safeFailure } from "../lib/claude";
import type { Side } from "../lib/policies";

export const start = internalAction({
  args: { eventId: v.id("events"), side }, returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const claimed = await ctx.runMutation(internal.advocates.begin, args);
    if (!claimed) return null;
    const { runId, input } = claimed;
    try {
      const { model } = claudeConfig();
      await ctx.runMutation(internal.agentRuns.progress, { runId, stage: "calling_model", model });
      const result = await callClaude(advocatePrompt(input));
      await ctx.runMutation(internal.agentRuns.progress, { runId, stage: "checking" });
      checkRecommendation(result.raw, input.evaluations, Boolean(input.policy), input.counterpart);
      await ctx.runMutation(internal.advocates.finish, { runId, ...result });
    } catch (error) { await ctx.runMutation(internal.advocates.fail, { runId, ...safeFailure(error) }); }
    return null;
  },
});

// One bounded round. For a pair, A's finish/fail transaction schedules B exactly once; retries of A
// also refresh B. B failures remain explicit retries and never restart A. Debris runs its one active
// side, which may be canonical A or B, and hands off to nobody.
export const negotiate = internalAction({
  args: { eventId: v.id("events") }, returns: v.null(),
  handler: async (ctx, { eventId }): Promise<null> => {
    const opening: Side | null = await ctx.runQuery(internal.advocates.openingSide, { eventId });
    if (opening) await ctx.runAction(internal.agents.advocate.start, { eventId, side: opening });
    return null;
  },
});
