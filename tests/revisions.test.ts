import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { AgentSpan, HostOutput } from "../convex/lib/host";
import type { CandidatesRequest, CandidatesResponse } from "../convex/lib/orbitClient";
import { filterDiscussionGrid, parseDiscussionConstraints } from "../convex/lib/publishCandidates";
import { advocateEvent } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { as, code, fn, pick, seed, selection, tick, userId } from "./decision";
import { insertEvent } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const text = "Move SIM-1001 only; burn after 2026-10-24T21:14:07Z; delta-v at most 0.1 m/s; use retrograde";
const info = (objectId: string) => ({ objectId, name: objectId, kind: "payload", maneuverability: "maneuverable",
  classificationBasis: "simulation", operationalStatus: null, group: "sim", simulated: true });
const grid = [
  ["A", 12, 0.02, "prograde", 1.3], ["B", 12, 0.02, "retrograde", 1.2], ["A", 6, 0.05, "prograde", 1.9],
  ["A", 6, 0.2, "retrograde", 2.5], ["A", 3, 0.1, "retrograde", 2.4],
] as const;
function answer(req: CandidatesRequest) {
  const common = { missBeforeKm: 0.18, estimatedFuelKg: null, indicative: true, simulated: true };
  return {
    snapshotId: req.snapshotId, evidenceVersion: req.evidenceVersion, objectA: req.objectA, objectB: req.objectB,
    objects: { [req.objectA]: info(req.objectA), [req.objectB]: info(req.objectB) }, notMovable: [],
    tcaUtc: req.tcaUtc, tcaInputUtc: req.tcaUtc, missBeforeKm: 0.18, relSpeedKmS: 7.6, simulated: true,
    candidates: grid.filter(([side]) => req.allowedMovingObjectIds.includes(side === "A" ? req.objectA : req.objectB)).map(([side, leadH, deltaVMs, direction, missAfterKm], i) => ({
      ...common, candidateId: `grid-${i}`, kind: "maneuver", movingSide: side, movingObjectId: side === "A" ? req.objectA : req.objectB,
      burnTimeUtc: new Date(Date.parse(req.tcaUtc) - leadH * 3600000).toISOString().replace(".000Z", "Z"), leadH,
      deltaVMs, direction, deltaAKm: 0.04, missAfterKm, tcaAfterUtc: req.tcaUtc, relSpeedKmS: 7.6, passesPairThreshold: true, rank: i + 1,
    })),
    wait: { ...common, candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null,
      leadH: null, deltaVMs: null, direction: null, deltaAKm: null, missAfterKm: null, tcaAfterUtc: null, relSpeedKmS: null,
      passesPairThreshold: false, rank: null },
    failed: [], assumptions: ["Indicative simulated geometry; no covariance."], method: "SGP4 test grid",
  };
}
function orbit(before?: () => Promise<void>, patch?: (body: ReturnType<typeof answer>) => void) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = answer(JSON.parse(String(init.body))); await before?.(); patch?.(body);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}

