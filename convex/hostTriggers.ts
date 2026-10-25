import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hostTrigger } from "./schema/rooms";
import { agentSpanValidator, hostOutputValidator, spanFailure, type AgentSpan, type HostContext, type HostOutput } from "./lib/host";
import { checkResultValidator, type CheckResult } from "./lib/checker";
import { buildHostContext } from "./lib/hostContext";
import { requireFleetScope } from "./fleetQuery";

// Coordination Host runs (roadmap §6 Gemini Host contract). A caller asks explicitly; nothing here watches messages.
// One run per room, input version and trigger; a failed or superseded run may be retried, at most MAX_ATTEMPTS failures.

const MAX_ATTEMPTS = 3;
// Longer than the host call and the parallel checker calls together (90 s each), so only a lost job is timed out.
const RUNNING_TIMEOUT_MS = 10 * 60_000;
// parseCheck's limit for one checker reason; the merged reason stays within it.
const MAX_REASON = 1000;
const hostCheck = v.object({ span: agentSpanValidator, result: v.union(checkResultValidator, v.null()) });
type HostCheck = { span: AgentSpan; result: CheckResult | null };

// A closed room or a reset demo run takes no host work and publishes none.
async function isOpen(ctx: QueryCtx, room: Doc<"rooms">): Promise<boolean> {
  if (room.state === "closed") return false;
  const demo = room.demoRunId && await ctx.db.get(room.demoRunId);
  return !(demo && demo.state === "closed");
}

async function currentInputs(ctx: MutationCtx, run: Doc<"hostRuns">): Promise<boolean> {
  const room = await ctx.db.get(run.roomId);
  if (!room || room.demoRunId !== run.demoRunId || !await isOpen(ctx, room)) return false;
  try {
    return (await buildHostContext(ctx, room, run.trigger)).inputVersion === run.inputVersion;
  } catch {
    // Inputs that can no longer be read are not the inputs the host answered.
    return false;
  }
}

// A job lost before finishing would otherwise hold its input version forever.
async function expireLost(ctx: MutationCtx, roomId: Id<"rooms">, now: number) {
  const lost = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", roomId).lt("createdAt", now - RUNNING_TIMEOUT_MS))
    .filter(q => q.eq(q.field("status"), "running")).collect();
  for (const row of lost) await ctx.db.patch(row._id, { status: "failed", finishedAt: now });
}

/** The allowlisted context the host would get for this room now. */
export const context = internalQuery({
  args: { roomId: v.id("rooms"), trigger: hostTrigger },
  handler: async (ctx, { roomId, trigger }): Promise<HostContext | null> => {
    const room = await ctx.db.get(roomId);
    return room && buildHostContext(ctx, room, trigger);
  },
});

/**
 * Asks the host to run on the room's current inputs. Returns the run that covers them: an existing running or
 * succeeded run, a new attempt after a failed or superseded one, or the last failure once MAX_ATTEMPTS have failed.
 * Returns null without storing a run when there is nothing to do: a closed room or demo run, no linked events, a
 * final_message trigger with no shared messages, or a caller passing an inputVersion the room has moved past.
 */
export const request = internalMutation({
  args: { roomId: v.id("rooms"), trigger: hostTrigger, inputVersion: v.optional(v.string()) },
  returns: v.union(v.id("hostRuns"), v.null()),
  handler: async (ctx, { roomId, trigger, inputVersion: seen }): Promise<Id<"hostRuns"> | null> => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new ConvexError({ code: "NOT_FOUND", message: "Room not found." });
    if (!await isOpen(ctx, room)) return null;
    const now = Date.now();
    await expireLost(ctx, roomId, now);
    const context = await buildHostContext(ctx, room, trigger);
    const { inputVersion } = context;
    if (seen !== undefined && seen !== inputVersion) return null;
    if (!context.events.length || (trigger === "final_message" && !context.messages.length)) return null;
    const rows = await ctx.db.query("hostRuns").withIndex("by_room_input_trigger", q =>
      q.eq("roomId", roomId).eq("inputVersion", inputVersion).eq("trigger", trigger)).collect();
    const covering = rows.find(row => row.status === "running" || row.status === "succeeded");
    if (covering) return covering._id;
    const failed = rows.filter(row => row.status === "failed");
    if (failed.length >= MAX_ATTEMPTS) return failed[failed.length - 1]._id;
    const hostRunId = await ctx.db.insert("hostRuns", {
      roomId, trigger, inputVersion, attempt: rows.length + 1, status: "running", span: null, output: null, check: null,
      demoRunId: room.demoRunId, createdAt: now, finishedAt: null,
    });
    await ctx.scheduler.runAfter(0, internal.hostTriggers.run, { hostRunId });
    return hostRunId;
  },
});

