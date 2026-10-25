import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { getCandidates, type CandidatesResponse } from "../convex/lib/orbitClient";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { as, companyA, seed, userId } from "./decision";
import { backend, insertEvent, type Backend } from "./helpers";

vi.mock("../convex/lib/orbitClient", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/orbitClient")>(), getCandidates: vi.fn(),
}));
const completion = { raw: '{"preferredCandidateId":null}', model: "checked-fixture", usage: { inputTokens: 3, outputTokens: 1 } };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.invalid"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-token");
  vi.mocked(getCandidates).mockReset().mockImplementation(async req => ({
    ...req, objectA: req.objectA, objectB: req.objectB, objects: {}, notMovable: [], tcaInputUtc: req.tcaUtc,
    missBeforeKm: advocateEvent.missKm, relSpeedKmS: advocateEvent.relSpeedKmS, simulated: true, candidates: [],
    wait: { candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null, leadH: null,
      deltaVMs: null, direction: null, deltaAKm: null, missBeforeKm: advocateEvent.missKm, missAfterKm: null,
      tcaAfterUtc: null, relSpeedKmS: null, passesPairThreshold: false, estimatedFuelKg: null, indicative: true, simulated: true, rank: null },
    failed: [], assumptions: ["Synthetic geometry for this test."], method: "fixture",
  } satisfies CandidatesResponse));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const setOf = (t: Backend, eventId: Id<"events">) => t.run(async ctx =>
  (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique())!);
const jobs = (t: Backend, name: string) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter(job => job.name === name && job.state.kind === "pending"));
const notices = (t: Backend) => t.run(ctx => ctx.db.query("inbox").collect());
const messages = (t: Backend) => t.run(ctx => ctx.db.query("messages").collect());
const logs = (t: Backend, kind: string) => t.run(async ctx => (await ctx.db.query("log").collect()).filter(row => row.after?.kind === kind));
async function request(t: Backend, eventId: Id<"events">) {
  const set = await setOf(t, eventId);
  return t.mutation(internal.advocates.publicationFollowups, { eventId, version: set.version, evidenceKey: set.evidenceKey });
}
async function room(t: Backend, eventId: Id<"events">, fields: Partial<Doc<"rooms">> = {}) {
  const set = await setOf(t, eventId);
  return t.run(async ctx => {
    const id = await ctx.db.insert("rooms", {
      state: "open", companyIds: [set.companyAId, set.companyBId].filter((id): id is Id<"companies"> => id !== null),
      demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null, ...fields,
    });
    await ctx.db.insert("roomEvents", { roomId: id, eventId, linkedAt: FIXTURE_NOW });
    return id;
  });
}
async function blockEveryOption(t: Backend) {
  await t.run(async ctx => {
    const a = (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "a")).unique())!;
    const b = (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "b")).unique())!;
    const policy = (await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", a._id)).unique())!;
    await ctx.db.patch(policy._id, { revision: policy.revision + 1, satellites: [{ ...policyA, currentFuelKg: 7.7 }] });
    await ctx.db.insert("policies", { companyId: b._id, revision: 1, satellites: [policyB], updatedAt: FIXTURE_NOW });
  });
}
async function assess(t: Backend, eventId: Id<"events">, side: "A" | "B") {
  const claim = (await t.mutation(internal.advocates.begin, { eventId, side }))!;
  expect(claim).not.toBeNull();
  const result = await t.mutation(internal.advocates.finish, { runId: claim.runId, ...completion });
  return { claim, result };
}

