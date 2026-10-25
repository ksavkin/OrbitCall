import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent, policyA } from "../fixtures/policies";
import { ingestArgs } from "./helpers";
import { as, companyA, fn, pick, seed, selection, tick } from "./decision";
import { putFixture, upsertObject } from "../convex/lib/events";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());
async function approvedA() {
  const result = await seed();
  await pick(result.t, "a", result.eventId, "P2");
  await as(result.t, "a").mutation(fn.approve, await tick(result.t, result.eventId));
  return result;
}
type Test = Awaited<ReturnType<typeof approvedA>>;
const status = ({ t, eventId }: Test) => as(t, "b").query(fn.status, { eventId });
const event = ({ t, eventId }: Test) => t.run(ctx => ctx.db.get(eventId));
const approvals = ({ t, eventId }: Test) => t.run(ctx => ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", eventId)).collect());
const set = ({ t, eventId }: Test) => t.run(ctx => ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique());
const policyChange = ({ t }: Test) => as(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, minFuelReserveKg: 8 }] });
async function expectReset(test: Test, reason: string) {
  expect(await status(test)).toMatchObject({ allRequiredApproved: false, turn: "A", approvals: { A: { status: "pending" } }, lastReset: { reason } });
  expect((await selection(test.t, test.eventId))!.generation).toBeGreaterThan(1);
  expect((await approvals(test)).every(a => !a.current)).toBe(true);
}