export const load = internalQuery({
  args: { hostRunId: v.id("hostRuns") },
  handler: async (ctx, { hostRunId }) => {
    const run = await ctx.db.get(hostRunId);
    if (!run || run.status !== "running") return null;
    const room = await ctx.db.get(run.roomId);
    return { inputVersion: run.inputVersion, attempt: run.attempt,
      context: room && room.demoRunId === run.demoRunId && await isOpen(ctx, room) ? await buildHostContext(ctx, room, run.trigger) : null };
  },
});

// The hostRuns row has one check field; keeping a separate check per event would need a schema change.
function mergeChecks(checks: ({ eventId: string } & HostCheck)[]): HostCheck {
  const spans = checks.map(c => c.span);
  const firstFailure = spans.find(s => s.status === "failed");
  const usages = spans.flatMap(s => s.usage ? [s.usage] : []);
  const span: AgentSpan = {
    ...spans[0],
    startedAt: Math.min(...spans.map(s => s.startedAt)), finishedAt: Math.max(...spans.map(s => s.finishedAt)),
    status: firstFailure ? "failed" : "succeeded",
    usage: usages.length ? {
      inputTokens: usages.reduce((sum, u) => sum + u.inputTokens, 0), outputTokens: usages.reduce((sum, u) => sum + u.outputTokens, 0),
    } : null,
    errorCode: firstFailure?.errorCode ?? null, errorMessage: firstFailure?.errorMessage ?? null,
  };
  if (checks.every(c => c.result === null)) return { span, result: null };
  // The storage budget must not hide a disagreement behind long successful reasons from earlier events.
  const ordered = [...checks.filter(c => c.result?.agrees !== true), ...checks.filter(c => c.result?.agrees === true)];
  const reason = ordered.map(c => `${c.eventId}: ${c.result?.reason ?? `The check failed (${c.span.errorCode}).`}`).join("\n");
  return {
    span,
    result: {
      agrees: checks.every(c => c.result?.agrees === true),
      reason: reason.length <= MAX_REASON ? reason : `${reason.slice(0, MAX_REASON - 1)}…`,
      flaggedCandidateIds: [...new Set(checks.flatMap(c => c.result?.flaggedCandidateIds ?? []))],
    },
  };
}

// One Grok check per summary against that event's candidates only, so each input stays within the checker's limits.
async function checkSummaries(ctx: ActionCtx, context: HostContext, summaries: HostOutput["summaries"], attempt: number): Promise<HostCheck> {
  const events = new Map(context.events.map(e => [e.eventId, e]));
  const checks = await Promise.all(summaries.map(async s => ({
    eventId: s.eventId,
    ...await ctx.runAction(internal.rationaleCheck.run, {
      input: { inputVersion: context.inputVersion, candidates: events.get(s.eventId)?.candidates ?? [], explanation: s.text }, attempt,
    }),
  })));
  return mergeChecks(checks);
}

// Only our own ConvexError codes and messages are kept; anything else becomes the generic sanitized failure.
function failure(error: unknown): { errorCode: string; errorMessage: string } {
  const data = error instanceof ConvexError ? error.data as { code?: unknown; message?: unknown } : null;
  if (data && typeof data.code === "string" && typeof data.message === "string") return { errorCode: data.code, errorMessage: data.message };
  const { code, message } = spanFailure(error);
  return { errorCode: code, errorMessage: message };
}