describe("changed candidate publication follow-ups", () => {
  it("schedules every current open linked room and one rationale action, deduplicating repeated requests", async () => {
    const { t, eventId } = await seed();
    const r1 = await room(t, eventId), r2 = await room(t, eventId);
    await room(t, eventId, { state: "closed", closedAt: FIXTURE_NOW });
    const demo = await t.run(ctx => ctx.db.insert("demoRuns", { scenario: "other-run", state: "open", manifest: null, startedBy: null, startedAt: FIXTURE_NOW, closedAt: null }));
    await room(t, eventId, { demoRunId: demo });
    await t.run(ctx => ctx.db.insert("roomEvents", { roomId: r1, eventId, linkedAt: FIXTURE_NOW }));
    expect(await request(t, eventId)).toEqual({ scheduled: true });
    expect(await request(t, eventId)).toEqual({ scheduled: false });
    expect((await jobs(t, "hostTriggers:request")).map(job => job.args[0])).toEqual([
      { roomId: r1, trigger: "candidates_changed" }, { roomId: r2, trigger: "candidates_changed" },
    ]);
    expect(await jobs(t, "agents/rationale:start")).toHaveLength(1);
    expect(await logs(t, "candidate_followups")).toHaveLength(1);
    expect(await notices(t)).toEqual([]);
  });

  it("runs the hook after actual changed orbital publication but not an unchanged response", async () => {
    const { t, eventId } = await seed(); await room(t, eventId);
    const first = await t.action(internal.advocates.publishFromOrbit, { eventId });
    expect(first).toMatchObject({ status: "published", changed: true });
    expect(await jobs(t, "agents/rationale:start")).toHaveLength(1);
    expect(await t.action(internal.advocates.publishFromOrbit, { eventId })).toMatchObject({ status: "published", changed: false });
    expect(await jobs(t, "agents/rationale:start")).toHaveLength(1);
    expect(await jobs(t, "hostTriggers:request")).toHaveLength(1);
  });

  it("does not dispatch stale versions, changed evidence, ownership changes or closed incidents", async () => {
    const { t, eventId } = await seed(); const set = await setOf(t, eventId);
    expect(await t.mutation(internal.advocates.publicationFollowups, { eventId, version: set.version - 1, evidenceKey: set.evidenceKey })).toEqual({ scheduled: false });
    await t.run(ctx => ctx.db.patch(eventId, { missKm: 9 }));
    expect(await request(t, eventId)).toEqual({ scheduled: false });
    await t.run(ctx => ctx.db.patch(eventId, { missKm: advocateEvent.missKm, status: "no_action_needed" }));
    expect(await request(t, eventId)).toEqual({ scheduled: false });
    await t.run(async ctx => {
      await ctx.db.patch(eventId, { status: "proposal" });
      const owner = (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1001")).unique())!;
      await ctx.db.delete(owner._id);
    });
    expect(await request(t, eventId)).toEqual({ scheduled: false });
    expect(await jobs(t, "agents/rationale:start")).toEqual([]);
    expect(await jobs(t, "hostTriggers:request")).toEqual([]);
  });

  it("announces an empty grid without calling a rationale model or declaring an Advocate deadlock", async () => {
    const { t, eventId } = await seed(); await room(t, eventId);
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: [], start: false });
    expect(await request(t, eventId)).toEqual({ scheduled: true });
    expect(await request(t, eventId)).toEqual({ scheduled: false });
    expect(await jobs(t, "agents/rationale:start")).toEqual([]);
    expect(await jobs(t, "hostTriggers:request")).toHaveLength(1);
    expect(await notices(t)).toHaveLength(2);
    expect((await messages(t))[0].originalText).toContain("No computed candidate options");
    expect(await logs(t, "no_mutually_acceptable_option")).toEqual([]);
  });

  it("keeps committed candidates when follow-up dispatch fails and records a sanitized diagnostic", async () => {
    const { t, eventId } = await seed();
    await t.run(async ctx => {
      for (let i = 0; i < 1001; i++) await ctx.db.insert("log", {
        eventId, actor: { kind: "system" }, action: "message", summary: "Fixture history", texts: null, before: null, after: null,
        proposalId: null, revision: null, roomId: null, demoRunId: null, simulated: true, at: FIXTURE_NOW,
      });
    });
    expect(await t.action(internal.advocates.publishFromOrbit, { eventId })).toMatchObject({ status: "published", changed: true, cards: 1 });
    expect((await setOf(t, eventId)).candidateRevisionIds).toHaveLength(1);
    expect((await logs(t, "candidate_followups")).at(-1)?.after?.state).toBe("failed");
    expect(await jobs(t, "agents/rationale:start")).toEqual([]);
  });
});

