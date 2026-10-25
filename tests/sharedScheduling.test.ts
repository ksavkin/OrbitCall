import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { inputKey } from "../convex/lib/analyst";
import { loadFacts } from "../convex/lib/events";
import { HORIZON_H, scheduleContent, scheduleDiff } from "../convex/maneuvers";
import type { RescreenRequest } from "../convex/lib/orbitClient";

// A shared mover: one spacecraft (SIM-1001) moved by one burn that affects two linked pair events, E1 (vs SIM-1002)
// and E2 (vs SIM-3001). The trajectory plan binds both events; one schedule write and one commit cover both.
// The worker and orbit service below are in-memory test fixtures, not deployed services.
const call = {
  get: makeFunctionReference<"query">("maneuvers:get"),
  requestPreview: makeFunctionReference<"mutation">("maneuvers:requestPreview"),
  requestSchedule: makeFunctionReference<"mutation">("maneuvers:requestSchedule"),
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

const MOVED = advocateCandidates[0];
// E2's encounter follows the burn and lies well inside the 72 h horizon; same snapshot key and sources as E1.
const partnerEvent = {
  ...advocateEvent,
  objectB: { ...advocateEvent.objectB, objectId: "SIM-3001", name: "Advocate fixture C" },
  tcaUtc: "2026-10-25T05:14:07Z",
};
const policyC = { ...policyB, objectId: "SIM-3001" };
type EventRef = { eventId: Id<"events">; proposalId: Id<"proposals">; revision: number; selectionGeneration: number };
type PairEvent = { eventId: Id<"events">; proposalId: Id<"proposals">; proposalRevisionId: Id<"proposalRevisions">; selectionId: Id<"selections">; ref: EventRef };

async function setup(options: { shared?: boolean; omitPartnerFromPlan?: boolean; partnerDeltaVMs?: number } = {}) {
  const shared = options.shared ?? true;
  const t = backend();
  const e1Id = await insertEvent(t, advocateEvent);
  const e2Id = shared ? await insertEvent(t, partnerEvent) : null;
  const ids = await t.run(async ctx => {
    const a = await ctx.db.insert("companies", { key: "a", name: "A", simulated: true });
    const b = await ctx.db.insert("companies", { key: "b", name: "B", simulated: true });
    const c = await ctx.db.insert("companies", { key: "c", name: "C", simulated: true });
    const users = {} as Record<"a" | "b" | "c", Id<"users">>;
    for (const [name, companyId] of [["a", a], ["b", b], ["c", c]] as const) {
      users[name] = await ctx.db.insert("users", { tokenIdentifier: `https://fixture.invalid|${name}`, companyId, role: "operator", assignmentVersion: 1 });
    }
    const owners = [["SIM-1001", a, users.a, policyA], ["SIM-1002", b, users.b, policyB], ["SIM-3001", c, users.c, policyC]] as const;
    for (const [objectId, companyId, userId, policy] of owners) {
      if (!shared && objectId === "SIM-3001") continue;
      await ctx.db.insert("satelliteOwners", { objectId, companyId });
      await ctx.db.insert("fleetAssignments", { userId, objectId, active: true });
      await ctx.db.insert("policies", { companyId, revision: 1, satellites: [policy], updatedAt: FIXTURE_NOW - 1_000 });
    }
    const pair = async (eventId: Id<"events">, companyBId: Id<"companies">, candidate: typeof MOVED): Promise<PairEvent> => {
      await ctx.db.patch(eventId, { status: "proposal", workflow: "bilateral", requiredApprovalSides: ["A", "B"], approvalRuleVersion: 1 });
      const candidateRevisionId = await ctx.db.insert("candidateRevisions", { ...candidate, eventId });
      await ctx.db.insert("candidateSets", { eventId, companyAId: a, companyBId, version: 1,
        evidenceKey: inputKey(await loadFacts(ctx, (await ctx.db.get(eventId))!)), candidateRevisionIds: [candidateRevisionId], state: "open", reviewRequired: false });
      const proposalId = await ctx.db.insert("proposals", { eventId, candidateId: candidate.candidateId, label: candidate.label, latestRevision: candidate.revision, demoRunId: null, createdAt: FIXTURE_NOW });
      const proposalRevisionId = await ctx.db.insert("proposalRevisions", { eventId, proposalId, revision: candidate.revision, candidateRevisionId,
        changeSummary: null, sourceMessageIds: [], rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null, simulated: true, createdAt: FIXTURE_NOW });
      const selectionId = await ctx.db.insert("selections", { eventId, proposalId, revision: candidate.revision, generation: 1, by: { kind: "agents" }, at: FIXTURE_NOW, lastReset: null });
      return { eventId, proposalId, proposalRevisionId, selectionId, ref: { eventId, proposalId, revision: candidate.revision, selectionGeneration: 1 } };
    };
    const e1 = await pair(e1Id, b, MOVED);
    // Same moved spacecraft, burn time, delta-v and direction; only the event and proposal differ.
    const e2 = e2Id ? await pair(e2Id, c, { ...MOVED, ...(options.partnerDeltaVMs ? { deltaVMs: options.partnerDeltaVMs } : {}) }) : null;
    const planned = e2 && !options.omitPartnerFromPlan ? [e1, e2] : [e1];
    const planId = e2 ? await ctx.db.insert("trajectoryPlans", { objectId: "SIM-1001", planVersion: 1, state: "authorizing",
      affectedEventIds: planned.map(e => e.eventId), eventRefs: planned.map(e => e.ref), maneuverId: null, demoRunId: null,
      createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW }) : null;
    return { companies: { a, b, c }, users, e1, e2: e2!, planId: planId! };
  });
  return { t, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;
type Table = "maneuvers" | "maneuverEvents" | "approvals" | "log" | "trajectoryPlans" | "proposalRevisions" | "selections";
const rows = <T extends Table>(s: Setup, table: T) => s.t.run(ctx => ctx.db.query(table).collect());
const logs = async (s: Setup, action: string) => (await rows(s, "log")).filter(l => l.action === action);
const get = <T extends "events" | "trajectoryPlans" | "selections" | "proposalRevisions">(s: Setup, id: Id<T>) => s.t.run(ctx => ctx.db.get(id));
const pairOf = (s: Setup, which: "E1" | "E2") => which === "E1" ? s.e1 : s.e2;

// Both required sides of one event approve the plan-bound selection; `patch` lets a case make the approval stale.
async function approvePlan(s: Setup, which: "E1" | "E2", patch: Partial<Doc<"approvals">> = {}) {
  vi.setSystemTime(Date.now() + 100);
  const e = pairOf(s, which), partner = which === "E1" ? "b" : "c";
  await s.t.run(async ctx => {
    for (const [side, user] of [["A", "a"], ["B", partner]] as const) await ctx.db.insert("approvals", { eventId: e.eventId, side, status: "approved",
      userId: s.users[user], companyId: s.companies[user], proposalId: e.proposalId, revision: e.ref.revision, selectionGeneration: 1, approvalRuleVersion: 1,
      trajectoryPlanId: s.planId, trajectoryPlanVersion: 1, reason: null, demoRunId: null, current: true, at: Date.now(), assignmentVersion: 1, ...patch });
    await ctx.db.patch(e.eventId, { status: "approved" });
  });
}

// Orbit stand-in keyed by job id, so two partner re-screens each read back their own result.
function mockOrbit(refuse: string[] = []) {
  const jobs = new Map<string, RescreenRequest>(), posts: { path: string; body: RescreenRequest }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as RescreenRequest;
      posts.push({ path, body: request }); jobs.set(request.jobId, request);
      return json({ jobId: request.jobId, status: "queued", created: true, statusUrl: `/jobs/${request.jobId}` }, 202);
    }
    const jobId = decodeURIComponent(path.replace(/^\/jobs\//, "")), request = jobs.get(jobId);
    if (!request) return json({ error: { code: "NOT_FOUND" } }, 404);
    const pass = !refuse.includes(request.partnerObjectId);
    const result = { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion, passed: pass, objectsChecked: 154,
      objectsInCatalog: 19468, horizonH: HORIZON_H, originalMissAfterKm: pass ? 1.5 : 0.3, newConjunctions: [], refusalReason: pass ? null : "The original encounter remains below 1 km.",
      simulated: true, method: "test orbit service", limitations: ["Indicative"], fromUtc: request.fromUtc, toUtc: request.toUtc,
      screenedFromUtc: request.fromUtc, screenedToUtc: request.toUtc,
      ...(request.proposalId !== undefined ? { proposalId: request.proposalId } : {}), ...(request.revision !== undefined ? { revision: request.revision } : {}),
      ...(request.runId ? { runId: request.runId } : {}) };
    return json({ jobId, kind: "rescreen", status: "completed", phase: "done", progress: 1, counters: {}, coverage: null, requestHash: "fixture-request",
      createdAt: new Date(FIXTURE_NOW).toISOString(), startedAt: new Date(FIXTURE_NOW).toISOString(), finishedAt: new Date(Date.now()).toISOString(),
      result, resultRef: null, error: null });
  });
  return { fetch, posts, rescreens: () => posts.filter(p => p.path.endsWith("/rescreen")) };
}

// In-memory stand-in for the schedule worker's HTTP contract: deterministic job ids, idempotent POSTs per intent.
const WORKER = "https://scheduler.test";
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, "0")).join("");
type FakeJob = { jobId: string; intentKey: string; kind: "prepare" | "commit"; status: string; attempt: number; request: any; result: any; error: any };
function mockWorker(options: { refuse?: string[] } = {}) {
  const orbit = mockOrbit(options.refuse), jobs = new Map<string, FakeJob>(), posts: { path: string; body: any }[] = [];
  vi.stubEnv("SCHEDULE_SERVICE_URL", WORKER); vi.stubEnv("SCHEDULE_SERVICE_TOKEN", "fixture-token-of-at-least-thirty-two-chars");
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (!path.startsWith(WORKER)) return orbit.fetch(url, init);
    const route = path.slice(WORKER.length), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") posts.push({ path: route, body });
    if (route === "/prepare") {
      const jobId = await digest(`prepare:${body.intentKey}`);
      if (!jobs.has(jobId)) {
        const after = scheduleContent([body.entry]);
        jobs.set(jobId, { jobId, intentKey: body.intentKey, kind: "prepare", status: "completed", attempt: 1, request: body, error: null,
          result: { filePath: body.filePath, before: null, after, diff: scheduleDiff(body.filePath, null, after), contentHash: await digest(after),
            expectedPreviousHash: null, expectedPreviousCommit: SHA, factory: { sessionId: "fixture-session", modelId: "fixture-model", toolWrites: 1 }, commitSha: null } });
      }
      return json(jobs.get(jobId)!);
    }
    if (route === "/commit") {
      const jobId = await digest(`commit:${body.intentKey}`), prepared = jobs.get(body.preparedJobId)!;
      if (!jobs.has(jobId)) jobs.set(jobId, { jobId, intentKey: body.intentKey, kind: "commit", attempt: 1, request: body,
        status: "completed", result: { ...prepared.result, commitSha: "b".repeat(40) }, error: null });
      return json(jobs.get(jobId)!);
    }
    const job = jobs.get(route.replace(/^\/jobs\//, ""));
    return job ? json(job) : json({ error: { code: "NOT_FOUND" } }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, jobs, posts, orbit, prepares: () => posts.filter(p => p.path === "/prepare"), commits: () => posts.filter(p => p.path === "/commit") };
}
const trajectoryKey = (s: Setup) => `trajectory:${s.planId}:version:1`;
const wireRef = (ref: EventRef) => ({ eventId: String(ref.eventId), proposalId: String(ref.proposalId), revision: ref.revision, selectionGeneration: ref.selectionGeneration, approvalRuleVersion: 1 });

describe("shared mover: one plan-bound preview for both events", () => {
  it.each(["E1", "E2"] as const)("prepares one trajectory write for both events when %s asks first", async first => {
    const s = await setup(), worker = mockWorker();
    const other = first === "E1" ? "E2" : "E1";
    await s.t.mutation(call.requestPreview, { eventId: pairOf(s, first).eventId });
    await finish(s.t);
    expect(worker.prepares()).toHaveLength(1);
    const body = worker.prepares()[0].body;
    // The worker ref is always the plan's FIRST eventRef, whichever event triggered the preview.
    expect(body).toMatchObject({ intentKey: trajectoryKey(s), trajectory: { id: String(s.planId), version: 1 }, ref: wireRef(s.e1.ref) });
    expect(body.entry).toMatchObject({ eventId: String(s.e1.eventId), proposalId: String(s.e1.proposalId), objectId: "SIM-1001",
      burnTimeUtc: MOVED.burnTimeUtc, deltaVMs: MOVED.deltaVMs, direction: MOVED.direction });

    const maneuvers = await rows(s, "maneuvers");
    expect(maneuvers).toHaveLength(1);
    const [row] = maneuvers;
    expect(row).toMatchObject({ refs: [s.e1.ref, s.e2.ref], trajectoryPlanId: s.planId, trajectoryPlanVersion: 1, status: "preview", intentKey: trajectoryKey(s) });
    expect((await rows(s, "maneuverEvents")).filter(m => m.maneuverId === row._id).map(m => m.eventId).sort()).toEqual([s.e1.eventId, s.e2.eventId].sort());
    const r1 = await get(s, s.e1.proposalRevisionId), r2 = await get(s, s.e2.proposalRevisionId);
    expect(r1!.schedulePreviewDiff).not.toBeNull();
    expect(r1!.schedulePreviewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r2).toMatchObject({ schedulePreviewDiff: r1!.schedulePreviewDiff, schedulePreviewHash: r1!.schedulePreviewHash });

    expect(await s.t.mutation(call.requestPreview, { eventId: pairOf(s, other).eventId })).toMatchObject({ status: "prepared" });
    await finish(s.t);
    expect(worker.prepares()).toHaveLength(1);
    expect(await rows(s, "maneuvers")).toHaveLength(1);
  });
});

describe("shared mover: authorization over every affected event", () => {
  it("waits for the second event's approvals, then re-screens each partner and commits once for both", async () => {
    const s = await setup(), worker = mockWorker();
    await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId }); await finish(s.t);
    await approvePlan(s, "E1");
    expect(await s.t.mutation(call.requestSchedule, { eventId: s.e1.eventId })).toMatchObject({ status: "waiting", code: "PLAN_APPROVALS_PENDING" });
    await finish(s.t);
    expect(worker.orbit.rescreens()).toEqual([]);
    expect(worker.commits()).toEqual([]);
    expect(await logs(s, "schedule_failed")).toEqual([]);
    expect((await rows(s, "approvals")).every(a => a.current)).toBe(true);
    expect((await rows(s, "maneuvers"))[0].status).toBe("preview");

    await approvePlan(s, "E2");
    await s.t.mutation(call.requestSchedule, { eventId: s.e2.eventId });
    await finish(s.t);
    const rescreens = worker.orbit.rescreens().map(p => p.body);
    expect(rescreens).toHaveLength(2);
    expect(rescreens.map(r => r.partnerObjectId).sort()).toEqual(["SIM-1002", "SIM-3001"]);
    expect(new Set(rescreens.map(r => r.jobId)).size).toBe(2);
    for (const r of rescreens) expect(r).toMatchObject({ objectId: "SIM-1001", maneuver: { burnTimeUtc: MOVED.burnTimeUtc, deltaVMs: MOVED.deltaVMs, direction: MOVED.direction } });

    expect(worker.commits()).toHaveLength(1);
    expect(worker.commits()[0].body).toMatchObject({ intentKey: trajectoryKey(s), trajectory: { id: String(s.planId), version: 1 } });
    const maneuvers = await rows(s, "maneuvers");
    expect(maneuvers).toHaveLength(1);
    const [row] = maneuvers;
    expect(row).toMatchObject({ status: "committed", commitSha: "b".repeat(40) });
    expect((await get(s, s.e1.eventId))!.status).toBe("scheduled");
    expect((await get(s, s.e2.eventId))!.status).toBe("scheduled");
    expect(await get(s, s.planId)).toMatchObject({ state: "scheduled", maneuverId: row._id });
    for (const [who, e] of [["a", s.e1], ["b", s.e1], ["a", s.e2], ["c", s.e2]] as const) {
      expect(await identity(s.t, who).query(call.get, { eventId: e.eventId })).toMatchObject({ status: "committed", commitSha: row.commitSha, diff: row.diff });
    }
    expect(await logs(s, "schedule_failed")).toEqual([]);
  });

  it.each(["SIM-1002", "SIM-3001"])("refuses the whole plan and resets both events when the re-screen against %s fails", async partner => {
    const s = await setup(), worker = mockWorker({ refuse: [partner] });
    await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId }); await finish(s.t);
    await approvePlan(s, "E1"); await approvePlan(s, "E2");
    await s.t.mutation(call.requestSchedule, { eventId: s.e2.eventId }); await finish(s.t);
    expect(worker.orbit.rescreens().map(p => p.body.partnerObjectId)).toContain(partner);
    expect(worker.commits()).toEqual([]);
    expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "refused", commitSha: null });
    const approvals = await rows(s, "approvals");
    expect(approvals).toHaveLength(4);
    expect(approvals.every(a => !a.current)).toBe(true);
    for (const e of [s.e1, s.e2]) {
      expect(await get(s, e.selectionId)).toMatchObject({ generation: 2, lastReset: { reason: expect.any(String) } });
      expect((await get(s, e.selectionId))!.lastReset!.reason.length).toBeGreaterThan(0);
      expect((await get(s, e.eventId))!.status).toBe("agents");
    }
    // The refused version never strands the mover: the sync after the reset supersedes it.
    expect((await get(s, s.planId))!.state).toBe("superseded");
  });

  it.each([
    ["an E2 approval signed on plan version 2", async (s: Setup) => { await approvePlan(s, "E1"); await approvePlan(s, "E2", { trajectoryPlanVersion: 2 }); }],
    ["an E1 approval not bound to the plan", async (s: Setup) => { await approvePlan(s, "E1", { trajectoryPlanId: null, trajectoryPlanVersion: null }); await approvePlan(s, "E2"); }],
    ["a superseded plan", async (s: Setup) => {
      await approvePlan(s, "E1"); await approvePlan(s, "E2");
      await s.t.run(ctx => ctx.db.patch(s.planId, { state: "superseded" }));
    }],
  ] as const)("does not authorize the write with %s", async (_name, arrange) => {
    const s = await setup(), worker = mockWorker();
    await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId }); await finish(s.t);
    // Precondition: the plan-bound preview exists, so a refusal below is about authorization, not the preview.
    expect(await rows(s, "maneuvers")).toEqual([expect.objectContaining({ trajectoryPlanId: s.planId, status: "preview" })]);
    await arrange(s);
    const result = await s.t.mutation(call.requestSchedule, { eventId: s.e2.eventId });
    await finish(s.t);
    expect(worker.orbit.rescreens()).toEqual([]);
    expect(worker.commits()).toEqual([]);
    const failedLogs = await logs(s, "schedule_failed"), [row] = await rows(s, "maneuvers");
    expect({ result: result.status, logged: failedLogs.length > 0, row: row.status }).toSatisfy(
      // An approval that does not sign the current plan version does not count: the plan keeps waiting or fails visibly.
      (o: { result: string; logged: boolean; row: string }) => o.result === "failed" || o.result === "waiting" || o.logged || o.row === "failed");
    expect(row.commitSha).toBeNull();
    expect((await get(s, s.e1.eventId))!.status).not.toBe("scheduled");
    expect((await get(s, s.e2.eventId))!.status).not.toBe("scheduled");
  });

  it.each([
    ["a plan that omits an active partner event inside the burn horizon", { omitPartnerFromPlan: true }],
    ["selected candidates that disagree on the burn", { partnerDeltaVMs: 0.25 }],
  ] as const)("requires one shared trajectory for %s", async (_name, options) => {
    const s = await setup(options), worker = mockWorker();
    expect(await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId })).toEqual({ status: "skipped", code: "SHARED_TRAJECTORY_REQUIRED" });
    await finish(s.t);
    expect(worker.posts).toEqual([]);
    expect(await rows(s, "maneuvers")).toEqual([]);
  });
});

