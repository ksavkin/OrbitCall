import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { buildMemoryItem } from "./lib/advocateMemory";
import { AnalystError } from "./lib/analyst";
import { backboardConfig, closeRunAssistant, createRunAssistant, recallMemory, writeMemory } from "./lib/backboard";
import { buildFacts, isoUtc, putFixture } from "./lib/events";
import { exportFields } from "./lib/tigerExport";
import type { AgentSpan, HostContext } from "./lib/host";

// An explicit operator-run diagnostic, never a browser endpoint, startup hook or health check.
// All evidence is synthetic and lives in a new run. Provider calls use the real application adapters.
const KIND = "provider_readiness_v1";
const PREFIX = "readiness:";
const PREFERENCE = "Prefer to discuss timing after the imaging pass.";
const PROVIDERS = ["claude", "gemini", "grok", "backboard", "tiger"] as const;
const provider = v.union(v.literal("claude"), v.literal("gemini"), v.literal("grok"), v.literal("backboard"), v.literal("tiger"));
const usage = v.union(v.object({ inputTokens: v.number(), outputTokens: v.number() }), v.null());
const resultValidator = v.object({
  provider, status: v.union(v.literal("succeeded"), v.literal("failed")), model: v.union(v.string(), v.null()),
  usage, durationMs: v.number(), errorCode: v.union(v.string(), v.null()),
  // Only checked synthetic output or an allowlisted receipt, never provider bodies, connection URLs or errors.
  resultJson: v.union(v.string(), v.null()),
});
type Result = Infer<typeof resultValidator>;
type Provider = Result["provider"];
type Fixture = {
  runId: Id<"demoRuns">; companyId: Id<"companies">; eventId: Id<"events">; roomId: Id<"rooms">;
  messageId: Id<"messages">; exportId: Id<"observationExports">; inputVersion: string; observedAt: string;
  context: HostContext;
};
const runArgs = { runId: v.id("demoRuns") };
const invalid = () => new ConvexError({ code: "INVALID_STATE", message: "This is not a provider-readiness run." });
const safeCode = (code: string | null | undefined) => code && /^[A-Z_]{1,64}$/.test(code) ? code : "CHECK_FAILED";
const safeModel = (model: string | null | undefined) => model && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(model) ? model : null;
const failed = (name: Provider, startedAt: number, code = "CHECK_FAILED"): Result => ({
  provider: name, status: "failed", model: null, usage: null, durationMs: Math.max(0, Date.now() - startedAt),
  errorCode: safeCode(code), resultJson: null,
});
const fromSpan = (name: "gemini" | "grok", span: AgentSpan, output: unknown | null): Result => ({
  provider: name, status: span.status === "succeeded" && output !== null ? "succeeded" : "failed",
  model: safeModel(span.model), usage: span.usage, durationMs: Math.max(0, span.finishedAt - span.startedAt),
  errorCode: span.status === "succeeded" && output !== null ? null : safeCode(span.errorCode),
  resultJson: span.status === "succeeded" && output !== null ? JSON.stringify(output) : null,
});

async function ownedRun(ctx: QueryCtx, runId: Id<"demoRuns">) {
  const run = await ctx.db.get(runId);
  if (run?.scenario !== KIND || run.manifest?.[`${PREFIX}kind`] !== KIND) throw invalid();
  const eventId = ctx.db.normalizeId("events", String(run.manifest[`${PREFIX}eventId`]));
  const roomId = ctx.db.normalizeId("rooms", String(run.manifest[`${PREFIX}roomId`]));
  const companyId = ctx.db.normalizeId("companies", String(run.manifest[`${PREFIX}companyId`]));
  if (!eventId || !roomId || !companyId) throw invalid();
  const [event, room, company] = await Promise.all([ctx.db.get(eventId), ctx.db.get(roomId), ctx.db.get(companyId)]);
  if (event?.demoRunId !== runId || room?.demoRunId !== runId || !event.simulated || !room.simulated
    || company?.key !== `${KIND}:${runId}` || !company.simulated) throw invalid();
  return { run, event, room, company };
}

