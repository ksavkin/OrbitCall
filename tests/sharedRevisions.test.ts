import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { AgentSpan, HostOutput } from "../convex/lib/host";
import type { CandidatesRequest, RescreenRequest } from "../convex/lib/orbitClient";
import { putFixture } from "../convex/lib/events";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { as, fn, pick, seed, selection, userId } from "./decision";
import { backend, insertEvent, type Backend } from "./helpers";

// A card change is refused only when it changes a shared burn (spec §4.1 "Shared maneuvers"). Sharing follows the burn
// horizon of trajectoryPlans.ts affectedBy, or a live plan listing the incident; rooms do not decide. E1 = SIM-1001 ×
// SIM-1002 and the partner E2 = SIM-1001 × SIM-3001 share the mover SIM-1001 when E2's encounter lies inside
// [burn, burn + 72 h] of the P1 burn. The orbit service below is an in-memory test fixture, not a deployed service.
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const P1 = advocateCandidates.find(c => c.candidateId === "P1")!;
const P2 = advocateCandidates.find(c => c.candidateId === "P2")!;
const atBurnPlus = (hours: number) => new Date(Date.parse(P1.burnTimeUtc!) + hours * 3_600_000).toISOString().replace(".000Z", "Z");
const partner = (tcaUtc: string) => ({ ...advocateEvent, objectB: { ...advocateEvent.objectA, objectId: "SIM-3001", name: "Fixture SIM-3001" }, tcaUtc });

// ---- Host revision (fixtures follow tests/revisions.test.ts) ----

const DEFAULT = "Move SIM-1001 only; burn after 2026-10-24T21:14:07Z; delta-v at most 0.1 m/s; use retrograde";
// Keeps both SIM-1001 cards (P1 0.2 m/s, P2 0.3 m/s) and lets a SIM-1002 option change.
const KEEP = "delta-v at most 0.3 m/s";
type Point = readonly ["A" | "B", string, number, "prograde" | "retrograde", number];
const leadGrid = (tcaUtc: string): Point[] => ([["A", 12, 0.02, "prograde", 1.3], ["B", 12, 0.02, "retrograde", 1.2], ["A", 6, 0.05, "prograde", 1.9],
  ["A", 6, 0.2, "retrograde", 2.5], ["A", 3, 0.1, "retrograde", 2.4]] as const).map(([side, leadH, dv, direction, miss]) =>
  [side, new Date(Date.parse(tcaUtc) - leadH * 3_600_000).toISOString().replace(".000Z", "Z"), dv, direction, miss] as const);
// The exact P1 and P2 burns of SIM-1001 and one new SIM-1002 burn in place of P4.
const keepGrid: Point[] = [["A", P1.burnTimeUtc!, P1.deltaVMs!, P1.direction!, 1.3], ["A", P2.burnTimeUtc!, P2.deltaVMs!, P2.direction!, 1.2],
  ["B", "2026-10-24T22:00:00Z", 0.05, "prograde", 1.9]];
const info = (objectId: string) => ({ objectId, name: objectId, kind: "payload", maneuverability: "maneuverable",
  classificationBasis: "simulation", operationalStatus: null, group: "sim", simulated: true });
function answer(req: CandidatesRequest, points: Point[]) {
  const common = { missBeforeKm: 0.18, estimatedFuelKg: null, indicative: true, simulated: true };
  return {
    snapshotId: req.snapshotId, evidenceVersion: req.evidenceVersion, objectA: req.objectA, objectB: req.objectB,
    objects: { [req.objectA]: info(req.objectA), [req.objectB]: info(req.objectB) }, notMovable: [],
    tcaUtc: req.tcaUtc, tcaInputUtc: req.tcaUtc, missBeforeKm: 0.18, relSpeedKmS: 7.6, simulated: true,
    candidates: points.filter(([side]) => req.allowedMovingObjectIds.includes(side === "A" ? req.objectA : req.objectB)).map(([side, burnTimeUtc, deltaVMs, direction, missAfterKm], i) => ({
      ...common, candidateId: `grid-${i}`, kind: "maneuver", movingSide: side, movingObjectId: side === "A" ? req.objectA : req.objectB,
      burnTimeUtc, leadH: (Date.parse(req.tcaUtc) - Date.parse(burnTimeUtc)) / 3_600_000,
      deltaVMs, direction, deltaAKm: 0.04, missAfterKm, tcaAfterUtc: req.tcaUtc, relSpeedKmS: 7.6, passesPairThreshold: true, rank: i + 1,
    })),
    wait: { ...common, candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null,
      leadH: null, deltaVMs: null, direction: null, deltaAKm: null, missAfterKm: null, tcaAfterUtc: null, relSpeedKmS: null,
      passesPairThreshold: false, rank: null },
    failed: [], assumptions: ["Indicative simulated geometry; no covariance."], method: "SGP4 test grid",
  };
}
function orbit(points: Point[] = leadGrid(advocateEvent.tcaUtc)) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => json(answer(JSON.parse(String(init.body)), points)));
  vi.stubGlobal("fetch", fetch); return fetch;
}

