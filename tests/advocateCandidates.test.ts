import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { callClaude } from "../convex/lib/claude";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import type { Id } from "../convex/_generated/dataModel";
import type { CandidatesRequest } from "../convex/lib/orbitClient";

// Orbit answers follow services/orbit/docs/contract.md: they echo the request, rank the grid 1..n and always carry
// a separate wait candidate. advocateEvent: SIM-1001 (A) and SIM-1002 (B), TCA 2026-10-25T03:14:07Z, miss 0.18 km.

vi.mock("../convex/lib/claude", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/claude")>(), callClaude: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key"); vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-service-token");
  vi.mocked(callClaude).mockReset().mockImplementation(async prompt => {
    const data = JSON.parse(prompt.user);
    return { raw: JSON.stringify({ preferredCandidateId: data.eligibleCandidateIds?.[0] ?? null }), model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const TCA_MS = Date.parse(advocateEvent.tcaUtc);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
type GridPoint = { side: "A" | "B"; leadH: number; dv: number; dir: "prograde" | "retrograde"; missAfterKm: number };
// Service order: passing the 1 km pair threshold first, then least delta-v.
const GRID: GridPoint[] = [
  { side: "A", leadH: 12, dv: 0.02, dir: "prograde", missAfterKm: 1.3 },
  { side: "B", leadH: 12, dv: 0.02, dir: "retrograde", missAfterKm: 1.2 },
  { side: "A", leadH: 6, dv: 0.05, dir: "prograde", missAfterKm: 1.9 },
  { side: "A", leadH: 6, dv: 0.1, dir: "retrograde", missAfterKm: 2.4 },
  { side: "B", leadH: 3, dv: 0.2, dir: "prograde", missAfterKm: 2.8 },
  { side: "A", leadH: 3, dv: 0.02, dir: "prograde", missAfterKm: 0.6 },
];
interface AnswerOptions { grid?: GridPoint[]; missBeforeKm?: number; debris?: "A" | "B" }
const info = (objectId: string, debris: boolean) => ({
  objectId, name: `Fixture ${objectId}`, kind: debris ? "debris" : "payload", maneuverability: debris ? "non_maneuverable" : "maneuverable",
  classificationBasis: "simulated demo satellite", operationalStatus: null, group: "sim", simulated: true,
});
function orbitAnswer(req: CandidatesRequest, { grid = GRID, missBeforeKm = 0.18, debris }: AnswerOptions = {}) {
  const ids = { A: req.objectA, B: req.objectB };
  const allowed = new Set(req.allowedMovingObjectIds);
  const common = { missBeforeKm, estimatedFuelKg: null, indicative: true, simulated: true };
  return {
    snapshotId: req.snapshotId, evidenceVersion: req.evidenceVersion, objectA: req.objectA, objectB: req.objectB,
    objects: { [req.objectA]: info(req.objectA, debris === "A"), [req.objectB]: info(req.objectB, debris === "B") },
    notMovable: (["A", "B"] as const).filter(s => !allowed.has(ids[s])).map(side => ({ side, objectId: ids[side], reason: "not in allowedMovingObjectIds" })),
    tcaUtc: req.tcaUtc, tcaInputUtc: req.tcaUtc, missBeforeKm, relSpeedKmS: 7.6, simulated: true,
    candidates: grid.filter(g => allowed.has(ids[g.side])).map((g, i) => ({
      ...common, candidateId: `${g.side}:T-${g.leadH}h:${g.dir === "prograde" ? "+" : "-"}${g.dv}`, kind: "maneuver",
      movingSide: g.side, movingObjectId: ids[g.side], burnTimeUtc: iso(TCA_MS - g.leadH * 3_600_000), leadH: g.leadH,
      deltaVMs: g.dv, direction: g.dir, deltaAKm: 0.04, missAfterKm: g.missAfterKm, tcaAfterUtc: req.tcaUtc, relSpeedKmS: 7.6,
      passesPairThreshold: g.missAfterKm >= 1, rank: i + 1,
    })),
    wait: {
      ...common, candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null, leadH: null, deltaVMs: null,
      direction: null, deltaAKm: null, missAfterKm: null, tcaAfterUtc: null, relSpeedKmS: null, passesPairThreshold: missBeforeKm >= 1, rank: null,
    },
    failed: [], assumptions: ["Indicative geometry: SGP4 on public mean elements, impulsive along-track burn, no covariance."],
    method: "SGP4 (python-sgp4, WGS-72) with a differential impulsive along-track burn",
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockOrbit(options: AnswerOptions = {}, before?: () => Promise<void>) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    await before?.();
    return json(orbitAnswer(JSON.parse(String(init.body)), options));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const sent = (fetch: ReturnType<typeof mockOrbit>, i = 0) => ({ url: String(fetch.mock.calls[i][0]), body: JSON.parse(String(fetch.mock.calls[i][1].body)) });

const identity = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${name}` });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);
const publish = (t: Backend, eventId: Id<"events">) => t.action(internal.advocates.publishFromOrbit, { eventId });
const candidateSet = (t: Backend, eventId: Id<"events">) =>
  t.run(ctx => ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique());
const currentCards = (t: Backend, eventId: Id<"events">) => t.run(async ctx => {
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  return Promise.all((set?.candidateRevisionIds ?? []).map(async id => (await ctx.db.get(id))!));
});
const revisions = (t: Backend, eventId: Id<"events">) =>
  t.run(async ctx => (await ctx.db.query("candidateRevisions").collect()).filter(r => r.eventId === eventId));
const pendingAdvocateStarts = (t: Backend) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter(f => f.name.startsWith("agents/advocate:") && f.state.kind === "pending"));

async function operator(t: Backend, name: string, objectId: string) {
  await t.mutation(internal.operators.provision, {
    key: `fixture-${name}`, name: name.toUpperCase(), simulated: true, objectIds: [objectId],
    members: [{ tokenIdentifier: `https://fixture.invalid|${name}`, role: "operator", assignedObjectIds: [objectId] }],
  });
}
async function pairSetup() {
  const t = backend(); const eventId = await insertEvent(t, advocateEvent);
  await operator(t, "a", policyA.objectId); await operator(t, "b", policyB.objectId);
  await identity(t, "a").mutation(api.policies.update, { satellites: [policyA] });
  await identity(t, "b").mutation(api.policies.update, { satellites: [policyB] });
  return { t, eventId };
}
async function debrisSetup() {
  const t = backend(); const eventId = await insertEvent(t, advocateEvent);
  await operator(t, "a", policyA.objectId);
  await identity(t, "a").mutation(api.policies.update, { satellites: [policyA] });
  await t.run(ctx => ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["A"] }));
  return { t, eventId };
}