export const prepare = internalMutation({
  args: {},
  handler: async (ctx): Promise<Fixture> => {
    const now = Date.now();
    const runId = await ctx.db.insert("demoRuns", {
      scenario: KIND, state: "open", startedBy: null, manifest: null, startedAt: now, closedAt: null,
    });
    const companyId = await ctx.db.insert("companies", {
      key: `${KIND}:${runId}`, name: "Synthetic provider readiness company", simulated: true,
    });
    // Injective decimal encoding keeps the SIM-<digits> contract and never reuses a catalog or demo object.
    const digits = [...runId].map(c => c.charCodeAt(0).toString().padStart(3, "0")).join("");
    const object = (side: string) => ({
      objectId: `SIM-${digits}${side}`, name: `Synthetic readiness ${side}`, country: null, launchDate: null,
    });
    const observedAt = isoUtc(now);
    const facts = buildFacts({ tcaMs: now + 86_400_000, missKm: 1.25, relSpeedKmS: 7.5, pcValue: 1e-7, simulated: true },
      object("1"), object("2"), [{ name: "simulated", url: null, epochUtc: observedAt, fetchedAt: observedAt }]);
    const eventId = await putFixture(ctx, `${KIND}:${runId}`, facts, "none");
    await ctx.db.patch(eventId, { demoRunId: runId });
    const roomId = await ctx.db.insert("rooms", {
      state: "open", companyIds: [companyId], demoRunId: runId, simulated: true, createdAt: now, closedAt: null,
    });
    await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: now });
    // A labeled diagnostic source, not a fabricated human statement or an approval.
    const messageId = await ctx.db.insert("messages", {
      roomId, eventId, author: { kind: "system" }, kind: "system", originalText: PREFERENCE, originalLang: "en",
      translations: { en: PREFERENCE }, translationStatus: { en: "original_only" }, values: [],
      refs: { eventId }, form: null, demoRunId: runId, simulated: true, createdAt: now,
    });
    const inputVersion = `${KIND}:${runId}`;
    // A private diagnostic ledger row lets exportObservation run once immediately, without racing its queue.
    // The actual SQL export, idempotency check and cache refresh still use the production history actions.
    const exportId = await ctx.db.insert("observationExports", {
      ...exportFields(eventId, { observedAt, source: "simulated", metric: "missKm", value: facts.missKm,
        evidenceVersion: inputVersion, simulated: true, runId }),
      exportState: "pending", attempts: 0, lastError: null, updatedAt: now,
    });
    await ctx.db.patch(runId, { manifest: {
      [`${PREFIX}kind`]: KIND, [`${PREFIX}mode`]: "live_calls_synthetic_input", [`${PREFIX}status`]: "running",
      [`${PREFIX}eventId`]: eventId, [`${PREFIX}roomId`]: roomId, [`${PREFIX}companyId`]: companyId,
      [`${PREFIX}messageId`]: messageId, [`${PREFIX}exportId`]: exportId, [`${PREFIX}inputVersion`]: inputVersion,
      [`${PREFIX}observedAt`]: observedAt, [`${PREFIX}cleanup`]: "pending",
    } });
    // If the calling action is interrupted, close just this diagnostic and its registered memory assistant.
    await ctx.scheduler.runAfter(10 * 60_000, internal.providerReadiness.cleanup, { runId });
    return { runId, companyId, eventId, roomId, messageId, exportId, inputVersion, observedAt, context: {
      roomId, inputVersion, trigger: "summary_requested", members: [{ companyId, language: "en" }],
      events: [{ eventId, objectAId: facts.objectA.objectId, objectBId: facts.objectB.objectId, debris: false,
        tcaUtc: facts.tcaUtc, missKm: facts.missKm, simulated: true, candidates: [], feasibility: [], approvals: [] }],
      messages: [{ messageId, companyId, language: "en", text: PREFERENCE, createdAt: observedAt }],
    } };
  },
});

export const saveResult = internalMutation({
  args: { ...runArgs, result: resultValidator }, returns: v.null(),
  handler: async (ctx, { runId, result }) => {
    const { run } = await ownedRun(ctx, runId);
    // A late provider completion cannot turn an interrupted diagnostic into a successful one.
    if (run.state !== "open") return null;
    await ctx.db.patch(runId, { manifest: { ...run.manifest, [`${PREFIX}${result.provider}`]: JSON.stringify(result) } });
    return null;
  },
});

