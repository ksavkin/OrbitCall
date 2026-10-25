import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { inputKey } from "../convex/lib/analyst";
import { loadFacts } from "../convex/lib/events";
import { HORIZON_H, POLL_LIMIT, scheduleContent, scheduleDiff } from "../convex/maneuvers";
import type { RescreenRequest } from "../convex/lib/orbitClient";

// New module paths deliberately avoid generated bindings (#6). Worker artifacts below are explicitly test
// fixtures for the internal adapter seams, not evidence of a deployed Factory worker or spacecraft execution.
const call = {
  preview: makeFunctionReference<"query">("maneuvers:preview"),
  get: makeFunctionReference<"query">("maneuvers:get"),
  recordPreview: makeFunctionReference<"mutation">("maneuvers:recordPreview"),
  start: makeFunctionReference<"mutation">("maneuvers:start"),
  reserveCommit: makeFunctionReference<"mutation">("maneuvers:reserveCommit"),
  recordCommit: makeFunctionReference<"mutation">("maneuvers:recordCommit"),
  requestPreview: makeFunctionReference<"mutation">("maneuvers:requestPreview"),
};
const identity = (t: Backend, who: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${who}` });
const SHA = "a".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-service-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup(options: { wait?: boolean; debris?: "A" | "B"; demo?: boolean } = {}) {
  const t = backend(), eventId = await insertEvent(t, advocateEvent);
  const ids = await t.run(async ctx => {
    const a = await ctx.db.insert("companies", { key: "a", name: "A", simulated: true });
    const b = await ctx.db.insert("companies", { key: "b", name: "B", simulated: true });
    const users = {} as Record<string, Id<"users">>;
    for (const [name, companyId, role] of [["a", a, "operator"], ["b", b, "operator"], ["head", a, "head_of_ops"], ["observer", a, "demo_observer"], ["stranger", b, "operator"]] as const) {
      users[name] = await ctx.db.insert("users", { tokenIdentifier: `https://fixture.invalid|${name}`, companyId, role, assignmentVersion: 1 });
    }
    const assignments = {} as Record<string, Id<"fleetAssignments">>;
    const policyIds = {} as Record<string, Id<"policies">>;
    for (const [side, companyId, objectId, userId, policy] of [["A", a, "SIM-1001", users.a, policyA], ["B", b, "SIM-1002", users.b, policyB]] as const) {
      if (options.debris && side !== options.debris) continue;
      await ctx.db.insert("satelliteOwners", { objectId, companyId });
      assignments[side] = await ctx.db.insert("fleetAssignments", { userId, objectId, active: true });
      policyIds[side] = await ctx.db.insert("policies", { companyId, revision: 1, satellites: [policy], updatedAt: FIXTURE_NOW - 1_000 });
    }
    const demoRunId = options.demo ? await ctx.db.insert("demoRuns", { scenario: "schedule-fixture", state: "open", startedBy: users.a, manifest: null, startedAt: FIXTURE_NOW, closedAt: null }) : null;
    await ctx.db.patch(eventId, { status: "proposal", workflow: options.debris ? "unilateral_debris" : "bilateral",
      requiredApprovalSides: options.debris ? [options.debris] : ["A", "B"], approvalRuleVersion: 1, ...(demoRunId ? { demoRunId } : {}) });
    const candidate = options.wait ? advocateCandidates.find(c => c.kind === "wait")! : options.debris === "B" ? advocateCandidates.find(c => c.movingSide === "B")! : advocateCandidates[0];
    const candidateRevisionId = await ctx.db.insert("candidateRevisions", { ...candidate, eventId });
    const candidateSetId = await ctx.db.insert("candidateSets", { eventId, companyAId: options.debris === "B" ? null : a,
      companyBId: options.debris === "A" ? null : b, version: 1, evidenceKey: inputKey(await loadFacts(ctx, (await ctx.db.get(eventId))!)),
      candidateRevisionIds: [candidateRevisionId], state: "open", reviewRequired: false });
    const proposalId = await ctx.db.insert("proposals", { eventId, candidateId: candidate.candidateId, label: candidate.label, latestRevision: candidate.revision, demoRunId, createdAt: FIXTURE_NOW });
    const proposalRevisionId = await ctx.db.insert("proposalRevisions", { eventId, proposalId, revision: candidate.revision, candidateRevisionId,
      changeSummary: null, sourceMessageIds: [], rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null, simulated: true, createdAt: FIXTURE_NOW });
    const selectionId = await ctx.db.insert("selections", { eventId, proposalId, revision: candidate.revision, generation: 1, by: { kind: "agents" }, at: FIXTURE_NOW, lastReset: null });
    return { a, b, users, assignments, policyIds, demoRunId, candidateSetId, candidateRevisionId, proposalRevisionId, selectionId,
      selection: { eventId, proposalId, revision: candidate.revision, selectionGeneration: 1, approvalRuleVersion: 1 } };
  });
  return { t, eventId, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function prepare(s: Setup) {
  const preview = await s.t.query(call.preview, { ref: s.selection });
  const after = scheduleContent([preview.entry]);
  const diff = scheduleDiff(preview.filePath, null, after);
  const maneuverId: Id<"maneuvers"> = await s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: preview.pinned, before: null, after, diff });
  return { preview, after, diff, maneuverId };
}
async function approve(s: Setup, sides: ("A" | "B")[] = ["A", "B"]) {
  vi.setSystemTime(Date.now() + 100);
  await s.t.run(async ctx => {
    for (const side of sides) await ctx.db.insert("approvals", { eventId: s.eventId, side, status: "approved", userId: s.users[side.toLowerCase()],
      companyId: side === "A" ? s.a : s.b, proposalId: s.selection.proposalId, revision: s.selection.revision, selectionGeneration: 1, approvalRuleVersion: 1,
      trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null, demoRunId: s.demoRunId, current: true, at: Date.now(), assignmentVersion: 1 });
    await ctx.db.patch(s.eventId, { status: "approved" });
  });
}
const rows = <T extends "maneuvers" | "approvals" | "log" | "verifications">(s: Setup, table: T) => s.t.run(ctx => ctx.db.query(table).collect());
const start = (s: Setup, p: Awaited<ReturnType<typeof prepare>>) => s.t.mutation(call.start, { ref: s.selection, expectedPinned: p.preview.pinned });
const workerResult = (p: Awaited<ReturnType<typeof prepare>>, overrides = {}) => ({ maneuverId: p.maneuverId, intentKey: p.preview.intentKey,
  filePath: p.preview.filePath, after: p.after, diff: p.diff, commitSha: SHA, ...overrides });