describe("advocates.publishFromOrbit", () => {
  it("publishes at most four computed cards for a pair and starts both Advocates", async () => {
    const { t, eventId } = await pairSetup();
    const fetch = mockOrbit();
    const outcome = await publish(t, eventId);
    expect(outcome).toEqual({ status: "published", version: 1, changed: true, cards: 4 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, body } = sent(fetch);
    expect(url).toBe("https://orbit.test/candidates");
    expect(body).toMatchObject({
      snapshotId: "fixture:test", objectA: "SIM-1001", objectB: "SIM-1002", tcaUtc: advocateEvent.tcaUtc,
      allowedMovingObjectIds: ["SIM-1001", "SIM-1002"], notBeforeUtc: iso(FIXTURE_NOW),
    });
    expect(body.evidenceVersion).toMatch(/^ev-[0-9a-f]+$/);

    const cards = await currentCards(t, eventId);
    expect(cards).toHaveLength(4);
    // The cheapest passing option for each side comes first, then the service's next one, then wait.
    expect(cards.map(c => [c.kind, c.movingSide, c.deltaVMs])).toEqual([
      ["maneuver", "A", 0.02], ["maneuver", "B", 0.02], ["maneuver", "A", 0.05], ["wait", null, null],
    ]);
    for (const c of cards) {
      expect(c).toMatchObject({ revision: 1, missBeforeKm: 0.18, estimatedFuelKg: null, indicative: true, simulated: true });
      expect(c.assumptions.length).toBeGreaterThan(0);
    }
    expect(cards.some(c => c.missAfterKm !== null && c.missAfterKm < 1)).toBe(false);
    expect(cards[3].reviewCondition?.trim()).toBeTruthy();
    expect(cards[0].label).toBe("Move SIM-1001 prograde 0.02 m/s, 12 h before closest approach");
    const set = await candidateSet(t, eventId);
    expect(set?.companyAId).not.toBeNull(); expect(set?.companyBId).not.toBeNull();

    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callClaude).mock.calls.map(([p]) => JSON.parse(p.user).side)).toEqual(["A", "B"]);
    const shared = await identity(t, "b").query(api.advocates.list, { eventId });
    expect(shared.candidates).toHaveLength(4);
    expect(shared.runs.A?.status).toBe("succeeded"); expect(shared.runs.B?.status).toBe("succeeded");
  });

  it("publishes debris with one Advocate, only the active object moving and no side B", async () => {
    const { t, eventId } = await debrisSetup();
    const fetch = mockOrbit({ debris: "B" });
    const outcome = await publish(t, eventId);
    expect(outcome).toMatchObject({ status: "published", changed: true });
    expect(sent(fetch).body.allowedMovingObjectIds).toEqual(["SIM-1001"]);
    const cards = await currentCards(t, eventId);
    expect(cards.filter(c => c.kind === "maneuver").every(c => c.movingSide === "A" && c.movingObjectId === "SIM-1001")).toBe(true);
    expect(cards.map(c => c.kind)).toEqual(["maneuver", "maneuver", "maneuver", "wait"]);
    const set = await candidateSet(t, eventId);
    expect(set?.companyAId).not.toBeNull(); expect(set?.companyBId).toBeNull();

    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user).side).toBe("A");
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
    const shared = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(shared.runs.A?.status).toBe("succeeded"); expect(shared.runs.B).toBeNull();
    expect(shared.assessments.B).toEqual([]);
  });

  it("lets canonical side B act alone when side A is debris", async () => {
    const t = backend(); const eventId = await insertEvent(t, advocateEvent);
    await operator(t, "b", policyB.objectId);
    await t.run(ctx => ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["B"] }));
    const fetch = mockOrbit({ debris: "A" });
    expect(await publish(t, eventId)).toMatchObject({ status: "published" });
    expect(sent(fetch).body.allowedMovingObjectIds).toEqual(["SIM-1002"]);
    const cards = await currentCards(t, eventId);
    expect(cards.filter(c => c.kind === "maneuver").every(c => c.movingSide === "B")).toBe(true);
    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user).side).toBe("B");
  });

  it("leaves the previous set and runs untouched when the orbit service fails", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    const runsBefore = await t.run(ctx => ctx.db.query("agentRuns").collect());
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "ERROR", message: "secret diagnostic at /srv/orbit" } }, 503)));
    const outcome = await publish(t, eventId);
    expect(outcome).toMatchObject({ status: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    await finish(t);
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual(runsBefore);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("offers only waiting when no maneuver clears the pair threshold", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit({ grid: GRID.map(g => ({ ...g, missAfterKm: 0.7 })) });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", cards: 1 });
    expect((await currentCards(t, eventId)).map(c => c.kind)).toEqual(["wait"]);
  });

  it("refuses a service geometry that disagrees with the event beyond its resolution", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit({ missBeforeKm: 2.5 });
    const outcome = await publish(t, eventId);
    expect(outcome).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toBeNull();
    expect(await revisions(t, eventId)).toEqual([]);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
    // Within about a kilometre the event's own miss distance stays on the cards.
    mockOrbit({ missBeforeKm: 0.9 });
    expect(await publish(t, eventId)).toMatchObject({ status: "published" });
    expect((await currentCards(t, eventId)).every(c => c.missBeforeKm === 0.18)).toBe(true);
  });

  it("publishes the same service answer twice without a new version or Advocate round", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    expect(await publish(t, eventId)).toEqual({ status: "published", version: 1, changed: false, cards: 4 });
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
    await finish(t);
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await revisions(t, eventId)).toHaveLength(4);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("bumps changed cards against every stored revision and publishes a new version", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const first = await currentCards(t, eventId);
    mockOrbit({ grid: GRID.map((g, i) => i === 0 ? { ...g, missAfterKm: 1.6 } : g) });
    expect(await publish(t, eventId)).toEqual({ status: "published", version: 2, changed: true, cards: 4 });
    const second = await currentCards(t, eventId);
    expect(second.map(c => c.candidateId)).toEqual(first.map(c => c.candidateId));
    expect(second.map(c => c.revision)).toEqual([2, 1, 1, 1]);
    expect(second[0].missAfterKm).toBe(1.6);
    expect(await revisions(t, eventId)).toHaveLength(5);
    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(4);
    // Back to the first answer: the earlier content returns as a further revision, never a rollback.
    mockOrbit();
    expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 3, changed: true });
    expect((await currentCards(t, eventId))[0].revision).toBe(3);
  });

  it("reports a concurrent publication as a stale revision and keeps the newer set", async () => {
    const { t, eventId } = await pairSetup();
    let raced = false;
    mockOrbit({}, async () => {
      if (raced) return;
      raced = true;
      await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates, start: false });
    });
    const outcome = await publish(t, eventId);
    expect(outcome).toMatchObject({ status: "failed", code: "STALE_REVISION" });
    const set = await candidateSet(t, eventId);
    expect(set?.version).toBe(1);
    expect((await currentCards(t, eventId)).map(c => c.candidateId)).toEqual(advocateCandidates.map(c => c.candidateId));
  });

  it("skips without calling the service when it is not configured", async () => {
    const { t, eventId } = await pairSetup();
    const fetch = mockOrbit();
    vi.stubEnv("ORBIT_SERVICE_TOKEN", "");
    expect(await publish(t, eventId)).toEqual({ status: "skipped", reason: "ORBIT_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await candidateSet(t, eventId)).toBeNull();
  });

  it("skips inactive, past, closed and unsupported events without calling the service", async () => {
    const cases: [string, (t: Backend, eventId: Id<"events">) => Promise<unknown>][] = [
      ["EVENT_INACTIVE", (t, eventId) => t.run(ctx => ctx.db.patch(eventId, { active: false }))],
      ["EVENT_INACTIVE", async () => { vi.setSystemTime(TCA_MS + 1_000); }],
      ["WORKFLOW_UNSUPPORTED", (t, eventId) => t.run(ctx => ctx.db.patch(eventId, { workflow: "internal_review", requiredApprovalSides: [] }))],
      ["SET_NOT_OPEN", async (t, eventId) => {
        await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates, start: false });
        const set = await candidateSet(t, eventId);
        await t.run(ctx => ctx.db.patch(set!._id, { state: "scheduled" }));
      }],
    ];
    for (const [reason, arrange] of cases) {
      vi.setSystemTime(FIXTURE_NOW);
      const { t, eventId } = await pairSetup();
      await arrange(t, eventId);
      const fetch = mockOrbit();
      expect(await publish(t, eventId)).toEqual({ status: "skipped", reason });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("never treats a missing active counterpart as debris", async () => {
    const t = backend(); const eventId = await insertEvent(t, advocateEvent);
    await operator(t, "a", policyA.objectId);
    const fetch = mockOrbit();
    expect(await publish(t, eventId)).toEqual({ status: "skipped", reason: "WORKFLOW_UNSUPPORTED" });
    expect(fetch).not.toHaveBeenCalled();
    await t.run(ctx => ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["B"] }));
    expect(await publish(t, eventId)).toEqual({ status: "skipped", reason: "WORKFLOW_UNSUPPORTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes one linked event without touching another event that shares its mover", async () => {
    const { t, eventId } = await pairSetup();
    const otherFacts = { ...advocateEvent, objectB: { ...advocateEvent.objectB, objectId: "SIM-1003", name: "Advocate fixture C" } };
    const otherId = await insertEvent(t, otherFacts);
    expect(otherId).not.toBe(eventId);
    await operator(t, "c", "SIM-1003");
    await t.run(async ctx => {
      const companyIds = (await ctx.db.query("companies").collect()).map(c => c._id);
      const roomId = await ctx.db.insert("rooms", { state: "open", companyIds, demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
      for (const id of [eventId, otherId]) await ctx.db.insert("roomEvents", { roomId, eventId: id, linkedAt: FIXTURE_NOW });
    });
    mockOrbit();
    await publish(t, otherId);
    const other = await candidateSet(t, otherId);
    const otherRevisions = await revisions(t, otherId);
    await publish(t, eventId);
    mockOrbit({ grid: GRID.map((g, i) => i === 0 ? { ...g, missAfterKm: 1.6 } : g) });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 2 });
    expect(await candidateSet(t, otherId)).toEqual(other);
    expect(await revisions(t, otherId)).toEqual(otherRevisions);
    expect(await t.run(ctx => ctx.db.query("trajectoryPlans").collect())).toEqual([]);
  });
});
