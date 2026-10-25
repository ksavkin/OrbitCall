import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { callClaude } from "../convex/lib/claude";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import type { Id } from "../convex/_generated/dataModel";
import type { CandidatesRequest } from "../convex/lib/orbitClient";
import { publishFailure } from "../convex/lib/publishCandidates";
import { inputKey } from "../convex/lib/analyst";
import { loadFacts } from "../convex/lib/events";

const FEWER = "Some burns could not be computed or an object cannot move; fewer options are shown.";

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
interface AnswerOptions { grid?: GridPoint[]; missBeforeKm?: number; debris?: "A" | "B"; extraAssumptions?: string[]; failed?: number }
const info = (objectId: string, debris: boolean) => ({
  objectId, name: `Fixture ${objectId}`, kind: debris ? "debris" : "payload", maneuverability: debris ? "non_maneuverable" : "maneuverable",
  classificationBasis: "simulated demo satellite", operationalStatus: null, group: "sim", simulated: true,
});
function orbitAnswer(req: CandidatesRequest, { grid = GRID, missBeforeKm = 0.18, debris, extraAssumptions = [], failed = 0 }: AnswerOptions = {}) {
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
    failed: Array.from({ length: failed }, (_, i) => ({ candidateId: `A:T-12h:-0.${i + 1}`, reason: "the orbit decays" })),
    assumptions: ["Indicative geometry: SGP4 on public mean elements, impulsive along-track burn, no covariance.", ...extraAssumptions],
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

const demoRun = (t: Backend) => t.run(ctx => ctx.db.insert("demoRuns", {
  scenario: "candidate-publication-test", state: "open", startedBy: null, manifest: null, startedAt: FIXTURE_NOW, closedAt: null,
}));

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
    expect(outcome).toEqual({ status: "published", version: 1, changed: true, cards: 4, sharedMoverEventIds: [] });
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
    expect(cards.some(c => c.assumptions.includes(FEWER))).toBe(false);
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
    // The debris side is reported as not movable, so every card says fewer options are shown.
    expect(cards.every(c => c.assumptions.filter(a => a === FEWER).length === 1)).toBe(true);
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

  it("refuses mixed source geometry while allowing the service's numerical output rounding", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit({ missBeforeKm: 2.5 });
    const outcome = await publish(t, eventId);
    expect(outcome).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toBeNull();
    expect(await revisions(t, eventId)).toEqual([]);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
    // Within a kilometre but across the 1 km pair threshold: the service says waiting clears the pair, the event does not.
    mockOrbit({ missBeforeKm: 1.05 });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toBeNull();
    // Being on the same side of the demo threshold does not make two source baselines interchangeable.
    mockOrbit({ missBeforeKm: 0.95 });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toBeNull();
    // The service rounds miss distance to 0.001 km; one output unit of rounding is allowed, not 1 km uncertainty.
    mockOrbit({ missBeforeKm: 0.181 });
    expect(await publish(t, eventId)).toMatchObject({ status: "published" });
    expect((await currentCards(t, eventId)).every(c => c.missBeforeKm === 0.18)).toBe(true);
    expect((await currentCards(t, eventId)).every(c => c.assumptions.some(a => a.includes("baseline miss 0.181 km")))).toBe(true);
  });

  it.each(["time", "speed", "grid baseline"])("rejects a contradictory service %s before publishing", async field => {
    const { t, eventId } = await pairSetup();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const answer = orbitAnswer(JSON.parse(String(init.body)));
      if (field === "time") answer.tcaUtc = iso(TCA_MS + 120_000);
      if (field === "speed") answer.relSpeedKmS = 2.6;
      if (field === "grid baseline") answer.candidates[0].missBeforeKm = 0.8;
      return json(answer);
    }));
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toBeNull();
    expect(await revisions(t, eventId)).toEqual([]);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
  });

  it("preserves the existing cards and assessments when new source geometry disagrees", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    const beforeRevisions = await revisions(t, eventId);
    const beforeRuns = await t.run(ctx => ctx.db.query("agentRuns").collect());
    mockOrbit({ missBeforeKm: 0.95 });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await revisions(t, eventId)).toEqual(beforeRevisions);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual(beforeRuns);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
  });

  it("checks the pair threshold from above 1 km and drops maneuvers that do not widen the miss", async () => {
    const t = backend(); const eventId = await insertEvent(t, { ...advocateEvent, missKm: 1.5 });
    await operator(t, "a", policyA.objectId); await operator(t, "b", policyB.objectId);
    mockOrbit({ missBeforeKm: 0.95 });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "GEOMETRY_MISMATCH" });
    // 1.3 and 1.2 km pass the pair threshold but are closer than the 1.5 km the pair already has.
    mockOrbit({ missBeforeKm: 1.5 });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", cards: 4 });
    const cards = await currentCards(t, eventId);
    expect(cards.map(c => c.missAfterKm)).toEqual([1.9, 2.8, 2.4, null]);
    expect(cards.every(c => c.missBeforeKm === 1.5)).toBe(true);
  });

  it("sends the OMM snapshot the orbit service holds for a SOCRATES-loaded event", async () => {
    const { t, eventId } = await pairSetup();
    const useSnapshot = (snapshotId: string, ommUrl?: string) => t.run(async ctx => {
      const id = await ctx.db.insert("snapshots", { snapshotId, sources: advocateEvent.sources, ...(ommUrl === undefined ? {} : { ommUrl }) });
      await ctx.db.patch(eventId, { snapshotId: id });
    });
    await useSnapshot("socrates-20261024T0147Z", "/snapshots/gp-20261024T2134Z/catalog.json");
    const fetch = mockOrbit();
    expect(await publish(t, eventId)).toMatchObject({ status: "published" });
    expect(sent(fetch).body.snapshotId).toBe("gp-20261024T2134Z");
    for (const ommUrl of [undefined, "/snapshots/catalog.json", "/snapshots/gp-latest/catalog.json", "/snapshots/xgp-20261024T2134Z/catalog.json"]) {
      await useSnapshot("socrates-20261024T0147Z", ommUrl);
      expect(await publish(t, eventId)).toEqual({ status: "skipped", reason: "OMM_SNAPSHOT_UNKNOWN" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to publish when the event's evidence or snapshot changes during the orbit call", async () => {
    const drifts: [string, (t: Backend, eventId: Id<"events">) => Promise<unknown>][] = [
      ["tca", (t, eventId) => t.run(ctx => ctx.db.patch(eventId, { tcaMs: TCA_MS + 30_000 }))],
      ["pc", (t, eventId) => t.run(ctx => ctx.db.patch(eventId, { pcValue: 0.0003 }))],
      ["snapshot", (t, eventId) => t.run(async ctx => {
        const id = await ctx.db.insert("snapshots", { snapshotId: "fixture:other", sources: advocateEvent.sources });
        await ctx.db.patch(eventId, { snapshotId: id });
      })],
    ];
    for (const [, drift] of drifts) {
      const { t, eventId } = await pairSetup();
      mockOrbit();
      await publish(t, eventId);
      const before = await candidateSet(t, eventId);
      const beforeRevisions = await revisions(t, eventId);
      mockOrbit({ grid: GRID.map((g, i) => i === 0 ? { ...g, missAfterKm: 1.6 } : g) }, () => drift(t, eventId).then(() => undefined));
      expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "STALE_REVISION" });
      expect(await candidateSet(t, eventId)).toEqual(before);
      expect(await revisions(t, eventId)).toEqual(beforeRevisions);
    }
  });

  it("refuses a changed OMM catalog even when the event's stored snapshot ID is unchanged", async () => {
    const { t, eventId } = await pairSetup();
    const snapshotId = await t.run(async ctx => {
      const id = (await ctx.db.get(eventId))!.snapshotId;
      await ctx.db.patch(id, { snapshotId: "socrates-20261024T0147Z", ommUrl: "/snapshots/gp-20261024T2134Z/catalog.json" });
      return id;
    });
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    const beforeRevisions = await revisions(t, eventId);
    const beforeRuns = await t.run(ctx => ctx.db.query("agentRuns").collect());
    const fetch = mockOrbit({}, async () => {
      await t.run(ctx => ctx.db.patch(snapshotId, { ommUrl: "/snapshots/gp-20261025T2134Z/catalog.json" }));
    });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "STALE_REVISION" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await revisions(t, eventId)).toEqual(beforeRevisions);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual(beforeRuns);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
  });

  it("keeps the computed snapshot and geometry on immutable cards even when a new catalog returns identical numbers", async () => {
    const { t, eventId } = await pairSetup();
    const snapshotId = await t.run(async ctx => {
      const id = (await ctx.db.get(eventId))!.snapshotId;
      await ctx.db.patch(id, { snapshotId: "socrates-20261024T0147Z", ommUrl: "/snapshots/gp-20261024T2134Z/catalog.json" });
      return id;
    });
    mockOrbit();
    await publish(t, eventId);
    const original = await currentCards(t, eventId);
    expect(original.every(c => c.assumptions.some(a => a.includes("gp-20261024T2134Z") && a.includes("baseline miss 0.18 km") && a.includes(advocateEvent.tcaUtc)))).toBe(true);
    await t.run(ctx => ctx.db.patch(snapshotId, { ommUrl: "/snapshots/gp-20261025T2134Z/catalog.json" }));
    expect(await publish(t, eventId)).toMatchObject({ status: "published", changed: true, version: 2 });
    const changed = await currentCards(t, eventId);
    expect(changed.map(c => c.candidateId)).toEqual(original.map(c => c.candidateId));
    expect(changed.every(c => c.revision === 2 && c.assumptions.some(a => a.includes("gp-20261025T2134Z")))).toBe(true);
    expect((await revisions(t, eventId)).filter(c => c.revision === 1)).toEqual(original);
  });

  it("lets candidates.publish pin the evidence key and snapshot it was computed on", async () => {
    const { t, eventId } = await pairSetup();
    const args = { eventId, baseVersion: null, candidates: advocateCandidates, start: false };
    await expect(t.mutation(internal.candidates.publish, { ...args, expectedEvidenceKey: "{}" })).rejects.toThrow("STALE_REVISION");
    await expect(t.mutation(internal.candidates.publish, { ...args, expectedSnapshotId: "fixture:other" })).rejects.toThrow("STALE_REVISION");
    expect(await candidateSet(t, eventId)).toBeNull();
    const evidenceKey = await t.run(async ctx => inputKey(await loadFacts(ctx, (await ctx.db.get(eventId))!)));
    expect(await t.mutation(internal.candidates.publish, { ...args, expectedEvidenceKey: evidenceKey, expectedSnapshotId: "fixture:test" }))
      .toEqual({ version: 1, changed: true });
  });

  it("keeps card assumptions stable when only the count of burns before now changes", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId);
    mockOrbit({ extraAssumptions: ["12 grid burns fall before notBeforeUtc and are not offered."] });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 1, changed: false });
    mockOrbit({ extraAssumptions: ["13 grid burns fall before notBeforeUtc and are not offered."] });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 1, changed: false });
    expect((await currentCards(t, eventId)).some(c => c.assumptions.some(a => a.includes("notBeforeUtc")))).toBe(false);
  });

  it("explains fewer options once when the service could not compute some burns", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit({ failed: 2 });
    await publish(t, eventId);
    expect((await currentCards(t, eventId)).every(c => c.assumptions.filter(a => a === FEWER).length === 1)).toBe(true);
  });

  it("returns a failed outcome instead of throwing when event data is incomplete", async () => {
    const { t, eventId } = await pairSetup();
    await t.run(async ctx => ctx.db.delete((await ctx.db.get(eventId))!.objectBId));
    const fetch = mockOrbit();
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs an unexpected error and returns a generic failure", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(publishFailure(new TypeError("boom"))).toEqual({ status: "failed", code: "PUBLISH_FAILED", message: expect.any(String) });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("publishes the same service answer twice without a new version or Advocate round", async () => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    expect(await publish(t, eventId)).toEqual({ status: "published", version: 1, changed: false, cards: 4, sharedMoverEventIds: [] });
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
    expect(await publish(t, eventId)).toEqual({ status: "published", version: 2, changed: true, cards: 4, sharedMoverEventIds: [] });
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

  it("retries once when a concurrent publication wrote the same cards", async () => {
    const { t, eventId } = await pairSetup();
    let raced = false;
    mockOrbit({}, async () => {
      if (raced) return;
      raced = true;
      expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 1, changed: true });
    });
    expect(await publish(t, eventId)).toEqual({ status: "published", version: 1, changed: false, cards: 4, sharedMoverEventIds: [] });
    expect(await revisions(t, eventId)).toHaveLength(4);
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

  it.each(["inactive", "past", "internal_review"])("preserves existing cards when the event becomes %s during the orbit call", async change => {
    const { t, eventId } = await pairSetup();
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    const beforeRevisions = await revisions(t, eventId);
    const beforeRuns = await t.run(ctx => ctx.db.query("agentRuns").collect());
    const fetch = mockOrbit({}, async () => {
      if (change === "inactive") await t.run(ctx => ctx.db.patch(eventId, { active: false }));
      else if (change === "internal_review") await t.run(ctx => ctx.db.patch(eventId, { workflow: "internal_review", requiredApprovalSides: [] }));
      else vi.setSystemTime(TCA_MS + 1_000);
    });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "STALE_REVISION" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await revisions(t, eventId)).toEqual(beforeRevisions);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual(beforeRuns);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
  });

  it("drops burns that expire while the orbit service is calculating", async () => {
    const { t, eventId } = await pairSetup();
    const firstBurn = TCA_MS - 12 * 3_600_000;
    vi.setSystemTime(firstBurn - 15_000);
    mockOrbit({}, async () => { vi.setSystemTime(firstBurn + 15_000); });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", cards: 4 });
    const cards = await currentCards(t, eventId);
    expect(cards.filter(c => c.kind === "maneuver").every(c => Date.parse(c.burnTimeUtc!) > Date.now())).toBe(true);
    expect(cards.some(c => c.burnTimeUtc === iso(firstBurn))).toBe(false);
  });

  it("keeps each moving side represented after its earliest option expires", async () => {
    const { t, eventId } = await pairSetup();
    const firstBurn = TCA_MS - 12 * 3_600_000;
    vi.setSystemTime(firstBurn - 15_000);
    const grid: GridPoint[] = [...GRID.slice(0, 4), { ...GRID[3], leadH: 3, dir: "prograde", missAfterKm: 2.3 }, GRID[4]];
    mockOrbit({ grid }, async () => { vi.setSystemTime(firstBurn + 15_000); });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", cards: 4 });
    expect((await currentCards(t, eventId)).filter(c => c.kind === "maneuver").map(c => c.movingSide)).toEqual(["A", "B", "A"]);
  });

  it("refuses pinned candidates that have expired at the final publication transaction", async () => {
    const { t, eventId } = await pairSetup();
    const evidenceKey = await t.run(async ctx => inputKey(await loadFacts(ctx, (await ctx.db.get(eventId))!)));
    const firstBurn = Math.min(...advocateCandidates.filter(c => c.kind === "maneuver").map(c => Date.parse(c.burnTimeUtc!)));
    vi.setSystemTime(firstBurn);
    await expect(t.mutation(internal.candidates.publish, {
      eventId, baseVersion: null, candidates: advocateCandidates, start: false, expectedEvidenceKey: evidenceKey,
    })).rejects.toThrow("STALE_REVISION");
    expect(await candidateSet(t, eventId)).toBeNull();
    expect(await revisions(t, eventId)).toEqual([]);
  });

  it.each(["closed", "closedAt", "missing"])("skips a %s demo run without calling the orbit service", async change => {
    const { t, eventId } = await pairSetup();
    const runId = await demoRun(t);
    await t.run(async ctx => {
      await ctx.db.patch(eventId, { demoRunId: runId });
      if (change === "closed") await ctx.db.patch(runId, { state: "closed" });
      else if (change === "closedAt") await ctx.db.patch(runId, { closedAt: FIXTURE_NOW });
      else await ctx.db.delete(runId);
    });
    const fetch = mockOrbit();
    expect(await publish(t, eventId)).toEqual({ status: "skipped", reason: "DEMO_RUN_CLOSED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await candidateSet(t, eventId)).toBeNull();
  });

  it.each(["closed", "closedAt", "missing", "changed", "removed"])("preserves candidates if their demo run is %s during calculation", async change => {
    const { t, eventId } = await pairSetup();
    const runId = await demoRun(t);
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    mockOrbit();
    await publish(t, eventId); await finish(t);
    const before = await candidateSet(t, eventId);
    const beforeRevisions = await revisions(t, eventId);
    const beforeRuns = await t.run(ctx => ctx.db.query("agentRuns").collect());
    const fetch = mockOrbit({}, async () => {
      const nextRunId = change === "changed" ? await demoRun(t) : undefined;
      await t.run(async ctx => {
        if (change === "closed") await ctx.db.patch(runId, { state: "closed" });
        else if (change === "closedAt") await ctx.db.patch(runId, { closedAt: FIXTURE_NOW });
        else if (change === "missing") await ctx.db.delete(runId);
        else await ctx.db.patch(eventId, { demoRunId: nextRunId });
      });
    });
    expect(await publish(t, eventId)).toMatchObject({ status: "failed", code: "STALE_REVISION" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await candidateSet(t, eventId)).toEqual(before);
    expect(await revisions(t, eventId)).toEqual(beforeRevisions);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual(beforeRuns);
    expect(await pendingAdvocateStarts(t)).toHaveLength(0);
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

  async function linkedSetup(roomState: "open" | "closed" = "open") {
    const { t, eventId } = await pairSetup();
    const otherFacts = { ...advocateEvent, objectB: { ...advocateEvent.objectB, objectId: "SIM-1003", name: "Advocate fixture C" } };
    const otherId = await insertEvent(t, otherFacts);
    expect(otherId).not.toBe(eventId);
    await operator(t, "c", "SIM-1003");
    await t.run(async ctx => {
      const companyIds = (await ctx.db.query("companies").collect()).map(c => c._id);
      const roomId = await ctx.db.insert("rooms", { state: roomState, companyIds, demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
      for (const id of [eventId, otherId]) await ctx.db.insert("roomEvents", { roomId, eventId: id, linkedAt: FIXTURE_NOW });
    });
    return { t, eventId, otherId };
  }
  const sharedLine = (ids: string[]) => `This spacecraft is also in linked incident(s) ${ids.join(", ")}; one burn must be authorized through a single trajectory plan.`;

  it("flags a mover shared with another active linked event and leaves that event's set alone", async () => {
    const { t, eventId, otherId } = await linkedSetup();
    mockOrbit();
    expect(await publish(t, otherId)).toMatchObject({ status: "published", sharedMoverEventIds: [eventId] });
    const other = await candidateSet(t, otherId);
    const otherRevisions = await revisions(t, otherId);
    expect(await publish(t, eventId)).toMatchObject({ status: "published", sharedMoverEventIds: [otherId] });
    const cards = await currentCards(t, eventId);
    // SIM-1001 is in both events; SIM-1002 and the wait card are this event's alone.
    for (const c of cards) expect(c.assumptions.includes(sharedLine([otherId]))).toBe(c.movingObjectId === "SIM-1001");
    mockOrbit({ grid: GRID.map((g, i) => i === 0 ? { ...g, missAfterKm: 1.6 } : g) });
    expect(await publish(t, eventId)).toMatchObject({ status: "published", version: 2, changed: true });
    // The line is stable: an unchanged card keeps its revision.
    expect((await currentCards(t, eventId)).map(c => c.revision)).toEqual([2, 1, 1, 1]);
    expect(await candidateSet(t, otherId)).toEqual(other);
    expect(await revisions(t, otherId)).toEqual(otherRevisions);
    expect(await t.run(ctx => ctx.db.query("trajectoryPlans").collect())).toEqual([]);
  });

  it("ignores linked events in a closed room and inactive linked events", async () => {
    const closed = await linkedSetup("closed");
    mockOrbit();
    expect(await publish(closed.t, closed.eventId)).toMatchObject({ status: "published", sharedMoverEventIds: [] });
    const open = await linkedSetup();
    await open.t.run(ctx => ctx.db.patch(open.otherId, { active: false }));
    expect(await publish(open.t, open.eventId)).toMatchObject({ status: "published", sharedMoverEventIds: [] });
    expect((await currentCards(open.t, open.eventId)).some(c => c.assumptions.some(a => a.includes("linked incident")))).toBe(false);
  });
});
