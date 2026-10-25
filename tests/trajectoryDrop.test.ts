import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent } from "../fixtures/policies";
import type { RescreenRequest } from "../convex/lib/orbitClient";
import { HORIZON_H, scheduleContent, scheduleDiff } from "../convex/maneuvers";
import { catalogObject, insertEvent, type Backend } from "./helpers";
import { as, fn, pick, seed, selection, tick, token } from "./decision";

// Dropping a shared plan, by burn horizon (spec §4.1 "Shared maneuvers"). Fixtures as in trajectoryHorizon.test.ts.
// Shared trajectory by burn horizon, without any room link. E1 = SIM-1001 × SIM-1002
// (a, b) and E2 = SIM-1001 × SIM-3001 (a, c) share the mover SIM-1001; both encounters lie inside [burn, burn + 72 h]
// of the P1 burn. E3 = SIM-1001 × SIM-3002 (a, d) lies 80 h after the burn, E4 = SIM-1001 × SIM-3003 (a, d) before it.
// The worker and orbit service below are in-memory test fixtures, not deployed services.
const call = {
  requestPreview: makeFunctionReference<"mutation">("maneuvers:requestPreview"),
  requestSchedule: makeFunctionReference<"mutation">("maneuvers:requestSchedule"),
  sync: makeFunctionReference<"mutation", { eventId: Id<"events"> }>("trajectoryPlans:sync"),
};
const SHA = "a".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-service-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);

const P1 = advocateCandidates.find(c => c.candidateId === "P1")!;
const atBurnPlus = (hours: number) => new Date(Date.parse(P1.burnTimeUtc!) + hours * 3_600_000).toISOString().replace(".000Z", "Z");
type Event = typeof advocateEvent;
const pairOf = (a: string, b: string, tcaUtc: string): Event => ({
  ...advocateEvent, objectA: { ...advocateEvent.objectA, objectId: a, name: `Fixture ${a}` }, objectB: { ...advocateEvent.objectA, objectId: b, name: `Fixture ${b}` }, tcaUtc,
});
// The same P1-P4 cards with each maneuver moving this pair's own object of its side, burning before this pair's encounter.
const cardsFor = (a: string, b: string, tcaUtc: string) => advocateCandidates.map(c => c.kind === "maneuver" ? { ...c, movingObjectId: c.movingSide === "A" ? a : b,
  burnTimeUtc: Date.parse(c.burnTimeUtc!) < Date.parse(tcaUtc) ? c.burnTimeUtc : new Date(Date.parse(tcaUtc) - 6 * 3_600_000).toISOString().replace(".000Z", "Z") } : c);

/** E1 from the shared seed plus the partner events this case needs; no event is linked in a room. */
async function events(options: { partner?: boolean; outside?: boolean } = {}) {
  const { t, eventId: E1 } = await seed();
  const extra = async (b: string, tcaUtc: string) => {
    const eventId = await insertEvent(t, pairOf("SIM-1001", b, tcaUtc));
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: cardsFor("SIM-1001", b, tcaUtc), start: false });
    return eventId;
  };
  let E3: Id<"events"> | null = null, E4: Id<"events"> | null = null;
  if (options.outside) {
    await t.run(async ctx => { for (const id of ["SIM-3002", "SIM-3003"]) await ctx.db.insert("spaceObjects", catalogObject(id)); });
    await t.mutation(internal.operators.provision, { key: "d", name: "Company D", simulated: true, objectIds: ["SIM-3002", "SIM-3003"],
      members: [{ tokenIdentifier: token("d"), role: "operator", assignedObjectIds: ["SIM-3002", "SIM-3003"], name: "D" }] });
    E3 = await extra("SIM-3002", atBurnPlus(80));
    E4 = await extra("SIM-3003", atBurnPlus(-1));
  }
  const E2 = options.partner === false ? null : await extra("SIM-3001", atBurnPlus(8));
  // Precondition: the events are independent; nothing groups them in a room.
  expect(await t.run(ctx => ctx.db.query("roomEvents").collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query("rooms").collect())).toEqual([]);
  return { t, E1, E2: E2!, E3: E3!, E4: E4! };
}

