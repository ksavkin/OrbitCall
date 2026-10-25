import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import type { HostContext, HostOutput, AgentSpan } from "../convex/lib/host";
import { as, fn, seed, userId } from "./decision";
import { insertEvent, type Backend } from "./helpers";
import { advocateEvent, advocateCandidates } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { callClaude } from "../convex/lib/claude";
import { createRunAssistant, writeMemory, recallMemory, type BackboardMemoryEntry } from "../convex/lib/backboard";

vi.mock("../convex/lib/claude", async original => ({ ...await original<typeof import("../convex/lib/claude")>(), callClaude: vi.fn() }));
vi.mock("../convex/lib/backboard", async original => ({ ...await original<typeof import("../convex/lib/backboard")>(),
  createRunAssistant: vi.fn(), writeMemory: vi.fn(), recallMemory: vi.fn() }));
const entries = new Map<string, BackboardMemoryEntry[]>();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); entries.clear();
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture"); vi.stubEnv("ANTHROPIC_MODEL", "fixture"); vi.stubEnv("BACKBOARD_API_KEY", "fixture");
  vi.mocked(createRunAssistant).mockReset().mockImplementation(async ({ companyId }) => ({ assistantId: `assistant-${companyId}` }));
  vi.mocked(writeMemory).mockReset().mockImplementation(async (id, item) => {
    entries.set(id, [{ memoryId: "one", text: item.text, companyId: item.companyId, sourceEventId: item.sourceEventId,
      sourceMessageIds: item.sourceMessageIds, createdAt: new Date().toISOString() }]);
    return { memoryId: "one" };
  });
  vi.mocked(recallMemory).mockReset().mockImplementation(async id => ({ status: "available", entries: entries.get(id) ?? [] }));
  vi.mocked(callClaude).mockReset().mockResolvedValue({ raw: '{"preferredCandidateId":null}', model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const request = ref<"mutation">("hostTriggers:request"), finish = ref<"mutation">("hostTriggers:finish"), contextRef = ref<"query">("hostTriggers:context");
async function cancelQueued(t: Backend) {
  await t.run(async ctx => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

it("carries actual spoken context through checked Host publication and a human correction into private next-incident memory", async () => {
  const { t, eventId } = await seed();
  const uid = await userId(t, "a");
  const { demoRunId, companyId } = await t.run(async ctx => {
    const user = (await ctx.db.get(uid))!;
    const demoRunId = await ctx.db.insert("demoRuns", { scenario: "cross-feature", state: "open", startedBy: uid, manifest: null, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(eventId, { demoRunId });
    return { demoRunId, companyId: user.companyId };
  });
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId });
  await cancelQueued(t);
  const spoken = "Prefer burns after the imaging pass.";
  const phraseId = await t.run(ctx => ctx.db.insert("call_phrases", { roomId, eventId, segId: "cross-feature-voice", rev: 2,
    speaker: { userId: uid, companyId, name: "A", identity: `user-${uid}` }, originalLang: "en", original: spoken,
    translations: { ru: "Предпочитаю маневр после съемки." }, translationStatus: { ru: "ok" }, errors: {}, values: [],
    startedAtMs: Date.now(), simulated: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  async function publish(outputFor: (context: HostContext) => HostOutput) {
    const hostRunId = await t.mutation(request, { roomId, trigger: "final_message" });
    await cancelQueued(t);
    const context = await t.query(contextRef, { roomId, trigger: "final_message" }) as HostContext;
    const span: AgentSpan = { role: "coordination_host", provider: "google", model: "fixture", inputVersion: context.inputVersion,
      attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
    await t.mutation(finish, { hostRunId, span, output: outputFor(context), check: null });
    return context;
  }
  const first = await publish(context => ({ inputVersion: context.inputVersion, clarifications: [], summaries: [], requestedRevisions: [],
    understood: [{ eventId, kind: "preference", hard: false, text: spoken, sourceMessageId: phraseId, correctsId: null }] }));
  expect(first.messages).toContainEqual(expect.objectContaining({ messageId: phraseId, text: spoken }));
  const [old] = await t.run(ctx => ctx.db.query("understood").collect());
  expect(old.sourceMessageId).not.toBe(phraseId);
  const corrected = "Actually, prefer burns before the imaging pass.";
  vi.setSystemTime(FIXTURE_NOW + 100);
  const { messageId } = await as(t, "a").mutation(api.messages.send, { roomId, eventId, text: corrected });
  const second = await publish(context => ({ inputVersion: context.inputVersion, clarifications: [], summaries: [], requestedRevisions: [],
    understood: [{ eventId, kind: "correction", hard: false, text: corrected, sourceMessageId: messageId, correctsId: old._id }] }));
  expect(second.understood).toContainEqual(expect.objectContaining({ understoodId: old._id, text: spoken }));
  const rows = await t.run(ctx => ctx.db.query("understood").collect());
  expect(rows.find(row => row._id === old._id)).toMatchObject({ status: "corrected" });
  expect(rows.find(row => row._id !== old._id)).toMatchObject({ status: "active", text: corrected });
  vi.setSystemTime(FIXTURE_NOW + 200);
  await t.run(async ctx => {
    await ctx.db.patch(eventId, { status: "no_action_needed" });
    await ctx.db.insert("log", { eventId, actor: { kind: "system" }, action: "no_action_needed", summary: "No action needed", texts: null,
      before: null, after: null, proposalId: null, revision: null, roomId, demoRunId, simulated: true, at: Date.now() });
  });
  const nextId = await insertEvent(t, { ...advocateEvent, tcaUtc: "2026-10-26T03:14:07Z" });
  await t.run(ctx => ctx.db.patch(nextId, { demoRunId }));
  await t.mutation(internal.candidates.publish, { eventId: nextId, baseVersion: null, candidates: advocateCandidates, start: false });
  await t.action(internal.agents.advocate.start, { eventId: nextId, side: "A" });
  await cancelQueued(t);
  expect(writeMemory).toHaveBeenCalledExactlyOnceWith(`assistant-${companyId}`, expect.objectContaining({ text: corrected, sourceEventId: eventId, sourceMessageIds: [messageId] }));
  const prompt = JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user);
  expect(prompt.memory).toContain(corrected); expect(prompt.memory).not.toContain(spoken);
  const shared = await as(t, "b").query(api.advocates.list, { eventId: nextId });
  expect(shared.runs.A!.memory).toMatchObject({ status: "used", sourceEventIds: [eventId] });
  expect(JSON.stringify(shared)).not.toContain(corrected);
  expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query("maneuvers").collect())).toEqual([]);
});
