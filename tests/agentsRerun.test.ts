import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { backend, insertEvent, type Backend } from "./helpers";
import { as, fn, pick, seed as decisionSeed, tick } from "./decision";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); vi.stubEnv("ANTHROPIC_API_KEY", ""); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function seed(t: Backend) {
  const eventId = await insertEvent(t);
  const ids = await t.run(async ctx => {
    const companyId = await ctx.db.insert("companies", { key: "retry", name: "Retry", simulated: true });
    const userId = await ctx.db.insert("users", { tokenIdentifier: "retry-operator", companyId, role: "operator", name: "Operator", language: "en" });
    await ctx.db.insert("satelliteOwners", { objectId: redEvent.objectA.objectId, companyId });
    const assignmentId = await ctx.db.insert("fleetAssignments", { userId, objectId: redEvent.objectA.objectId, active: true });
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [companyId], demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
    await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: FIXTURE_NOW });
    await ctx.db.insert("roomMembers", { roomId, userId, companyId, inRoom: false, inCall: false, updatedAt: FIXTURE_NOW });
    return { userId, companyId, assignmentId, roomId };
  });
  return { ...ids, eventId, op: t.withIdentity({ tokenIdentifier: "retry-operator" }) };
}
const logs = (t: Backend) => t.run(ctx => ctx.db.query("log").collect());

describe("public bounded agent rerun", () => {
  it("requires sign-in and current ownership/assignment before candidates exist", async () => {
    const t = backend(), r = await seed(t);
    await expect(t.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("UNAUTHENTICATED");
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId });
    expect((await logs(t)).filter(l => l.action === "agents_rerun")).toHaveLength(1);
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("INVALID_STATE");
  });
  it.each(["head_of_ops", "demo_observer", "revoked", "foreign_owner"])("rejects %s without scheduling or logging", async mode => {
    const t = backend(), r = await seed(t);
    await t.run(async ctx => {
      if (mode === "head_of_ops" || mode === "demo_observer") await ctx.db.patch(r.userId, { role: mode });
      if (mode === "revoked") await ctx.db.patch(r.assignmentId, { active: false });
      if (mode === "foreign_owner") await ctx.db.delete((await ctx.db.query("satelliteOwners").first())!._id);
    });
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("FORBIDDEN");
    expect(await logs(t)).toEqual([]);
  });
  it("bounds Analyst retries for the same evidence and permits a new evidence version", async () => {
    const t = backend(), r = await seed(t);
    for (let i = 0; i < 3; i++) {
      await r.op.mutation(api.agents.rerun, { eventId: r.eventId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("RETRY_LIMIT");
    await t.run(ctx => ctx.db.patch(r.eventId, { missKm: 0.25 }));
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId });
    expect((await logs(t)).filter(l => l.action === "agents_rerun")).toHaveLength(4);
  });
  it("does not restart a working or succeeded Analyst on unchanged evidence", async () => {
    const t = backend(), r = await seed(t);
    const run = await t.mutation(internal.agentRuns.begin, { eventId: r.eventId });
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("INVALID_STATE");
    await t.run(ctx => ctx.db.patch(run!.runId, { status: "succeeded", finishedAt: FIXTURE_NOW }));
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("INVALID_STATE");
  });
  it("creates one Host request without changing the decision or approvals", async () => {
    const t = backend(), r = await seed(t);
    const before = await t.run(ctx => ctx.db.get(r.eventId));
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" });
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" })).rejects.toThrow("INVALID_STATE");
    expect(await t.run(ctx => ctx.db.query("hostRuns").collect())).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.get(r.eventId))).toEqual(before);
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    const [log] = await logs(t);
    expect(log.action).toBe("agents_rerun");
    expect(log.actor).toMatchObject({ kind: "human", userId: r.userId });
  });
  it("uses the Host's failed trigger and stops after its bounded retry count", async () => {
    const t = backend(), r = await seed(t);
    const context = await t.query(internal.hostTriggers.context, { roomId: r.roomId, trigger: "candidates_changed" });
    for (let i = 1; i <= 2; i++) await t.run(ctx => ctx.db.insert("hostRuns", { roomId: r.roomId, trigger: "candidates_changed", inputVersion: context!.inputVersion, attempt: i, status: "failed", span: null, output: null, check: null, demoRunId: null, createdAt: FIXTURE_NOW + i, finishedAt: FIXTURE_NOW + i }));
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" });
    await t.run(async ctx => {
      const rows = await ctx.db.query("hostRuns").collect();
      expect(rows.at(-1)!.trigger).toBe("candidates_changed");
      await ctx.db.patch(rows.at(-1)!._id, { status: "failed", finishedAt: FIXTURE_NOW });
    });
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" })).rejects.toThrow("RETRY_LIMIT");
  });
  it("rejects expired incidents and closed rooms", async () => {
    const t = backend(), r = await seed(t);
    await t.run(ctx => ctx.db.patch(r.roomId, { state: "closed", closedAt: FIXTURE_NOW }));
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" })).rejects.toThrow("INVALID_STATE");
    await t.run(ctx => ctx.db.patch(r.eventId, { active: false }));
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("INVALID_STATE");
  });
  it("refuses a reset demonstration without changing its history", async () => {
    const t = backend(), r = await seed(t);
    await t.run(async ctx => {
      const demoRunId = await ctx.db.insert("demoRuns", { scenario: "closed", state: "closed", startedBy: r.userId, manifest: null, startedAt: FIXTURE_NOW, closedAt: FIXTURE_NOW });
      await ctx.db.patch(r.eventId, { demoRunId });
    });
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId })).rejects.toThrow("INVALID_STATE");
    await expect(r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" })).rejects.toThrow("INVALID_STATE");
    expect(await logs(t)).toEqual([]);
  });
  it("never revives retired signatures or moves the selected revision", async () => {
    const { t, eventId } = await decisionSeed();
    await pick(t, "a", eventId, "P2");
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await pick(t, "b", eventId, "P4");
    const before = await t.run(async ctx => ({ approvals: await ctx.db.query("approvals").collect(), selections: await ctx.db.query("selections").collect() }));
    expect(before.approvals[0].current).toBe(false);
    await as(t, "a").mutation(api.agents.rerun, { eventId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async ctx => ({ approvals: await ctx.db.query("approvals").collect(), selections: await ctx.db.query("selections").collect() }))).toEqual(before);
    expect(JSON.stringify((await logs(t)).filter(l => l.action === "agents_rerun"))).not.toContain("protectedWindows");
  });
  it("replaces a lost Host run without allowing its late output to succeed", async () => {
    const t = backend(), r = await seed(t);
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" });
    const first = await t.run(ctx => ctx.db.query("hostRuns").first());
    vi.setSystemTime(first!.createdAt + 10 * 60_000 + 1);
    await r.op.mutation(api.agents.rerun, { eventId: r.eventId, role: "coordination_host" });
    expect((await t.run(ctx => ctx.db.get(first!._id)))!.status).toBe("failed");
    await t.mutation(internal.hostTriggers.finish, { hostRunId: first!._id, span: null, output: null, check: null });
    expect((await t.run(ctx => ctx.db.get(first!._id)))!.status).toBe("failed");
  });
});
