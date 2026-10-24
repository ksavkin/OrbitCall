import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { checkAndRenderSummary, inputKey, STALLED_AFTER_MS, validateFacts } from "./lib/analyst";
import { factsFromEvent } from "./lib/events";

async function refreshFlags(ctx: MutationCtx, eventId: Id<"events">) {
  const active = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
    q.eq("eventId", eventId).eq("status", "running")).collect();
  if (await ctx.db.get(eventId)) await ctx.db.patch(eventId, {
    agentsWorking: active.length > 0,
    agentsStalled: active.some(run => run.stalled),
  });
}

export const begin = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    const input = factsFromEvent(event);
    validateFacts(input);
    const key = inputKey(input);
    const previous = await ctx.db.query("agentRuns").withIndex("by_event_role", q =>
      q.eq("eventId", eventId).eq("role", "incident_analyst")).order("desc").first();
    if (previous?.inputKey === key && ["running", "succeeded"].includes(previous.status)) return null;
    const now = Date.now();
    if (previous?.status === "running") await ctx.db.patch(previous._id, {
      status: "superseded", finishedAt: now, stalled: false, stage: "superseded",
    });
    const runId = await ctx.db.insert("agentRuns", {
      eventId, role: "incident_analyst", inputKey: key, input,
      status: "running", attempt: (previous?.attempt ?? 0) + 1,
      startedAt: now, lastProgressAt: now, finishedAt: null, stalled: false,
      stage: "loading", errorCode: null, errorMessage: null, model: null, usage: null,
    });
    await refreshFlags(ctx, eventId);
    await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
    return { runId, input };
  },
});

export const progress = internalMutation({
  args: { runId: v.id("agentRuns"), stage: v.string(), model: v.optional(v.string()) },
  handler: async (ctx, { runId, stage, model }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(runId, { stage, lastProgressAt: Date.now(), stalled: false,
      ...(model ? { model } : {}) });
    // A stalled watchdog has stopped polling. Resume monitoring if work resumes.
    if (run.stalled) await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
    await refreshFlags(ctx, run.eventId);
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
    await refreshFlags(ctx, run.eventId);
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
    const latest = await ctx.db.query("agentRuns").withIndex("by_event_role", q =>
      q.eq("eventId", run.eventId).eq("role", "incident_analyst")).order("desc").first();
    if (!event || latest?._id !== runId || inputKey(factsFromEvent(event)) !== run.inputKey) {
      await ctx.db.patch(runId, { status: "superseded", stage: "superseded", finishedAt: Date.now(), stalled: false });
      await refreshFlags(ctx, run.eventId);
      return { published: false };
    }
    // Validate again inside the publishing transaction. A caller cannot bypass the gate.
    const summaryLines = checkAndRenderSummary(raw, run.input);
    const previous = await ctx.db.query("eventSummaries").withIndex("by_event", q => q.eq("eventId", run.eventId)).unique();
    const summary = {
      eventId: run.eventId, runId, inputKey: run.inputKey, summaryLines,
      numbersChecked: true as const, originalLang: "en" as const,
      createdAt: new Date().toISOString(), simulated: event.simulated,
    };
    if (previous) await ctx.db.replace(previous._id, summary);
    else await ctx.db.insert("eventSummaries", summary);
    await ctx.db.patch(runId, { status: "succeeded", stage: "completed", finishedAt: Date.now(), stalled: false, model, usage });
    await refreshFlags(ctx, run.eventId);
    return { published: true };
  },
});

export const fail = internalMutation({
  args: { runId: v.id("agentRuns"), code: v.string(), message: v.string() },
  handler: async (ctx, { runId, code, message }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(runId, {
      status: "failed", stage: "failed", finishedAt: Date.now(), stalled: false,
      errorCode: code, errorMessage: message,
    });
    await refreshFlags(ctx, run.eventId);
  },
});

export const inspect = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    const runs = await ctx.db.query("agentRuns").withIndex("by_event_role", q =>
      q.eq("eventId", eventId).eq("role", "incident_analyst")).order("desc").take(10);
    const summary = await ctx.db.query("eventSummaries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return {
      agentsWorking: event?.agentsWorking ?? false, agentsStalled: event?.agentsStalled ?? false,
      summary: event && summary?.inputKey === inputKey(factsFromEvent(event)) ? summary.summaryLines : null,
      runs: runs.map(({ input: _input, inputKey: _key, ...run }) => run),
    };
  },
});