/** E1 from the shared seed, the partner events this case needs (none in a room), then a checked Host revision of E1. */
async function hostSetup(text: string, partners: string[] = []) {
  const { t, eventId } = await seed();
  const others: Id<"events">[] = [];
  for (const tcaUtc of partners) {
    const id = await insertEvent(t, partner(tcaUtc));
    await t.mutation(internal.candidates.publish, { eventId: id, baseVersion: null, start: false,
      candidates: advocateCandidates.map(c => c.movingSide === "B" ? { ...c, movingObjectId: "SIM-3001" } : c) });
    others.push(id);
  }
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
  // Precondition: the room groups only E1's own pair rows; no partner event is linked.
  expect((await t.run(ctx => ctx.db.query("roomEvents").collect())).map(l => l.eventId)).toEqual([eventId]);
  const sourceId = (await as(t, "a").mutation(api.messages.send, { roomId, eventId, text })).messageId;
  const hostRunId = (await t.mutation(internal.hostTriggers.request, { roomId, trigger: "final_message" }))!;
  const context = (await t.query(internal.hostTriggers.context, { roomId, trigger: "final_message" }))!;
  const target = context.events.find(e => e.eventId === eventId)!.candidates.find(c => c.label === "P1")!;
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], summaries: [],
    requestedRevisions: [{ eventId, candidateId: target.candidateId, reason: "The operator requested a revised maneuver.", messageIds: [sourceId] }],
    understood: [{ eventId, kind: "constraint", hard: true, text, sourceMessageId: sourceId, correctsId: null }] };
  const span: AgentSpan = { role: "coordination_host", provider: "google", model: "test-model", inputVersion: context.inputVersion,
    attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
  await t.mutation(internal.hostTriggers.finish, { hostRunId, span, output, check: null });
  return { t, E1: eventId, others, roomId, hostRunId };
}
type HostSetup = Awaited<ReturnType<typeof hostSetup>>;
const run = (s: HostSetup) => s.t.action(internal.revisions.fromHost, { hostRunId: s.hostRunId });
const cards = (t: Backend, eventId: Id<"events">) => t.run(async ctx => {
  const set = (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique())!;
  return Promise.all(set.candidateRevisionIds.map(async id => (await ctx.db.get(id))!));
});
const plans = (t: Backend) => t.run(ctx => ctx.db.query("trajectoryPlans").collect());
const live = async (t: Backend) => (await plans(t)).filter(p => p.objectId === "SIM-1001" && p.state !== "superseded");
const burnOf = (c: { movingObjectId: string | null; movingSide: string | null; burnTimeUtc: string | null; deltaVMs: number | null; direction: string | null }) =>
  [c.movingObjectId, c.movingSide, c.burnTimeUtc, c.deltaVMs, c.direction];
const plan = (t: Backend, eventIds: Id<"events">[]) => t.run(ctx => ctx.db.insert("trajectoryPlans", { objectId: "SIM-1001", planVersion: 1,
  state: "authorizing", affectedEventIds: eventIds, eventRefs: [], maneuverId: null, demoRunId: null, createdAt: Date.now(), updatedAt: Date.now() }));

/** Side A selects the same P1 burn of SIM-1001 in E1 and E2, and C's approval of E2 signs the resulting plan. */
async function sharedPlan(s: HostSetup) {
  const E2 = s.others[0];
  await pick(s.t, "a", s.E1, "P1");
  await pick(s.t, "a", E2, "P1");
  const [before, ...rest] = await live(s.t);
  expect(rest).toEqual([]);
  expect([...before.affectedEventIds].sort()).toEqual([s.E1, E2].sort());
  const c = await userId(s.t, "c"), picked = (await selection(s.t, E2))!;
  await s.t.run(async ctx => ctx.db.insert("approvals", { eventId: E2, side: "B", status: "approved", userId: c,
    companyId: (await ctx.db.get(c))!.companyId, proposalId: picked.proposalId!, revision: picked.revision!, selectionGeneration: picked.generation,
    approvalRuleVersion: 1, trajectoryPlanId: before._id, trajectoryPlanVersion: before.planVersion, reason: null,
    demoRunId: null, current: true, at: Date.now(), assignmentVersion: 1 }));
  return { E2, before };
}