async function setup(options: { text?: string; voice?: boolean; hard?: boolean; request?: boolean } = {}) {
  const { t, eventId } = await seed();
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
  const original = options.text ?? text;
  const operatorId = await userId(t, "a");
  let sourceId: Id<"messages"> | Id<"call_phrases">;
  if (options.voice) sourceId = await t.run(async ctx => {
    const operator = (await ctx.db.get(operatorId))!;
    return ctx.db.insert("call_phrases", { roomId, eventId, segId: "revision-voice", rev: 2,
      speaker: { userId: operator._id, companyId: operator.companyId, name: "A", identity: `user-${operator._id}` },
      originalLang: "en", original, translations: { ru: "Перевод" }, translationStatus: { ru: "ok" }, errors: {}, values: [],
      startedAtMs: Date.now(), simulated: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  else sourceId = (await as(t, "a").mutation(api.messages.send, { roomId, eventId, text: original })).messageId;
  const hostRunId = (await t.mutation(internal.hostTriggers.request, { roomId, trigger: "final_message" }))!;
  const context = (await t.query(internal.hostTriggers.context, { roomId, trigger: "final_message" }))!;
  const target = context.events.find(e => e.eventId === eventId)!.candidates.find(c => c.label === "P1")!;
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], summaries: [],
    requestedRevisions: options.request === false ? [] : [{ eventId, candidateId: target.candidateId, reason: "The operator requested a revised maneuver.", messageIds: [sourceId] }],
    ...(options.hard === false ? {} : { understood: [{ eventId, kind: "constraint" as const, hard: true, text: original, sourceMessageId: sourceId, correctsId: null }] }),
  };
  const span: AgentSpan = { role: "coordination_host", provider: "google", model: "test-model", inputVersion: context.inputVersion,
    attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
  await t.mutation(internal.hostTriggers.finish, { hostRunId, span, output, check: null });
  return { t, eventId, roomId, sourceId, operatorId, hostRunId, output };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const run = (s: Setup) => s.t.action(internal.revisions.fromHost, { hostRunId: s.hostRunId });
const cards = (s: Setup) => s.t.run(async ctx => {
  const set = (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", s.eventId)).unique())!;
  return Promise.all(set.candidateRevisionIds.map(async id => (await ctx.db.get(id))!));
});
const revisions = (s: Setup) => s.t.run(ctx => ctx.db.query("proposalRevisions").withIndex("by_event", q => q.eq("eventId", s.eventId)).collect());

describe("discussion-driven publication", () => {
  it("filters all grid points before the four-card limit, keeps proposal identity and resets historical signatures", async () => {
    const s = await setup();
    await pick(s.t, "a", s.eventId, "P1");
    await as(s.t, "a").mutation(fn.approve, await tick(s.t, s.eventId));
    const before = await revisions(s), fetch = orbit();
    expect(await run(s)).toEqual([{ eventId: s.eventId, status: "published", changed: true, version: 2 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body)).allowedMovingObjectIds).toEqual(["SIM-1001", "SIM-1002"]);
    const current = await cards(s);
    expect(current).toHaveLength(2);
    expect(current[0]).toMatchObject({ candidateId: "P1", revision: 2, movingObjectId: "SIM-1001", direction: "retrograde", deltaVMs: 0.1, missAfterKm: 2.4 });
    expect(current[1].kind).toBe("wait");
    expect((await selection(s.t, s.eventId))).toMatchObject({ revision: 2, generation: 2, lastReset: { reason: "revision_changed" } });
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([expect.objectContaining({ status: "approved", current: false, revision: 1 })]);
    const after = await revisions(s);
    for (const old of before) expect(after.find(r => r._id === old._id)).toEqual(old);
    const added = after.filter(r => !before.some(old => old._id === r._id));
    expect(added).toHaveLength(2);
    expect(added.every(r => r.changeSummary?.includes("Human approval is still required") && r.sourceMessageIds.length > 0)).toBe(true);
    const logs = await s.t.run(ctx => ctx.db.query("log").collect());
    expect(logs.filter(l => l.action === "proposal_revised")).toHaveLength(2);
    expect(logs.filter(l => l.action === "proposal_revised").every(l => l.after?.originalSourceIds === JSON.stringify([s.sourceId]))).toBe(true);
    const jobs = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some(j => j.name === "agents/advocate:negotiate")).toBe(true);
    expect(jobs.some(j => j.name === "advocates:publicationFollowups")).toBe(true);
    expect(await s.t.run(ctx => ctx.db.query("maneuvers").collect())).toEqual([]);
    expect(await run(s)).toEqual([{ eventId: s.eventId, status: "published", changed: false, version: 2 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await revisions(s)).toEqual(after);
  });

  it.each([true, false])("uses real voice provenance through an actual message bridge (understood=%s)", async hard => {
    const s = await setup({ voice: true, hard }); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published", changed: true })]);
    const revised = (await revisions(s)).filter(r => r.changeSummary);
    for (const revision of revised) {
      expect(revision.sourceMessageIds).not.toContain(s.sourceId);
      const source = await s.t.run(ctx => ctx.db.get(revision.sourceMessageIds[0]));
      expect(source).toMatchObject({ originalText: text, originalLang: "en", author: { kind: "agent", role: "coordination_host" } });
    }
    expect(JSON.stringify(revised)).not.toContain("Перевод");
  });

  it("honors active hard constraints even without an explicit requested revision", async () => {
    const s = await setup({ request: false }); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
    expect((await cards(s)).filter(c => c.kind === "maneuver")).toEqual([expect.objectContaining({ direction: "retrograde", deltaVMs: 0.1 })]);
  });

  it("accepts a new original time window in a requested-only revision", async () => {
    const s = await setup({ text: text.replace("21:14:07", "20:00:00"), hard: false }); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
    expect((await cards(s))[0]).toMatchObject({ direction: "retrograde", deltaVMs: 0.1 });
  });

  it("does not republish or reset approvals when the next Host run repeats the same hard constraints", async () => {
    const s = await setup({ text: "Move SIM-1001 only; delta-v at most 0.1 m/s; use retrograde" }); const fetch = orbit();
    await run(s);
    await pick(s.t, "a", s.eventId, "P1", 2);
    await as(s.t, "a").mutation(fn.approve, await tick(s.t, s.eventId));
    const before = await cards(s), decision = await selection(s.t, s.eventId);
    const hostRunId = (await s.t.mutation(internal.hostTriggers.request, { roomId: s.roomId, trigger: "candidates_changed" }))!;
    const context = (await s.t.query(internal.hostTriggers.context, { roomId: s.roomId, trigger: "candidates_changed" }))!;
    const span: AgentSpan = { role: "coordination_host", provider: "google", model: "test", inputVersion: context.inputVersion,
      attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
    await s.t.mutation(internal.hostTriggers.finish, { hostRunId, span, check: null, output: {
      inputVersion: context.inputVersion, summaries: [], clarifications: [], requestedRevisions: [], understood: s.output.understood,
    } });
    expect(await s.t.action(internal.revisions.fromHost, { hostRunId })).toEqual([expect.objectContaining({ status: "published", changed: false, version: 2 })]);
    expect(await cards(s)).toEqual(before); expect(await selection(s.t, s.eventId)).toEqual(decision);
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([expect.objectContaining({ current: true })]);
    const count = fetch.mock.calls.length;
    expect(await s.t.action(internal.revisions.fromHost, { hostRunId })).toEqual([expect.objectContaining({ changed: false })]);
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("reopens the numerical grid when a checked correction releases a hard constraint", async () => {
    const s = await setup({ text: "Cannot maneuver" }); orbit(); await run(s);
    expect((await cards(s)).every(c => c.movingSide !== "A")).toBe(true);
    const old = (await s.t.run(ctx => ctx.db.query("understood").collect()))[0];
    const { messageId } = await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, eventId: s.eventId, text: "Actually, we prefer to maneuver later." });
    const hostRunId = (await s.t.mutation(internal.hostTriggers.request, { roomId: s.roomId, trigger: "final_message" }))!;
    const context = (await s.t.query(internal.hostTriggers.context, { roomId: s.roomId, trigger: "final_message" }))!;
    const span: AgentSpan = { role: "coordination_host", provider: "google", model: "test", inputVersion: context.inputVersion,
      attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
    await s.t.mutation(internal.hostTriggers.finish, { hostRunId, span, check: null, output: {
      inputVersion: context.inputVersion, summaries: [], clarifications: [], requestedRevisions: [],
      understood: [{ eventId: s.eventId, kind: "correction", hard: false, text: "Actually, we prefer to maneuver later.", sourceMessageId: messageId, correctsId: old._id }],
    } });
    expect(await s.t.action(internal.revisions.fromHost, { hostRunId })).toEqual([expect.objectContaining({ status: "published", changed: true })]);
    expect((await cards(s)).some(c => c.movingSide === "A")).toBe(true);
    expect((await revisions(s)).some(r => r.changeSummary?.includes("corrected a hard constraint") && r.sourceMessageIds.length > 0)).toBe(true);
  });

  it("applies the other company's active constraints to its own mover only", async () => {
    const s = await setup({ text: "delta-v at most 0.05 m/s", hard: false });
    const { messageId } = await as(s.t, "b").mutation(api.messages.send, { roomId: s.roomId, eventId: s.eventId, text: "Cannot maneuver" });
    await s.t.run(ctx => ctx.db.insert("understood", { roomId: s.roomId, eventId: s.eventId, kind: "constraint", hard: true,
      text: "Cannot maneuver", originalLang: "en", side: "B", sourceMessageId: messageId, status: "active", correctedById: null,
      hostRunId: null, demoRunId: null, createdAt: Date.now() }));
    orbit(); expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
    expect((await cards(s)).filter(c => c.kind === "maneuver").every(c => c.movingSide === "A" && c.deltaVMs! <= 0.05)).toBe(true);
  });

  it("keeps wait when no computed burn satisfies the constraints without inventing a maneuver or approving wait", async () => {
    const s = await setup({ text: "Move SIM-1001 only; delta-v at most 0.001 m/s" }); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
    expect((await cards(s)).map(c => c.kind)).toEqual(["wait"]);
    expect(await selection(s.t, s.eventId)).toBeNull();
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  });

  it("revises confirmed debris using only the active operator's object", async () => {
    const s = await setup();
    await s.t.run(async ctx => {
      const owner = (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1002")).unique())!;
      await ctx.db.delete(owner._id);
      await ctx.db.patch(s.eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["A"] });
    });
    const fetch = orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body)).allowedMovingObjectIds).toEqual(["SIM-1001"]);
    expect((await cards(s)).every(c => c.kind === "wait" || c.movingSide === "A")).toBe(true);
  });

  it.each(["We cannot maneuver on Wednesday.", "Do not use retrograde", "Use prograde unless the fuel is low", "Не маневрировать до среды."])("asks for clarification instead of discarding unsupported hard text: %s", async original => {
    const s = await setup({ text: original }); const before = await cards(s), fetch = orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "CLARIFICATION_REQUIRED" })]);
    expect(fetch).not.toHaveBeenCalled(); expect(await cards(s)).toEqual(before);
    await run(s);
    const messages = await s.t.run(ctx => ctx.db.query("messages").collect());
    expect(messages.filter(m => m.originalText.startsWith("Candidate revision needs attention:"))).toHaveLength(1);
  });

  it("never treats a partial understood excerpt as permission to omit a negation", async () => {
    const s = await setup({ text: "Do not use retrograde" });
    await s.t.run(async ctx => {
      const row = (await ctx.db.query("understood").collect())[0];
      await ctx.db.patch(row._id, { text: "use retrograde" });
      await ctx.db.patch(row.sourceMessageId, { originalText: "use retrograde" });
    });
    const before = await cards(s), fetch = orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(fetch).not.toHaveBeenCalled(); expect(await cards(s)).toEqual(before);
  });
});

describe("publication freshness and authorization", () => {
  it.each(["original", "correction", "assignment", "ownership", "evidence", "candidate_set", "closed_room", "closed_demo"])("refuses a %s change during the numerical request", async changed => {
    const s = await setup();
    let demoRunId: Id<"demoRuns"> | undefined;
    if (changed === "closed_demo") await s.t.run(async ctx => {
      demoRunId = await ctx.db.insert("demoRuns", { scenario: "revision", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
      await ctx.db.patch(s.eventId, { demoRunId }); await ctx.db.patch(s.roomId, { demoRunId }); await ctx.db.patch(s.hostRunId, { demoRunId });
      for (const row of await ctx.db.query("messages").collect()) await ctx.db.patch(row._id, { demoRunId });
      for (const row of await ctx.db.query("understood").collect()) await ctx.db.patch(row._id, { demoRunId });
      for (const row of await ctx.db.query("log").collect()) await ctx.db.patch(row._id, { demoRunId });
    });
    const before = await cards(s);
    orbit(() => s.t.run(async ctx => {
      if (changed === "original") await ctx.db.patch(s.sourceId as Id<"messages">, { originalText: "Cannot maneuver" });
      if (changed === "correction") {
        const row = (await ctx.db.query("understood").collect())[0]; await ctx.db.patch(row._id, { status: "corrected" });
      }
      if (changed === "assignment") {
        const assignment = (await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", s.operatorId)).collect())[0];
        await ctx.db.patch(assignment._id, { active: false });
      }
      if (changed === "ownership") {
        const owners = await ctx.db.query("satelliteOwners").collect(); const a = owners.find(o => o.objectId === "SIM-1001")!, b = owners.find(o => o.objectId === "SIM-1002")!;
        await ctx.db.patch(a._id, { companyId: b.companyId });
      }
      if (changed === "evidence") await ctx.db.patch(s.eventId, { missKm: 0.8 });
      if (changed === "candidate_set") {
        const set = (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", s.eventId)).unique())!;
        await ctx.db.patch(set._id, { version: set.version + 1 });
      }
      if (changed === "closed_room") await ctx.db.patch(s.roomId, { state: "closed", closedAt: Date.now() });
      if (changed === "closed_demo") await ctx.db.patch(demoRunId!, { state: "closed", closedAt: Date.now() });
    }));
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(await cards(s)).toEqual(before);
    expect((await revisions(s)).every(r => r.changeSummary === null)).toBe(true);
    expect((await s.t.run(ctx => ctx.db.query("log").collect())).filter(l => l.action === "proposal_revised")).toEqual([]);
  });

  it("does not reject harmless voice playback and translation metadata changes", async () => {
    const s = await setup({ voice: true });
    orbit(() => s.t.run(ctx => ctx.db.patch(s.sourceId as Id<"call_phrases">, { rev: 3, translations: { zh: "翻译" }, updatedAt: new Date().toISOString() })));
    expect(await run(s)).toEqual([expect.objectContaining({ status: "published" })]);
  });

  it.each(["head", "eye", "unassigned", "c"])("rejects public revision requests from %s", async name => {
    const s = await setup();
    expect(await code(as(s.t, name).mutation(api.revisions.request, { eventId: s.eventId, hostRunId: s.hostRunId }))).toBe("FORBIDDEN");
  });

  it("allows a responsible operator without room presence while enforcing current decision turns", async () => {
    const s = await setup();
    await s.t.run(async ctx => { for (const member of await ctx.db.query("roomMembers").collect()) await ctx.db.patch(member._id, { inRoom: false, inCall: false }); });
    expect(await as(s.t, "a").mutation(api.revisions.request, { eventId: s.eventId, hostRunId: s.hostRunId })).toEqual({ accepted: true, alreadyApplied: false });
    await as(s.t, "a").mutation(api.revisions.request, { eventId: s.eventId, hostRunId: s.hostRunId });
    const queued = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued.filter(j => j.name === "revisions:fromHost")).toHaveLength(1);
    await pick(s.t, "a", s.eventId, "P1");
    expect(await code(as(s.t, "b").mutation(api.revisions.request, { eventId: s.eventId, hostRunId: s.hostRunId }))).toBe("INVALID_STATE");
    expect(await code(s.t.mutation(api.revisions.request, { eventId: s.eventId, hostRunId: s.hostRunId }))).toBe("UNAUTHENTICATED");
  });

  it("refuses an earlier checked request once a newer Host discussion has succeeded", async () => {
    const s = await setup(), before = await cards(s), fetch = orbit();
    await s.t.run(ctx => ctx.db.insert("hostRuns", { roomId: s.roomId, trigger: "final_message", inputVersion: "newer",
      attempt: 1, status: "succeeded", span: null, output: { inputVersion: "newer", clarifications: [], requestedRevisions: [], summaries: [] },
      check: null, demoRunId: null, createdAt: Date.now() + 1, finishedAt: Date.now() + 1 }));
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "STALE_REVISION" })]);
    expect(fetch).not.toHaveBeenCalled(); expect(await cards(s)).toEqual(before);
  });

  it("refuses a shared mover without publishing independent per-event revisions", async () => {
    const s = await setup();
    const other = await insertEvent(s.t, { ...advocateEvent, objectB: { ...advocateEvent.objectB, objectId: "SIM-3001" } });
    await s.t.run(ctx => ctx.db.insert("roomEvents", { roomId: s.roomId, eventId: other, linkedAt: Date.now() }));
    const before = await cards(s); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "TRAJECTORY_PLAN_REQUIRED" })]);
    expect(await cards(s)).toEqual(before);
    expect(await s.t.run(ctx => ctx.db.query("trajectoryPlans").collect())).toEqual([]);
  });

  it("rechecks a shared-mover link that appears while the numerical request is in flight", async () => {
    const s = await setup();
    const other = await insertEvent(s.t, { ...advocateEvent, objectB: { ...advocateEvent.objectB, objectId: "SIM-3001" } });
    const before = await cards(s);
    orbit(() => s.t.run(async ctx => { await ctx.db.insert("roomEvents", { roomId: s.roomId, eventId: other, linkedAt: Date.now() }); }));
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "TRAJECTORY_PLAN_REQUIRED" })]);
    expect(await cards(s)).toEqual(before);
  });

  it("cannot remove a plan-bound mover by replacing its cards with wait", async () => {
    const s = await setup({ text: "Move SIM-1001 only; delta-v at most 0.001 m/s" });
    await s.t.run(ctx => ctx.db.insert("trajectoryPlans", { objectId: "SIM-1001", planVersion: 4, state: "authorizing",
      affectedEventIds: [s.eventId], eventRefs: [], maneuverId: null, demoRunId: null, createdAt: Date.now(), updatedAt: Date.now() }));
    orbit(); expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "TRAJECTORY_PLAN_REQUIRED" })]);
    expect((await cards(s)).length).toBe(4);
  });

  it("refuses mismatched numerical geometry and leaves current options unchanged", async () => {
    const s = await setup(), before = await cards(s);
    orbit(undefined, body => { body.relSpeedKmS = 9; });
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "GEOMETRY_MISMATCH" })]);
    expect(await cards(s)).toEqual(before);
  });
});

