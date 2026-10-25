import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { backend, insertEvent, type Backend } from "./helpers";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";
import { POLL_LIMIT } from "../convex/summary";
import { inputKey } from "../convex/lib/analyst";
import { loadFacts, putFixture } from "../convex/lib/events";
import type { RescreenRequest } from "../convex/lib/orbitClient";

const as = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${name}` });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ORBIT_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function setup(options: { wait?: boolean; demo?: boolean; debris?: boolean } = {}) {
  const t = backend(); const eventId = await insertEvent(t, advocateEvent);
  const ids = await t.run(async ctx => {
    const a = await ctx.db.insert("companies", { key: "a", name: "A", simulated: true });
    const b = await ctx.db.insert("companies", { key: "b", name: "B", simulated: true });
    const users = {} as Record<string, Id<"users">>;
    for (const [name, companyId, role] of [["a", a, "operator"], ["b", b, "operator"], ["unassigned", a, "operator"],
      ["head", a, "head_of_ops"], ["observer", a, "demo_observer"]] as const) {
      users[name] = await ctx.db.insert("users", { tokenIdentifier: `https://fixture.invalid|${name}`, companyId, role, assignmentVersion: 1 });
    }
    const assignments = {} as Record<string, Id<"fleetAssignments">>;
    const policies = {} as Record<string, Id<"policies">>;
    const owners = {} as Record<string, Id<"satelliteOwners">>;
    for (const [side, companyId, objectId, policy] of [["A", a, "SIM-1001", policyA], ["B", b, "SIM-1002", policyB]] as const) {
      if (options.debris && side === "B") continue;
      owners[side] = await ctx.db.insert("satelliteOwners", { objectId, companyId });
      assignments[side] = await ctx.db.insert("fleetAssignments", { objectId, userId: users[side.toLowerCase()], active: true });
      policies[side] = await ctx.db.insert("policies", { companyId, revision: 1, satellites: [policy], updatedAt: FIXTURE_NOW - 1000 });
    }
    const demoRunId = options.demo ? await ctx.db.insert("demoRuns", {
      scenario: "summary-test", state: "open", startedBy: users.a, startedAt: FIXTURE_NOW, closedAt: null, manifest: null,
    }) : null;
    await ctx.db.patch(eventId, { status: "proposal", workflow: options.debris ? "unilateral_debris" : "bilateral",
      requiredApprovalSides: options.debris ? ["A"] : ["A", "B"], approvalRuleVersion: 1, ...(demoRunId ? { demoRunId } : {}) });
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: options.debris ? [a] : [a, b],
      demoRunId, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
    await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: FIXTURE_NOW });
    return { a, b, users, assignments, policies, owners, demoRunId, roomId };
  });
  const cards = advocateCandidates.filter(card => !options.debris || card.movingSide !== "B");
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: cards, start: false });
  const card = options.wait ? cards.find(c => c.kind === "wait")! : cards[0];
  const proposal = await t.run(ctx => ctx.db.query("proposals").withIndex("by_event_candidate", q =>
    q.eq("eventId", eventId).eq("candidateId", card.candidateId)).unique());
  await as(t, "a").mutation(api.proposals.select, { eventId, proposalId: proposal!._id, revision: card.revision, expectedGeneration: 0 });
  const selection = await t.run(ctx => ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique());
  return { t, eventId, proposalId: proposal!._id, card, selectionId: selection!._id, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const editArgs = (s: Setup, changes = { deltaVMs: 0.75 }) => ({ eventId: s.eventId, proposalId: s.proposalId,
  baseRevision: s.card.revision, expectedGeneration: 1, changes });
async function jobs(s: Setup) {
  return s.t.run(async ctx => (await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", s.eventId)).collect())
    .filter(row => row.after?.type === "summary_edit_v1" && row.after.state === "requested"));
}
async function approveA(s: Setup) {
  await s.t.run(ctx => ctx.db.insert("approvals", { eventId: s.eventId, side: "A", status: "approved",
    userId: s.users.a, companyId: s.a, proposalId: s.proposalId, revision: s.card.revision, selectionGeneration: 1,
    approvalRuleVersion: 1, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null,
    demoRunId: s.demoRunId, current: true, at: FIXTURE_NOW + 10, assignmentVersion: 1 }));
}
async function artifact(s: Setup, status: "preview" | "rescreening" | "committing" | "committed" | "failed", reserved = false) {
  return s.t.run(async ctx => {
    const maneuverId = await ctx.db.insert("maneuvers", { refs: [{ eventId: s.eventId, proposalId: s.proposalId,
      revision: s.card.revision, selectionGeneration: 1 }], trajectoryPlanId: null, trajectoryPlanVersion: null,
      pinned: { snapshotId: "fixture:test", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] },
      intentKey: "fixture-intent", status, filePath: "operators/fixture/schedule.json", diff: "checked old diff",
      commitSha: status === "committed" ? "a".repeat(40) : null, writtenBy: "droid", rescreenJobId: null,
      rescreen: reserved ? { snapshotId: "fixture:test", evidenceKeys: [], passed: true, objectsChecked: 10,
        horizonH: 72, originalMissAfterKm: 2, newConjunctions: [], refusalReason: null } : null,
      error: null, reviewRequired: false, demoRunId: s.demoRunId, updatedAt: FIXTURE_NOW });
    await ctx.db.insert("maneuverEvents", { eventId: s.eventId, maneuverId }); return maneuverId;
  });
}
function orbit(options: { resultPatch?: Record<string, unknown>; running?: boolean; beforeGet?: () => Promise<void>; reject?: boolean } = {}) {
  let request: RescreenRequest;
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (options.reject) throw new Error("secret-worker-token");
    if (init?.method === "POST") {
      request = JSON.parse(String(init.body));
      return json({ jobId: request.jobId, status: "queued", created: true, statusUrl: `/jobs/${request.jobId}` }, 202);
    }
    await options.beforeGet?.();
    return json({ jobId: request.jobId, kind: "rescreen", status: options.running ? "running" : "completed",
      phase: options.running ? "screening" : "done", progress: options.running ? null : 1, counters: {}, coverage: null,
      requestHash: "test-hash", createdAt: new Date(FIXTURE_NOW).toISOString(), startedAt: new Date(FIXTURE_NOW).toISOString(),
      finishedAt: options.running ? null : new Date(FIXTURE_NOW).toISOString(), resultRef: null, error: null,
      result: options.running ? null : { snapshotId: request.snapshotId, evidenceVersion: request.evidenceVersion,
        passed: true, objectsChecked: 20, objectsInCatalog: 100, horizonH: 72, originalMissAfterKm: 2.25,
        newConjunctions: [], refusalReason: null, simulated: true, method: "fixture orbit", limitations: ["Indicative"],
        fromUtc: request.fromUtc, toUtc: request.toUtc, screenedFromUtc: request.fromUtc, screenedToUtc: request.toUtc,
        proposalId: request.proposalId, revision: request.revision, ...(request.runId ? { runId: request.runId } : {}),
        ...options.resultPatch } });
  });
  vi.stubGlobal("fetch", fetch); return { fetch, request: () => request! };
}
async function runJob(s: Setup) {
  const row = (await jobs(s)).at(-1)!;
  await s.t.action(internal.summary.submit, { jobId: row._id });
  await s.t.action(internal.summary.poll, { jobId: row._id, attempt: 0 });
  return row;
}

