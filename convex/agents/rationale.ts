"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { callClaude, claudeConfig, safeFailure } from "../lib/claude";
import { checkRationale, rationalePrompt, rationaleCheckInput, type RationaleResult, type RationaleSpan } from "../lib/rationale";

/** Stable entry after candidate publication. All provider calls use public immutable candidate facts only. */
export const start = internalAction({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }): Promise<{ status: string; published: number }> => {
    const claimed = await ctx.runMutation(internal.lib.rationale.begin, { eventId });
    if (!claimed) return { status: "skipped", published: 0 };
    const results: RationaleResult[] = await Promise.all(claimed.cards.map(async card => {
      const version = `${claimed.inputVersion}:${card.candidateId}`;
      const span: RationaleSpan = { role: "candidate_rationale", provider: "anthropic", model: process.env.ANTHROPIC_MODEL || "unconfigured",
        inputVersion: version, attempt: claimed.attempt, startedAt: Date.now(), finishedAt: Date.now(),
        status: "failed", usage: null, errorCode: null, errorMessage: null };
      let raw: string | null = null;
      try {
        claudeConfig();
        const call = await callClaude(rationalePrompt(card));
        span.model = call.model; span.usage = call.usage;
        const text = checkRationale(call.raw, card);
        raw = call.raw;
        span.status = "succeeded"; span.finishedAt = Date.now();
        const check = await ctx.runAction(internal.rationaleCheck.run, {
          input: rationaleCheckInput(claimed.inputVersion, card, text), attempt: claimed.attempt,
        });
        return { candidateId: card.candidateId, raw, span, check };
      } catch (error) {
        // Preserve a completed Claude call if the subsequent action dispatch itself failed.
        if (span.status !== "succeeded") {
          const failure = safeFailure(error);
          span.errorCode = failure.code; span.errorMessage = failure.message; span.finishedAt = Date.now();
        }
        return { candidateId: card.candidateId, raw, span, check: null };
      }
    }));
    return ctx.runMutation(internal.lib.rationale.finish, { requestId: claimed.requestId, results });
  },
});