describe("material approval invalidation", () => {
  it("retires approval in the policy transaction, including a change in the same clock tick", async () => {
    const test = await approvedA();
    const old = await tick(test.t, test.eventId);
    await policyChange(test);
    await expectReset(test, "policy_changed");
    await expect(as(test.t, "b").mutation(fn.approve, old)).rejects.toMatchObject({ data: { code: "STALE_REVISION" } });
    await as(test.t, "a").mutation(fn.approve, await tick(test.t, test.eventId));
    expect(await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).toMatchObject({ allRequiredApproved: true });
    expect(await approvals(test)).toHaveLength(3);
  });

  it("keeps idempotent policy updates and unchanged ingestion from resetting an approval", async () => {
    const test = await approvedA();
    const before = await selection(test.t, test.eventId);
    vi.setSystemTime(FIXTURE_NOW + 1000);
    await as(test.t, "a").mutation(api.policies.update, { satellites: [policyA] });
    await test.t.mutation(internal.events.ingest, ingestArgs((await event(test))!.snapshotId, advocateEvent));
    expect(await selection(test.t, test.eventId)).toEqual(before);
    expect(await status(test)).toMatchObject({ approvals: { A: { status: "approved" } }, turn: "B", lastReset: null });
  });

  it("reopens an approved but unscheduled decision after a policy change", async () => {
    const test = await approvedA();
    await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId));
    await policyChange(test);
    await expectReset(test, "policy_changed");
    expect((await event(test))!.status).toBe("proposal");
    await as(test.t, "a").mutation(fn.approve, await tick(test.t, test.eventId));
    expect(await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).toMatchObject({ allRequiredApproved: true });
  });

  it("permanently invalidates changed evidence until new candidates are published", async () => {
    const test = await approvedA();
    await test.t.mutation(internal.events.ingest, ingestArgs((await event(test))!.snapshotId, { ...advocateEvent, missKm: 0.28 }));
    await expectReset(test, "evidence_changed");
    expect(await set(test)).toMatchObject({ reviewRequired: true });
    expect((await event(test))!.status).toBe("agents");
    await expect(as(test.t, "a").mutation(fn.approve, await tick(test.t, test.eventId))).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    await test.t.mutation(internal.candidates.publish, { eventId: test.eventId, baseVersion: 1, start: false,
      candidates: advocateCandidates.map(c => ({ ...c, revision: 2, missBeforeKm: 0.28 })) });
    expect(await set(test)).toMatchObject({ reviewRequired: false });
    expect((await event(test))!.status).toBe("proposal");
    await as(test.t, "a").mutation(fn.approve, await tick(test.t, test.eventId));
    expect(await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).toMatchObject({ allRequiredApproved: true });
  });

  it("rejects stale evidence even if an administrative patch bypassed the normal writer", async () => {
    const test = await approvedA();
    await test.t.run(ctx => ctx.db.patch(test.eventId, { missKm: 0.28 }));
    expect(await status(test)).toMatchObject({ approvals: { A: { status: "pending" } }, canAct: false, turn: "A" });
    await expect(as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).rejects.toMatchObject({ data: { code: "STALE_REVISION" } });
    expect((await event(test))!.status).toBe("proposal");
  });

  it("rejects a candidate set marked for review without taking another approval", async () => {
    const test = await approvedA();
    const current = (await set(test))!;
    await test.t.run(ctx => ctx.db.patch(current._id, { reviewRequired: true }));
    expect(await status(test)).toMatchObject({ allRequiredApproved: false, canAct: false, approvals: { A: { status: "pending" } } });
    await expect(as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).rejects.toMatchObject({ data: { code: "STALE_REVISION" } });
  });

  it("resets a snapshot identity change even with identical measured facts", async () => {
    const test = await approvedA();
    const e = (await event(test))!;
    const snapshotId = await test.t.run(async ctx => ctx.db.insert("snapshots", { snapshotId: "new-orbit-pin", sources: (await ctx.db.get(e.snapshotId))!.sources }));
    await test.t.mutation(internal.events.ingest, ingestArgs(snapshotId, advocateEvent));
    await expectReset(test, "evidence_changed");
    expect(await set(test)).toMatchObject({ reviewRequired: true });
  });

  it.each(["sources", "ommUrl"] as const)("resets a shared snapshot %s change before a pair reload", async field => {
    const test = await approvedA();
    const e = (await event(test))!;
    const snapshot = await test.t.run(async ctx => {
      await ctx.db.patch(e.snapshotId, { snapshotId: "test-catalog" });
      return (await ctx.db.get(e.snapshotId))!;
    });
    await test.t.mutation(internal.ingest.register, { snapshotId: "test-catalog",
      sources: field === "sources" ? snapshot.sources.map(s => ({ ...s, fetchedAt: "2026-10-24T13:00:00Z" })) : snapshot.sources,
      ...(field === "ommUrl" ? { ommUrl: "/catalog/new-pin.json" } : {}) });
    await expectReset(test, "evidence_changed");
    expect(await set(test)).toMatchObject({ reviewRequired: true });
  });

  it("invalidates dev fixture evidence permanently while preserving identical fixture reloads", async () => {
    const test = await approvedA();
    const before = await selection(test.t, test.eventId);
    await test.t.run(ctx => putFixture(ctx, "fixture:test", advocateEvent, "red"));
    expect(await selection(test.t, test.eventId)).toEqual(before);
    await test.t.run(ctx => putFixture(ctx, "fixture:test", { ...advocateEvent, missKm: 0.28 }, "red"));
    await expectReset(test, "evidence_changed");
    await test.t.run(ctx => putFixture(ctx, "fixture:test", advocateEvent, "red"));
    expect((await approvals(test)).every(a => !a.current)).toBe(true);
  });

  it("resets other encounters when shared object evidence changes", async () => {
    const test = await approvedA();
    await test.t.run(ctx => upsertObject(ctx, { objectId: "SIM-1001", name: "Renamed evidence", country: null, launchDate: null }, false));
    await expectReset(test, "evidence_changed");
  });

  it("retires approvals when the monitor deactivates an event", async () => {
    const test = await approvedA();
    vi.setSystemTime((await event(test))!.tcaMs + 1);
    await test.t.mutation(internal.riskMonitor.recolor, {});
    expect((await approvals(test)).every(a => !a.current)).toBe(true);
    expect((await selection(test.t, test.eventId))!.lastReset?.reason).toBe("evidence_changed");
  });

  it("keeps committed artifacts and scheduled status while visibly requiring review", async () => {
    const test = await approvedA();
    await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId));
    const ref = await tick(test.t, test.eventId);
    const artifactId = await test.t.run(async ctx => {
      const { approvalRuleVersion: _rule, ...signed } = ref;
      await ctx.db.patch(test.eventId, { status: "scheduled" });
      const current = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", test.eventId)).unique();
      await ctx.db.patch(current!._id, { state: "scheduled" });
      const id = await ctx.db.insert("maneuvers", { refs: [signed], trajectoryPlanId: null, trajectoryPlanVersion: null,
        pinned: { snapshotId: "catalog", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] }, intentKey: "committed-test",
        status: "committed", filePath: "schedule.json", diff: "immutable diff", commitSha: "immutable-sha", writtenBy: "droid",
        rescreenJobId: null, rescreen: null, error: null, reviewRequired: false, demoRunId: null, updatedAt: Date.now() });
      await ctx.db.insert("maneuverEvents", { maneuverId: id, eventId: test.eventId });
      return id;
    });
    await policyChange(test);
    expect((await event(test))!.status).toBe("scheduled");
    expect(await set(test)).toMatchObject({ state: "scheduled", reviewRequired: true });
    expect(await test.t.run(ctx => ctx.db.get(artifactId))).toMatchObject({ status: "committed", diff: "immutable diff", commitSha: "immutable-sha", reviewRequired: true });
    expect((await approvals(test)).every(a => !a.current)).toBe(true);
  });
});

