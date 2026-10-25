import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import type { Backend } from "./helpers";
import { HORIZON_H, scheduleContent, scheduleDiff } from "../convex/maneuvers";
import type { RescreenRequest } from "../convex/lib/orbitClient";
import { as, code, fn, pick, seed, selection, tick } from "./decision";

// One single-event demo path driven only through the mutations the app calls: an operator selects a maneuver card,
// the selection hook asks the Factory worker for the schedule diff, both companies approve, and the consensus hook
// re-screens the trajectory and commits the prepared diff. Scheduled functions really run; nothing is inserted by hand.
// The worker and the orbit service below are in-memory test fixtures, not a deployed service or spacecraft execution.
const call = { get: makeFunctionReference<"query">("maneuvers:get") };
const WORKER = "https://scheduler.test";
const ORBIT = "https://orbit.test";
const SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, "0")).join("");

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", ORBIT); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-service-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);
const configureWorker = () => {
  vi.stubEnv("SCHEDULE_SERVICE_URL", WORKER); vi.stubEnv("SCHEDULE_SERVICE_TOKEN", "fixture-token-of-at-least-thirty-two-chars");
};
// Every log row of the action, whatever event it names: each test seeds a single event.
const logs = async (t: Backend, action: string) => (await t.run(ctx => ctx.db.query("log").collect())).filter(l => l.action === action);
const maneuvers = (t: Backend) => t.run(ctx => ctx.db.query("maneuvers").collect());
const eventStatus = async (t: Backend, eventId: Id<"events">) => (await t.run(ctx => ctx.db.get(eventId)))!.status;
const currentRevision = async (t: Backend, eventId: Id<"events">) => {
  const s = (await selection(t, eventId))!;
  return t.run(async ctx => (await ctx.db.query("proposalRevisions")
    .withIndex("by_proposal_revision", q => q.eq("proposalId", s.proposalId!).eq("revision", s.revision!)).unique())!);
};
// A human takes a moment between seeing the diff and approving it.
const later = () => vi.setSystemTime(Date.now() + 100);

// The orbit service: POST /rescreen accepts the job under the caller's id, GET /jobs/<id> returns it completed.
function mockOrbit() {
  let request: RescreenRequest | undefined;
  const calls: { method: string; path: string }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(ORBIT.length), method = init?.method ?? "GET";
    calls.push({ method, path });
    if (method === "POST" && path === "/rescreen") {
      request = JSON.parse(String(init!.body));
      return json({ jobId: request!.jobId, status: "queued", created: true, statusUrl: `/jobs/${request!.jobId}` }, 202);
    }
    if (method === "GET" && request && path === `/jobs/${encodeURIComponent(request.jobId)}`) {
      const result = { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion, passed: true, objectsChecked: 154,
        objectsInCatalog: 19468, horizonH: HORIZON_H, originalMissAfterKm: 1.5, newConjunctions: [], refusalReason: null,
        simulated: true, method: "test orbit service", limitations: ["Indicative"], fromUtc: request.fromUtc, toUtc: request.toUtc,
        screenedFromUtc: request.fromUtc, screenedToUtc: request.toUtc, proposalId: request.proposalId, revision: request.revision,
        ...(request.runId ? { runId: request.runId } : {}) };
      return json({ jobId: request.jobId, kind: "rescreen", status: "completed", phase: "done", progress: 1, counters: {}, coverage: null,
        requestHash: "fixture-request", createdAt: new Date(FIXTURE_NOW).toISOString(), startedAt: new Date(FIXTURE_NOW).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(), result, resultRef: null, error: null });
    }
    throw new Error(`unexpected orbit fetch ${method} ${path}`);
  };
  return { fetch, calls, request: () => request };
}

