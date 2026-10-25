import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent } from "../fixtures/policies";
import { invalidateEventApprovals } from "../convex/lib/approvalState";
import { insertEvent, type Backend } from "./helpers";
import { as, code, fn, pick, seed, selection, tick } from "./decision";

// Shared trajectory plans (spec §4.1 "Shared maneuvers"). X = SIM-1001 × SIM-1002 (a, b) and Y = SIM-1001 × SIM-3001
// (a, c) share the mover SIM-1001; Z = SIM-1002 × SIM-3001 (b, c) is linked in the same room without it.

// trajectoryPlans.ts is a new function file and convex/_generated is regenerated on main only, so it is referenced by path.
const fns = {
  authorized: makeFunctionReference<"query", { id: Id<"trajectoryPlans">; version: number }, { authorized: boolean; reason: string | null; eventRefs: unknown[] }>("trajectoryPlans:authorized"),
  refuse: makeFunctionReference<"mutation", { id: Id<"trajectoryPlans">; version: number }, boolean>("trajectoryPlans:refuse"),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

type Event = typeof advocateEvent;
const pairOf = (a: string, b: string): Event => ({
  ...advocateEvent, objectA: { ...advocateEvent.objectA, objectId: a, name: `Fixture ${a}` }, objectB: { ...advocateEvent.objectA, objectId: b, name: `Fixture ${b}` },
});
// The same P1-P4 cards with each maneuver moving this pair's own object of its side.
const cardsFor = (a: string, b: string) => advocateCandidates.map(c => c.kind === "maneuver" ? { ...c, movingObjectId: c.movingSide === "A" ? a : b } : c);

async function linked() {
  const { t, eventId: X } = await seed();
  const Y = await insertEvent(t, pairOf("SIM-1001", "SIM-3001"));
  const Z = await insertEvent(t, pairOf("SIM-1002", "SIM-3001"));
  await t.mutation(internal.candidates.publish, { eventId: Y, baseVersion: null, candidates: cardsFor("SIM-1001", "SIM-3001"), start: false });
  await t.mutation(internal.candidates.publish, { eventId: Z, baseVersion: null, candidates: cardsFor("SIM-1002", "SIM-3001"), start: false });
  const roomId = await link(t, [X, Y, Z]);
  return { t, X, Y, Z, roomId };
}
const link = (t: Backend, eventIds: Id<"events">[]) => t.run(async ctx => {
  const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [], demoRunId: null, simulated: true, createdAt: Date.now(), closedAt: null });
  for (const eventId of eventIds) await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: Date.now() });
  return roomId;
});