describe("checked Advocate deadlock notices", () => {
  it("waits for all required current assessments and notifies only currently assigned operators once", async () => {
    const { t, eventId } = await seed(); await blockEveryOption(t);
    const r1 = await room(t, eventId), r2 = await room(t, eventId);
    await room(t, eventId, { state: "closed", closedAt: FIXTURE_NOW });
    // Presence is irrelevant: add a second responsible operator without joining a room/call.
    const a = await userId(t, "a");
    const other = await t.run(async ctx => {
      const user = (await ctx.db.get(a))!;
      const id = await ctx.db.insert("users", { companyId: user.companyId, tokenIdentifier: "offline-colleague", role: "operator", assignmentVersion: 1 });
      await ctx.db.insert("fleetAssignments", { userId: id, objectId: "SIM-1001", active: true });
      return id;
    });
    await assess(t, eventId, "A");
    expect(await notices(t)).toEqual([]); expect(await messages(t)).toEqual([]);
    const b = await assess(t, eventId, "B");
    expect(b.result).toEqual({ published: true });
    expect((await messages(t)).map(row => row.roomId)).toEqual([r1, r2]);
    expect((await messages(t))[0].originalText).toContain("no mutually acceptable option");
    expect((await notices(t)).map(row => row.userId).sort()).toEqual([a, other, await userId(t, "b")].sort());
    expect(await logs(t, "no_mutually_acceptable_option")).toHaveLength(1);
    expect(await t.mutation(internal.advocates.finish, { runId: b.claim.runId, ...completion })).toEqual({ published: false });
    expect(await logs(t, "no_mutually_acceptable_option")).toHaveLength(1);
    const firstNotices = await notices(t);
    await t.run(ctx => ctx.db.patch(b.claim.runId, { status: "failed" }));
    await assess(t, eventId, "B");
    expect(await notices(t)).toEqual(firstNotices);
    expect(await messages(t)).toHaveLength(2);
    expect(await logs(t, "no_mutually_acceptable_option")).toHaveLength(1);
    const shared = await as(t, "a").query(api.advocates.list, { eventId });
    expect(shared.situation).toBe("no_mutually_acceptable_option");
    const exported = JSON.stringify({ messages: await messages(t), inbox: await notices(t), logs: await logs(t, "no_mutually_acceptable_option") });
    expect(exported).not.toMatch(/7\.7|7\.625|PRIVATE_A|currentFuel|protectedWindows|memorySources/);
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("selections").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("maneuvers").collect())).toEqual([]);
  });

  it("does not mislabel pending risk evidence as a mutually unacceptable option", async () => {
    const { t, eventId } = await seed(); await room(t, eventId);
    await t.run(async ctx => {
      const b = (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "b")).unique())!;
      await ctx.db.insert("policies", { companyId: b._id, revision: 1, satellites: [policyB], updatedAt: FIXTURE_NOW });
    });
    await assess(t, eventId, "A"); await assess(t, eventId, "B");
    expect((await as(t, "a").query(api.advocates.list, { eventId })).situation).toBe("needs_more_data");
    expect(await logs(t, "no_mutually_acceptable_option")).toEqual([]);
    expect(await notices(t)).toEqual([]); expect(await messages(t)).toEqual([]);
  });

  it("does not announce a final outcome when one Advocate failed or has not responded", async () => {
    const { t, eventId } = await seed(); await blockEveryOption(t); await room(t, eventId);
    const a = (await t.mutation(internal.advocates.begin, { eventId, side: "A" }))!;
    await t.mutation(internal.advocates.fail, { runId: a.runId, code: "UPSTREAM_UNAVAILABLE", message: "Unavailable" });
    await assess(t, eventId, "B");
    expect((await as(t, "a").query(api.advocates.list, { eventId })).situation).toBe("awaiting_advocates");
    expect(await notices(t)).toEqual([]); expect(await messages(t)).toEqual([]);
  });

  it.each(["ownership", "assignment", "policy", "evidence", "revision", "demo", "resolved"] as const)(
    "supersedes a delayed assessment after %s changes", async change => {
      const { t, eventId } = await seed(); await blockEveryOption(t); await room(t, eventId);
      await assess(t, eventId, "A");
      const b = (await t.mutation(internal.advocates.begin, { eventId, side: "B" }))!;
      if (change === "assignment") await t.mutation(internal.operators.provision, companyA([]));
      if (change === "ownership") await t.run(async ctx => {
        const owner = (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1001")).unique())!;
        await ctx.db.delete(owner._id);
      });
      if (change === "policy") await as(t, "b").mutation(api.policies.update, { satellites: [{ ...policyB, acceptablePc: 0.001 }] });
      if (change === "evidence") await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.25 }));
      if (change === "revision") await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false,
        candidates: advocateCandidates.map(c => ({ ...c, revision: 2 })) });
      if (change === "demo") await t.run(async ctx => {
        const id = await ctx.db.insert("demoRuns", { scenario: "closed", state: "closed", startedBy: null, manifest: null, startedAt: FIXTURE_NOW, closedAt: FIXTURE_NOW });
        await ctx.db.patch(eventId, { demoRunId: id });
      });
      if (change === "resolved") await t.run(ctx => ctx.db.patch(eventId, { status: "no_action_needed" }));
      expect(await t.mutation(internal.advocates.finish, { runId: b.runId, ...completion })).toEqual({ published: false });
      expect((await t.run(ctx => ctx.db.get(b.runId)))?.status).toBe("superseded");
      expect(await logs(t, "no_mutually_acceptable_option")).toEqual([]);
      expect(await notices(t)).toEqual([]); expect(await messages(t)).toEqual([]);
    },
  );

  it("does not reuse the other side's stale assessment after a responsibility change", async () => {
    const { t, eventId } = await seed(); await blockEveryOption(t);
    await assess(t, eventId, "A");
    const id = await userId(t, "a");
    await t.run(ctx => ctx.db.patch(id, { assignmentVersion: 50 }));
    const b = (await t.mutation(internal.advocates.begin, { eventId, side: "B" }))!;
    expect(b.input.counterpart).toEqual([]);
    await t.mutation(internal.advocates.finish, { runId: b.runId, ...completion });
    expect(await notices(t)).toEqual([]);
    expect((await as(t, "a").query(api.advocates.list, { eventId })).situation).toBe("awaiting_advocates");
    // A's last run succeeded, but its source responsibility is stale: a human can request a fresh attempt.
    await as(t, "a").mutation(api.advocates.rerun, { eventId });
    expect(await jobs(t, "agents/advocate:start")).not.toHaveLength(0);
  });

  it.each(["A", "B"] as const)("uses only the active %s Advocate for confirmed debris", async side => {
    const t = backend(), eventId = await insertEvent(t, advocateEvent);
    const policy = side === "A" ? policyA : policyB;
    const { companyId } = await t.mutation(internal.operators.provision, {
      key: "debris", name: "Active operator", simulated: true, objectIds: [policy.objectId],
      members: [{ tokenIdentifier: "debris-operator", role: "operator", assignedObjectIds: [policy.objectId] }],
    });
    await t.run(async ctx => {
      await ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: [side] });
      await ctx.db.insert("policies", { companyId, revision: 1, satellites: [{ ...policy, currentFuelKg: policy.minFuelReserveKg }], updatedAt: FIXTURE_NOW });
    });
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, start: false,
      candidates: advocateCandidates.filter(c => c.kind === "wait" || c.movingSide === side) });
    await room(t, eventId);
    await assess(t, eventId, side);
    expect(await notices(t)).toHaveLength(1);
    expect((await messages(t))[0].originalText).toContain("Operator Advocate found no acceptable option");
    expect(await logs(t, "no_mutually_acceptable_option")).toHaveLength(1);
    expect(await jobs(t, "agents/advocate:start")).toEqual([]);
  });
});
