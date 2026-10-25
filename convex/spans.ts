import { ConvexError, v, type Infer } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFleetScope, resolveFleet } from "./fleetQuery";
import type { AgentSpan } from "./lib/host";

// Appendix C is a projection of recorded runs, not a fabricated tool trace. Both public APIs use this scope.
export const traceArgs = { eventId: v.optional(v.id("events")), limit: v.optional(v.number()) };
const runStatus = v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("superseded"));
export const spanView = v.object({
  id: v.string(), parent: v.union(v.string(), v.null()), eventId: v.union(v.id("events"), v.null()),
  agent: v.string(), target: v.string(), kind: v.union(v.literal("llm"), v.literal("check"), v.literal("handoff")),
  name: v.string(), status: v.union(v.literal("running"), v.literal("ok"), v.literal("error"), v.literal("waiting")),
  t0: v.number(), t1: v.optional(v.number()), ms: v.optional(v.number()), progress: v.null(),
  model: v.optional(v.string()), provider: v.optional(v.union(v.literal("anthropic"), v.literal("google"), v.literal("xai"))),
  tokensIn: v.optional(v.number()), tokensOut: v.optional(v.number()), costUsd: v.null(),
  output: v.object({ runStatus, stage: v.optional(v.string()), stalled: v.optional(v.boolean()), simulated: v.boolean(),
    trigger: v.optional(v.string()), callStatus: v.optional(v.union(v.literal("succeeded"), v.literal("failed"))),
    details: v.literal("not_exposed") }),
  error: v.optional(v.string()),
});
export type PublicSpan = Infer<typeof spanView>;
export const logView = v.object({ id: v.string(), t: v.number(), level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
  source: v.string(), msg: v.string(), spanId: v.string(), eventId: v.optional(v.id("events")) });
const MAX_LIMIT = 200, DEFAULT_LIMIT = 50, MAX_EVENTS = 500, MAX_ROOMS = 100, MAX_HISTORY = 1000, MAX_READ_ROWS = 8000;
const excessive = (): never => { throw new ConvexError({ code: "LIMIT_EXCEEDED", message: "This trace history is too large. Narrow the incident scope or archive older run history." }); };
const denied = (): never => { throw new ConvexError({ code: "FORBIDDEN", message: "A current owned fleet assignment is required to read these agent runs." }); };
function limitOf(limit?: number) {
  if (limit !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0)) {
    throw new ConvexError({ code: "VALIDATION", message: "Trace limit must be a positive integer." });
  }
  return Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
}

async function authorizedEvents(ctx: QueryCtx, eventId?: Id<"events">) {
  const scope = await requireFleetScope(ctx);
  const owned = new Set(scope.companyObjects.map(o => o.objectId));
  const objects = scope.objects.filter(o => owned.has(o.objectId));
  if (eventId) {
    const event = await ctx.db.get(eventId);
    const allowed = new Set(objects.map(o => o.objectId));
    const pair = event ? await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]) : [];
    if (!event || !pair.some(object => object && allowed.has(object.objectId))) return denied();
    return [event];
  }
  if (objects.length > MAX_EVENTS) excessive();
  const fleet = new Set((await resolveFleet(ctx, objects)).flatMap(o => o.doc ? [o.doc._id] : []));
  const events = new Map<Id<"events">, Doc<"events">>();
  let read = 0;
  for (const id of fleet) {
    const a = await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", id)).take(MAX_EVENTS + 1);
    const b = await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", id)).take(MAX_EVENTS + 1);
    read += a.length + b.length;
    if (read > MAX_READ_ROWS) excessive();
    for (const event of [...a, ...b]) events.set(event._id, event);
    if (events.size > MAX_EVENTS) excessive();
  }
  return [...events.values()];
}