describe("current summary form and requested Host output", () => {
  it("derives numbers from the current selection, and heads read without acting", async () => {
    const s = await setup();
    const form = await as(s.t, "a").query(api.summary.get, { eventId: s.eventId });
    expect(form).toMatchObject({ selectionGeneration: 1, canEdit: true, form: { proposalId: s.proposalId,
      revision: 1, movingSide: "A", deltaVMs: s.card.deltaVMs, burnTimeUtc: s.card.burnTimeUtc, note: "" } });
    expect((await as(s.t, "head").query(api.summary.get, { eventId: s.eventId })).canEdit).toBe(false);
    expect((await as(s.t, "b").query(api.summary.get, { eventId: s.eventId })).canEdit).toBe(false);
    expect(JSON.stringify(form)).not.toMatch(/PRIVATE_|currentFuelKg|acceptablePc|policyRevisions/);
    await s.t.run(ctx => ctx.db.patch(s.selectionId, { proposalId: null, revision: null, generation: 2 }));
    expect(await as(s.t, "a").query(api.summary.get, { eventId: s.eventId })).toMatchObject({ form: null, selectionGeneration: 2 });
  });

  it("requests one deduplicated Host run without approving anything and enforces decision turns", async () => {
    const s = await setup();
    await as(s.t, "a").mutation(api.summary.request, { roomId: s.roomId });
    await as(s.t, "a").mutation(api.summary.request, { roomId: s.roomId });
    const runs = await s.t.run(ctx => ctx.db.query("hostRuns").collect());
    expect(runs).toHaveLength(1); expect(runs[0].trigger).toBe("summary_requested");
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    await expect(as(s.t, "b").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    await approveA(s);
    await expect(as(s.t, "a").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    await as(s.t, "b").mutation(api.summary.request, { roomId: s.roomId });
    await s.t.run(ctx => ctx.db.patch(s.roomId, { state: "closed", closedAt: Date.now() }));
    await expect(as(s.t, "b").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
  });

  it("rejects unassigned, observer and revoked-owner access", async () => {
    const s = await setup();
    for (const who of ["unassigned", "observer"]) {
      await expect(as(s.t, who).query(api.summary.get, { eventId: s.eventId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
      await expect(as(s.t, who).mutation(api.summary.edit, editArgs(s))).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    }
    await expect(as(s.t, "head").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await s.t.run(ctx => ctx.db.patch(s.owners.A, { companyId: s.b }));
    await expect(as(s.t, "a").mutation(api.summary.edit, editArgs(s))).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(as(s.t, "a").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  it("allows the deciding dispatcher to request a summary when an unrelated pair has another turn", async () => {
    const s = await setup();
    const otherId = await s.t.run(async ctx => {
      const company = await ctx.db.insert("companies", { key: "c", name: "C", simulated: true });
      await ctx.db.insert("satelliteOwners", { companyId: company, objectId: "SIM-3003" });
      const eventId = await putFixture(ctx, "fixture:test", { ...advocateEvent,
        objectB: { ...advocateEvent.objectB, objectId: "SIM-3003" } }, "red");
      await ctx.db.patch(eventId, { workflow: "bilateral", requiredApprovalSides: ["A", "B"], approvalRuleVersion: 1 });
      await ctx.db.patch(s.roomId, { companyIds: [s.a, s.b, company] });
      await ctx.db.insert("roomEvents", { eventId, roomId: s.roomId, linkedAt: FIXTURE_NOW });
      return eventId;
    });
    await s.t.mutation(internal.candidates.publish, { eventId: otherId, baseVersion: null, start: false,
      candidates: advocateCandidates.map(card => card.movingSide === "B" ? { ...card, movingObjectId: "SIM-3003" } : card) });
    const proposal = await s.t.run(ctx => ctx.db.query("proposals").withIndex("by_event_candidate", q =>
      q.eq("eventId", otherId).eq("candidateId", s.card.candidateId)).unique());
    await as(s.t, "a").mutation(api.proposals.select, { eventId: otherId, proposalId: proposal!._id, revision: 1, expectedGeneration: 0 });
    await expect(as(s.t, "b").mutation(api.summary.request, { roomId: s.roomId })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    await approveA(s);
    await as(s.t, "b").mutation(api.summary.request, { roomId: s.roomId });
    expect(await s.t.run(ctx => ctx.db.query("hostRuns").collect())).toHaveLength(1);
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect()))).toHaveLength(1);
  });
});

describe("summary edits through numerical rescreen and canonical publication", () => {
  it("publishes one new revision, resets old approvals permanently and queues fresh Advocate and publication follow-ups", async () => {
    const s = await setup(); await approveA(s); const worker = orbit();
    await artifact(s, "preview");
    const args = { ...editArgs(s), changes: { deltaVMs: 0.75, note: "Discuss after the imaging pass." } };
    await as(s.t, "b").mutation(api.summary.edit, args);
    await as(s.t, "b").mutation(api.summary.edit, args);
    expect(await jobs(s)).toHaveLength(1);
    const job = await runJob(s);
    expect(worker.request()).toMatchObject({ snapshotId: "fixture:test", proposalId: s.proposalId, revision: 2,
      maneuver: { deltaVMs: 0.75, burnTimeUtc: s.card.burnTimeUtc, direction: s.card.direction }, fromUtc: s.card.burnTimeUtc });
    const view = await as(s.t, "a").query(api.summary.get, { eventId: s.eventId });
    expect(view).toMatchObject({ selectionGeneration: 2, canEdit: true, form: { revision: 2, deltaVMs: 0.75,
      note: "Discuss after the imaging pass." }, edit: { state: "completed" } });
    const revisions = await s.t.run(ctx => ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", s.proposalId)).collect());
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null });
    const candidate = await s.t.run(ctx => ctx.db.get(revisions[1].candidateRevisionId));
    expect(candidate).toMatchObject({ revision: 2, deltaVMs: 0.75, missAfterKm: 2.25, estimatedFuelKg: null });
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect())).every(row => !row.current)).toBe(true);
    const oldCandidate = await s.t.run(ctx => ctx.db.get(revisions[0].candidateRevisionId));
    expect(oldCandidate?.deltaVMs).toBe(s.card.deltaVMs);
    const scheduled = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter(row => row.name === "agents/advocate:negotiate")).toHaveLength(1);
    expect(scheduled.filter(row => row.name === "advocates:publicationFollowups")).toHaveLength(1);
    await as(s.t, "b").mutation(api.summary.edit, args); // repeat receipt even after the revision advanced
    await s.t.action(internal.summary.poll, { jobId: job._id, attempt: 0 });
    expect(worker.fetch).toHaveBeenCalledTimes(2);
    expect(await jobs(s)).toHaveLength(1);
  });

  it("keeps unedited alternatives unchanged", async () => {
    const s = await setup(); orbit();
    const before = await s.t.run(ctx => ctx.db.query("candidateRevisions").withIndex("by_event_candidate_revision", q => q.eq("eventId", s.eventId)).collect());
    await as(s.t, "a").mutation(api.summary.edit, editArgs(s)); await runJob(s);
    for (const candidate of before) expect(await s.t.run(ctx => ctx.db.get(candidate._id))).toEqual(candidate);
    const set = await s.t.run(ctx => ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", s.eventId)).unique());
    expect(set?.candidateRevisionIds).toHaveLength(4);
  });

  it("recomputes the new mover, direction and time and deduplicates equivalent field order", async () => {
    const s = await setup(); const worker = orbit();
    const burnTimeUtc = new Date(Date.parse(s.card.burnTimeUtc!) + 60_000).toISOString().replace(".000Z", "Z");
    await as(s.t, "a").mutation(api.summary.edit, { ...editArgs(s), changes: { movingSide: "B", direction: "retrograde", burnTimeUtc, deltaVMs: 0.7 } });
    await as(s.t, "a").mutation(api.summary.edit, { ...editArgs(s), changes: { deltaVMs: 0.7, burnTimeUtc, direction: "retrograde", movingSide: "B" } });
    expect(await jobs(s)).toHaveLength(1);
    await runJob(s);
    expect(worker.request()).toMatchObject({ objectId: "SIM-1002", partnerObjectId: "SIM-1001",
      maneuver: { burnTimeUtc, direction: "retrograde", deltaVMs: 0.7 } });
    expect((await as(s.t, "a").query(api.summary.get, { eventId: s.eventId })).form).toMatchObject({ revision: 2,
      movingSide: "B", direction: "retrograde", burnTimeUtc, deltaVMs: 0.7 });
  });

  it("edits a wait note without inventing a burn or numerical call", async () => {
    const s = await setup({ wait: true }); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await as(s.t, "a").mutation(api.summary.edit, { ...editArgs(s), changes: { note: "Wait for new tracking data." } });
    await s.t.action(internal.summary.submit, { jobId: (await jobs(s))[0]._id });
    expect(fetch).not.toHaveBeenCalled();
    expect((await as(s.t, "a").query(api.summary.get, { eventId: s.eventId })).form).toMatchObject({ revision: 2,
      movingSide: null, burnTimeUtc: null, deltaVMs: null, direction: null, note: "Wait for new tracking data." });
  });

  it("allows the active debris side only and never offers movement by debris", async () => {
    const s = await setup({ debris: true }); orbit();
    await expect(as(s.t, "a").mutation(api.summary.edit, { ...editArgs(s), changes: { movingSide: "B" } })).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    await as(s.t, "a").mutation(api.summary.edit, editArgs(s)); await runJob(s);
    expect((await as(s.t, "a").query(api.summary.get, { eventId: s.eventId })).form?.revision).toBe(2);
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  });

  it.each(["revision", "generation", "off-turn", "invalid-date", "unsupported-delta-v", "empty", "same"])("rejects %s edits before scheduling", async problem => {
    const s = await setup(); const args = editArgs(s);
    let who = "a";
    if (problem === "revision") args.baseRevision = 2;
    if (problem === "generation") args.expectedGeneration = 2;
    if (problem === "off-turn") who = "b";
    const changes = problem === "invalid-date" ? { burnTimeUtc: "2026-02-30T22:00:00Z" }
      : problem === "unsupported-delta-v" ? { deltaVMs: 1.01 }
      : problem === "empty" ? {} : problem === "same" ? { deltaVMs: s.card.deltaVMs } : args.changes;
    await expect(as(s.t, who).mutation(api.summary.edit, { ...args, changes })).rejects.toThrow();
    expect(await jobs(s)).toEqual([]);
  });

  it.each(["rescreening", "committing", "committed", "failed"] as const)("refuses edits around a %s reserved artifact", async status => {
    const s = await setup(); const id = await artifact(s, status, status === "failed");
    const before = await s.t.run(ctx => ctx.db.get(id));
    await expect(as(s.t, "a").mutation(api.summary.edit, editArgs(s))).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
    expect(await s.t.run(ctx => ctx.db.get(id))).toEqual(before);
  });

  it.each(["evidence", "policy", "assignment", "assignment-revoked", "selection", "closed-run", "approved", "reserved", "burn-time"])("discards a remote result after %s changes", async reason => {
    const s = await setup({ demo: true });
    orbit({ beforeGet: async () => {
      if (reason === "evidence") await s.t.run(ctx => ctx.db.patch(s.eventId, { missKm: 0.3 }));
      if (reason === "policy") await s.t.run(ctx => ctx.db.patch(s.policies.B, { revision: 2 }));
      if (reason === "assignment") await s.t.run(ctx => ctx.db.patch(s.users.a, { assignmentVersion: 2 }));
      if (reason === "assignment-revoked") await s.t.run(ctx => ctx.db.patch(s.assignments.A, { active: false }));
      if (reason === "selection") await s.t.run(ctx => ctx.db.patch(s.selectionId, { generation: 2 }));
      if (reason === "closed-run") await s.t.run(ctx => ctx.db.patch(s.demoRunId!, { state: "closed", closedAt: Date.now() }));
      if (reason === "approved") await s.t.run(ctx => ctx.db.patch(s.eventId, { status: "approved" }));
      if (reason === "reserved") await artifact(s, "committing");
      if (reason === "burn-time") vi.setSystemTime(Date.parse(s.card.burnTimeUtc!) + 1_000);
    } });
    await as(s.t, "a").mutation(api.summary.edit, editArgs(s)); await runJob(s);
    expect((await s.t.run(ctx => ctx.db.get(s.proposalId)))?.latestRevision).toBe(1);
    const rows = await s.t.run(ctx => ctx.db.query("log").collect());
    expect(rows.some(row => row.after?.type === "summary_edit_v1" && row.after.state === "failed")).toBe(true);
    expect(await s.t.run(ctx => ctx.db.query("maneuvers").collect())).toHaveLength(reason === "reserved" ? 1 : 0);
  });

  it("fails closed for another encounter affected by the mover, including when changing away from that mover", async () => {
    const s = await setup();
    await s.t.run(ctx => putFixture(ctx, "fixture:test", { ...advocateEvent,
      objectB: { ...advocateEvent.objectB, objectId: "SIM-9999" }, tcaUtc: "2026-10-25T05:00:00Z" }, "red"));
    await expect(as(s.t, "a").mutation(api.summary.edit, editArgs(s))).rejects.toMatchObject({ data: { code: "SHARED_TRAJECTORY_REQUIRED" } });
    await expect(as(s.t, "a").mutation(api.summary.edit, { ...editArgs(s), changes: { movingSide: "B" } })).rejects.toMatchObject({ data: { code: "SHARED_TRAJECTORY_REQUIRED" } });
  });

  it.each(["refused", "wrong-revision", "wrong-horizon", "missing-echo"])("does not publish a %s rescreen result", async reason => {
    const s = await setup(); await approveA(s);
    orbit({ resultPatch: reason === "refused" ? { passed: false, originalMissAfterKm: 0.2, refusalReason: "New risk." }
      : reason === "wrong-revision" ? { revision: 99 } : reason === "wrong-horizon" ? { horizonH: 24 } : { proposalId: undefined } });
    await as(s.t, "b").mutation(api.summary.edit, editArgs(s)); await runJob(s);
    expect((await s.t.run(ctx => ctx.db.get(s.proposalId)))?.latestRevision).toBe(1);
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect()))[0].current).toBe(true);
    expect((await as(s.t, "b").query(api.summary.get, { eventId: s.eventId })).edit?.state).toBe("failed");
  });

  it("records sanitized failure and permits only three explicit attempts for the same edit", async () => {
    const s = await setup(); const worker = orbit({ reject: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      await as(s.t, "a").mutation(api.summary.edit, editArgs(s));
      await s.t.action(internal.summary.submit, { jobId: (await jobs(s)).at(-1)!._id });
    }
    await expect(as(s.t, "a").mutation(api.summary.edit, editArgs(s))).rejects.toThrow("attempt limit");
    expect(worker.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await s.t.run(ctx => ctx.db.query("log").collect()))).not.toContain("secret-worker-token");
  });

  it("bounds polling and a watchdog timeout fences late completion", async () => {
    const s = await setup(); orbit({ running: true });
    await as(s.t, "a").mutation(api.summary.edit, editArgs(s));
    const job = (await jobs(s))[0];
    await s.t.action(internal.summary.submit, { jobId: job._id });
    await s.t.action(internal.summary.poll, { jobId: job._id, attempt: POLL_LIMIT - 1 });
    expect((await as(s.t, "a").query(api.summary.get, { eventId: s.eventId })).edit?.errorCode).toBe("RESCREEN_TIMEOUT");
    await s.t.mutation(internal.summary.finish, { jobId: job._id, result: null });
    expect((await s.t.run(ctx => ctx.db.get(s.proposalId)))?.latestRevision).toBe(1);
  });
});