export const run = internalAction({
  args: { hostRunId: v.id("hostRuns") },
  returns: v.null(),
  handler: async (ctx, { hostRunId }): Promise<null> => {
    const startedAt = Date.now();
    try {
      const loaded = await ctx.runQuery(internal.hostTriggers.load, { hostRunId });
      if (!loaded) return null;
      const { context, attempt, inputVersion } = loaded;
      // Changed inputs are recognized by finish and stored as superseded without a model call.
      if (!context || context.inputVersion !== inputVersion) {
        await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, span: null, output: null, check: null });
        return null;
      }
      const host = await ctx.runAction(internal.coordinationHost.run, { context, attempt });
      const summaries = host.output?.summaries ?? [];
      const check = summaries.length ? await checkSummaries(ctx, context, summaries, attempt) : null;
      await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, span: host.span, output: host.output, check });
    } catch (error) {
      // The host and checker report their failures as spans; anything else, including a context that can no longer
      // be built, still ends the run so the room can retry.
      await ctx.runMutation(internal.hostTriggers.fail, { hostRunId, startedAt, ...failure(error) });
    }
    return null;
  },
});

/**
 * Stores a run's result after rechecking its inputs. Stale results are superseded with their spans for the trace
 * and no output. Requested revisions are stored only; they never change proposals.
 */
export const finish = internalMutation({
  args: {
    hostRunId: v.id("hostRuns"), span: v.union(agentSpanValidator, v.null()), output: v.union(hostOutputValidator, v.null()),
    check: v.union(hostCheck, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { hostRunId, span, output, check }) => {
    const run = await ctx.db.get(hostRunId);
    if (!run || run.status !== "running") return null;
    const finishedAt = Date.now();
    if (!await currentInputs(ctx, run)) {
      await ctx.db.patch(hostRunId, { status: "superseded", span, output: null, check, finishedAt });
      return null;
    }
    // A checked host result and a successful independent disagreement are distinct results. Round 3 can
    // publish the disagreement alongside the summary; it never authorizes anything. An unavailable or invalid
    // checker result still fails the run, preserving the checked host output for the trace.
    const hostOutput = span?.status === "succeeded" ? output : null;
    const checked = hostOutput !== null &&
      (hostOutput.summaries.length === 0 || (check?.span.status === "succeeded" && check.result !== null));
    await ctx.db.patch(hostRunId, { status: checked ? "succeeded" : "failed", span, output: hostOutput, check, finishedAt });
    return null;
  },
});

/** Ends a run whose job failed outside the host and checker spans, without reading the room again. */
export const fail = internalMutation({
  args: { hostRunId: v.id("hostRuns"), startedAt: v.number(), errorCode: v.string(), errorMessage: v.string() },
  returns: v.null(),
  handler: async (ctx, { hostRunId, startedAt, errorCode, errorMessage }) => {
    const run = await ctx.db.get(hostRunId);
    if (!run || run.status !== "running") return null;
    const finishedAt = Date.now();
    const span: AgentSpan = {
      role: "coordination_host", provider: "google", model: process.env.GEMINI_HOST_MODEL || "unconfigured",
      inputVersion: run.inputVersion, attempt: run.attempt, startedAt, finishedAt, status: "failed", usage: null, errorCode, errorMessage,
    };
    await ctx.db.patch(hostRunId, { status: "failed", span, finishedAt });
    return null;
  },
});

/** A room's latest host runs for the agent trace, newest first. Current involved room members only. */
export const listForRoom = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const { user, objects, companyObjects } = await requireFleetScope(ctx);
    const member = await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", roomId).eq("userId", user._id)).first();
    if (!member || member.companyId !== user.companyId) throw new ConvexError({ code: "FORBIDDEN", message: "Only room members can see its host runs." });
    const owned = new Set(companyObjects.map(o => o.objectId));
    const responsible = new Set(objects.filter(o => owned.has(o.objectId)).map(o => o.objectId));
    const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", roomId)).collect();
    let involved = false;
    for (const link of links) {
      const event = await ctx.db.get(link.eventId);
      if (!event) continue;
      const pair = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
      if (pair.some(object => object && responsible.has(object.objectId))) { involved = true; break; }
    }
    if (!involved) throw new ConvexError({ code: "FORBIDDEN", message: "Current responsibility for a linked event is required." });
    const runs = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", roomId)).order("desc").take(20);
    return runs.map(r => ({
      hostRunId: r._id, trigger: r.trigger, inputVersion: r.inputVersion, attempt: r.attempt, status: r.status,
      span: r.span, output: r.output, check: r.check, createdAt: r.createdAt, finishedAt: r.finishedAt,
    }));
  },
});