function mockOrbit({ pass = true, running = false, resultPatch = {}, beforeGet }: { pass?: boolean; running?: boolean; resultPatch?: Record<string, unknown>; beforeGet?: () => Promise<void> } = {}) {
  let request: RescreenRequest;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      request = JSON.parse(String(init.body));
      return json({ jobId: request.jobId, status: "queued", created: true, statusUrl: `/jobs/${request.jobId}` }, 202);
    }
    await beforeGet?.();
    const result = { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion, passed: pass, objectsChecked: 154,
      objectsInCatalog: 19468, horizonH: HORIZON_H, originalMissAfterKm: pass ? 1.5 : 0.3, newConjunctions: [], refusalReason: pass ? null : "The original encounter remains below 1 km.",
      simulated: true, method: "test orbit service", limitations: ["Indicative"], fromUtc: request.fromUtc, toUtc: request.toUtc,
      screenedFromUtc: request.fromUtc, screenedToUtc: request.toUtc, proposalId: request.proposalId, revision: request.revision,
      ...(request.runId ? { runId: request.runId } : {}), ...resultPatch };
    return json({ jobId: request.jobId, kind: "rescreen", status: running ? "running" : "completed", phase: running ? "screening" : "done",
      progress: running ? 0.5 : 1, counters: {}, coverage: null, requestHash: "fixture-request", createdAt: new Date(FIXTURE_NOW).toISOString(),
      startedAt: new Date(FIXTURE_NOW).toISOString(), finishedAt: running ? null : new Date(Date.now()).toISOString(),
      result: running ? null : result, resultRef: null, error: null });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, request: () => request! };
}

