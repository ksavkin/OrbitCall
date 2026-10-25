import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { checkAndRenderSummary, inputKey, type EventFacts } from "./analyst";

// Working/stalled come from the runs themselves, never from a copy on the event.
export async function runFlags(ctx: QueryCtx, eventId: Id<"events">) {
  const running = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
    q.eq("eventId", eventId).eq("status", "running")).collect();
  return { agentsWorking: running.length > 0, agentsStalled: running.some(run => run.stalled) };
}

export function latestRun(ctx: QueryCtx, eventId: Id<"events">) {
  return ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", eventId))
    .filter(q => q.neq(q.field("role"), "operator_advocate")).order("desc").first();
}

// Runs newest first, each with its attempt number for the event.
export async function runsWithAttempt(ctx: QueryCtx, eventId: Id<"events">) {
  const runs = await ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", eventId))
    .filter(q => q.neq(q.field("role"), "operator_advocate")).collect();
  return runs.map((run, i) => ({ ...run, attempt: i + 1 })).reverse();
}

export const stageOf = (run: Pick<Doc<"agentRuns">, "stage" | "status">) => run.stage ?? (run.status === "succeeded" ? "completed" : run.status);

// The latest published summary, rendered against the current facts; null once the evidence changed.
export async function currentSummary(ctx: QueryCtx, eventId: Id<"events">, facts: EventFacts) {
  const run = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
    q.eq("eventId", eventId).eq("status", "succeeded"))
    .filter(q => q.neq(q.field("role"), "operator_advocate")).order("desc").first();
  if (!run?.checkedOutput || run.inputKey !== inputKey(facts)) return null;
  return { lines: checkAndRenderSummary(run.checkedOutput, facts), finishedAt: run.finishedAt ?? run._creationTime };
}

export async function supersede(ctx: MutationCtx, runId: Id<"agentRuns">) {
  await ctx.db.patch(runId, { status: "superseded", stage: undefined, finishedAt: Date.now(), stalled: false });
}
