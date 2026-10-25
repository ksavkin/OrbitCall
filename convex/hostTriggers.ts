import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hostTrigger } from "./schema/rooms";
import { agentSpanValidator, hostOutputValidator, type HostContext, type HostOutput } from "./lib/host";
import { checkResultValidator, type CheckInput } from "./lib/checker";
import { buildHostContext } from "./lib/hostContext";
import { requireUser } from "./session";

// Coordination Host runs (roadmap §6 Gemini Host contract). A caller asks explicitly; nothing here watches messages.
// One run per room, input version and trigger; a failed run may be retried up to MAX_ATTEMPTS times.

const MAX_ATTEMPTS = 3;
// Longer than the host and checker calls together (90 s each), so only a lost job is timed out.
const RUNNING_TIMEOUT_MS = 10 * 60_000;
const hostCheck = v.object({ span: agentSpanValidator, result: v.union(checkResultValidator, v.null()) });

// A room's inputs are stale for a run when the room is gone, its demo run was reset, or the inputs changed.
async function currentInputs(ctx: MutationCtx, run: Doc<"hostRuns">): Promise<boolean> {
  const room = await ctx.db.get(run.roomId);
  if (!room) return false;
  const demo = room.demoRunId && await ctx.db.get(room.demoRunId);
  if (demo && demo.state === "closed") return false;
  return (await buildHostContext(ctx, room, run.trigger)).inputVersion === run.inputVersion;
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
 * succeeded run, a new attempt after a failure, or the last failure once MAX_ATTEMPTS is reached. A caller passing
 * the inputVersion it saw gets null when the room has moved on.
 */
export const request = internalMutation({
  args: { roomId: v.id("rooms"), trigger: hostTrigger, inputVersion: v.optional(v.string()) },
  returns: v.union(v.id("hostRuns"), v.null()),
  handler: async (ctx, { roomId, trigger, inputVersion: seen }): Promise<Id<"hostRuns"> | null> => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new ConvexError({ code: "NOT_FOUND", message: "Room not found." });
    const demo = room.demoRunId && await ctx.db.get(room.demoRunId);
    if (demo && demo.state === "closed") return null;
    const { inputVersion } = await buildHostContext(ctx, room, trigger);
    if (seen !== undefined && seen !== inputVersion) return null;
    const rows = await ctx.db.query("hostRuns").withIndex("by_room_input_trigger", q =>
      q.eq("roomId", roomId).eq("inputVersion", inputVersion).eq("trigger", trigger)).collect();
    const now = Date.now();
    for (const row of rows) {
      if (row.status === "running" && now - row.createdAt > RUNNING_TIMEOUT_MS) {
        await ctx.db.patch(row._id, { status: "failed", finishedAt: now });
        row.status = "failed";
      }
    }
    const covering = rows.find(row => row.status !== "failed");
    if (covering) return covering._id;
    if (rows.length >= MAX_ATTEMPTS) return rows[rows.length - 1]._id;
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
    return { inputVersion: run.inputVersion, attempt: run.attempt, context: room && await buildHostContext(ctx, room, run.trigger) };
  },
});

// One combined check of every summary against the candidates of the events it summarizes.
function checkInput(context: HostContext, summaries: HostOutput["summaries"]): CheckInput {
  const summarized = new Set(summaries.map(s => s.eventId));
  return {
    inputVersion: context.inputVersion,
    candidates: context.events.filter(e => summarized.has(e.eventId)).flatMap(e => e.candidates),
    explanation: summaries.map(s => `${s.eventId}: ${s.text}`).join("\n"),
  };
}

export const run = internalAction({
  args: { hostRunId: v.id("hostRuns") },
  returns: v.null(),
  handler: async (ctx, { hostRunId }): Promise<null> => {
    const loaded = await ctx.runQuery(internal.hostTriggers.load, { hostRunId });
    if (!loaded) return null;
    const { context, attempt, inputVersion } = loaded;
    const empty = { span: null, output: null, check: null };
    // Changed inputs are recognized by finish and stored as superseded without a model call.
    if (!context || context.inputVersion !== inputVersion) {
      await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, ...empty });
      return null;
    }
    if (!context.events.length || (context.trigger === "final_message" && !context.messages.length)) {
      await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, ...empty, skipped: true });
      return null;
    }
    try {
      const host = await ctx.runAction(internal.coordinationHost.run, { context, attempt });
      const summaries = host.output?.summaries ?? [];
      const check = summaries.length
        ? await ctx.runAction(internal.rationaleCheck.run, { input: checkInput(context, summaries), attempt }) : null;
      await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, span: host.span, output: host.output, check });
    } catch {
      // The host and checker report failures as spans; anything else still ends the run so a retry can follow.
      await ctx.runMutation(internal.hostTriggers.finish, { hostRunId, ...empty });
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
    check: v.union(hostCheck, v.null()), skipped: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { hostRunId, span, output, check, skipped }) => {
    const run = await ctx.db.get(hostRunId);
    if (!run || run.status !== "running") return null;
    const finishedAt = Date.now();
    if (skipped || !await currentInputs(ctx, run)) {
      await ctx.db.patch(hostRunId, { status: "superseded", span, output: null, check, finishedAt });
      return null;
    }
    const succeeded = span?.status === "succeeded" && output !== null;
    await ctx.db.patch(hostRunId, { status: succeeded ? "succeeded" : "failed", span, output: succeeded ? output : null, check, finishedAt });
    return null;
  },
});

/** A room's latest host runs for the agent trace, newest first. Room members only. */
export const listForRoom = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const { user } = await requireUser(ctx);
    const member = await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", roomId).eq("userId", user._id)).first();
    if (!member) throw new ConvexError({ code: "FORBIDDEN", message: "Only room members can see its host runs." });
    const runs = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", roomId)).order("desc").take(20);
    return runs.map(r => ({
      hostRunId: r._id, trigger: r.trigger, inputVersion: r.inputVersion, attempt: r.attempt, status: r.status,
      span: r.span, output: r.output, check: r.check, createdAt: r.createdAt, finishedAt: r.finishedAt,
    }));
  },
});
