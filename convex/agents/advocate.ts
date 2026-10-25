"use node";

import { internalAction, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { memoryNote, type MemoryNote } from "../lib/advocateMemory";
import { createRunAssistant, recallMemory, writeMemory, closeRunAssistant } from "../lib/backboard";
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
      const memory = await memoryForRun(ctx, runId);
      if (!memory) return null;
      await ctx.runMutation(internal.agentRuns.progress, { runId, stage: "calling_model", model });
      const result = await callClaude(advocatePrompt({ ...input, memory }));
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


type Batch = NonNullable<FunctionReturnType<typeof internal.advocates.memoryBatch>>;
async function ensureAssistant(ctx: ActionCtx, eventId: Id<"events">, companyId: Id<"companies">): Promise<{
  assistantId: string; rowId: Id<"memoryAssistants">; demoRunId: Id<"demoRuns">;
} | null> {
  if (!process.env.BACKBOARD_API_KEY) return null;
  const token = crypto.randomUUID();
  const reservation = await ctx.runMutation(internal.advocates.reserveMemoryAssistant, { eventId, companyId, token });
  if (reservation.status === "ready") return reservation;
  if (reservation.status !== "create") return null;
  let assistantId: string;
  try { ({ assistantId } = await createRunAssistant({ companyId, demoRunId: reservation.demoRunId })); }
  catch {
    await ctx.runMutation(internal.advocates.failMemoryAssistant, { demoRunId: reservation.demoRunId, companyId, token });
    return null;
  }
  const registered = await ctx.runMutation(internal.advocates.registerMemoryAssistant, {
    demoRunId: reservation.demoRunId, companyId, token, assistantId,
  });
  return registered.usable ? { assistantId, rowId: registered.rowId, demoRunId: reservation.demoRunId } : null;
}

async function flushItems(ctx: ActionCtx, companyId: Id<"companies">, batch: Batch): Promise<{ written: number; failed: boolean }> {
  let written = 0, failed = batch.writeFailed;
  for (const item of batch.items) {
    const token = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.advocates.reserveMemoryWrite, {
      eventId: item.item.sourceEventId as Id<"events">, companyId, understoodId: item.understoodId, token,
    });
    if (!claim) continue;
    let success = false;
    try { await writeMemory(claim.assistantId, claim.item); success = true; written++; }
    catch { failed = true; }
    await ctx.runMutation(internal.advocates.finishMemoryWrite, {
      demoRunId: claim.demoRunId, companyId, understoodId: claim.understoodId, rowId: claim.rowId, token, success,
    });
  }
  return { written, failed };
}

async function memoryForRun(ctx: ActionCtx, runId: Id<"agentRuns">): Promise<MemoryNote | null> {
  const scope = await ctx.runQuery(internal.advocates.memoryScope, { runId });
  if (!scope) return null;
  let note = memoryNote({ status: "available", entries: [] }, scope.companyId), writeFailed = false;
  if (scope.demoRunId) {
    try {
      const batch = await ctx.runQuery(internal.advocates.memoryBatch, { eventId: scope.eventId, companyId: scope.companyId, previous: true });
      const assistant = batch && await ensureAssistant(ctx, scope.eventId, scope.companyId);
      if (!batch || !assistant) note = memoryNote({ status: "unavailable", reason: "Memory unavailable" }, scope.companyId);
      else {
        writeFailed = (await flushItems(ctx, scope.companyId, batch)).failed;
        // Recheck after external writes, and again after recall: a reset/correction never becomes fresh memory.
        const fresh = await ctx.runQuery(internal.advocates.memoryBatch, { eventId: scope.eventId, companyId: scope.companyId, previous: true });
        if (!fresh) {
          await ctx.runMutation(internal.advocates.noteMemory, { runId, status: "unavailable", sourceEventIds: [], writeFailed });
          return null;
        }
        const recalled = await recallMemory(assistant.assistantId, { companyId: scope.companyId, demoRunId: scope.demoRunId,
          query: "Previously stated maneuver timing and operational preferences relevant to this company's next incident.", limit: 3 });
        const current = await ctx.runQuery(internal.advocates.memoryBatch, { eventId: scope.eventId, companyId: scope.companyId, previous: true });
        if (!current) {
          await ctx.runMutation(internal.advocates.noteMemory, { runId, status: "unavailable", sourceEventIds: [], writeFailed });
          return null;
        }
        note = memoryNote(recalled.status === "unavailable" ? recalled : { status: "available", entries: recalled.entries.filter(entry =>
          current.items.some(source => source.item.sourceEventId === entry.sourceEventId && source.item.text === entry.text &&
            entry.sourceMessageIds.length === source.item.sourceMessageIds.length &&
            entry.sourceMessageIds.every(id => source.item.sourceMessageIds.includes(id)))) }, scope.companyId);
      }
    } catch { note = memoryNote({ status: "unavailable", reason: "Memory unavailable" }, scope.companyId); }
  }
  const published = await ctx.runMutation(internal.advocates.noteMemory, { runId, status: note.status,
    sourceEventIds: [...new Set(note.quotes.map(item => item.sourceEventId as Id<"events">))], writeFailed });
  return published ? note : null;
}

// Integration entry after an outcome. It accepts IDs only: preferences, sources and outcomes are re-read in Convex.
// Prior outcomes are also flushed before the next incident's recall, so this feature does not depend on room navigation.
export const rememberOutcome = internalAction({
  args: { eventId: v.id("events"), companyId: v.id("companies") },
  handler: async (ctx, { eventId, companyId }): Promise<{ written: number; failed: boolean }> => {
    const batch = await ctx.runQuery(internal.advocates.memoryBatch, { eventId, companyId, previous: false });
    if (!batch?.items.length) return { written: 0, failed: false };
    if (!await ensureAssistant(ctx, eventId, companyId)) return { written: 0, failed: true };
    return flushItems(ctx, companyId, batch);
  },
});

export const cleanupMemoryAssistant = internalAction({
  args: { rowId: v.id("memoryAssistants"), attempt: v.number() },
  handler: async (ctx, { rowId, attempt }): Promise<null> => {
    const row = await ctx.runQuery(internal.advocates.memoryCleanupScope, { rowId });
    if (!row) return null;
    let success = false;
    try { await closeRunAssistant(row.assistantId); success = true; } catch { /* Persist only a generic cleanup status. */ }
    await ctx.runMutation(internal.advocates.memoryCleanupResult, { rowId, success, attempt });
    return null;
  },
});