describe("prepared schedule and reads", () => {
  it("reports the absent Factory worker without inventing a preview or a committed maneuver", async () => {
    const s = await setup();
    const preview = await s.t.query(call.preview, { ref: s.selection });
    expect(preview).toMatchObject({ trajectory: null, intentKey: expect.stringContaining(":generation:1") });
    expect(preview).not.toHaveProperty("workerAvailable");
    expect(await s.t.mutation(call.requestPreview, { eventId: s.eventId })).toEqual({ status: "skipped", code: "WORKER_UNAVAILABLE" });
    await finish(s.t);
    expect(await rows(s, "maneuvers")).toEqual([]);
    expect((await rows(s, "log")).filter(l => l.action === "schedule_failed")).toEqual([]);
    // A configured but unreachable worker is logged once for the intent.
    vi.stubEnv("SCHEDULE_SERVICE_URL", "https://scheduler.test"); vi.stubEnv("SCHEDULE_SERVICE_TOKEN", "fixture-token-of-at-least-thirty-two-chars");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    expect(await s.t.mutation(call.requestPreview, { eventId: s.eventId })).toEqual({ status: "requested", code: null });
    await finish(s.t);
    expect((await rows(s, "log")).filter(l => l.action === "schedule_failed").map(l => l.summary)).toEqual([expect.stringMatching(/^WORKER_UNAVAILABLE/)]);
    vi.unstubAllEnvs(); vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-service-token");
    await approve(s);
    await expect(s.t.mutation(call.start, { ref: s.selection, expectedPinned: preview.pinned })).rejects.toMatchObject({ data: { code: "WORKER_UNAVAILABLE" } });
  });
  it("checks an exact append, keeps the preview immutable, and allows only current operator/head reads", async () => {
    const s = await setup(), p = await prepare(s);
    expect(await s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: p.preview.pinned, before: null, after: p.after, diff: p.diff })).toBe(p.maneuverId);
    expect(await rows(s, "maneuvers")).toHaveLength(1);
    for (const name of ["a", "b", "head"]) {
      const view = await identity(s.t, name).query(call.get, { eventId: s.eventId });
      expect(view).toMatchObject({ status: "preview", commitSha: null, execution: "not_verified" });
      expect(JSON.stringify(view)).not.toMatch(/PRIVATE_|currentFuelKg|policyRevisions|assignmentVersions/);
    }
    for (const name of ["observer", "stranger"]) await expect(identity(s.t, name).query(call.get, { eventId: s.eventId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(s.t.query(call.get, { eventId: s.eventId })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    const changed = scheduleContent([{ ...p.preview.entry, deltaVMs: 0.99 }]);
    await expect(s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: p.preview.pinned, before: null, after: changed, diff: scheduleDiff(p.preview.filePath, null, changed) })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });
  it("rejects a preview manufactured after approval and a prepared diff that touches another path", async () => {
    const s = await setup(), preview = await s.t.query(call.preview, { ref: s.selection });
    const after = scheduleContent([preview.entry]);
    await expect(s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: preview.pinned, before: null, after,
      diff: scheduleDiff("../../outside.json", null, after) })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await approve(s);
    await expect(s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: preview.pinned, before: null, after,
      diff: scheduleDiff(preview.filePath, null, after) })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
  });
  it("checks an append to an existing schedule without exposing previous unrelated entries in the shared diff", async () => {
    const s = await setup(), preview = await s.t.query(call.preview, { ref: s.selection });
    const previous = { eventId: "another-event", proposalId: "another-proposal", revision: 1, objectId: "UNRELATED_SATELLITE" };
    const before = scheduleContent([previous]), after = scheduleContent([previous, preview.entry]);
    const diff = scheduleDiff(preview.filePath, before, after);
    await s.t.mutation(call.recordPreview, { ref: s.selection, expectedPinned: preview.pinned, before, after, diff });
    expect(diff).not.toContain("UNRELATED_SATELLITE");
    expect((await identity(s.t, "b").query(call.get, { eventId: s.eventId })).diff).toBe(diff);
  });
  it("reselects the same immutable revision with a fresh generation without reviving the old intent", async () => {
    const s = await setup(), old = await prepare(s);
    await s.t.run(ctx => ctx.db.patch(s.selectionId, { generation: 3, lastReset: { at: Date.now(), reason: "selected again" } }));
    s.selection.selectionGeneration = 3;
    const next = await prepare(s);
    expect(next.after).toBe(old.after);
    expect(next.preview.intentKey).not.toBe(old.preview.intentKey);
    expect(next.maneuverId).not.toBe(old.maneuverId);
    await expect(start(s, next)).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
  });
});