// The Factory schedule worker's HTTP contract: deterministic job ids per intent, idempotent POSTs, jobs read by id.
type FakeJob = { jobId: string; intentKey: string; kind: "prepare" | "commit"; status: string; attempt: number; request: any; result: any; error: any };
function mockServices() {
  const orbit = mockOrbit(), jobs = new Map<string, FakeJob>(), posts: { path: string; body: any }[] = [], workerCalls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith(ORBIT)) return orbit.fetch(url, init);
    if (!path.startsWith(WORKER)) throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${path}`);
    const route = path.slice(WORKER.length), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    workerCalls.push(route);
    if (init?.method === "POST") posts.push({ path: route, body });
    if (route === "/prepare") {
      const jobId = await digest(`prepare:${body.intentKey}`);
      if (!jobs.has(jobId)) {
        const after = scheduleContent([body.entry]);
        jobs.set(jobId, { jobId, intentKey: body.intentKey, kind: "prepare", status: "completed", attempt: 1, request: body, error: null,
          result: { filePath: body.filePath, before: null, after, diff: scheduleDiff(body.filePath, null, after), contentHash: await digest(after),
            expectedPreviousHash: null, expectedPreviousCommit: SHA,
            factory: { sessionId: "fixture-session", modelId: "fixture-model", toolWrites: 1 }, commitSha: null } });
      }
      return json(jobs.get(jobId)!);
    }
    if (route === "/commit") {
      const jobId = await digest(`commit:${body.intentKey}`), prepared = jobs.get(body.preparedJobId);
      if (!prepared) return json({ error: { code: "NOT_FOUND" } }, 404);
      if (!jobs.has(jobId)) jobs.set(jobId, { jobId, intentKey: body.intentKey, kind: "commit", attempt: 1, request: body,
        status: "completed", result: { ...prepared.result, commitSha: COMMIT_SHA }, error: null });
      return json(jobs.get(jobId)!);
    }
    const job = /^\/jobs\/[a-f0-9]{64}$/.test(route) ? jobs.get(route.slice("/jobs/".length)) : undefined;
    if (!job) throw new Error(`unexpected worker fetch ${init?.method ?? "GET"} ${route}`);
    return json(job);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, posts, workerCalls, orbit };
}

describe("single-event scheduling through the app's own mutations", () => {
  it("selects a maneuver, prepares its diff, collects both approvals and commits the approved schedule", async () => {
    const { t, eventId } = await seed();
    configureWorker();
    const services = mockServices();

    expect(await pick(t, "a", eventId, "P2")).toBe(1);
    await finish(t);
    expect(services.posts.map(p => p.path)).toEqual(["/prepare"]);
    const prepare = services.posts[0].body;
    expect(prepare.intentKey).toMatch(/^event:.*:generation:1$/);
    expect(prepare.trajectory).toBeNull();
    expect(services.orbit.calls).toEqual([]);

    const preview = await as(t, "a").query(call.get, { eventId });
    expect(preview).toMatchObject({ status: "preview", commitSha: null, execution: "not_verified" });
    expect(typeof preview.diff).toBe("string");
    expect(preview.diff.length).toBeGreaterThan(0);
    expect(await currentRevision(t, eventId)).toMatchObject({ schedulePreviewDiff: preview.diff, schedulePreviewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await maneuvers(t)).toHaveLength(1);

    later();
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
    later();
    expect(await as(t, "b").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: true });
    await finish(t);

    expect(services.orbit.calls.filter(c => c.method === "POST")).toEqual([{ method: "POST", path: "/rescreen" }]);
    expect(services.posts.map(p => p.path)).toEqual(["/prepare", "/commit"]);
    expect(services.posts[1].body).toMatchObject({ intentKey: prepare.intentKey, contentHash: (await currentRevision(t, eventId)).schedulePreviewHash, trajectory: null });

    const committed = await as(t, "a").query(call.get, { eventId });
    expect(committed).toMatchObject({ status: "committed", commitSha: COMMIT_SHA, execution: "not_verified", diff: preview.diff });
    expect(await as(t, "b").query(call.get, { eventId })).toMatchObject({ status: "committed", commitSha: COMMIT_SHA });
    expect(await maneuvers(t)).toHaveLength(1);
    expect(await eventStatus(t, eventId)).toBe("scheduled");
    expect(await logs(t, "schedule_committed")).toHaveLength(1);
    expect(await logs(t, "schedule_failed")).toEqual([]);
  });

  it("refuses an approval before the prepared diff exists while the worker is configured", async () => {
    const { t, eventId } = await seed();
    configureWorker();
    const services = mockServices();
    await pick(t, "a", eventId, "P2");
    // The selection hook is scheduled but has not run: no diff yet.
    expect((await currentRevision(t, eventId)).schedulePreviewHash ?? null).toBeNull();
    later();
    expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(services.workerCalls).toEqual([]);
    expect(await maneuvers(t)).toEqual([]);
  });

  it("without a worker, approves without a gate and logs one WORKER_UNAVAILABLE failure", async () => {
    const { t, eventId } = await seed();
    const services = mockServices();

    await pick(t, "a", eventId, "P2");
    await finish(t);
    expect(services.workerCalls).toEqual([]);
    expect(await maneuvers(t)).toEqual([]);
    expect(await logs(t, "schedule_failed")).toEqual([]);

    later();
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
    later();
    expect(await as(t, "b").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: true });
    await finish(t);

    expect(services.workerCalls).toEqual([]);
    expect((await logs(t, "schedule_failed")).map(l => l.summary)).toEqual([expect.stringMatching(/^WORKER_UNAVAILABLE/)]);
    expect(await logs(t, "schedule_committed")).toEqual([]);
    expect(await eventStatus(t, eventId)).toBe("approved");
  });

  it("lets the side in turn veto while the prepared diff is still missing", async () => {
    const { t, eventId } = await seed();
    configureWorker();
    const services = mockServices();
    await pick(t, "a", eventId, "P2");
    expect((await currentRevision(t, eventId)).schedulePreviewHash ?? null).toBeNull();
    later();
    // The same state gates an approval, so the veto below is not passing for want of a configured worker.
    expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await as(t, "a").mutation(fn.veto, { ...await tick(t, eventId), reason: "Burn overlaps our downlink." })).toBeNull();
    expect((await t.run(ctx => ctx.db.query("approvals").collect())).map(r => [r.side, r.status, r.reason]))
      .toEqual([["A", "vetoed", "Burn overlaps our downlink."]]);
    expect(await eventStatus(t, eventId)).toBe("agents");
    expect(services.workerCalls).toEqual([]);
  });
});