const plans = (t: Backend) => t.run(ctx => ctx.db.query("trajectoryPlans").collect());
const active = async (t: Backend) => (await plans(t)).filter(p => p.state === "draft" || p.state === "authorizing");
const current = (t: Backend, eventId: Id<"events">) => t.run(ctx =>
  ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", eventId).eq("current", true)).collect());
const eventRow = (t: Backend, eventId: Id<"events">) => t.run(async ctx => (await ctx.db.get(eventId))!);
const status = (t: Backend, name: string, eventId: Id<"events">) =>
  as(t, name).query(fn.status, { eventId }) as Promise<{ allRequiredApproved: boolean; turn: string | null; lastReset: { reason: string } | null }>;
const approve = async (t: Backend, name: string, eventId: Id<"events">) => as(t, name).mutation(fn.approve, await tick(t, eventId));
const authorized = (t: Backend, id: Id<"trajectoryPlans">, version: number) => t.query(fns.authorized, { id, version });

/** X selects P1 and Y P2, both burns of SIM-1001: one plan lists both selections. */
async function shared() {
  const s = await linked();
  await pick(s.t, "a", s.X, "P1");
  await pick(s.t, "a", s.Y, "P2");
  return s;
}

describe("trajectoryPlans: one plan for a shared mover", () => {
  it("creates one plan for SIM-1001 across both linked events and versions it by row", async () => {
    const { t, X, Y, Z } = await linked();
    await pick(t, "a", X, "P1");
    let rows = await plans(t);
    // Y has no selection yet: it is affected but has no ref, so the plan cannot be authorized.
    expect(rows).toMatchObject([{ objectId: "SIM-1001", planVersion: 1, state: "draft", affectedEventIds: [X, Y].sort(), demoRunId: null, maneuverId: null }]);
    expect(rows[0].eventRefs).toEqual([{ eventId: X, ...await refOf(t, X) }]);
    await pick(t, "a", Y, "P2");
    rows = await plans(t);
    expect(rows.map(p => [p.planVersion, p.state])).toEqual([[1, "superseded"], [2, "draft"]]);
    expect(new Set(rows[1].eventRefs.map(r => r.eventId))).toEqual(new Set([X, Y]));
    for (const r of rows[1].eventRefs) expect(r).toEqual({ eventId: r.eventId, ...await refOf(t, r.eventId) });
    // Z does not involve SIM-1001 and never joins the plan.
    expect(rows.every(p => !p.affectedEventIds.includes(Z))).toBe(true);
  });

  it("binds both events' approvals to the same version and authorizes only when every affected event approved", async () => {
    const { t, X, Y, Z, roomId } = await shared();
    const [plan] = await active(t);
    expect(plan.planVersion).toBe(2);
    expect(await authorized(t, plan._id, 2)).toMatchObject({ authorized: false, reason: "PLAN_DRAFT" });
    await approve(t, "a", X);
    expect((await active(t))[0]).toMatchObject({ _id: plan._id, state: "authorizing" });
    await approve(t, "b", X);
    expect((await eventRow(t, X)).status).toBe("approved");
    // X's own consensus does not authorize the shared burn: Y has not approved.
    expect(await authorized(t, plan._id, 2)).toMatchObject({ authorized: false, reason: "APPROVALS_MISSING" });
    await approve(t, "a", Y);
    expect(await authorized(t, plan._id, 2)).toMatchObject({ authorized: false, reason: "APPROVALS_MISSING" });
    // Z, the unrelated linked event, decides with unbound approvals.
    await pick(t, "b", Z, "P3");
    await approve(t, "b", Z);
    await approve(t, "c", Z);
    expect((await current(t, Z)).map(a => [a.trajectoryPlanId, a.trajectoryPlanVersion])).toEqual([[null, null], [null, null]]);
    await approve(t, "c", Y);
    const signed = [...await current(t, X), ...await current(t, Y)];
    expect(signed).toHaveLength(4);
    expect(signed.every(a => a.trajectoryPlanId === plan._id && a.trajectoryPlanVersion === 2)).toBe(true);
    // The room closed on the last consensus; authorization reads the stored refs, not the room.
    expect((await t.run(ctx => ctx.db.get(roomId)))!.state).toBe("closed");
    expect(await authorized(t, plan._id, 2)).toEqual({ authorized: true, reason: null, eventRefs: plan.eventRefs });
    expect(await authorized(t, plan._id, 1)).toMatchObject({ authorized: false, reason: "STALE_PLAN_VERSION" });
    const old = (await plans(t)).find(p => p.planVersion === 1)!;
    expect(await authorized(t, old._id, 1)).toMatchObject({ authorized: false, reason: "PLAN_SUPERSEDED" });
  });
});

describe("trajectoryPlans: a change resets every affected event", () => {
  it("a new selection in Y advances the version and resets X and Y, each with its own reset; Z keeps its approvals", async () => {
    const { t, X, Y, Z, roomId } = await shared();
    await pick(t, "b", Z, "P3");
    await approve(t, "b", Z);
    await approve(t, "a", X);
    await approve(t, "b", X);
    await approve(t, "a", Y);
    const zBefore = await current(t, Z);
    const xGeneration = (await selection(t, X))!.generation;
    // It is side B's turn in Y; side B picks the wait card.
    await pick(t, "c", Y, "P3");
    const [plan, ...rest] = await active(t);
    expect(rest).toEqual([]);
    expect(plan).toMatchObject({ planVersion: 3, state: "draft" });
    expect(await current(t, X)).toEqual([]);
    expect(await current(t, Y)).toEqual([]);
    expect((await selection(t, X))!.generation).toBe(xGeneration + 1);
    expect((await status(t, "a", X)).lastReset?.reason).toBe("trajectory_changed");
    expect((await status(t, "a", Y)).lastReset?.reason).toBe("selection_changed");
    // X had reached its own consensus; it returns to the decision and both sides can sign the new version.
    expect((await eventRow(t, X)).status).toBe("proposal");
    expect(await current(t, Z)).toEqual(zBefore);
    expect((await status(t, "b", Z)).turn).toBe("B");
    const resets = await t.run(ctx => ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", roomId)).collect());
    expect(resets.filter(m => m.originalText === "Both approvals reset.").map(m => m.eventId).sort()).toEqual([X, Y].sort());
    expect(plan.eventRefs).toHaveLength(2);
    for (const r of plan.eventRefs) expect(r).toEqual({ eventId: r.eventId, ...await refOf(t, r.eventId) });
    await approve(t, "a", X);
    await approve(t, "b", X);
    expect((await current(t, X)).every(a => a.trajectoryPlanId === plan._id && a.trajectoryPlanVersion === 3)).toBe(true);
  });

  it("a veto in one event supersedes the version and resets the other", async () => {
    const { t, X, Y } = await shared();
    const before = (await active(t))[0];
    await approve(t, "a", X);
    await approve(t, "a", Y);
    await as(t, "c").mutation(fn.veto, await tick(t, Y));
    const after = (await active(t))[0];
    expect(after.planVersion).toBe(before.planVersion + 1);
    expect((await t.run(ctx => ctx.db.get(before._id)))!.state).toBe("superseded");
    expect(await current(t, X)).toEqual([]);
    expect((await status(t, "a", X)).lastReset?.reason).toBe("trajectory_changed");
    const veto = (await t.run(ctx => ctx.db.query("approvals").collect())).find(a => a.status === "vetoed")!;
    expect(veto).toMatchObject({ eventId: Y, trajectoryPlanId: before._id, trajectoryPlanVersion: before.planVersion });
    // An approval of the old version is no longer accepted as a signature.
    expect(await authorized(t, before._id, before.planVersion)).toMatchObject({ authorized: false });
  });

  it("flags a write reserved for the superseded version instead of replacing it", async () => {
    const { t, X, Y } = await shared();
    const plan = (await active(t))[0];
    const maneuverId = await t.run(async ctx => {
      const id = await ctx.db.insert("maneuvers", { refs: plan.eventRefs, trajectoryPlanId: plan._id, trajectoryPlanVersion: plan.planVersion,
        pinned: { snapshotId: "test", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] }, intentKey: `plan:${plan._id}:${plan.planVersion}`,
        status: "preview", filePath: "operators/a/schedule.json", diff: null, commitSha: null, writtenBy: "droid", rescreenJobId: null, rescreen: null,
        error: null, reviewRequired: false, demoRunId: null, updatedAt: Date.now() });
      await ctx.db.patch(plan._id, { maneuverId: id });
      return id;
    });
    await pick(t, "a", Y, "P3");
    expect((await t.run(ctx => ctx.db.get(plan._id)))!.state).toBe("superseded");
    expect((await t.run(ctx => ctx.db.get(maneuverId)))!.reviewRequired).toBe(true);
    expect((await active(t))[0]).toMatchObject({ planVersion: plan.planVersion + 1, maneuverId: null, affectedEventIds: [X, Y].sort() });
  });

  it("supersedes a scheduled version on a later change and flags its write and every affected event for review", async () => {
    const { t, X, Y } = await shared();
    for (const [name, e] of [["a", X], ["b", X], ["a", Y], ["c", Y]] as const) await approve(t, name, e);
    const plan = (await active(t))[0];
    const maneuverId = await t.run(async ctx => {
      const id = await ctx.db.insert("maneuvers", { refs: plan.eventRefs, trajectoryPlanId: plan._id, trajectoryPlanVersion: plan.planVersion,
        pinned: { snapshotId: "test", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] }, intentKey: `plan:${plan._id}:${plan.planVersion}`,
        status: "committed", filePath: "operators/a/schedule.json", diff: "diff", commitSha: "abc", writtenBy: "droid", rescreenJobId: null, rescreen: null,
        error: null, reviewRequired: false, demoRunId: null, updatedAt: Date.now() });
      for (const eventId of [X, Y]) {
        await ctx.db.insert("maneuverEvents", { maneuverId: id, eventId });
        await ctx.db.patch(eventId, { status: "scheduled" });
      }
      await ctx.db.patch(plan._id, { state: "scheduled", maneuverId: id });
      return id;
    });
    await t.run(async ctx => invalidateEventApprovals(ctx, (await ctx.db.get(X))!, "evidence_changed"));
    expect((await t.run(ctx => ctx.db.get(plan._id)))!.state).toBe("superseded");
    expect((await t.run(ctx => ctx.db.get(maneuverId)))!.reviewRequired).toBe(true);
    for (const e of [X, Y]) {
      expect((await eventRow(t, e)).status).toBe("scheduled");
      expect((await t.run(ctx => ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", e)).unique()))!.reviewRequired).toBe(true);
    }
    expect((await status(t, "a", Y)).lastReset?.reason).toBe("trajectory_changed");
    expect(await active(t)).toMatchObject([{ planVersion: plan.planVersion + 1, state: "draft" }]);
    expect(await authorized(t, plan._id, plan.planVersion)).toMatchObject({ authorized: false, reason: "PLAN_SUPERSEDED" });
  });

  it("a scheduler refusal marks the version for review, returns every event to the agents and starts the next draft", async () => {
    const { t, X, Y } = await shared();
    for (const [name, e] of [["a", X], ["b", X], ["a", Y], ["c", Y]] as const) await approve(t, name, e);
    const plan = (await active(t))[0];
    expect((await authorized(t, plan._id, plan.planVersion)).authorized).toBe(true);
    expect(await t.mutation(fns.refuse, { id: plan._id, version: plan.planVersion })).toBe(true);
    expect((await t.run(ctx => ctx.db.get(plan._id)))!.state).toBe("review_required");
    for (const e of [X, Y]) {
      expect((await eventRow(t, e)).status).toBe("agents");
      expect(await current(t, e)).toEqual([]);
      expect((await status(t, "a", e)).lastReset?.reason).toBe("trajectory_refused");
    }
    expect(await active(t)).toMatchObject([{ planVersion: plan.planVersion + 1, state: "draft" }]);
    // A repeated or late refusal of that version changes nothing.
    expect(await t.mutation(fns.refuse, { id: plan._id, version: plan.planVersion })).toBe(false);
    expect(await active(t)).toHaveLength(1);
  });
});

describe("trajectoryPlans: isolation and concurrency", () => {
  it("keeps trajectoryPlanId null for a maneuver that affects no other linked event, or only a duplicate row", async () => {
    const { t, eventId: X } = await seed();
    await pick(t, "a", X, "P1");
    await approve(t, "a", X);
    expect(await plans(t)).toEqual([]);
    expect((await current(t, X)).map(a => [a.trajectoryPlanId, a.trajectoryPlanVersion])).toEqual([[null, null]]);
    // The same encounter in the other object order is one conjunction, not a second affected event.
    const reversed = await insertEvent(t, pairOf("SIM-1002", "SIM-1001"));
    await link(t, [X, reversed]);
    await pick(t, "b", X, "P2");
    await approve(t, "a", X);
    expect(await plans(t)).toEqual([]);
    expect((await current(t, X)).map(a => a.trajectoryPlanId)).toEqual([null]);
  });

  it("isolates demo runs: another run's plan for the same spacecraft is neither read nor versioned with real rows", async () => {
    const { t, X } = await linked();
    const demo = await t.run(async ctx => {
      const runId = await ctx.db.insert("demoRuns", { scenario: "test", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
      const planId = await ctx.db.insert("trajectoryPlans", { objectId: "SIM-1001", planVersion: 7, state: "authorizing", affectedEventIds: [X],
        eventRefs: [], maneuverId: null, demoRunId: runId, createdAt: Date.now(), updatedAt: Date.now() });
      return { runId, planId };
    });
    await pick(t, "a", X, "P1");
    await approve(t, "a", X);
    const real = (await active(t)).filter(p => p.demoRunId === null);
    expect(real).toMatchObject([{ planVersion: 1, state: "authorizing" }]);
    expect((await current(t, X))[0]).toMatchObject({ trajectoryPlanId: real[0]._id, trajectoryPlanVersion: 1 });
    expect((await t.run(ctx => ctx.db.get(demo.planId)))).toMatchObject({ state: "authorizing", planVersion: 7 });
    await t.run(ctx => ctx.db.patch(demo.runId, { state: "closed", closedAt: Date.now() }));
    expect(await authorized(t, demo.planId, 7)).toMatchObject({ authorized: false, reason: "DEMO_RUN_CLOSED" });
    expect(await t.mutation(fns.refuse, { id: demo.planId, version: 7 })).toBe(false);
  });

  it("concurrent approvals in both events sign one version of one plan", async () => {
    const { t, X, Y } = await shared();
    const [x, y] = await Promise.all([tick(t, X), tick(t, Y)]);
    await Promise.all([as(t, "a").mutation(fn.approve, x), as(t, "a").mutation(fn.approve, y), as(t, "a").mutation(fn.approve, x)]);
    const [plan, ...rest] = await active(t);
    expect(rest).toEqual([]);
    expect(plan.state).toBe("authorizing");
    const signed = [...await current(t, X), ...await current(t, Y)];
    expect(signed).toHaveLength(2);
    expect(signed.every(a => a.trajectoryPlanId === plan._id && a.trajectoryPlanVersion === plan.planVersion)).toBe(true);
  });

  it("an approval on a stale link is not recorded: the event is reset and the next approval signs the new plan", async () => {
    const { t, eventId: X } = await seed();
    const Y = await insertEvent(t, pairOf("SIM-1001", "SIM-3001"));
    await t.mutation(internal.candidates.publish, { eventId: Y, baseVersion: null, candidates: cardsFor("SIM-1001", "SIM-3001"), start: false });
    await pick(t, "a", X, "P1");
    await approve(t, "a", X);
    // Linked after X's side A signed without a plan: no selection write saw the link.
    await link(t, [X, Y]);
    expect(await approve(t, "b", X)).toEqual({ allRequiredApproved: false, requiredApprovalSides: ["A", "B"] });
    expect(await current(t, X)).toEqual([]);
    expect((await status(t, "a", X)).lastReset?.reason).toBe("trajectory_changed");
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, X)))).toBe("INVALID_STATE");
    await approve(t, "a", X);
    const [plan] = await active(t);
    expect((await current(t, X))[0]).toMatchObject({ trajectoryPlanId: plan._id, trajectoryPlanVersion: plan.planVersion });
  });
});

async function refOf(t: Backend, eventId: Id<"events">) {
  const s = (await selection(t, eventId))!;
  return { proposalId: s.proposalId!, revision: s.revision!, selectionGeneration: s.generation };
}