it("keeps a single-event maneuver on its event intent without a trajectory", async () => {
  const s = await setup({ shared: false }), worker = mockWorker();
  expect(await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId })).toEqual({ status: "requested", code: null });
  await finish(s.t);
  expect(worker.prepares()).toHaveLength(1);
  const body = worker.prepares()[0].body;
  expect(body.intentKey).toMatch(/^event:/);
  expect(body).toMatchObject({ trajectory: null, ref: wireRef(s.e1.ref) });
  expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "preview", trajectoryPlanId: null, refs: [s.e1.ref] });
  expect(await rows(s, "trajectoryPlans")).toEqual([]);
  // The rest of the single-event chain is unchanged: one re-screen, one commit without a trajectory.
  await approvePlan(s, "E1", { trajectoryPlanId: null, trajectoryPlanVersion: null });
  await s.t.mutation(call.requestSchedule, { eventId: s.e1.eventId }); await finish(s.t);
  expect(worker.orbit.rescreens().map(p => p.body.partnerObjectId)).toEqual(["SIM-1002"]);
  expect(worker.commits()).toHaveLength(1);
  expect(worker.commits()[0].body).toMatchObject({ intentKey: body.intentKey, trajectory: null });
  expect((await rows(s, "maneuvers"))[0]).toMatchObject({ status: "committed", commitSha: "b".repeat(40) });
  expect((await get(s, s.e1.eventId))!.status).toBe("scheduled");
});