export const registerAssistant = internalMutation({
  args: { ...runArgs, assistantId: v.string() }, returns: v.null(),
  handler: async (ctx, { runId, assistantId }) => {
    const { run, company } = await ownedRun(ctx, runId);
    const prior = await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", runId)).unique();
    if (prior && prior.assistantId !== assistantId) throw invalid();
    if (!prior) await ctx.db.insert("memoryAssistants", {
      demoRunId: runId, companyId: company._id, assistantId, createdAt: Date.now(), closedAt: null,
    });
    await ctx.db.patch(runId, { manifest: { ...run.manifest, [`${PREFIX}cleanup`]: "pending",
      [`${PREFIX}assistantCreation`]: "registered" } });
    // Preserve a late-created namespace for cleanup even when the run closed during the remote request.
    if (run.state !== "open") await ctx.scheduler.runAfter(0, internal.providerReadiness.cleanup, { runId });
    return null;
  },
});

export const reserveAssistant = internalMutation({
  args: runArgs, returns: v.null(),
  handler: async (ctx, { runId }) => {
    const { run } = await ownedRun(ctx, runId);
    if (run.state !== "open" || run.manifest?.[`${PREFIX}assistantCreation`]) throw invalid();
    await ctx.db.patch(runId, { manifest: { ...run.manifest, [`${PREFIX}assistantCreation`]: "pending" } });
    return null;
  },
});

export const memoryWrite = internalMutation({
  args: { ...runArgs, state: v.union(v.literal("begin"), v.literal("settled")) }, returns: v.boolean(),
  handler: async (ctx, { runId, state }) => {
    const { run } = await ownedRun(ctx, runId);
    const assistant = await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", runId)).unique();
    if (state === "begin") {
      if (run.state !== "open" || !assistant || assistant.closedAt !== null) return false;
      await ctx.db.patch(runId, { manifest: { ...run.manifest, [`${PREFIX}memoryWrite`]: "pending" } });
    } else {
      await ctx.db.patch(runId, { manifest: { ...run.manifest, [`${PREFIX}memoryWrite`]: "settled",
        ...(run.state === "closed" ? { [`${PREFIX}cleanup`]: "pending" } : {}) } });
      // A write can finish after a watchdog/reset already deleted the assistant's memories.
      // Retry deletion of this exact namespace; a past cleanup receipt cannot cover a later write.
      if (run.state === "closed" && assistant) {
        await ctx.db.patch(assistant._id, { closedAt: null });
        await ctx.scheduler.runAfter(0, internal.providerReadiness.cleanup, { runId });
      }
    }
    return true;
  },
});

export const snapshot = internalQuery({
  args: runArgs,
  handler: async (ctx, { runId }) => {
    const { run, event, room } = await ownedRun(ctx, runId);
    const exportId = ctx.db.normalizeId("observationExports", String(run.manifest?.[`${PREFIX}exportId`]));
    const exported = exportId && await ctx.db.get(exportId);
    const series = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
    const assistant = await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", runId)).unique();
    return { run, eventId: event._id, roomId: room._id, exported, series, assistant };
  },
});

export const closeFixture = internalMutation({
  args: { ...runArgs, memoryClosed: v.boolean() }, returns: v.null(),
  handler: async (ctx, { runId, memoryClosed }) => {
    const { run, event, room } = await ownedRun(ctx, runId);
    const now = Date.now();
    const results = PROVIDERS.map(name => {
      const value = run.manifest?.[`${PREFIX}${name}`];
      return typeof value === "string" ? JSON.parse(value) as Result : null;
    });
    const complete = results.every(result => result !== null);
    const status = !complete ? "interrupted" : results.every(result => result?.status === "succeeded") ? "passed" : "failed";
    const writePending = run.manifest?.[`${PREFIX}memoryWrite`] === "pending";
    await ctx.db.patch(runId, { state: "closed", closedAt: run.closedAt ?? now, manifest: {
      ...run.manifest, [`${PREFIX}status`]: status,
      [`${PREFIX}cleanup`]: writePending ? "pending" : memoryClosed ? "complete" : "failed",
    } });
    await ctx.db.patch(event._id, { active: false });
    await ctx.db.patch(room._id, { state: "closed", closedAt: room.closedAt ?? now });
    if (memoryClosed && !writePending) {
      const assistant = await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", runId)).unique();
      if (assistant) await ctx.db.patch(assistant._id, { closedAt: assistant.closedAt ?? now });
    }
    return null;
  },
});