describe("deterministic constraint interpretation", () => {
  it("distinguishes after/before from cannot-before/cannot-after at the exact UTC boundary", () => {
    const req: CandidatesRequest = { snapshotId: "fixture:test", evidenceVersion: "ev-test", objectA: "SIM-1001", objectB: "SIM-1002",
      tcaUtc: advocateEvent.tcaUtc, allowedMovingObjectIds: ["SIM-1001", "SIM-1002"], notBeforeUtc: "2026-10-24T12:00:00Z" };
    const response = answer(req) as CandidatesResponse, at = response.candidates[0].burnTimeUtc!;
    const matching = (clause: string) => filterDiscussionGrid(response, parseDiscussionConstraints(clause, "SIM-1001", req.allowedMovingObjectIds)).candidates.some(c => c.candidateId === "grid-0");
    expect(matching(`burn after ${at}`)).toBe(false);
    expect(matching(`cannot maneuver before ${at}`)).toBe(true);
    expect(matching(`burn before ${at}`)).toBe(false);
    expect(matching(`cannot maneuver after ${at}`)).toBe(true);
  });
  it("filters a blocked UTC window and minimum delta-v across the full grid without changing other movers", () => {
    const response = answer({ snapshotId: "fixture:test", evidenceVersion: "ev-test", objectA: "SIM-1001", objectB: "SIM-1002",
      tcaUtc: advocateEvent.tcaUtc, allowedMovingObjectIds: ["SIM-1001", "SIM-1002"], notBeforeUtc: "2026-10-24T12:00:00Z" }) as CandidatesResponse;
    const constraints = parseDiscussionConstraints("Cannot maneuver between 2026-10-24T13:00:00Z and 2026-10-24T16:00:00Z; delta-v at least 0.1 m/s; burn before 2026-10-25T01:00:00Z", "SIM-1001", ["SIM-1001", "SIM-1002"]);
    const result = filterDiscussionGrid(response, constraints);
    expect(result.candidates.map(c => c.candidateId)).toEqual(["grid-1", "grid-3", "grid-4"]);
    expect(result.wait).toBe(response.wait);
  });
  it.each(["burn after 2026-02-30T12:00:00Z", "burn after 12:00", "delta-v at most -0.1 m/s", "delta-v at most 0 m/s", "Only SIM-1002 may move", "use retrograde or prograde"])("requires clarification for %s", original => {
    expect(() => parseDiscussionConstraints(original, "SIM-1001", ["SIM-1001", "SIM-1002"])).toThrow();
  });
});