function timing(start: number, end?: number) {
  // Missing legacy end times remain missing; lastProgressAt is not a measured completion time.
  return { t0: start, ...(end !== undefined && Number.isFinite(end) && end >= start ? { t1: end, ms: end - start } : {}) };
}
function usage(value?: { inputTokens: number; outputTokens: number } | null) {
  return { ...(value && Number.isInteger(value.inputTokens) && value.inputTokens >= 0 ? { tokensIn: value.inputTokens } : {}),
    ...(value && Number.isInteger(value.outputTokens) && value.outputTokens >= 0 ? { tokensOut: value.outputTokens } : {}) };
}
function state(status: Doc<"agentRuns">["status"], stalled = false): PublicSpan["status"] {
  return status === "superseded" || (status === "running" && stalled) ? "waiting"
    : status === "running" ? "running" : status === "succeeded" ? "ok" : "error";
}
function title(name: string, status: Doc<"agentRuns">["status"], stalled = false) {
  return `${name} · ${status === "running" && stalled ? "stalled" : status}`;
}
function agentSpan(run: Doc<"agentRuns">, event: Doc<"events">): PublicSpan | null {
  if (run.role === "operator_advocate" && !run.companyId) return null;
  const agent = run.role === "operator_advocate" ? `advocate:${run.companyId}` : "analyst";
  const name = run.role === "operator_advocate" ? "Operator Advocate" : "Incident Analyst";
  return { id: run._id, parent: null, eventId: event._id, agent, target: agent, kind: run.model ? "llm" : "handoff",
    name: title(name, run.status, run.stalled), status: state(run.status, run.stalled), ...timing(run._creationTime, run.finishedAt),
    progress: null, ...(run.model ? { model: run.model } : {}), ...usage(run.usage), costUsd: null,
    output: { runStatus: run.status, ...(run.stage ? { stage: run.stage } : {}), stalled: run.stalled, simulated: event.simulated, details: "not_exposed" },
    ...(run.status === "failed" ? { error: "This recorded agent attempt failed. Detailed provider errors are not exposed." } : {}),
  };
}
function hostSpan(run: Doc<"hostRuns">, recorded: AgentSpan | null, agent: "host" | "checker", eventId: Id<"events"> | null,
  simulated: boolean): PublicSpan {
  const hostId = `${run._id}:host`, name = agent === "host" ? "Coordination Host" : "Rationale Check";
  const callStatus = recorded?.status;
  return { id: `${run._id}:${agent}`, parent: agent === "checker" ? hostId : null, eventId, agent, target: agent,
    kind: recorded ? agent === "checker" ? "check" : "llm" : "handoff",
    name: title(name, run.status), status: run.status === "superseded" ? "waiting" : callStatus ? state(callStatus) : state(run.status),
    ...timing(recorded?.startedAt ?? run.createdAt, recorded?.finishedAt ?? run.finishedAt ?? undefined), progress: null,
    ...(recorded ? { model: recorded.model, provider: recorded.provider, ...usage(recorded.usage) } : {}), costUsd: null,
    output: { runStatus: run.status, trigger: run.trigger, simulated, details: "not_exposed", ...(callStatus ? { callStatus } : {}) },
    ...(callStatus === "failed" || (!recorded && run.status === "failed") ? { error: "This recorded attempt failed. Detailed provider errors are not exposed." } : {}),
  };
}
const active = (row: PublicSpan) => row.output.runStatus === "running";
const newest = (a: PublicSpan, b: PublicSpan) => Number(active(b)) - Number(active(a)) || b.t0 - a.t0 || a.id.localeCompare(b.id);

/** Shared implementation for spans.list and the thin agentLogs.list facade. */
export async function listSafeSpans(ctx: QueryCtx, args: { eventId?: Id<"events">; limit?: number }): Promise<PublicSpan[]> {
  const limit = limitOf(args.limit), events = await authorizedEvents(ctx, args.eventId);
  const result = new Map<string, PublicSpan>();
  const rooms = new Map<Id<"rooms">, { event: Doc<"events">; linkedAt: number }[]>();
  let read = 0;
  for (const event of events) {
    const [running, recent, links] = await Promise.all([
      ctx.db.query("agentRuns").withIndex("by_event_status", q => q.eq("eventId", event._id).eq("status", "running")).order("desc").take(limit),
      ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", event._id)).order("desc").take(limit),
      ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", event._id)).take(MAX_ROOMS + 1),
    ]);
    read += running.length + recent.length + links.length;
    if (read > MAX_READ_ROWS || links.length > MAX_ROOMS) excessive();
    for (const run of [...running, ...recent]) {
      const span = agentSpan(run, event);
      if (span) result.set(span.id, span);
    }
    for (const link of links) rooms.set(link.roomId, [...(rooms.get(link.roomId) ?? []), { event, linkedAt: link.linkedAt }]);
    if (rooms.size > MAX_ROOMS) excessive();
  }
  for (const [roomId, linked] of rooms) {
    const room = await ctx.db.get(roomId);
    if (!room) continue;
    // No status index exists on hostRuns. Read a bounded complete room history so an old still-running attempt
    // cannot disappear behind recent finished runs. Oversized history fails visibly instead of leaking globally.
    const runs = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", roomId)).order("desc").take(MAX_HISTORY + 1);
    read += runs.length;
    if (runs.length > MAX_HISTORY || read > MAX_READ_ROWS) excessive();
    for (const run of runs) {
      if (run.demoRunId !== room.demoRunId) continue;
      const relevant = [...new Map(linked.filter(l => l.linkedAt <= run.createdAt && (l.event.demoRunId ?? null) === run.demoRunId)
        .map(l => [l.event._id, l])).values()];
      if (!relevant.length) continue;
      const eventId = args.eventId ?? (relevant.length === 1 ? relevant[0].event._id : null);
      // Only measured metadata crosses this boundary. Even an event-labelled Host summary may mention another
      // event in the room, and the merged checker reason may contain facts from all of them.
      const main = hostSpan(run, run.span, "host", eventId, room.simulated);
      result.set(main.id, main);
      if (run.check?.span) {
        const checker = hostSpan(run, run.check.span, "checker", eventId, room.simulated);
        result.set(checker.id, checker);
      }
    }
  }
  return [...result.values()].sort(newest).slice(0, limit);
}

export const list = query({ args: traceArgs, returns: v.array(spanView), handler: listSafeSpans });

export async function listSafeLogs(ctx: QueryCtx, args: { eventId?: Id<"events">; limit?: number }): Promise<Infer<typeof logView>[]> {
  return (await listSafeSpans(ctx, args)).map(span => ({
    id: `${span.id}:status`, t: span.t1 ?? span.t0,
    level: span.output.runStatus === "failed" ? "error" as const
      : span.output.runStatus === "superseded" || span.output.stalled ? "warn" as const : "info" as const,
    source: span.agent, msg: `${span.name}. Detailed output is not exposed in the trace.`, spanId: span.id,
    ...(span.eventId ? { eventId: span.eventId } : {}),
  }));
}
