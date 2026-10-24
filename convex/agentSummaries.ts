import { query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { inputKey } from "./lib/analyst";
import { isoUtc, loadFacts } from "./lib/events";
import { currentSummary, runFlags, runsWithAttempt, stageOf } from "./lib/runs";

// Phase 1 read contract, usable without constructing a decision room. Phase 1 events are public
// catalog data, so this read needs no sign-in (plan D3); Phase 2 adds identity checks.
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    const facts = await loadFacts(ctx, event);
    const summary = await currentSummary(ctx, eventId, facts);
    const [run] = await runsWithAttempt(ctx, eventId);
    const currentRun = run && run.inputKey === inputKey(facts);
    return {
      eventId, summaryLines: summary?.lines ?? [],
      numbersChecked: Boolean(summary), originalLang: "en" as const,
      createdAt: summary ? isoUtc(summary.finishedAt) : null, simulated: event.simulated,
      ...await runFlags(ctx, eventId),
      run: currentRun ? {
        status: run.status, stage: stageOf(run), attempt: run.attempt,
        startedAt: isoUtc(run._creationTime),
        lastProgressAt: isoUtc(run.lastProgressAt),
        errorCode: run.errorCode ?? null, errorMessage: run.errorMessage ?? null,
      } : null,
    };
  },
});