describe("host revision of an incident whose spacecraft shares a burn", () => {
  it("accepts a revision that keeps the shared burns, then supersedes the plan version and resets the partner", async () => {
    const s = await hostSetup(KEEP, [atBurnPlus(8)]);
    const { E2, before } = await sharedPlan(s);
    const old = await cards(s.t, s.E1);
    orbit(keepGrid);
    expect(await run(s)).toEqual([{ eventId: s.E1, status: "published", changed: true, version: 2 }]);
    const next = await cards(s.t, s.E1);
    // The SIM-1001 burns are identical under their card ids; only the SIM-1002 option changed.
    for (const id of ["P1", "P2"]) {
      const was = old.find(c => c.candidateId === id)!, is = next.find(c => c.candidateId === id)!;
      expect(is.revision).toBe(2);
      expect(burnOf(is)).toEqual(burnOf(was));
    }
    expect(next.some(c => c.candidateId === "P4")).toBe(false);
    expect(next.filter(c => c.movingObjectId === "SIM-1002").map(c => c.burnTimeUtc)).toEqual(["2026-10-24T22:00:00Z"]);
    // The selection moved to the new P1 revision: the plan version advanced and E2's signature was reset.
    expect(await selection(s.t, s.E1)).toMatchObject({ revision: 2, generation: 2 });
    const all = await plans(s.t);
    expect(all.find(p => p._id === before._id)!.state).toBe("superseded");
    const [after, ...rest] = await live(s.t);
    expect(rest).toEqual([]);
    expect(after.planVersion).toBe(before.planVersion + 1);
    expect([...after.affectedEventIds].sort()).toEqual([s.E1, E2].sort());
    expect(after.eventRefs.find(r => r.eventId === s.E1)).toMatchObject({ revision: 2 });
    expect(await selection(s.t, E2)).toMatchObject({ lastReset: { reason: "trajectory_changed" } });
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect())).filter(a => a.eventId === E2 && a.current)).toEqual([]);
  });

  it("accepts a revision that moves the other spacecraft instead of the shared one", async () => {
    // "Move SIM-1002 instead": the requested P1 keeps its card id but no longer moves the shared SIM-1001.
    const s = await hostSetup(KEEP, [atBurnPlus(8)]);
    const { before } = await sharedPlan(s);
    orbit([["B", "2026-10-24T22:00:00Z", 0.05, "prograde", 1.9]]);
    expect(await run(s)).toEqual([expect.objectContaining({ eventId: s.E1, status: "published", changed: true })]);
    expect((await cards(s.t, s.E1)).filter(c => c.kind === "maneuver")).toEqual([expect.objectContaining({ candidateId: "P1", movingObjectId: "SIM-1002" })]);
    expect((await plans(s.t)).find(p => p._id === before._id)!.state).toBe("superseded");
  });

  it("refuses a revision that changes the shared P1 burn and leaves options and plan untouched", async () => {
    const s = await hostSetup(DEFAULT, [atBurnPlus(8)]);
    const { before } = await sharedPlan(s);
    const old = await cards(s.t, s.E1), fetch = orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ eventId: s.E1, status: "failed", code: "TRAJECTORY_PLAN_REQUIRED",
      message: expect.stringContaining("only change together in every affected incident") })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await cards(s.t, s.E1)).toEqual(old);
    expect(await live(s.t)).toEqual([before]);
  });

  it("refuses the shared burn without any plan or selection: the horizon alone makes it shared", async () => {
    const s = await hostSetup(DEFAULT, [atBurnPlus(8)]);
    const old = await cards(s.t, s.E1); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "TRAJECTORY_PLAN_REQUIRED" })]);
    expect(await cards(s.t, s.E1)).toEqual(old);
  });

  it("accepts a revision of an unrelated incident while the mover has a live plan that does not list it", async () => {
    // Another pair of SIM-1001 encounters, both far outside the horizon of any E1 burn, holds the live plan.
    const s = await hostSetup(DEFAULT, [atBurnPlus(100), atBurnPlus(101)]);
    const id = await plan(s.t, s.others);
    orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ eventId: s.E1, status: "published", changed: true })]);
    expect((await cards(s.t, s.E1)).find(c => c.candidateId === "P1")).toMatchObject({ revision: 2, deltaVMs: 0.1, direction: "retrograde" });
    expect((await s.t.run(ctx => ctx.db.get(id)))!.state).toBe("authorizing");
  });

  it("still refuses when a live plan lists this incident", async () => {
    const s = await hostSetup(DEFAULT, [atBurnPlus(100)]);
    await plan(s.t, [s.E1, s.others[0]]);
    const old = await cards(s.t, s.E1); orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ status: "failed", code: "TRAJECTORY_PLAN_REQUIRED" })]);
    expect(await cards(s.t, s.E1)).toEqual(old);
  });

  it("no longer blocks an incident whose open room links an event of the mover outside the burn horizon", async () => {
    // E1's encounter is 3:14 after midnight; the linked encounter lies 80 h after the P1 burn, beyond every E1 burn's horizon.
    const s = await hostSetup(DEFAULT, [atBurnPlus(80)]);
    await s.t.run(ctx => ctx.db.insert("roomEvents", { roomId: s.roomId, eventId: s.others[0], linkedAt: Date.now() }));
    orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ eventId: s.E1, status: "published", changed: true })]);
    expect(await plans(s.t)).toEqual([]);
  });

  it("ignores a partner inside the horizon that was closed without the burn", async () => {
    const s = await hostSetup(DEFAULT, [atBurnPlus(8)]);
    await s.t.run(ctx => ctx.db.patch(s.others[0], { status: "no_action_needed" }));
    orbit();
    expect(await run(s)).toEqual([expect.objectContaining({ eventId: s.E1, status: "published", changed: true })]);
  });
});