describe("human authorization", () => {
  it("requires both companies, not selection or one approval, before starting the orbital job", async () => {
    const s = await setup(), p = await prepare(s), orbit = mockOrbit();
    await expect(start(s, p)).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    await approve(s, ["A"]);
    await expect(start(s, p)).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    expect(orbit.fetch).not.toHaveBeenCalled();
  });
  it.each(["A", "B"] as const)("supports confirmed debris with only active side %s and no invented approval", async side => {
    const s = await setup({ debris: side }), p = await prepare(s); mockOrbit();
    await approve(s, [side]); await start(s, p); await finish(s.t);
    expect((await rows(s, "approvals")).map(a => a.side)).toEqual([side]);
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "failed", rescreen: { passed: true }, error: expect.stringContaining("WORKER_UNAVAILABLE") });
  });
  it("moves an explicitly approved wait to monitoring without an artifact or service request", async () => {
    const s = await setup({ wait: true }), preview = await s.t.query(call.preview, { ref: s.selection }), orbit = mockOrbit();
    expect(preview.entry).toBeNull();
    await expect(s.t.mutation(call.start, { ref: s.selection, expectedPinned: preview.pinned })).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    await approve(s);
    for (let i = 0; i < 2; i++) expect(await s.t.mutation(call.start, { ref: s.selection, expectedPinned: preview.pinned })).toEqual({ maneuverId: null, status: "monitoring" });
    expect(await rows(s, "maneuvers")).toEqual([]); expect(orbit.fetch).not.toHaveBeenCalled();
    expect((await rows(s, "log")).filter(l => l.action === "status_changed")).toHaveLength(1);
  });
  it("does not carry an approved wait across changed policy pins", async () => {
    const s = await setup({ wait: true }), preview = await s.t.query(call.preview, { ref: s.selection }); await approve(s);
    await s.t.run(ctx => ctx.db.patch(s.policyIds.A, { revision: 2 }));
    await expect(s.t.mutation(call.start, { ref: s.selection, expectedPinned: preview.pinned })).rejects.toMatchObject({ data: { code: "STALE_REVISION" } });
    expect((await s.t.run(ctx => ctx.db.get(s.eventId)))!.status).toBe("approved");
    expect(await rows(s, "maneuvers")).toEqual([]);
  });
  it.each(["revision", "generation", "rule", "role", "assignment", "assignment_version", "legacy_version"])("rejects stale approval %s", async field => {
    const s = await setup(), p = await prepare(s); await approve(s);
    await s.t.run(async ctx => {
      const approval = (await ctx.db.query("approvals").collect())[0];
      if (field === "revision") await ctx.db.patch(approval._id, { revision: 999 });
      if (field === "generation") await ctx.db.patch(approval._id, { selectionGeneration: 999 });
      if (field === "rule") await ctx.db.patch(approval._id, { approvalRuleVersion: 999 });
      if (field === "role") await ctx.db.patch(s.users.a, { role: "head_of_ops" });
      if (field === "assignment") await ctx.db.patch(s.assignments.A, { active: false });
      if (field === "assignment_version") await ctx.db.patch(approval._id, { assignmentVersion: 99 });
      if (field === "legacy_version") await ctx.db.patch(approval._id, { assignmentVersion: undefined });
    });
    await expect(start(s, p)).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
  });
  it("rejects internal review and empty required-side lists", async () => {
    const s = await setup(), p = await prepare(s); await approve(s);
    await s.t.run(ctx => ctx.db.patch(s.eventId, { workflow: "internal_review", requiredApprovalSides: [] }));
    await expect(start(s, p)).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
  });
});

