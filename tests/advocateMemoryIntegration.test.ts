import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineSchema, defineTable, makeFunctionReference as ref } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { hostOutputValidator } from "../convex/lib/host";
import type { Id } from "../convex/_generated/dataModel";
import { api, internal } from "../convex/_generated/api";
import { backend, insertEvent, modules } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { callClaude } from "../convex/lib/claude";
import { createRunAssistant, recallMemory, writeMemory, closeRunAssistant, type BackboardMemoryEntry } from "../convex/lib/backboard";

vi.mock("../convex/lib/claude", async original => ({ ...await original<typeof import("../convex/lib/claude")>(), callClaude: vi.fn() }));
vi.mock("../convex/lib/backboard", async original => ({ ...await original<typeof import("../convex/lib/backboard")>(),
  createRunAssistant: vi.fn(), recallMemory: vi.fn(), writeMemory: vi.fn(), closeRunAssistant: vi.fn() }));
const entries = new Map<string, BackboardMemoryEntry[]>();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture"); vi.stubEnv("ANTHROPIC_MODEL", "fixture"); vi.stubEnv("BACKBOARD_API_KEY", "fixture");
  entries.clear();
  vi.mocked(createRunAssistant).mockReset().mockImplementation(async ({ companyId }) => ({ assistantId: `assistant-${companyId}` }));
  vi.mocked(writeMemory).mockReset().mockImplementation(async (id, item) => {
    const memoryId = `memory-${entries.get(id)?.length ?? 0}`;
    entries.set(id, [...entries.get(id) ?? [], { memoryId, text: item.text, companyId: item.companyId, sourceEventId: item.sourceEventId,
      sourceMessageIds: item.sourceMessageIds, createdAt: new Date().toISOString() }]);
    return { memoryId };
  });
  vi.mocked(recallMemory).mockReset().mockImplementation(async id => ({ status: "available", entries: entries.get(id) ?? [] }));
  vi.mocked(closeRunAssistant).mockReset().mockResolvedValue({ closed: true });
  vi.mocked(callClaude).mockReset().mockResolvedValue({ raw: '{"preferredCandidateId":null}', model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const remember = ref<"action">("agents/advocate:rememberOutcome");

async function setup(t = backend()) {
  const eventId = await insertEvent(t, advocateEvent);
  const previousId = await insertEvent(t, { ...advocateEvent, tcaUtc: "2026-10-26T03:14:07Z" });
  const companies: Id<"companies">[] = [];
  for (const [name, policy] of [["a", policyA], ["b", policyB]] as const) {
    const { companyId } = await t.mutation(internal.operators.provision, { key: name, name, simulated: true,
      objectIds: [policy.objectId], members: [{ tokenIdentifier: name, role: "operator", assignedObjectIds: [policy.objectId] }] });
    companies.push(companyId);
    await t.withIdentity({ tokenIdentifier: name }).mutation(api.policies.update, { satellites: [policy] });
  }
  const [companyAId, companyBId] = companies;
  const data = await t.run(async ctx => {
    const user = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", "a")).unique())!;
    const demoRunId = await ctx.db.insert("demoRuns", { scenario: "memory", state: "open", startedBy: user._id,
      manifest: { preserved: true }, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(eventId, { demoRunId }); await ctx.db.patch(previousId, { demoRunId });
    const roomId = await ctx.db.insert("rooms", { state: "closed", companyIds: companies, demoRunId, simulated: true, createdAt: Date.now(), closedAt: Date.now() });
    await ctx.db.insert("roomEvents", { roomId, eventId: previousId, linkedAt: Date.now() });
    const preference = "Prefers burns after the imaging pass.";
    const messageId = await ctx.db.insert("messages", { roomId, eventId: previousId, author: { kind: "human", userId: user._id, companyId: companyAId, name: "A" },
      kind: "text", originalText: preference, originalLang: "en", translations: {}, translationStatus: {}, values: [], refs: {}, form: null,
      demoRunId, simulated: true, createdAt: Date.now() });
    const understoodId = await ctx.db.insert("understood", { roomId, eventId: previousId, kind: "preference", hard: false, text: preference,
      originalLang: "en", side: "A", sourceMessageId: messageId, status: "active", correctedById: null, hostRunId: null, demoRunId, createdAt: Date.now() });
    await ctx.db.insert("log", { eventId: previousId, actor: { kind: "system" }, action: "no_action_needed", summary: "No action needed", texts: null,
      before: null, after: null, proposalId: null, revision: null, roomId, demoRunId, simulated: true, at: Date.now() });
    return { demoRunId, messageId, understoodId, roomId, preference, userId: user._id };
  });
  for (const id of [eventId, previousId]) await t.mutation(internal.candidates.publish, { eventId: id, baseVersion: null, candidates: advocateCandidates, start: false });
  await t.run(ctx => ctx.db.patch(previousId, { status: "no_action_needed" }));
  return { t, eventId, previousId, companyAId, companyBId, ...data };
}

const finish = (t: ReturnType<typeof backend>) => t.finishAllScheduledFunctions(vi.runAllTimers);
describe("Advocate memory integration", () => {
  it("learns a checked preference after an outcome and recalls it only in that company's next incident prompt", async () => {
    const { t, eventId, previousId, companyAId, companyBId, demoRunId, preference } = await setup();
    await t.action(internal.agents.advocate.start, { eventId, side: "A" });
    await finish(t);
    expect(writeMemory).toHaveBeenCalledExactlyOnceWith(`assistant-${companyAId}`, expect.objectContaining({ companyId: companyAId, demoRunId, text: preference, sourceEventId: previousId }));
    const prompts = vi.mocked(callClaude).mock.calls.map(([p]) => JSON.parse(p.user));
    expect(prompts.find(p => p.side === "A").memory).toContain(preference);
    expect(prompts.find(p => p.side === "B").memory).not.toContain(preference);
    const view = await t.withIdentity({ tokenIdentifier: "b" }).query(api.advocates.list, { eventId });
    expect(view.runs.A).toMatchObject({ memory: { status: "used", sourceEventIds: [previousId] } });
    expect(view.runs.B).toMatchObject({ memory: { status: "none" } });
    expect(JSON.stringify(view)).not.toContain(preference);
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("memoryAssistants").collect())).toHaveLength(2);
    expect(createRunAssistant).toHaveBeenCalledWith({ companyId: companyBId, demoRunId });
  });

  it("does not write memory before a recorded outcome, and repeated outcome delivery writes once", async () => {
    const { t, previousId, companyAId } = await setup();
    await t.run(ctx => ctx.db.patch(previousId, { status: "communication" }));
    await t.action(remember, { eventId: previousId, companyId: companyAId });
    expect(writeMemory).not.toHaveBeenCalled();
    await t.run(ctx => ctx.db.patch(previousId, { status: "no_action_needed" }));
    await t.action(remember, { eventId: previousId, companyId: companyAId });
    await t.action(remember, { eventId: previousId, companyId: companyAId });
    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(createRunAssistant).toHaveBeenCalledTimes(1);
  });

  it("proceeds with current policy and visible unavailable memory when Backboard fails", async () => {
    const { t, eventId } = await setup();
    vi.mocked(recallMemory).mockResolvedValue({ status: "unavailable", reason: "provider secret" });
    await t.action(internal.agents.advocate.start, { eventId, side: "A" });
    const view = await t.withIdentity({ tokenIdentifier: "a" }).query(api.advocates.list, { eventId });
    expect(view.runs.A).toMatchObject({ status: "succeeded", memory: { status: "unavailable", shareable: "Memory unavailable" } });
    expect(JSON.stringify(view)).not.toContain("provider secret");
    expect(JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user).ownPolicy).toEqual(policyA);
    await finish(t);
  });
});

// Mirror PR48's optional Host output field for independent branch tests; every production table rule remains checked.
const hostSchema = defineSchema({ ...schema.tables, hostRuns: defineTable({ ...schema.tables.hostRuns.validator.fields,
  output: v.union(v.null(), v.object({ ...hostOutputValidator.fields, understood: v.optional(v.array(v.object({
    kind: v.string(), hard: v.boolean(), text: v.string(), eventId: v.union(v.string(), v.null()), sourceMessageId: v.string(),
    correctsId: v.optional(v.union(v.string(), v.null())),
  }))) })),
}).index("by_room_input_trigger", ["roomId", "inputVersion", "trigger"]).index("by_room_created", ["roomId", "createdAt"]).index("by_demo_run", ["demoRunId"]) });
async function hostSetup(voice = false) {
  const fixture = await setup(convexTest(hostSchema, modules));
  const { t, roomId, previousId, companyAId, userId, messageId, understoodId, demoRunId, preference } = fixture;
  const ids = await t.run(async ctx => {
    const sourceId = voice ? await ctx.db.insert("call_phrases", { roomId, eventId: previousId, segId: "voice-preference", rev: 2,
      speaker: { userId, companyId: companyAId, name: "A", identity: "a" }, originalLang: "en", original: preference,
      translations: {}, values: [], translationStatus: {}, errors: {}, startedAtMs: Date.now(), simulated: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) : messageId;
    const output = { inputVersion: "fixture", clarifications: [], requestedRevisions: [], summaries: [],
      understood: [{ kind: "preference", hard: false, text: preference, eventId: previousId, sourceMessageId: sourceId }] };
    const hostRunId = await ctx.db.insert("hostRuns", { roomId, trigger: "final_message", inputVersion: "fixture", attempt: 1,
      status: "succeeded", span: null, output, check: null, demoRunId, createdAt: Date.now(), finishedAt: Date.now() });
    const hostMessageId = await ctx.db.insert("messages", { roomId, eventId: previousId,
      author: { kind: "agent", role: "coordination_host", companyId: null }, kind: "text", originalText: preference, originalLang: "en",
      translations: {}, translationStatus: {}, values: [], refs: {}, form: null, demoRunId, simulated: true, createdAt: Date.now() });
    await ctx.db.patch(understoodId, { sourceMessageId: hostMessageId, hostRunId });
    const source = { id: sourceId, kind: voice ? "voice_phrase" : "message", companyId: companyAId, userId, text: preference, language: "en", eventId: previousId };
    const auditId = await ctx.db.insert("log", { eventId: previousId,
      actor: { kind: "agent", role: "coordination_host", companyId: null, side: null }, action: "summary_posted", summary: preference,
      texts: null, before: null, after: { kind: "understood", hostRunId, messageId: hostMessageId, understoodId,
        sourceMessageIds: JSON.stringify([sourceId]), sources: JSON.stringify([source]) },
      proposalId: null, revision: null, roomId, demoRunId, simulated: true, at: Date.now() });
    return { sourceId, hostRunId, hostMessageId, auditId };
  });
  return { ...fixture, ...ids };
}
async function correctPreference(f: Awaited<ReturnType<typeof hostSetup>>, correctsId = f.understoodId,
  text = "Correction: prefer burns before the imaging pass.") {
  return f.t.run(async ctx => {
    const prior = (await ctx.db.get(correctsId))!;
    const { _id, _creationTime, ...original } = (await ctx.db.get(f.messageId))!;
    const messageId = await ctx.db.insert("messages", { ...original, originalText: text });
    const output = { inputVersion: "correction", clarifications: [], requestedRevisions: [], summaries: [],
      understood: [{ kind: "correction", hard: false, text, eventId: f.previousId, sourceMessageId: messageId, correctsId }] };
    const hostRunId = await ctx.db.insert("hostRuns", { roomId: f.roomId, trigger: "final_message", inputVersion: "correction", attempt: 1,
      status: "succeeded", span: null, output, check: null, demoRunId: f.demoRunId, createdAt: Date.now(), finishedAt: Date.now() });
    const hostMessageId = await ctx.db.insert("messages", { roomId: f.roomId, eventId: f.previousId,
      author: { kind: "agent", role: "coordination_host", companyId: null }, kind: "text", originalText: text, originalLang: "en",
      translations: {}, translationStatus: {}, values: [], refs: {}, form: null, demoRunId: f.demoRunId, simulated: true, createdAt: Date.now() });
    const understoodId = await ctx.db.insert("understood", { roomId: f.roomId, eventId: f.previousId, kind: "correction", hard: false,
      text, originalLang: "en", side: "A", sourceMessageId: hostMessageId, status: "active", correctedById: null,
      hostRunId, demoRunId: f.demoRunId, createdAt: Date.now() });
    await ctx.db.patch(prior._id, { status: "corrected", correctedById: understoodId });
    const source = { id: messageId, kind: "message", companyId: f.companyAId, userId: f.userId, text, language: "en", eventId: f.previousId };
    await ctx.db.insert("log", { eventId: f.previousId, actor: { kind: "agent", role: "coordination_host", companyId: null, side: null },
      action: "summary_posted", summary: text, texts: null, before: null,
      after: { kind: "understood", hostRunId, messageId: hostMessageId, understoodId,
        sourceMessageIds: JSON.stringify([messageId]), sources: JSON.stringify([source]) },
      proposalId: null, revision: null, roomId: f.roomId, demoRunId: f.demoRunId, simulated: true, at: Date.now() });
    return { understoodId, messageId, hostRunId, text };
  });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("memory provenance and namespace lifecycle", () => {
  it("learns the current source through a chain of corrections to a soft preference", async () => {
    const f = await hostSetup();
    const first = await correctPreference(f);
    const current = await correctPreference(f, first.understoodId, "Correction: prefer burns once imaging has finished.");
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    expect(writeMemory).toHaveBeenCalledExactlyOnceWith(`assistant-${f.companyAId}`, expect.objectContaining({
      text: current.text, sourceMessageIds: [current.messageId], sourceEventId: f.previousId,
    }));
  });

  it.each(["constraint", "hard", "foreign", "missing", "ambiguous", "output"] as const)("does not reinterpret invalid correction ancestry as a preference: %s", async problem => {
    const f = await hostSetup(), correction = await correctPreference(f);
    await f.t.run(async ctx => {
      if (problem === "constraint") await ctx.db.patch(f.understoodId, { kind: "constraint" });
      if (problem === "hard") await ctx.db.patch(f.understoodId, { hard: true });
      if (problem === "foreign") await ctx.db.patch(f.understoodId, { side: "B" });
      if (problem === "missing") await ctx.db.patch(f.understoodId, { correctedById: null });
      if (problem === "ambiguous") {
        const { _id, _creationTime, ...row } = (await ctx.db.get(f.understoodId))!;
        await ctx.db.insert("understood", row);
      }
      if (problem === "output") await ctx.db.patch(correction.hostRunId, { output: null });
    });
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it.each([false, true])("resolves a Host interpretation to its original %s voice source", async voice => {
    const { t, previousId, companyAId, sourceId, hostMessageId, preference } = await hostSetup(voice);
    await t.action(remember, { eventId: previousId, companyId: companyAId });
    expect(writeMemory).toHaveBeenCalledExactlyOnceWith(`assistant-${companyAId}`, expect.objectContaining({ text: preference, sourceMessageIds: [sourceId] }));
    expect(vi.mocked(writeMemory).mock.calls[0][1].sourceMessageIds).not.toContain(hostMessageId);
  });

  it.each(["audit", "output", "voice_changed", "voice_pending", "foreign_speaker", "unassigned", "observer"] as const)("rejects invalid Host provenance: %s", async problem => {
    const f = await hostSetup(true);
    await f.t.run(async ctx => {
      if (problem === "audit") await ctx.db.delete(f.auditId);
      if (problem === "output") await ctx.db.patch(f.hostRunId, { output: null });
      if (problem === "voice_changed") await ctx.db.patch(f.sourceId as Id<"call_phrases">, { original: "Changed after the Host read it." });
      if (problem === "voice_pending") await ctx.db.patch(f.sourceId as Id<"call_phrases">, { translationStatus: { ru: "pending" } });
      if (problem === "foreign_speaker") {
        const phrase = (await ctx.db.get(f.sourceId as Id<"call_phrases">))!;
        await ctx.db.patch(phrase._id, { speaker: { ...phrase.speaker, companyId: f.companyBId } });
      }
      if (problem === "unassigned") for (const row of await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", f.userId)).collect()) await ctx.db.patch(row._id, { active: false });
      if (problem === "observer") await ctx.db.patch(f.userId, { role: "head_of_ops" });
    });
    expect(await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId })).toEqual({ written: 0, failed: false });
    expect(createRunAssistant).not.toHaveBeenCalled(); expect(writeMemory).not.toHaveBeenCalled();
  });

  it.each(["corrected", "hard", "foreign", "ungrounded", "approval", "private"] as const)("rejects an ineligible preference: %s", async problem => {
    const f = await setup();
    await f.t.run(async ctx => {
      if (problem === "corrected") await ctx.db.patch(f.understoodId, { status: "corrected" });
      if (problem === "hard") await ctx.db.patch(f.understoodId, { hard: true });
      if (problem === "foreign") await ctx.db.patch(f.understoodId, { side: "B" });
      if (problem === "ungrounded") await ctx.db.patch(f.understoodId, { text: "A preference nobody stated." });
      if (problem === "approval" || problem === "private") {
        const text = problem === "approval" ? "We approved the next maneuver." : "Prefer holding a fuel reserve of 25 kg.";
        await ctx.db.patch(f.messageId, { originalText: text }); await ctx.db.patch(f.understoodId, { text });
      }
    });
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it("serializes concurrent assistant creation and memory writes for one company", async () => {
    const f = await setup(), entered = gate(), release = gate();
    vi.mocked(createRunAssistant).mockImplementation(async () => { entered.resolve(); await release.promise; return { assistantId: "one-assistant" }; });
    const first = f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    await entered.promise;
    expect(await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId })).toEqual({ written: 0, failed: true });
    release.resolve(); await first;
    await Promise.all([f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId }), f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId })]);
    expect(createRunAssistant).toHaveBeenCalledTimes(1); expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(await f.t.run(ctx => ctx.db.query("memoryAssistants").collect())).toHaveLength(1);
  });

  it("tracks and closes an assistant created while its demo is reset, without invoking the model", async () => {
    const f = await setup(), entered = gate(), release = gate();
    vi.stubEnv("DEMO_LAUNCH", "on");
    vi.mocked(createRunAssistant).mockImplementation(async () => { entered.resolve(); await release.promise; return { assistantId: "late-assistant" }; });
    const pending = f.t.action(internal.agents.advocate.start, { eventId: f.eventId, side: "A" });
    await entered.promise;
    await f.t.withIdentity({ tokenIdentifier: "a" }).mutation(api.demoReset.reset, { demoRunId: f.demoRunId });
    await finish(f.t);
    release.resolve(); await pending; await finish(f.t);
    const rows = await f.t.run(ctx => ctx.db.query("memoryAssistants").collect());
    expect(rows).toHaveLength(1); expect(rows[0].closedAt).not.toBeNull();
    expect(closeRunAssistant).toHaveBeenCalledWith("late-assistant");
    expect(writeMemory).not.toHaveBeenCalled(); expect(recallMemory).not.toHaveBeenCalled(); expect(callClaude).not.toHaveBeenCalled();
    expect((await f.t.run(ctx => ctx.db.get(f.demoRunId)))!.manifest).toMatchObject({ preserved: true, memoryCleanupState: "complete" });
  });

  it("closes again after a write finishes later than the reset cleanup", async () => {
    const f = await setup(), entered = gate(), release = gate();
    vi.stubEnv("DEMO_LAUNCH", "on");
    vi.mocked(writeMemory).mockImplementation(async () => { entered.resolve(); await release.promise; return { memoryId: "late-write" }; });
    const pending = f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    await entered.promise;
    await f.t.withIdentity({ tokenIdentifier: "a" }).mutation(api.demoReset.reset, { demoRunId: f.demoRunId });
    await finish(f.t); const before = vi.mocked(closeRunAssistant).mock.calls.length;
    release.resolve(); await pending; await finish(f.t);
    expect(vi.mocked(closeRunAssistant).mock.calls.length).toBeGreaterThan(before);
    expect((await f.t.run(ctx => ctx.db.get(f.demoRunId)))!.manifest!.memoryCleanupState).toBe("complete");
  });

  it("retries failed late cleanup and preserves a visible complete state after recovery", async () => {
    const f = await setup();
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    const row = (await f.t.run(ctx => ctx.db.query("memoryAssistants").collect()))[0];
    await f.t.run(async ctx => { await ctx.db.patch(f.demoRunId, { state: "closed", closedAt: Date.now() }); await ctx.db.patch(row._id, { closedAt: Date.now() }); });
    vi.mocked(closeRunAssistant).mockRejectedValueOnce(new Error("provider secret"));
    await f.t.action(internal.agents.advocate.cleanupMemoryAssistant, { rowId: row._id, attempt: 0 });
    expect((await f.t.run(ctx => ctx.db.get(f.demoRunId)))!.manifest![`memory:cleanup:${row._id}`]).toBe("failed");
    await finish(f.t);
    expect((await f.t.run(ctx => ctx.db.get(f.demoRunId)))!.manifest).toMatchObject({ [`memory:cleanup:${row._id}`]: "complete", memoryCleanupState: "complete" });
  });

  it("does not adopt or close a provider ID belonging to another company", async () => {
    const f = await setup();
    const foreign = await f.t.run(ctx => ctx.db.insert("memoryAssistants", { demoRunId: f.demoRunId, companyId: f.companyBId, assistantId: "foreign", createdAt: Date.now(), closedAt: null }));
    vi.mocked(createRunAssistant).mockResolvedValue({ assistantId: "foreign" });
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId }); await finish(f.t);
    expect(writeMemory).not.toHaveBeenCalled(); expect(closeRunAssistant).not.toHaveBeenCalled();
    expect((await f.t.run(ctx => ctx.db.get(foreign)))!.closedAt).toBeNull();
  });

  it("does not recall a stored statement after its source is corrected", async () => {
    const f = await setup();
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    await f.t.run(ctx => ctx.db.patch(f.understoodId, { status: "corrected" }));
    await f.t.action(internal.agents.advocate.start, { eventId: f.eventId, side: "A" });
    expect(JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user).memory).not.toContain(f.preference);
    expect((await f.t.withIdentity({ tokenIdentifier: "a" }).query(api.advocates.list, { eventId: f.eventId })).runs.A!.memory.status).toBe("none");
    await finish(f.t);
  });

  it("preserves the full original statement when the understood excerpt omits a negation", async () => {
    const f = await setup(), statement = "We do not prefer burns after the imaging pass.";
    await f.t.run(async ctx => {
      await ctx.db.patch(f.messageId, { originalText: statement });
      await ctx.db.patch(f.understoodId, { text: "prefer burns after the imaging pass." });
    });
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    expect(writeMemory).toHaveBeenCalledExactlyOnceWith(`assistant-${f.companyAId}`, expect.objectContaining({ text: statement }));
  });

  it("drops a source corrected while the provider recall is in flight", async () => {
    const f = await setup(), entered = gate(), release = gate();
    vi.mocked(recallMemory).mockImplementation(async id => {
      entered.resolve(); await release.promise;
      return { status: "available", entries: entries.get(id) ?? [] };
    });
    const pending = f.t.action(internal.agents.advocate.start, { eventId: f.eventId, side: "A" });
    await entered.promise;
    await f.t.run(ctx => ctx.db.patch(f.understoodId, { status: "corrected" }));
    release.resolve(); await pending;
    expect(JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user).memory).not.toContain(f.preference);
    expect((await f.t.withIdentity({ tokenIdentifier: "a" }).query(api.advocates.list, { eventId: f.eventId })).runs.A!.memory.status).toBe("none");
    await finish(f.t);
  });

  it("does not publish a recalled recommendation after the demo resets during the model call", async () => {
    const f = await setup(), entered = gate(), release = gate();
    vi.stubEnv("DEMO_LAUNCH", "on");
    vi.mocked(callClaude).mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { raw: '{"preferredCandidateId":null}', model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const pending = f.t.action(internal.agents.advocate.start, { eventId: f.eventId, side: "A" });
    await entered.promise;
    await f.t.withIdentity({ tokenIdentifier: "a" }).mutation(api.demoReset.reset, { demoRunId: f.demoRunId });
    release.resolve(); await pending; await finish(f.t);
    expect(await f.t.run(ctx => ctx.db.query("negotiationMessages").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect((await f.t.run(ctx => ctx.db.query("agentRuns").collect())).every(run => run.status === "superseded")).toBe(true);
  });

  it.each(["create", "write"] as const)("does not automatically repeat uncertain provider %s requests", async failure => {
    const f = await setup();
    if (failure === "create") vi.mocked(createRunAssistant).mockRejectedValue(new Error("provider secret"));
    else vi.mocked(writeMemory).mockRejectedValue(new Error("provider secret"));
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    await f.t.action(remember, { eventId: f.previousId, companyId: f.companyAId });
    expect(createRunAssistant).toHaveBeenCalledTimes(1); expect(writeMemory).toHaveBeenCalledTimes(failure === "create" ? 0 : 1);
    expect(JSON.stringify(await f.t.run(ctx => ctx.db.get(f.demoRunId)))).not.toContain("provider secret");
  });

  it("keeps non-demo events independent of Backboard", async () => {
    const f = await setup(); await f.t.run(ctx => ctx.db.patch(f.eventId, { demoRunId: undefined }));
    await f.t.action(internal.agents.advocate.start, { eventId: f.eventId, side: "A" }); await finish(f.t);
    expect(createRunAssistant).not.toHaveBeenCalled(); expect(recallMemory).not.toHaveBeenCalled();
    expect((await f.t.withIdentity({ tokenIdentifier: "a" }).query(api.advocates.list, { eventId: f.eventId })).runs.A!.memory.status).toBe("none");
  });
});
