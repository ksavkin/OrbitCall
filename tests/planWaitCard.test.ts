import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent } from "../fixtures/policies";
import type { RescreenRequest } from "../convex/lib/orbitClient";
import { HORIZON_H, scheduleContent, scheduleDiff } from "../convex/maneuvers";
import { catalogObject, insertEvent, type Backend } from "./helpers";
import { as, fn, pick, seed, selection, tick, token, userId } from "./decision";

// A shared mover whose other affected event selects the waiting card (spec §4.1 "Shared maneuvers"). E1 = SIM-1001 ×
// SIM-1002 (a, b) and E2 = SIM-1001 × SIM-3001 (a, c) share SIM-1001 inside [burn, burn + 72 h] of the P1 burn, without
// a room. P3 is the waiting card: its operators accept the other event's burn and do not maneuver themselves. The worker
// and orbit service below are in-memory test fixtures, not deployed services.
const call = {
  requestPreview: makeFunctionReference<"mutation">("maneuvers:requestPreview"),
  requestSchedule: makeFunctionReference<"mutation">("maneuvers:requestSchedule"),
};
const SHA = "a".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-service-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);

const WAIT = advocateCandidates.find(c => c.kind === "wait")!.candidateId;
const P1 = advocateCandidates.find(c => c.candidateId === "P1")!;
const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const atBurnPlus = (hours: number) => utc(Date.parse(P1.burnTimeUtc!) + hours * 3_600_000);
type Event = typeof advocateEvent;
const pairOf = (a: string, b: string, tcaUtc: string): Event => ({
  ...advocateEvent, objectA: { ...advocateEvent.objectA, objectId: a, name: `Fixture ${a}` }, objectB: { ...advocateEvent.objectA, objectId: b, name: `Fixture ${b}` }, tcaUtc,
});
// The same P1-P4 cards with each maneuver moving this pair's own object of its side, burning before this pair's encounter.
const cardsFor = (a: string, b: string, tcaUtc: string) => advocateCandidates.map(c => c.kind === "maneuver" ? { ...c, movingObjectId: c.movingSide === "A" ? a : b,
  burnTimeUtc: Date.parse(c.burnTimeUtc!) < Date.parse(tcaUtc) ? c.burnTimeUtc : utc(Date.parse(tcaUtc) - 6 * 3_600_000) } : c);

/** E1 from the shared seed and E2 sharing its mover SIM-1001; no event is linked in a room. */
async function events() {
  const { t, eventId: E1 } = await seed();
  const E2 = await extra(t, "SIM-3001", atBurnPlus(8));
  expect(await t.run(ctx => ctx.db.query("roomEvents").collect())).toEqual([]);
  return { t, E1, E2 };
}
async function extra(t: Backend, b: string, tcaUtc: string, cards = cardsFor("SIM-1001", b, tcaUtc)) {
  const eventId = await insertEvent(t, pairOf("SIM-1001", b, tcaUtc));
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: cards, start: false });
  return eventId;
}

const plans = (t: Backend) => t.run(ctx => ctx.db.query("trajectoryPlans").collect());
const live = async (t: Backend) => (await plans(t)).filter(p => p.objectId === "SIM-1001" && p.state !== "superseded");
const maneuvers = (t: Backend) => t.run(ctx => ctx.db.query("maneuvers").collect());
const failures = async (t: Backend, eventId: Id<"events">) =>
  (await t.run(ctx => ctx.db.query("log").collect())).filter(l => l.action === "schedule_failed" && l.eventId === eventId);
const eventRow = (t: Backend, eventId: Id<"events">) => t.run(async ctx => (await ctx.db.get(eventId))!);
const approve = async (t: Backend, name: string, eventId: Id<"events">) => as(t, name).mutation(fn.approve, await tick(t, eventId));
const sorted = (ids: Id<"events">[]) => [...ids].sort();
async function refOf(t: Backend, eventId: Id<"events">) {
  const s = (await selection(t, eventId))!;
  return { eventId, proposalId: s.proposalId!, revision: s.revision!, selectionGeneration: s.generation };
}