const plans = (t: Backend) => t.run(ctx => ctx.db.query("trajectoryPlans").collect());
const live = async (t: Backend) => (await plans(t)).filter(p => p.objectId === "SIM-1001" && p.state !== "superseded");
const approvals = (t: Backend) => t.run(ctx => ctx.db.query("approvals").collect());
const current = (t: Backend, eventId: Id<"events">) => t.run(ctx =>
  ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", eventId).eq("current", true)).collect());
const eventRow = (t: Backend, eventId: Id<"events">) => t.run(async ctx => (await ctx.db.get(eventId))!);
const approve = async (t: Backend, name: string, eventId: Id<"events">) => as(t, name).mutation(fn.approve, await tick(t, eventId));
const sorted = (ids: Id<"events">[]) => [...ids].sort();
/** The refs a fresh version must carry: every affected event's current selection that still names a proposal. */
async function freshRefs(t: Backend, eventIds: Id<"events">[]) {
  const refs = [];
  for (const eventId of eventIds) if ((await selection(t, eventId))?.proposalId) refs.push(await refOf(t, eventId));
  return refs.sort((x, y) => x.eventId.localeCompare(y.eventId));
}
const byEvent = <T extends { eventId: Id<"events"> }>(refs: T[]) => [...refs].sort((x, y) => x.eventId.localeCompare(y.eventId));
async function refOf(t: Backend, eventId: Id<"events">) {
  const s = (await selection(t, eventId))!;
  return { eventId, proposalId: s.proposalId!, revision: s.revision!, selectionGeneration: s.generation };
}

// Orbit stand-in keyed by job id, so each partner re-screen reads back its own result.
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

/** Side A selects the same P1 burn of SIM-1001 in E1 and E2; the previews run before anyone approves. */
async function sharedBurn(options: { refuse?: string[] } = {}) {
  const s = await events(), worker = mockWorker(options);
  await pick(s.t, "a", s.E1, "P1");
  await pick(s.t, "a", s.E2, "P1");
  await finish(s.t);
  // Precondition: one plan covers the shared burn and its preview is ready, so approvals below can sign it.
  expect(await live(s.t)).toHaveLength(1);
  return { ...s, worker };
}
const approveAll = async (s: Awaited<ReturnType<typeof sharedBurn>>) => {
  for (const [name, e] of [["a", s.E1], ["b", s.E1], ["a", s.E2], ["c", s.E2]] as const) await approve(s.t, name, e);
};


describe("trajectory drop: the remaining event prepares on its own", () => {
  it("a sync that drops the plan requests the single-event preview without any other call", async () => {
    const s = await events(), worker = mockWorker();
    await pick(s.t, "a", s.E1, "P1");
    await pick(s.t, "a", s.E2, "P1");
    expect(await live(s.t)).toHaveLength(1);
    await s.t.run(ctx => ctx.db.patch(s.E2, { status: "no_action_needed" }));
    await s.t.mutation(call.sync, { eventId: s.E1 });
    expect(await live(s.t)).toEqual([]);
    await finish(s.t);
    const single = worker.prepares().filter(p => /^event:/.test(p.body.intentKey));
    expect(single.length).toBeGreaterThan(0);
    expect(new Set(single.map(p => p.body.intentKey)).size).toBe(1);
    expect(single[0].body).toMatchObject({ trajectory: null });
  });

  it("an event that leaves a plan which still covers others requests its own preview", async () => {
    const s = await events({ outside: true });
    mockWorker();
    const hour = 3_600_000, burn = Date.parse(P1.burnTimeUtc!);
    await s.t.run(ctx => ctx.db.patch(s.E3, { tcaMs: burn + 10 * hour }));
    await pick(s.t, "a", s.E1, "P1");
    await pick(s.t, "a", s.E2, "P1");
    expect(sorted((await live(s.t))[0].affectedEventIds)).toEqual(sorted([s.E1, s.E2, s.E3]));
    // Nothing from the picks is still queued.
    await finish(s.t);
    await s.t.run(ctx => ctx.db.patch(s.E2, { tcaMs: burn + 90 * hour }));
    await s.t.mutation(call.sync, { eventId: s.E1 });
    expect(sorted((await live(s.t))[0].affectedEventIds)).toEqual(sorted([s.E1, s.E3]));
    const queued = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued.some(job => /requestPreview$/.test(job.name) && (job.args[0] as { eventId?: string }).eventId === s.E2 && job.state.kind === "pending")).toBe(true);
  });

  it("a sync that finds the current version unchanged retires only the refused version beside it", async () => {
    const s = await events();
    await pick(s.t, "a", s.E1, "P1");
    await pick(s.t, "a", s.E2, "P1");
    const [first] = await live(s.t);
    await s.t.mutation(makeFunctionReference<"mutation">("trajectoryPlans:refuse"), { id: first._id, version: first.planVersion });
    const draft = (await live(s.t)).find(p => p.state === "draft")!;
    expect((await live(s.t)).map(p => p.state).sort()).toEqual(["draft", "review_required"]);
    await s.t.mutation(call.sync, { eventId: s.E1 });
    expect(await live(s.t)).toMatchObject([{ _id: draft._id, state: "draft" }]);
  });
});