// ---- Summary edit (fixtures follow tests/summaryWorkflow.test.ts) ----

const syncPlans = makeFunctionReference<"mutation", { eventId: Id<"events"> }>("trajectoryPlans:sync");
const asOperator = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${name}` });

/** E1 with side A's P1 selected; `partnerTca` adds E2 = SIM-1001 × SIM-3001, never linked in a room. */
async function summarySetup(partnerTca?: string) {
  const t = backend(); const eventId = await insertEvent(t, advocateEvent);
  const ids = await t.run(async ctx => {
    const a = await ctx.db.insert("companies", { key: "a", name: "A", simulated: true });
    const b = await ctx.db.insert("companies", { key: "b", name: "B", simulated: true });
    const users = {} as Record<string, Id<"users">>;
    for (const [name, companyId] of [["a", a], ["b", b]] as const) {
      users[name] = await ctx.db.insert("users", { tokenIdentifier: `https://fixture.invalid|${name}`, companyId, role: "operator", assignmentVersion: 1 });
    }
    for (const [side, companyId, objectId, policy] of [["A", a, "SIM-1001", policyA], ["B", b, "SIM-1002", policyB]] as const) {
      await ctx.db.insert("satelliteOwners", { objectId, companyId });
      await ctx.db.insert("fleetAssignments", { objectId, userId: users[side.toLowerCase()], active: true });
      await ctx.db.insert("policies", { companyId, revision: 1, satellites: [policy], updatedAt: FIXTURE_NOW - 1000 });
    }
    await ctx.db.patch(eventId, { status: "proposal", workflow: "bilateral", requiredApprovalSides: ["A", "B"], approvalRuleVersion: 1 });
    const E2 = partnerTca ? await putFixture(ctx, "fixture:test", partner(partnerTca), "red") : null;
    return { users, E2 };
  });
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates, start: false });
  const proposal = await t.run(ctx => ctx.db.query("proposals").withIndex("by_event_candidate", q =>
    q.eq("eventId", eventId).eq("candidateId", "P1")).unique());
  await asOperator(t, "a").mutation(api.proposals.select, { eventId, proposalId: proposal!._id, revision: 1, expectedGeneration: 0 });
  return { t, eventId, proposalId: proposal!._id, E2: ids.E2 };
}
type SummarySetup = Awaited<ReturnType<typeof summarySetup>>;
const edit = (s: SummarySetup, changes: Record<string, unknown>) => asOperator(s.t, "a").mutation(api.summary.edit,
  { eventId: s.eventId, proposalId: s.proposalId, baseRevision: 1, expectedGeneration: 1, changes });
