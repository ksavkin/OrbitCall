import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { callClaude } from "../convex/lib/claude";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";

vi.mock("../convex/lib/claude", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/claude")>(), callClaude: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key"); vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.mocked(callClaude).mockReset().mockImplementation(async prompt => {
    const data = JSON.parse(prompt.user);
    const raw = data.slots ? JSON.stringify({ lines: data.slots.map((s: { kind: string; templates: string[] }) => ({ kind: s.kind, template: s.templates[0] })) })
      : JSON.stringify({ preferredCandidateId: data.eligibleCandidateIds.includes("P2") ? "P2" : data.eligibleCandidateIds[0] ?? null });
    return { raw, model: "test-model", usage: { inputTokens: 100, outputTokens: 20 } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const identity = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${name}` });
async function setup() {
  const t = backend(); const eventId = await insertEvent(t, advocateEvent);
  const { companyId: companyAId } = await t.mutation(internal.operators.provision, {
    key: "fixture-a", name: "A", simulated: true, objectIds: [policyA.objectId], members: [
      { tokenIdentifier: "https://fixture.invalid|a", role: "operator", assignedObjectIds: [policyA.objectId] },
      { tokenIdentifier: "https://fixture.invalid|unassigned", role: "operator", assignedObjectIds: [] },
      { tokenIdentifier: "https://fixture.invalid|head", role: "head_of_ops", assignedObjectIds: [policyA.objectId] },
    ],
  });
  const { companyId: companyBId } = await t.mutation(internal.operators.provision, {
    key: "fixture-b", name: "B", simulated: true, objectIds: [policyB.objectId], members: [
      { tokenIdentifier: "https://fixture.invalid|b", role: "operator", assignedObjectIds: [policyB.objectId] },
    ],
  });
  await identity(t, "a").mutation(api.policies.update, { satellites: [policyA] });
  await identity(t, "b").mutation(api.policies.update, { satellites: [policyB] });
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates });
  return { t, eventId, companyAId, companyBId };
}
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe("Operator Advocate v1", () => {
  it("seeds an opt-in synthetic fixture without model calls and preserves later policy edits", async () => {
    const t = backend();
    await expect(t.action(internal.dev.seedAdvocates, {})).rejects.toThrow("FEATURE_DISABLED");
    vi.stubEnv("ENABLE_DEV_FIXTURES", "true");
    const first = await t.action(internal.dev.seedAdvocates, {});
    const second = await t.action(internal.dev.seedAdvocates, {});
    expect(second.eventId).toBe(first.eventId); expect(callClaude).not.toHaveBeenCalled();
    expect(await t.run(ctx => ctx.db.query("candidateRevisions").collect())).toHaveLength(4);
    const a = t.withIdentity({ tokenIdentifier: "https://orbitcall-fixtures.invalid|operator-a" });
    await a.mutation(api.policies.update, { satellites: [{ ...policyA, currentFuelKg: 7.7 }] });
    await t.action(internal.dev.seedAdvocates, {});
    expect((await a.query(api.policies.getMine, {})).satellites[0].currentFuelKg).toBe(7.7);
  });

  it("does not invent a counterpart or turn an unregistered active operator into debris", async () => {
    const t = backend(); const eventId = await insertEvent(t, advocateEvent);
    await t.mutation(internal.operators.provision, { key: "only-a", name: "A", simulated: true, objectIds: [policyA.objectId], members: [] });
    await expect(t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates })).rejects.toThrow("INVALID_STATE");
    expect(await t.run(ctx => ctx.db.query("companies").collect())).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.query("candidateSets").collect())).toHaveLength(0);
  });

  it("shows sanitized configuration failures and leaves unchecked assessments unpublished", async () => {
    const { t, eventId } = await setup();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await finish(t);
    const shared = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(shared.runs.A?.errorCode).toBe("MODEL_NOT_CONFIGURED");
    expect(shared.runs.B?.status).toBe("failed");
    expect(shared.agentsWorking).toBe(false);
    expect(shared.assessments.A).toEqual([]);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("runs separate agents, sends A's checked outcomes to B, and stores provisional recommendations", async () => {
    const { t, eventId } = await setup(); await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(2);
    const a = JSON.parse(vi.mocked(callClaude).mock.calls[0][0].user);
    const b = JSON.parse(vi.mocked(callClaude).mock.calls[1][0].user);
    expect(a.ownPolicy.objectId).toBe(policyA.objectId);
    expect(b.ownPolicy.objectId).toBe(policyB.objectId);
    expect(b.counterpart.find((x: { candidateId: string }) => x.candidateId === "P2").recommended).toBe(true);
    expect(JSON.stringify(b)).not.toContain("PRIVATE_A");
    expect(JSON.stringify(b)).not.toContain("7.625");
    expect(JSON.stringify(a)).not.toContain(String(policyB.dryMassKg));
    const shared = await identity(t, "b").query(api.advocates.list, { eventId });
    expect(shared.situation).toBe("needs_more_data");
    expect(shared.reviewCandidates).toEqual(["P2"]);
    expect(shared.mutuallyAcceptable).toEqual([]);
    expect(shared.assessments.A[1]).toMatchObject({ recommended: true, outcome: "pending" });
    expect(shared.agentsWorking).toBe(false); expect(shared.simulated).toBe(true);
    expect(JSON.stringify(shared)).not.toContain("PRIVATE_A");
    expect(JSON.stringify(shared)).not.toContain("7.625");
    const runs = await t.run(ctx => ctx.db.query("agentRuns").collect());
    expect(JSON.stringify(runs)).not.toContain("PRIVATE_A");
    expect(JSON.stringify(runs)).not.toContain("7.625");
  });

  it("keeps policies private and rejects anonymous, head-of-ops and foreign writes", async () => {
    const { t } = await setup();
    await expect(t.query(api.policies.getMine, {})).rejects.toThrow("UNAUTHENTICATED");
    await expect(identity(t, "head").query(api.policies.getMine, {})).rejects.toThrow("FORBIDDEN");
    await expect(identity(t, "unknown").mutation(api.policies.update, { satellites: [] })).rejects.toThrow("FORBIDDEN");
    await expect(identity(t, "a").mutation(api.policies.update, { satellites: [policyB] })).rejects.toThrow("FORBIDDEN");
    expect((await identity(t, "a").query(api.policies.getMine, {})).satellites).toEqual([policyA]);
    expect((await identity(t, "b").query(api.policies.getMine, {})).satellites).toEqual([policyB]);
  });

  it("requires a current fleet assignment for negotiation reads and retries", async () => {
    const { t, eventId } = await setup();
    await expect(t.query(api.advocates.list, { eventId })).rejects.toThrow("UNAUTHENTICATED");
    await expect(identity(t, "unassigned").query(api.advocates.list, { eventId })).rejects.toThrow("FORBIDDEN");
    await expect(identity(t, "unassigned").mutation(api.advocates.rerun, { eventId })).rejects.toThrow("FORBIDDEN");
    await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", "https://fixture.invalid|a")).unique();
      const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user!._id)).first();
      await ctx.db.patch(assignment!._id, { active: false });
    });
    await expect(identity(t, "a").query(api.advocates.list, { eventId })).rejects.toThrow("FORBIDDEN");
  });

  it("deduplicates starts per company without suppressing the other side", async () => {
    const { t, eventId } = await setup();
    const claims = await Promise.all([t.mutation(internal.advocates.begin, { eventId, side: "A" }), t.mutation(internal.advocates.begin, { eventId, side: "A" }), t.mutation(internal.advocates.begin, { eventId, side: "B" })]);
    expect(claims.filter(Boolean)).toHaveLength(2);
  });

  it("rejects a model's private prose or hard-limit violation without publishing it", async () => {
    const { t, eventId } = await setup();
    vi.mocked(callClaude).mockResolvedValueOnce({ raw: '{"preferredCandidateId":"P1","reason":"PRIVATE_A_IMAGING_WINDOW"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
    await finish(t);
    let shared = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(shared.assessments.A).toEqual([]);
    expect(JSON.stringify(shared)).not.toContain("PRIVATE_A");
    await identity(t, "a").mutation(api.advocates.rerun, { eventId }); await finish(t);
    shared = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(shared.assessments.A).toHaveLength(4);
    expect((await t.run(ctx => ctx.db.query("negotiationMessages").collect())).filter(m => m.kind === "assessment")).toHaveLength(3);
  });

  it("refreshes B's recommendation when A recovers with a previously missing hard constraint", async () => {
    const { t, eventId } = await setup();
    vi.mocked(callClaude)
      .mockRejectedValueOnce(new Error("Temporary model failure"))
      .mockResolvedValueOnce({ raw: '{"preferredCandidateId":"P1"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
    await finish(t);
    const before = await identity(t, "b").query(api.advocates.list, { eventId });
    expect(before.assessments.A).toEqual([]);
    expect(before.assessments.B[0].recommended).toBe(true);

    await identity(t, "a").mutation(api.advocates.rerun, { eventId });
    await finish(t);
    const after = await identity(t, "b").query(api.advocates.list, { eventId });
    expect(after.assessments.A[0].outcome).toBe("infeasible");
    expect(after.assessments.B[0].recommended).toBe(false);
    expect(after.assessments.B[1].recommended).toBe(true);
    expect(after.messages.filter(m => m.current)).toHaveLength(2);
    expect(callClaude).toHaveBeenCalledTimes(4);
  });

  it("supersedes an in-flight B result when A publishes new shared outcomes", async () => {
    const { t, eventId } = await setup();
    const b = await t.mutation(internal.advocates.begin, { eventId, side: "B" });
    const a = await t.mutation(internal.advocates.begin, { eventId, side: "A" });
    const result = { raw: '{"preferredCandidateId":"P2"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } };
    await t.mutation(internal.advocates.finish, { runId: a!.runId, ...result });
    expect((await t.mutation(internal.advocates.finish, { runId: b!.runId, ...result })).published).toBe(false);
    await finish(t);
    const shared = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(shared.assessments.B[1].recommended).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed B response for an explicit retry instead of calling it twice", async () => {
    const { t, eventId } = await setup();
    vi.mocked(callClaude).mockImplementation(async prompt => {
      if (JSON.parse(prompt.user).side === "B") throw new Error("Temporary model failure");
      return { raw: '{"preferredCandidateId":"P2"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(2);
    expect((await identity(t, "b").query(api.advocates.list, { eventId })).runs.B?.status).toBe("failed");
    vi.mocked(callClaude).mockResolvedValue({ raw: '{"preferredCandidateId":"P2"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
    await identity(t, "b").mutation(api.advocates.rerun, { eventId });
    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(3);
    expect((await identity(t, "b").query(api.advocates.list, { eventId })).assessments.B[1].recommended).toBe(true);
  });

  it("rechecks hard limits inside publication even when the action check is bypassed", async () => {
    const { t, eventId } = await setup();
    const claimed = await t.mutation(internal.advocates.begin, { eventId, side: "A" });
    await expect(t.mutation(internal.advocates.finish, { runId: claimed!.runId, raw: '{"preferredCandidateId":"P1"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } })).rejects.toThrow();
    expect((await identity(t, "a").query(api.advocates.list, { eventId })).assessments.A).toEqual([]);
  });

  it("reruns both sides after a policy edit and shares only the changed category", async () => {
    const { t, eventId } = await setup(); await finish(t);
    await identity(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, currentFuelKg: 7.7 }] });
    expect((await identity(t, "b").query(api.advocates.list, { eventId })).assessments.A).toEqual([]);
    await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(4);
    const shared = await identity(t, "b").query(api.advocates.list, { eventId });
    expect(shared.situation).toBe("no_mutually_acceptable_option");
    expect(shared.messages.find(m => m.kind === "policy_changed")?.categories).toEqual(["fuel"]);
    expect(JSON.stringify(shared)).not.toContain("7.7");
  });

  it("does not rerun an unchanged policy", async () => {
    const { t } = await setup(); await finish(t);
    await identity(t, "a").mutation(api.policies.update, { satellites: [policyA] }); await finish(t);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("shows zero supplied candidates explicitly without manufacturing options or calling Claude", async () => {
    const { t, eventId } = await setup();
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: [] });
    await finish(t);
    const result = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(result.situation).toBe("no_candidates"); expect(result.mutuallyAcceptable).toEqual([]);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("prevents old results from publishing after policy, candidate or orbital changes", async () => {
    for (const change of ["policy", "candidate", "evidence"] as const) {
      const { t, eventId } = await setup();
      const old = await t.mutation(internal.advocates.begin, { eventId, side: "A" });
      if (change === "policy") await identity(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, currentFuelKg: 7.7 }] });
      if (change === "candidate") await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates.map(c => c.candidateId === "P2" ? { ...c, revision: 2, deltaVMs: 0.4 } : c) });
      if (change === "evidence") await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.5 }));
      const result = await t.mutation(internal.advocates.finish, { runId: old!.runId, raw: '{"preferredCandidateId":"P2"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
      expect(result.published).toBe(false);
    }
  });

  it("makes revisions immutable and refuses stale writers or revision rollback", async () => {
    const { t, eventId } = await setup();
    await expect(t.mutation(internal.candidates.publish, { eventId, baseVersion: 0, candidates: advocateCandidates })).rejects.toThrow("STALE_REVISION");
    await expect(t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates.map(c => c.candidateId === "P2" ? { ...c, deltaVMs: 9 } : c) })).rejects.toThrow("STALE_REVISION");
    expect((await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates })).changed).toBe(false);
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates.map(c => c.candidateId === "P2" ? { ...c, revision: 2 } : c) });
    await expect(t.mutation(internal.candidates.publish, { eventId, baseVersion: 2, candidates: advocateCandidates })).rejects.toThrow("STALE_REVISION");
  });

  it("flags scheduled plans for review without rewriting candidates or starting agents", async () => {
    const { t, eventId } = await setup(); await finish(t);
    const before = await t.run(async ctx => {
      const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
      await ctx.db.patch(set!._id, { state: "scheduled" }); return set!;
    });
    await identity(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, acceptablePc: 0.001 }] }); await finish(t);
    const after = await t.run(ctx => ctx.db.get(before._id));
    expect(after?.candidateRevisionIds).toEqual(before.candidateRevisionIds);
    expect(after?.state).toBe("scheduled"); expect(after?.reviewRequired).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(2);
    await expect(t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates })).rejects.toThrow("INVALID_STATE");
  });

  it("allows shared wait feasibility without selecting, approving or scheduling it", async () => {
    const { t, eventId } = await setup();
    await identity(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, acceptablePc: 0.001 }] });
    await identity(t, "b").mutation(api.policies.update, { satellites: [{ ...policyB, acceptablePc: 0.001 }] });
    await finish(t);
    const result = await identity(t, "a").query(api.advocates.list, { eventId });
    expect(result.mutuallyAcceptable).toEqual(["P3"]);
    expect(result.situation).toBe("needs_operator_decision");
    expect(result.state).toBe("open");
  });

  it("keeps Analyst output and role-specific attempts intact when Advocates run", async () => {
    const { t, eventId } = await setup();
    await t.action(internal.agents.analyst.start, { eventId }); await finish(t);
    const summary = await t.query(api.agentSummaries.get, { eventId });
    expect(summary.summaryLines).toHaveLength(5); expect(summary.run?.attempt).toBe(1);
    await t.action(internal.agents.analyst.start, { eventId });
    expect(callClaude).toHaveBeenCalledTimes(3);
  });

  it("flags stalled Advocates and supersedes their result on an authorized retry", async () => {
    const { t, eventId } = await setup();
    const old = await t.mutation(internal.advocates.begin, { eventId, side: "A" });
    await expect(identity(t, "a").mutation(api.advocates.rerun, { eventId })).rejects.toThrow("INVALID_STATE");
    vi.setSystemTime(FIXTURE_NOW + 61_000);
    await t.mutation(internal.agentRuns.watchdog, { runId: old!.runId });
    expect((await identity(t, "a").query(api.advocates.list, { eventId })).agentsStalled).toBe(true);
    await identity(t, "a").mutation(api.advocates.rerun, { eventId }); await finish(t);
    expect((await t.mutation(internal.advocates.finish, { runId: old!.runId, raw: '{"preferredCandidateId":"P2"}', model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } })).published).toBe(false);
  });
});