export const cleanup = internalAction({
  args: runArgs, returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const state = await ctx.runQuery(internal.providerReadiness.snapshot, { runId });
    if (state.run.state === "closed" && state.run.manifest?.[`${PREFIX}cleanup`] === "complete") return null;
    // Fence new work before the first remote delete, including when this is the interruption watchdog.
    await ctx.runMutation(internal.providerReadiness.closeFixture, { runId, memoryClosed: false });
    // A timed-out create may have reached Backboard. Never claim cleanup of an unknown namespace.
    let memoryClosed = state.assistant ? state.assistant.closedAt !== null
      : state.run.manifest?.[`${PREFIX}assistantCreation`] !== "pending";
    if (!memoryClosed && state.assistant) {
      try { await closeRunAssistant(state.assistant.assistantId); memoryClosed = true; }
      catch { /* The manifest retains failure and the exact namespace row for an explicit cleanup retry. */ }
    }
    await ctx.runMutation(internal.providerReadiness.closeFixture, { runId, memoryClosed });
    return null;
  },
});

async function probeClaude(ctx: ActionCtx, fixture: Fixture): Promise<Result> {
  const startedAt = Date.now();
  await ctx.runAction(internal.agents.analyst.start, { eventId: fixture.eventId });
  const inspected = await ctx.runQuery(internal.agentRuns.inspect, { eventId: fixture.eventId });
  const run = inspected.runs.find(row => row.role === "incident_analyst");
  if (run?.status !== "succeeded" || inspected.summary?.length !== 5) return failed("claude", startedAt, run?.errorCode);
  return { provider: "claude", status: "succeeded", model: safeModel(run.model), usage: run.usage ?? null,
    durationMs: Math.max(0, Date.now() - startedAt), errorCode: null,
    resultJson: JSON.stringify({ agentRunId: run._id, numbersChecked: true, summary: inspected.summary }) };
}

async function probeBackboard(ctx: ActionCtx, fixture: Fixture): Promise<Result> {
  const startedAt = Date.now();
  backboardConfig();
  await ctx.runMutation(internal.providerReadiness.reserveAssistant, { runId: fixture.runId });
  const created = await createRunAssistant({ companyId: fixture.companyId, demoRunId: fixture.runId });
  await ctx.runMutation(internal.providerReadiness.registerAssistant, { runId: fixture.runId, assistantId: created.assistantId });
  const item = buildMemoryItem({ companyId: fixture.companyId, demoRunId: fixture.runId, preference: PREFERENCE,
    sourceEventId: fixture.eventId, sourceMessageIds: [fixture.messageId] });
  if (!await ctx.runMutation(internal.providerReadiness.memoryWrite, { runId: fixture.runId, state: "begin" })) {
    return failed("backboard", startedAt, "INACTIVE_DIAGNOSTIC");
  }
  let written: { memoryId: string };
  try { written = await writeMemory(created.assistantId, item); }
  finally { await ctx.runMutation(internal.providerReadiness.memoryWrite, { runId: fixture.runId, state: "settled" }); }
  const afterWrite = await ctx.runQuery(internal.providerReadiness.snapshot, { runId: fixture.runId });
  if (afterWrite.run.state !== "open") return failed("backboard", startedAt, "INACTIVE_DIAGNOSTIC");
  const recalled = await recallMemory(created.assistantId, { companyId: fixture.companyId, demoRunId: fixture.runId,
    query: PREFERENCE, limit: 3 });
  const exact = recalled.status === "available" && recalled.entries.some(entry => entry.memoryId === written.memoryId
    && entry.text === item.text && entry.companyId === fixture.companyId && entry.sourceEventId === fixture.eventId
    && entry.sourceMessageIds.length === 1 && entry.sourceMessageIds[0] === fixture.messageId);
  if (!exact) return failed("backboard", startedAt, recalled.status === "unavailable" ? "MEMORY_UNAVAILABLE" : "MEMORY_NOT_RECALLED");
  return { provider: "backboard", status: "succeeded", model: null, usage: null,
    durationMs: Math.max(0, Date.now() - startedAt), errorCode: null,
    resultJson: JSON.stringify({ exactWriteRecalled: true, sourceEventId: fixture.eventId, sourceMessageId: fixture.messageId }) };
}