// Orbit stand-in keyed by job id, so each partner re-screen reads back its own result.
function mockOrbit() {
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
    const result = { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion, passed: true, objectsChecked: 154,
      objectsInCatalog: 19468, horizonH: HORIZON_H, originalMissAfterKm: 1.5, newConjunctions: [], refusalReason: null,
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
function mockWorker() {
  const orbit = mockOrbit(), jobs = new Map<string, FakeJob>(), posts: { path: string; body: any }[] = [];
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

/** The mover's event selects the P1 burn of SIM-1001, the other event the waiting card; previews run before approvals. */
async function waitingPartner(waiter: "E1" | "E2") {
  const s = await events(), worker = mockWorker();
  const mover = waiter === "E1" ? s.E2 : s.E1, wait = waiter === "E1" ? s.E1 : s.E2;
  await pick(s.t, "a", mover, "P1");
  await pick(s.t, "a", wait, WAIT);
  await finish(s.t);
  return { ...s, worker, mover, wait, partner: (e: Id<"events">) => e === s.E1 ? "b" : "c" };
}
const approveEvent = async (s: Awaited<ReturnType<typeof waitingPartner>>, eventId: Id<"events">) => {
  await approve(s.t, "a", eventId);
  await approve(s.t, s.partner(eventId), eventId);
};

describe("shared mover with a waiting partner: one plan, one write", () => {
  it.each(["E2", "E1"] as const)("schedules the P1 burn once for both events when %s selects the waiting card", async waiter => {
    const s = await waitingPartner(waiter);
    const [plan, ...rest] = await live(s.t);
    expect(rest).toEqual([]);
    expect(sorted(plan.affectedEventIds)).toEqual(sorted([s.E1, s.E2]));
    for (const r of plan.eventRefs) expect(r).toEqual(await refOf(s.t, r.eventId));
    expect(sorted(plan.eventRefs.map(r => r.eventId))).toEqual(sorted([s.E1, s.E2]));
    expect(s.worker.prepares()).toHaveLength(1);
    const prepared = s.worker.prepares()[0].body;
    expect(prepared).toMatchObject({ intentKey: `trajectory:${plan._id}:version:${plan.planVersion}`, trajectory: { id: String(plan._id), version: plan.planVersion },
      ref: { eventId: String(s.mover) } });
    expect(prepared.entry).toMatchObject({ eventId: String(s.mover), objectId: "SIM-1001", burnTimeUtc: P1.burnTimeUtc, deltaVMs: P1.deltaVMs, direction: P1.direction });

    await approveEvent(s, s.mover);
    await approveEvent(s, s.wait);
    const signed = await s.t.run(ctx => ctx.db.query("approvals").collect());
    expect(signed).toHaveLength(4);
    for (const a of signed) expect(a).toMatchObject({ trajectoryPlanId: plan._id, trajectoryPlanVersion: plan.planVersion, current: true });
    await finish(s.t);

    expect(s.worker.prepares()).toHaveLength(1);
    // Every partner encounter is re-screened against the mover's trajectory, the waiting one included.
    expect(s.worker.orbit.rescreens().map(p => p.body.partnerObjectId).sort()).toEqual(["SIM-1002", "SIM-3001"]);
    for (const r of s.worker.orbit.rescreens()) expect(r.body).toMatchObject({ objectId: "SIM-1001", maneuver: { burnTimeUtc: P1.burnTimeUtc } });
    expect(s.worker.commits()).toHaveLength(1);
    expect(s.worker.commits()[0].body).toMatchObject({ intentKey: prepared.intentKey, ref: { eventId: String(s.mover) } });
    const [row, ...others] = await maneuvers(s.t);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ status: "committed", trajectoryPlanId: plan._id, intentKey: prepared.intentKey });
    expect(row.refs[0].eventId).toBe(s.mover);
    expect(sorted(row.refs.map(r => r.eventId))).toEqual(sorted([s.E1, s.E2]));
    // The plan's one write covers the waiting event like any other affected event.
    expect((await eventRow(s.t, s.mover)).status).toBe("scheduled");
    expect((await eventRow(s.t, s.wait)).status).toBe("scheduled");
    expect((await plans(s.t)).find(p => p._id === plan._id)).toMatchObject({ state: "scheduled", maneuverId: row._id });
    expect(await failures(s.t, s.E1)).toEqual([]);
    expect(await failures(s.t, s.E2)).toEqual([]);
  });

  it("lets the waiting event ask first: it waits for the plan, then the burn is written once", async () => {
    const s = await waitingPartner("E2");
    await approveEvent(s, s.wait);
    expect(await s.t.mutation(call.requestSchedule, { eventId: s.wait })).toEqual({ maneuverId: null, status: "waiting", code: "PLAN_APPROVALS_PENDING" });
    await finish(s.t);
    expect(s.worker.orbit.rescreens()).toEqual([]);
    expect(s.worker.commits()).toEqual([]);
    expect(await failures(s.t, s.wait)).toEqual([]);
    expect((await eventRow(s.t, s.wait)).status).toBe("approved");

    await approveEvent(s, s.mover);
    await finish(s.t);
    expect(s.worker.commits()).toHaveLength(1);
    expect((await eventRow(s.t, s.wait)).status).toBe("scheduled");
    // A repeated request from either event does not write the shared burn a second time.
    for (const eventId of [s.wait, s.mover]) {
      expect(await s.t.mutation(call.requestSchedule, { eventId })).toMatchObject({ status: "committed" });
      await finish(s.t);
    }
    expect(s.worker.commits()).toHaveLength(1);
    expect(await maneuvers(s.t)).toHaveLength(1);
  });
});

describe("a waiting event already in monitoring when the shared burn appears", () => {
  it("returns to the decision, signs the plan with the mover and the burn is written once", async () => {
    const s = await events(), worker = mockWorker();
    await pick(s.t, "a", s.E2, WAIT);
    await finish(s.t);
    await approve(s.t, "a", s.E2);
    await approve(s.t, "c", s.E2);
    await finish(s.t);
    expect((await eventRow(s.t, s.E2)).status).toBe("monitoring");
    await pick(s.t, "a", s.E1, "P1");
    await finish(s.t);
    expect(sorted((await live(s.t))[0].affectedEventIds)).toEqual(sorted([s.E1, s.E2]));
    expect((await eventRow(s.t, s.E2)).status).toBe("proposal");
    for (const [name, eventId] of [["a", s.E1], ["b", s.E1], ["a", s.E2], ["c", s.E2]] as const) await approve(s.t, name, eventId);
    await finish(s.t);
    expect(worker.commits()).toHaveLength(1);
    expect((await eventRow(s.t, s.E2)).status).toBe("scheduled");
  });

  it("refuses the waiting event's approval until the plan's diff is prepared", async () => {
    const s = await events();
    mockWorker();
    await pick(s.t, "a", s.E1, "P1");
    await pick(s.t, "a", s.E2, WAIT);
    await expect(approve(s.t, "a", s.E2)).rejects.toThrow(/preparing this plan's schedule diff/);
    await finish(s.t);
    await approve(s.t, "a", s.E2);
  });
});

describe("waiting card outside any plan", () => {
  it("still goes to monitoring without a worker call", async () => {
    const { t, eventId: E1 } = await seed(), worker = mockWorker();
    await pick(t, "a", E1, WAIT);
    await finish(t);
    await approve(t, "a", E1);
    await approve(t, "b", E1);
    await finish(t);
    expect(await plans(t)).toEqual([]);
    expect((await eventRow(t, E1)).status).toBe("monitoring");
    expect(worker.posts).toEqual([]);
    expect(await maneuvers(t)).toEqual([]);
    expect(await failures(t, E1)).toEqual([]);
  });
});

/** Fully approved rows for the current selection, inserted directly because the public approve requires a preview. */
async function approvedDirectly(t: Backend, eventId: Id<"events">, sides: [side: "A" | "B", name: string][], planId: Id<"trajectoryPlans"> | null, planVersion: number | null) {
  const ref = await refOf(t, eventId);
  for (const [side, name] of sides) {
    const user = await userId(t, name);
    await t.run(async ctx => ctx.db.insert("approvals", { eventId, side, status: "approved", userId: user, companyId: (await ctx.db.get(user))!.companyId,
      proposalId: ref.proposalId, revision: ref.revision, selectionGeneration: ref.selectionGeneration, approvalRuleVersion: 1, trajectoryPlanId: planId,
      trajectoryPlanVersion: planVersion, reason: null, demoRunId: null, current: true, at: Date.now(), assignmentVersion: 1 }));
  }
  await t.run(ctx => ctx.db.patch(eventId, { status: "approved" }));
}

describe("shared mover with a partner that selects another burn", () => {
  it("fails visibly when the partner's card moves its other spacecraft, and never commits", async () => {
    const s = await events(), worker = mockWorker();
    await pick(s.t, "a", s.E1, "P1");
    // P4 moves side B: SIM-3001, the other spacecraft of E2.
    await pick(s.t, "c", s.E2, "P4");
    await finish(s.t);
    const [plan] = await live(s.t);
    expect(sorted(plan.eventRefs.map(r => r.eventId))).toEqual(sorted([s.E1, s.E2]));
    expect(worker.prepares()).toEqual([]);
    for (const eventId of [s.E1, s.E2]) {
      expect(await s.t.mutation(call.requestPreview, { eventId })).toEqual({ status: "skipped", code: "SHARED_TRAJECTORY_REQUIRED" });
      expect((await failures(s.t, eventId)).map(l => l.summary)).toEqual([expect.stringMatching(/^SHARED_TRAJECTORY_REQUIRED: .*waiting card or the same burn/)]);
    }
    vi.setSystemTime(Date.now() + 1_000);
    await approvedDirectly(s.t, s.E1, [["A", "a"], ["B", "b"]], plan._id, plan.planVersion);
    await approvedDirectly(s.t, s.E2, [["A", "a"], ["B", "c"]], plan._id, plan.planVersion);
    for (const eventId of [s.E1, s.E2]) {
      expect(await s.t.mutation(call.requestSchedule, { eventId })).toEqual({ maneuverId: null, status: "failed", code: "SHARED_TRAJECTORY_REQUIRED" });
    }
    await finish(s.t);
    expect(worker.posts).toEqual([]);
    expect(await maneuvers(s.t)).toEqual([]);
    for (const eventId of [s.E1, s.E2]) expect((await eventRow(s.t, eventId)).status).not.toBe("scheduled");
  });

  it("says the partner must select the waiting card or the same burn, once per selection", async () => {
    const s = await events(), worker = mockWorker();
    await pick(s.t, "a", s.E1, "P1");
    await finish(s.t);
    // A partner that has not selected a card yet is a normal wait, not a failure.
    expect(await failures(s.t, s.E1)).toEqual([]);
    // E2's own P2 card moves the same spacecraft at another time: a different trajectory.
    await pick(s.t, "a", s.E2, "P2");
    await finish(s.t);
    expect(await live(s.t)).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect(await s.t.mutation(call.requestPreview, { eventId: s.E1 })).toEqual({ status: "skipped", code: "SHARED_TRAJECTORY_REQUIRED" });
    const logged = await failures(s.t, s.E1);
    expect(logged.map(l => l.summary)).toEqual([expect.stringMatching(/^SHARED_TRAJECTORY_REQUIRED: .*waiting card or the same burn/)]);
    expect(logged[0].after).toMatchObject({ intentKey: expect.stringMatching(/^event:/) });
    expect(worker.prepares()).toEqual([]);
  });
});

describe("a committed plan is history for the mover", () => {
  it("schedules a later single-event maneuver of the same spacecraft outside the old horizon", async () => {
    const s = await events(), worker = mockWorker();
    await pick(s.t, "a", s.E1, "P1");
    await pick(s.t, "a", s.E2, "P1");
    await finish(s.t);
    for (const [name, e] of [["a", s.E1], ["b", s.E1], ["a", s.E2], ["c", s.E2]] as const) await approve(s.t, name, e);
    await finish(s.t);
    const [plan] = await live(s.t);
    expect(plan.state).toBe("scheduled");
    expect(worker.commits()).toHaveLength(1);

    await s.t.run(async ctx => { await ctx.db.insert("spaceObjects", catalogObject("SIM-3002")); });
    await s.t.mutation(internal.operators.provision, { key: "d", name: "Company D", simulated: true, objectIds: ["SIM-3002"],
      members: [{ tokenIdentifier: token("d"), role: "operator", assignedObjectIds: ["SIM-3002"], name: "D" }] });
    // Its burn horizon [94 h, 166 h] after the old burn holds neither E1 nor E2.
    const tca = atBurnPlus(100);
    const E5 = await extra(s.t, "SIM-3002", tca, cardsFor("SIM-1001", "SIM-3002", tca).map(c => c.kind === "maneuver" && c.movingSide === "A"
      ? { ...c, burnTimeUtc: atBurnPlus(94) } : c));
    await pick(s.t, "a", E5, "P1");
    await finish(s.t);
    expect(worker.prepares().at(-1)!.body).toMatchObject({ intentKey: expect.stringMatching(/^event:/), trajectory: null });
    await approve(s.t, "a", E5);
    await approve(s.t, "d", E5);
    await finish(s.t);
    expect(worker.commits()).toHaveLength(2);
    expect(worker.commits()[1].body).toMatchObject({ trajectory: null });
    expect((await eventRow(s.t, E5)).status).toBe("scheduled");
    expect(await failures(s.t, E5)).toEqual([]);
  });
});
