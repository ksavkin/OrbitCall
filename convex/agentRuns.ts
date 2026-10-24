import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { checkAndRenderSummary, inputKey, STALLED_AFTER_MS, validateFacts } from "./lib/analyst";
import { loadFacts } from "./lib/events";
import { currentSummary, latestRun, runFlags, runsWithAttempt, stageOf, supersede } from "./lib/runs";
import { runStage } from "./lib/validators";

export const begin = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    const input = await loadFacts(ctx, event);
    validateFacts(input);
    const key = inputKey(input);
    const previous = await latestRun(ctx, eventId);
    if (previous?.inputKey === key && ["running", "succeeded"].includes(previous.status)) return null;
    if (previous?.status === "running") await supersede(ctx, previous._id);
    const runId = await ctx.db.insert("agentRuns", {
      eventId, inputKey: key, status: "running", stage: "loading",
      lastProgressAt: Date.now(), stalled: false,
    });
    await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
    // The input travels to the action; it is not stored with the run.
    return { runId, input };
  },
});

export const progress = internalMutation({
  args: { runId: v.id("agentRuns"), stage: runStage, model: v.optional(v.string()) },
  handler: async (ctx, { runId, stage, model }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(runId, { stage, lastProgressAt: Date.now(), stalled: false,
      ...(model ? { model } : {}) });
    // A stalled watchdog has stopped polling. Resume monitoring if work resumes.
    if (run.stalled) await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
  },
});

export const watchdog = internalMutation({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    const remaining = STALLED_AFTER_MS - (Date.now() - run.lastProgressAt);
    if (remaining > 0) {
      await ctx.scheduler.runAfter(remaining, internal.agentRuns.watchdog, { runId });
      return;
    }
    await ctx.db.patch(runId, { stalled: true });
  },
});

export const finish = internalMutation({
  args: {
    runId: v.id("agentRuns"), raw: v.string(), model: v.string(),
    usage: v.object({ inputTokens: v.number(), outputTokens: v.number() }),
  },
  handler: async (ctx, { runId, raw, model, usage }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return { published: false };
    const event = await ctx.db.get(run.eventId);
    const latest = await latestRun(ctx, run.eventId);
    const facts = event && await loadFacts(ctx, event);
    if (!facts || latest?._id !== runId || inputKey(facts) !== run.inputKey) {
      await supersede(ctx, runId);
      return { published: false };
    }
    // Validate again inside the publishing transaction. A caller cannot bypass the gate.
    checkAndRenderSummary(raw, facts);
    await ctx.db.patch(runId, {
      status: "succeeded", stage: undefined, finishedAt: Date.now(), stalled: false,
      model, usage, checkedOutput: raw,
    });
    return { published: true };
  },
});

export const fail = internalMutation({
  args: { runId: v.id("agentRuns"), code: v.string(), message: v.string() },
  handler: async (ctx, { runId, code, message }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(runId, {
      status: "failed", stage: undefined, finishedAt: Date.now(), stalled: false,
      errorCode: code, errorMessage: message,
    });
  },
});

export const inspect = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    const summary = event && await currentSummary(ctx, eventId, await loadFacts(ctx, event));
    const runs = (await runsWithAttempt(ctx, eventId)).slice(0, 10);
    return {
      ...await runFlags(ctx, eventId),
      summary: summary?.lines ?? null,
      runs: runs.map(({ inputKey: _key, checkedOutput: _output, ...run }) => ({ ...run, stage: stageOf(run) })),
    };
  },
});