async function probeTiger(ctx: ActionCtx, fixture: Fixture): Promise<Result> {
  const startedAt = Date.now();
  await ctx.runAction(internal.historyActions.exportObservation, { exportId: fixture.exportId });
  await ctx.runAction(internal.historyActions.refreshSeries, { eventId: fixture.eventId });
  const state = await ctx.runQuery(internal.providerReadiness.snapshot, { runId: fixture.runId });
  const exact = state.exported?.exportState === "exported" && state.exported.demoRunId === fixture.runId
    && state.series && !state.series.stale && state.series.points.some(point => point.simulated
      && point.source === "simulated" && point.atUtc === fixture.observedAt && point.missKm === 1.25 && point.pc === null);
  if (!exact) return failed("tiger", startedAt, "HISTORY_WRITE_READ_NOT_VERIFIED");
  return { provider: "tiger", status: "succeeded", model: null, usage: null,
    durationMs: Math.max(0, Date.now() - startedAt), errorCode: null,
    resultJson: JSON.stringify({ exportId: fixture.exportId, observationKey: state.exported!.observationKey,
      seriesVersion: state.series!.seriesVersion, source: "simulated", simulated: true,
      observedAt: fixture.observedAt, missKm: 1.25, pc: null }) };
}

export const run = internalAction({
  args: { confirmation: v.literal("RUN_LIVE_PROVIDER_CHECKS") },
  returns: v.object({ runId: v.id("demoRuns"), status: v.string(), cleanup: v.string(), results: v.array(resultValidator) }),
  handler: async (ctx): Promise<{ runId: Id<"demoRuns">; status: string; cleanup: string; results: Result[] }> => {
    const fixture = await ctx.runMutation(internal.providerReadiness.prepare, {});
    const jobs: Record<Provider, () => Promise<Result>> = {
      claude: () => probeClaude(ctx, fixture),
      gemini: async () => {
        const result = await ctx.runAction(internal.coordinationHost.run, { context: fixture.context, attempt: 1 });
        if (result.span.status === "succeeded" && !result.output?.summaries.some(summary => summary.eventId === fixture.eventId)) {
          return { ...fromSpan("gemini", result.span, null), errorCode: "HOST_SUMMARY_MISSING" };
        }
        return fromSpan("gemini", result.span, result.output);
      },
      grok: async () => {
        const result = await ctx.runAction(internal.rationaleCheck.run, { attempt: 1, input: {
          inputVersion: fixture.inputVersion, candidates: [],
          explanation: "The discussion is pending. No maneuver candidate has been published.",
        } });
        // Disagreement is a checked result, not a network failure or an approval.
        return fromSpan("grok", result.span, result.result);
      },
      backboard: () => probeBackboard(ctx, fixture), tiger: () => probeTiger(ctx, fixture),
    };
    const results: Result[] = [];
    try {
      await Promise.allSettled(PROVIDERS.map(async name => {
        const startedAt = Date.now();
        let result: Result;
        try { result = await jobs[name](); }
        catch (error) { result = failed(name, startedAt, error instanceof AnalystError ? error.code : "PROVIDER_CHECK_FAILED"); }
        await ctx.runMutation(internal.providerReadiness.saveResult, { runId: fixture.runId, result });
        results.push(result);
      }));
    } finally {
      await ctx.runAction(internal.providerReadiness.cleanup, { runId: fixture.runId });
    }
    const state = await ctx.runQuery(internal.providerReadiness.snapshot, { runId: fixture.runId });
    return { runId: fixture.runId, status: String(state.run.manifest?.[`${PREFIX}status`]),
      cleanup: String(state.run.manifest?.[`${PREFIX}cleanup`]),
      results: PROVIDERS.flatMap(name => results.filter(result => result.provider === name)) };
  },
});

// Export only the sanitized report. `snapshot` is an internal diagnostic helper, not an app query.
export const report = internalQuery({
  args: runArgs,
  handler: async (ctx, { runId }) => {
    const { run } = await ownedRun(ctx, runId);
    return { runId, startedAt: run.startedAt, closedAt: run.closedAt, manifest: run.manifest };
  },
});