const canEdit = async (s: SummarySetup) => (await asOperator(s.t, "a").query(api.summary.get, { eventId: s.eventId })).canEdit;
function rescreen() {
  let request: RescreenRequest;
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      request = JSON.parse(String(init.body));
      return json({ jobId: request.jobId, status: "queued", created: true, statusUrl: `/jobs/${request.jobId}` }, 202);
    }
    return json({ jobId: request.jobId, kind: "rescreen", status: "completed", phase: "done", progress: 1, counters: {}, coverage: null,
      requestHash: "test-hash", createdAt: new Date(FIXTURE_NOW).toISOString(), startedAt: new Date(FIXTURE_NOW).toISOString(),
      finishedAt: new Date(FIXTURE_NOW).toISOString(), resultRef: null, error: null,
      result: { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion, passed: true, objectsChecked: 20, objectsInCatalog: 100,
        horizonH: 72, originalMissAfterKm: 2.25, newConjunctions: [], refusalReason: null, simulated: true, method: "fixture orbit",
        limitations: ["Indicative"], fromUtc: request.fromUtc, toUtc: request.toUtc, screenedFromUtc: request.fromUtc, screenedToUtc: request.toUtc,
        proposalId: request.proposalId, revision: request.revision } });
  }));
}
async function runJob(s: SummarySetup) {
  const row = (await s.t.run(async ctx => (await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", s.eventId)).collect())
    .filter(r => r.after?.type === "summary_edit_v1" && r.after.state === "requested"))).at(-1)!;
  await s.t.action(internal.summary.submit, { jobId: row._id });
  await s.t.action(internal.summary.poll, { jobId: row._id, attempt: 0 });
}
const revisionsOf = (s: SummarySetup) => s.t.run(async ctx => Promise.all((await ctx.db.query("proposalRevisions")
  .withIndex("by_proposal_revision", q => q.eq("proposalId", s.proposalId)).collect()).map(async r => (await ctx.db.get(r.candidateRevisionId))!)));

describe("summary edit of a card whose burn is shared", () => {
  it("publishes a text-only edit that keeps the shared burn", async () => {
    const s = await summarySetup(atBurnPlus(8));
    expect(await canEdit(s)).toBe(true);
    rescreen();
    await edit(s, { note: "Keep the imaging pass clear." });
    await runJob(s);
    const [first, second] = await revisionsOf(s);
    expect(second).toMatchObject({ revision: 2 });
    expect(burnOf(second)).toEqual(burnOf(first));
    expect((await asOperator(s.t, "a").query(api.summary.get, { eventId: s.eventId })).form).toMatchObject({ revision: 2, note: "Keep the imaging pass clear." });
  });

  it.each([["delta-v", { deltaVMs: 0.75 }], ["burn time", { burnTimeUtc: "2026-10-24T21:30:00Z" }], ["mover", { movingSide: "B" }],
    ["direction", { direction: "retrograde" }]])("refuses an edit of the shared burn's %s", async (_name, changes) => {
    const s = await summarySetup(atBurnPlus(8));
    await expect(edit(s, changes)).rejects.toMatchObject({ data: { code: "SHARED_TRAJECTORY_REQUIRED" } });
  });

  it("refuses a burn edit when a live plan lists this incident", async () => {
    const s = await summarySetup();
    await plan(s.t, [s.eventId]);
    await expect(edit(s, { deltaVMs: 0.75 })).rejects.toMatchObject({ data: { code: "SHARED_TRAJECTORY_REQUIRED" } });
    expect(await canEdit(s)).toBe(true);
  });

  it.each([["the partner was closed without the burn", "closed"], ["the partner lies outside the burn horizon", "outside"],
    ["the mover's live plan lists only another pair", "plan"]])("accepts a burn edit when %s", async (_name, kind) => {
    const s = await summarySetup(atBurnPlus(kind === "outside" ? 80 : 8));
    // Selecting P1 drafted a plan with E2 inside the horizon; the repair sync drops it once E2 is closed.
    if (kind !== "outside") {
      await s.t.run(ctx => ctx.db.patch(s.E2!, { status: kind === "closed" ? "no_action_needed" : "verified" }));
      await s.t.mutation(syncPlans, { eventId: s.eventId });
      expect(await live(s.t)).toEqual([]);
    }
    if (kind === "plan") await plan(s.t, [s.E2!, await insertEvent(s.t, partner(atBurnPlus(100)))]);
    expect(await canEdit(s)).toBe(true);
    await edit(s, { deltaVMs: 0.75 });
    rescreen(); await runJob(s);
    expect((await revisionsOf(s)).at(-1)).toMatchObject({ revision: 2, deltaVMs: 0.75 });
  });
});