it("refuses a plan whose affected incidents and event refs disagree", async () => {
  const s = await setup(), worker = mockWorker();
  await s.t.run(async ctx => {
    const plan = (await ctx.db.get(s.planId))!;
    await ctx.db.patch(s.planId, { eventRefs: plan.eventRefs.slice(0, 1) });
  });
  expect(await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId })).toEqual({ status: "skipped", code: "SHARED_TRAJECTORY_REQUIRED" });
  await s.t.run(async ctx => {
    const plan = (await ctx.db.get(s.planId))!;
    await ctx.db.patch(s.planId, { eventRefs: [plan.eventRefs[0], plan.eventRefs[0]] });
  });
  expect(await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId })).toEqual({ status: "skipped", code: "SHARED_TRAJECTORY_REQUIRED" });
  await finish(s.t);
  expect(worker.posts).toEqual([]);
});

it("waits quietly when an affected incident whose own approvals are incomplete asks to schedule", async () => {
  const s = await setup(), worker = mockWorker();
  await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId }); await finish(s.t);
  await approvePlan(s, "E1");
  expect(await s.t.mutation(call.requestSchedule, { eventId: s.e2.eventId })).toEqual({ maneuverId: null, status: "waiting", code: "PLAN_APPROVALS_PENDING" });
  await finish(s.t);
  expect(await logs(s, "schedule_failed")).toEqual([]);
  expect(worker.orbit.rescreens()).toEqual([]);
});

it("fails visibly instead of waiting when another affected incident's workflow no longer authorizes scheduling", async () => {
  const s = await setup(), worker = mockWorker();
  await s.t.mutation(call.requestPreview, { eventId: s.e1.eventId }); await finish(s.t);
  await approvePlan(s, "E1");
  await s.t.run(ctx => ctx.db.patch(s.e2.eventId, { workflow: "internal_review", requiredApprovalSides: [] }));
  expect(await s.t.mutation(call.requestSchedule, { eventId: s.e1.eventId })).toMatchObject({ status: "failed", code: "APPROVAL_REQUIRED" });
  expect(await logs(s, "schedule_failed")).toHaveLength(1);
  expect(worker.orbit.rescreens()).toEqual([]);
});