describe("re-screen and artifact intent", () => {
  it("posts one stable job for repeated starts and leaves absent-worker failure visible after a pass", async () => {
    const s = await setup(), p = await prepare(s), orbit = mockOrbit(); await approve(s);
    const first = await start(s, p);
    expect(await start(s, p)).toEqual(first);
    await finish(s.t);
    expect(orbit.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(orbit.request()).toMatchObject({ jobId: `rescreen-${p.maneuverId}`, snapshotId: p.preview.pinned.snapshotId,
      objectId: p.preview.entry.objectId, partnerObjectId: "SIM-1002", maneuver: { deltaVMs: p.preview.entry.deltaVMs, burnTimeUtc: p.preview.entry.burnTimeUtc, direction: p.preview.entry.direction } });
    const [row] = await rows(s, "maneuvers");
    expect(row).toMatchObject({ status: "failed", commitSha: null, reviewRequired: false, rescreen: { passed: true }, error: expect.stringContaining("WORKER_UNAVAILABLE") });
    expect((await s.t.run(ctx => ctx.db.get(s.eventId)))!.status).toBe("approved");
    expect(await rows(s, "verifications")).toEqual([]);
  });
  it("refuses unsafe geometry, preserves the approval history and visibly advances the generation", async () => {
    const s = await setup(), p = await prepare(s); mockOrbit({ pass: false }); await approve(s);
    await start(s, p); await finish(s.t);
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "refused", commitSha: null, rescreen: { passed: false } });
    expect((await rows(s, "approvals")).map(a => [a.status, a.current])).toEqual([["approved", false], ["approved", false]]);
    expect(await s.t.run(ctx => ctx.db.get(s.selectionId))).toMatchObject({ generation: 2, lastReset: { reason: expect.stringContaining("below 1 km") } });
    expect((await s.t.run(ctx => ctx.db.get(s.eventId)))!.status).toBe("agents");
  });
  it.each(["evidence", "policy", "assignment", "candidate_set", "snapshot", "ownership"])("rejects %s changes while the remote re-screen is running", async change => {
    const s = await setup(), p = await prepare(s); await approve(s);
    let changed = false;
    mockOrbit({ beforeGet: async () => {
      if (changed) return; changed = true;
      await s.t.run(async ctx => {
        if (change === "evidence") await ctx.db.patch(s.eventId, { missKm: 0.2 });
        if (change === "policy") await ctx.db.patch(s.policyIds.A, { revision: 2 });
        if (change === "assignment") await ctx.db.patch(s.users.a, { assignmentVersion: 2 });
        if (change === "candidate_set") await ctx.db.patch(s.candidateSetId, { version: 2 });
        if (change === "snapshot") {
          const event = (await ctx.db.get(s.eventId))!;
          await ctx.db.patch(event.snapshotId, { snapshotId: "changed", ommUrl: "/snapshots/gp-20261025T0900Z/catalog.json" });
        }
        if (change === "ownership") {
          const owner = (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1001")).unique())!;
          await ctx.db.patch(owner._id, { companyId: s.b });
        }
      });
    } });
    await start(s, p); await finish(s.t);
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "failed", commitSha: null, reviewRequired: true });
    expect((await rows(s, "approvals")).every(a => !a.current)).toBe(true);
  });
  it("does not reset a newer selection when an old remote result returns", async () => {
    const s = await setup(), p = await prepare(s); await approve(s);
    mockOrbit({ beforeGet: () => s.t.run(ctx => ctx.db.patch(s.selectionId, { generation: 2, lastReset: { at: Date.now(), reason: "new human selection" } })) });
    await start(s, p); await finish(s.t);
    expect(await s.t.run(ctx => ctx.db.get(s.selectionId))).toMatchObject({ generation: 2, lastReset: { reason: "new human selection" } });
    expect((await rows(s, "maneuvers"))[0].reviewRequired).toBe(true);
  });
  it("bounds polling and retries the same intent and orbit job", async () => {
    const s = await setup(), p = await prepare(s), orbit = mockOrbit({ running: true }); await approve(s);
    await start(s, p); await finish(s.t);
    expect(orbit.fetch).toHaveBeenCalledTimes(POLL_LIMIT + 1);
    expect((await rows(s, "maneuvers"))[0].error).toMatch(/^RESCREEN_TIMEOUT/);
    const jobId = orbit.request().jobId;
    await start(s, p); await finish(s.t);
    expect(orbit.request().jobId).toBe(jobId); expect(await rows(s, "maneuvers")).toHaveLength(1);
  });
  it.each([{ snapshotId: "wrong" }, { horizonH: 1 }, { screenedToUtc: "2026-10-26T00:00:00Z" }, { revision: 999 }, { runId: "another-run" }])("rejects a mismatched service response %j", async resultPatch => {
    const s = await setup(), p = await prepare(s); mockOrbit({ resultPatch }); await approve(s);
    await start(s, p); await finish(s.t);
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "failed", commitSha: null, rescreen: null });
  });
  it("records the checked worker artifact once, then returns it on the same key without execution claims", async () => {
    const s = await setup(), p = await prepare(s); mockOrbit(); await approve(s);
    await start(s, p); await finish(s.t);
    expect(await s.t.mutation(call.reserveCommit, { maneuverId: p.maneuverId })).toMatchObject({ status: "reserved", intentKey: p.preview.intentKey });
    await expect(s.t.mutation(call.recordCommit, workerResult(p, { after: "{}" }))).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await expect(s.t.mutation(call.recordCommit, workerResult(p, { filePath: "../../outside.json" }))).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    expect(await s.t.mutation(call.recordCommit, workerResult(p))).toBe(p.maneuverId);
    const saved = (await rows(s, "maneuvers"))[0]; vi.setSystemTime(Date.now() + 5_000);
    expect(await s.t.mutation(call.recordCommit, workerResult(p))).toBe(p.maneuverId);
    expect((await rows(s, "maneuvers"))[0]).toEqual(saved);
    expect(await s.t.mutation(call.reserveCommit, { maneuverId: p.maneuverId })).toMatchObject({ status: "committed", commitSha: SHA });
    expect((await rows(s, "log")).filter(l => l.action === "schedule_committed")).toHaveLength(1);
    expect((await s.t.run(ctx => ctx.db.get(s.eventId)))!.status).toBe("scheduled");
    expect(await rows(s, "verifications")).toEqual([]);
    expect(await identity(s.t, "a").query(call.get, { eventId: s.eventId })).toMatchObject({ status: "committed", execution: "not_verified", reviewRequired: false });
  });
  it("preserves a late actual artifact but flags changed authorization instead of silently scheduling it", async () => {
    const s = await setup(), p = await prepare(s); mockOrbit(); await approve(s);
    await start(s, p); await finish(s.t);
    await s.t.mutation(call.reserveCommit, { maneuverId: p.maneuverId });
    await s.t.run(ctx => ctx.db.patch(s.policyIds.A, { revision: 2 }));
    await s.t.mutation(call.recordCommit, workerResult(p));
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "committed", commitSha: SHA, reviewRequired: true });
    expect((await s.t.run(ctx => ctx.db.get(s.eventId)))!.status).toBe("agents");
    expect((await rows(s, "approvals")).every(a => !a.current)).toBe(true);
  });
  it("rejects closed demo runs and shared movers until all-event trajectory authorization is connected", async () => {
    const s = await setup({ demo: true }), p = await prepare(s); await approve(s);
    await s.t.run(ctx => ctx.db.patch(s.demoRunId!, { state: "closed", closedAt: Date.now() }));
    await expect(start(s, p)).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    const next = await setup();
    await next.t.run(async ctx => {
      const event = (await ctx.db.get(next.eventId))!;
      const other = await ctx.db.insert("spaceObjects", { objectId: "60001", name: "Third spacecraft", country: null, launchDate: null });
      const { _id, _creationTime, ...fields } = event;
      await ctx.db.insert("events", { ...fields, objectBId: other, tcaMs: event.tcaMs + 3600_000 });
    });
    await expect(next.t.query(call.preview, { ref: next.selection })).rejects.toMatchObject({ data: { code: "SHARED_TRAJECTORY_REQUIRED" } });
  });
});

it("cannot authorize a wait from an old assignment version before reserving any artifact", async () => {
  const s = await setup({ wait: true });
  await approve(s);
  await s.t.run(ctx => ctx.db.patch(s.users.a, { assignmentVersion: 2 }));
  const preview = await s.t.query(call.preview, { ref: s.selection });
  await expect(s.t.mutation(call.start, { ref: s.selection, expectedPinned: preview.pinned }))
    .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
  expect(await rows(s, "maneuvers")).toEqual([]);
});