describe("permanent responsibility resets", () => {
  it("never revives an approval after revoke and reassign", async () => {
    const test = await approvedA();
    await test.t.mutation(internal.operators.provision, companyA([]));
    await expectReset(test, "assignment_changed");
    await test.t.mutation(internal.operators.provision, companyA());
    await expectReset(test, "assignment_changed");
    await as(test.t, "a").mutation(fn.approve, await tick(test.t, test.eventId));
    expect(await status(test)).toMatchObject({ approvals: { A: { status: "approved" } }, turn: "B" });
  });

  it("lets the replacement operator act first after responsibility changes", async () => {
    const test = await approvedA();
    const replacement = companyA([]);
    replacement.members[1].assignedObjectIds = ["SIM-1001"];
    await test.t.mutation(internal.operators.provision, replacement);
    expect(await as(test.t, "unassigned").query(fn.status, { eventId: test.eventId })).toMatchObject({ turn: "A", myTurn: true });
    await as(test.t, "unassigned").mutation(fn.approve, await tick(test.t, test.eventId));
    expect(await as(test.t, "b").mutation(fn.approve, await tick(test.t, test.eventId))).toMatchObject({ allRequiredApproved: true });
  });

  it("uses the same valid-approval predicate for turn and count after direct revocation", async () => {
    const test = await approvedA();
    await test.t.run(async ctx => {
      const user = (await ctx.db.query("users").collect()).find(u => u.name === "A")!;
      for (const a of await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect()) await ctx.db.patch(a._id, { active: false });
    });
    expect(await status(test)).toMatchObject({ turn: "A", approvals: { A: { status: "pending" } } });
  });

  it("never revives an approval after a role change with unchanged assignment", async () => {
    const test = await approvedA();
    const changed = companyA();
    changed.members[0].role = "head_of_ops";
    await test.t.mutation(internal.operators.provision, changed);
    await expectReset(test, "authorization_changed");
    await test.t.mutation(internal.operators.provision, companyA());
    await expectReset(test, "authorization_changed");
  });

  it("does not reset identical provisioning", async () => {
    const test = await approvedA();
    const before = await selection(test.t, test.eventId);
    await test.t.mutation(internal.operators.provision, companyA());
    expect(await selection(test.t, test.eventId)).toEqual(before);
    expect(await status(test)).toMatchObject({ approvals: { A: { status: "approved" } }, turn: "B" });
  });

  it("writes a shared reset record without private policy values", async () => {
    const test = await approvedA();
    await as(test.t, "a").mutation(fn.startWorkflow, { eventId: test.eventId });
    await policyChange(test);
    const log = await test.t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", test.eventId)).collect());
    expect(log.some(r => r.action === "approvals_reset" && r.after?.reason === "policy_changed")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("PRIVATE_A");
    expect(JSON.stringify(log)).not.toContain("minFuelReserveKg");
    const messages = await test.t.run(ctx => ctx.db.query("messages").collect());
    expect(messages.some(m => m.originalText === "Both approvals reset.")).toBe(true);
  });
});
