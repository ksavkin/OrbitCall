import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { internal } from "../convex/_generated/api";
import { backend, insertEvent } from "./helpers";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { closeRunAssistant } from "../convex/lib/backboard";
import { roomNameOf } from "../convex/call/core";

vi.mock("../convex/lib/backboard", async original => ({
  ...await original<typeof import("../convex/lib/backboard")>(), closeRunAssistant: vi.fn(),
}));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("DEMO_LAUNCH", "on");
  vi.stubEnv("LIVEKIT_URL", "wss://voice.example.test/");
  vi.stubEnv("LIVEKIT_API_KEY", "test-key");
  vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.mocked(closeRunAssistant).mockReset().mockResolvedValue({ closed: true });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const reset = ref<"mutation">("demoReset:reset");
const cleanup = ref<"action">("demoReset:cleanup");
const mark = ref<"mutation">("demoReset:markCleanup");

async function setup() {
  const t = backend();
  const eventId = await insertEvent(t);
  const otherEvent = await insertEvent(t, { ...redEvent, objectA: { ...redEvent.objectA, objectId: "SIM-0099" } });
  await t.mutation(internal.operators.provision, { key: "a", name: "A", simulated: true,
    objectIds: ["SIM-0001", "SIM-0099"], members: [
      { tokenIdentifier: "a", role: "operator", assignedObjectIds: ["SIM-0001"] },
      { tokenIdentifier: "other", role: "operator", assignedObjectIds: ["SIM-0099"] },
      { tokenIdentifier: "head", role: "head_of_ops", assignedObjectIds: [] },
      { tokenIdentifier: "observer", role: "demo_observer", assignedObjectIds: [] },
    ] });
  const data = await t.run(async ctx => {
    const user = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", "a")).unique())!;
    const otherUser = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", "other")).unique())!;
    const run = await ctx.db.insert("demoRuns", { scenario: "demo", state: "open", startedBy: user._id,
      manifest: { provider: "preserved" }, startedAt: Date.now(), closedAt: null });
    const other = await ctx.db.insert("demoRuns", { scenario: "other", state: "open", startedBy: otherUser._id,
      manifest: null, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(eventId, { demoRunId: run, status: "communication" });
    await ctx.db.patch(otherEvent, { demoRunId: other, status: "communication" });
    const room = await ctx.db.insert("rooms", { state: "open", companyIds: [user.companyId], demoRunId: run,
      simulated: true, createdAt: Date.now(), closedAt: null });
    const otherRoom = await ctx.db.insert("rooms", { state: "open", companyIds: [user.companyId], demoRunId: other,
      simulated: true, createdAt: Date.now(), closedAt: null });
    await ctx.db.insert("roomMembers", { roomId: room, userId: user._id, companyId: user.companyId,
      inRoom: true, inCall: true, updatedAt: Date.now() });
    await ctx.db.insert("memoryAssistants", { demoRunId: run, companyId: user.companyId, assistantId: "this-run", createdAt: Date.now(), closedAt: null });
    await ctx.db.insert("memoryAssistants", { demoRunId: other, companyId: user.companyId, assistantId: "other-run", createdAt: Date.now(), closedAt: null });
    return { run, other, room, otherRoom, user, otherUser };
  });
  return { t, eventId, otherEvent, ...data, as: (id = "a") => t.withIdentity({ tokenIdentifier: id, subject: id }) };
}

const finish = (t: ReturnType<typeof backend>) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe("demo reset", () => {
  it("closes only the caller's run and memory, preserving catalog, snapshots and history", async () => {
    const { t, as, run, other, room, otherRoom, eventId, otherEvent } = await setup();
    const readUnchanged = () => t.run(async ctx => ({ snapshots: await ctx.db.query("snapshots").collect(),
      objects: await ctx.db.query("spaceObjects").collect(), otherEvent: await ctx.db.get(otherEvent), otherRoom: await ctx.db.get(otherRoom) }));
    const before = await readUnchanged();
    const result = await as().mutation(reset, {});
    expect(result.closedRunId).toBe(run);
    await finish(t);
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ state: "closed", manifest: {
      provider: "preserved", memoryCleanupState: "complete", voiceCleanupState: "complete",
    } });
    expect(await t.run(ctx => ctx.db.get(other))).toMatchObject({ state: "open" });
    expect(await t.run(ctx => ctx.db.get(room))).toMatchObject({ state: "closed" });
    expect(await t.run(ctx => ctx.db.get(eventId))).toMatchObject({ active: false });
    expect(await readUnchanged()).toEqual(before);
    expect(closeRunAssistant).toHaveBeenCalledExactlyOnceWith("this-run");
    expect(await t.run(ctx => ctx.db.query("log").collect())).toHaveLength(1);
    const second = await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(second.assignmentVersion).toBe(result.assignmentVersion);
    expect(closeRunAssistant).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await t.run(ctx => ctx.db.query("log").collect())).toHaveLength(1);
  });

  it("rejects anonymous users, read-only roles, other operators and disabled demos", async () => {
    const { t, as, run } = await setup();
    await expect(t.mutation(reset, { demoRunId: run })).rejects.toThrow();
    for (const id of ["other", "head", "observer"]) await expect(as(id).mutation(reset, { demoRunId: run })).rejects.toThrow();
    vi.stubEnv("DEMO_LAUNCH", "off");
    await expect(as().mutation(reset, { demoRunId: run })).rejects.toThrow("disabled");
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ state: "open" });
  });

  it("finds the caller's run even behind more than 100 unrelated open runs", async () => {
    const { t, as, run } = await setup();
    await t.run(async ctx => {
      for (let n = 0; n < 110; n++) await ctx.db.insert("demoRuns", { scenario: "unrelated", state: "open",
        startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
    });
    expect((await as().mutation(reset, {})).closedRunId).toBe(run);
    await finish(t);
    expect((await as().mutation(reset, {})).closedRunId).toBe(null);
  });

  it("retires current approvals, selections and work while retaining historical approvals and committed artifacts", async () => {
    const { t, as, run, other, eventId, otherEvent, user, room } = await setup();
    const ids = await t.run(async ctx => {
      const proposalId = await ctx.db.insert("proposals", { eventId, candidateId: "P1", label: "Plan", latestRevision: 1, demoRunId: run, createdAt: Date.now() });
      const selection = await ctx.db.insert("selections", { eventId, proposalId, revision: 1, generation: 5,
        by: { kind: "human", userId: user._id }, at: Date.now(), lastReset: null });
      const common = { eventId, side: "A" as const, status: "approved" as const, userId: user._id, companyId: user.companyId,
        proposalId, revision: 1, selectionGeneration: 5, approvalRuleVersion: 1, trajectoryPlanId: null, trajectoryPlanVersion: null,
        reason: null, demoRunId: run, at: Date.now() };
      const approval = await ctx.db.insert("approvals", { ...common, current: true });
      const oldApproval = await ctx.db.insert("approvals", { ...common, selectionGeneration: 4, current: false });
      const otherApproval = await ctx.db.insert("approvals", { ...common, eventId: otherEvent, demoRunId: other, current: true });
      const agent = await ctx.db.insert("agentRuns", { eventId, inputKey: "old", status: "running", stage: "loading", lastProgressAt: Date.now(), stalled: false });
      const set = await ctx.db.insert("candidateSets", { eventId, companyAId: user.companyId, companyBId: null, version: 1,
        evidenceKey: "evidence", candidateRevisionIds: [], state: "open", reviewRequired: false });
      const host = await ctx.db.insert("hostRuns", { roomId: room, trigger: "final_message", inputVersion: "old", attempt: 1,
        status: "running", span: null, output: null, check: null, demoRunId: run, createdAt: Date.now(), finishedAt: null });
      const artifact = { refs: [{ eventId, proposalId, revision: 1, selectionGeneration: 5 }], trajectoryPlanId: null, trajectoryPlanVersion: null,
        pinned: { snapshotId: "gp-test", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] }, intentKey: "test",
        filePath: "runs/old/schedule.json", diff: "old diff", commitSha: "old-commit", writtenBy: "backend" as const,
        rescreenJobId: null, rescreen: null, error: null, reviewRequired: false, demoRunId: run, updatedAt: Date.now() };
      const committed = await ctx.db.insert("maneuvers", { ...artifact, status: "committed" });
      const pending = await ctx.db.insert("maneuvers", { ...artifact, intentKey: "pending", status: "rescreening", commitSha: null });
      const observation = await ctx.db.insert("observationExports", { observationKey: "test", eventId, demoRunId: run, observedAtMs: Date.now(),
        source: "simulated", metric: "pc", value: 0.1, evidenceVersion: "one", simulated: true, exportState: "pending", attempts: 0, lastError: null, updatedAt: Date.now() });
      return { selection, approval, oldApproval, otherApproval, agent, set, host, committed, pending, observation };
    });
    const old = await t.run(ctx => ctx.db.get(ids.oldApproval));
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(ctx => ctx.db.get(ids.selection))).toMatchObject({ proposalId: null, revision: null, generation: 6, lastReset: { reason: "Demo run closed" } });
    expect(await t.run(ctx => ctx.db.get(ids.approval))).toMatchObject({ current: false, status: "approved" });
    expect(await t.run(ctx => ctx.db.get(ids.oldApproval))).toEqual(old);
    expect(await t.run(ctx => ctx.db.get(ids.otherApproval))).toMatchObject({ current: true });
    expect(await t.run(ctx => ctx.db.get(ids.agent))).toMatchObject({ status: "superseded", stalled: false });
    expect(await t.run(ctx => ctx.db.get(ids.host))).toMatchObject({ status: "superseded" });
    expect(await t.run(ctx => ctx.db.get(ids.set))).toMatchObject({ state: "closed" });
    expect(await t.run(ctx => ctx.db.get(ids.committed))).toMatchObject({ status: "committed", filePath: "runs/old/schedule.json", diff: "old diff", commitSha: "old-commit", reviewRequired: true });
    expect(await t.run(ctx => ctx.db.get(ids.pending))).toMatchObject({ status: "failed", error: "Demo run closed" });
    expect(await t.run(ctx => ctx.db.get(ids.observation))).toMatchObject({ exportState: "failed" });
    await finish(t);
  });

  it("cancels only pending jobs explicitly scoped to the old run", async () => {
    const { t, as, run, other, eventId } = await setup();
    const jobs = await t.run(async ctx => {
      const agent = await ctx.db.insert("agentRuns", { eventId, inputKey: "old", status: "running", lastProgressAt: Date.now(), stalled: false });
      return {
        watchdog: await ctx.scheduler.runAfter(60_000, internal.agentRuns.watchdog, { runId: agent }),
        oldCleanup: await ctx.scheduler.runAfter(60_000, cleanup, { demoRunId: run }),
        unrelated: await ctx.scheduler.runAfter(60_000, mark, { demoRunId: other, memory: false, voice: false }),
      };
    });
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(ctx => ctx.db.system.get(jobs.watchdog))).toMatchObject({ state: { kind: "canceled" } });
    expect(await t.run(ctx => ctx.db.system.get(jobs.oldCleanup))).toMatchObject({ state: { kind: "canceled" } });
    expect(await t.run(ctx => ctx.db.system.get(jobs.unrelated))).toMatchObject({ state: { kind: "pending" } });
    await finish(t);
  });

  it("fails pending scans and clears old inbox attention without changing completed or unrelated scans", async () => {
    const { t, as, run, other, eventId, user } = await setup();
    const ids = await t.run(async ctx => {
      const scan = { requestedBy: user._id, requestId: "old", assignmentVersion: 1, primaryObjectIds: ["SIM-0001"], snapshotId: "gp-test",
        fromMs: Date.now(), toMs: Date.now() + 1000, status: "running" as const, phase: "screening" as const, progress: 0.5,
        counts: { primaryObjects: 1, catalogObjects: 100, primariesCompleted: 0, pairsChecked: 50, eventsFound: 1 },
        coverage: { complete: false, catalogScope: "test", excludedObjects: 0, reasons: [], missingPrimaryIds: [] },
        jobId: "remote-old", startedAt: Date.now(), finishedAt: null, error: null, demoRunId: run, updatedAt: Date.now() };
      const pending = await ctx.db.insert("scanRuns", scan);
      const completed = await ctx.db.insert("scanRuns", { ...scan, requestId: "completed", status: "completed", phase: "done" });
      const unrelated = await ctx.db.insert("scanRuns", { ...scan, requestId: "other", demoRunId: other });
      const inbox = await ctx.db.insert("inbox", { userId: user._id, eventId, unread: true, lastUpdateAt: Date.now(),
        lastUpdateSummary: "Retained notification", demoRunId: run, simulated: true });
      const poll = await ctx.scheduler.runAfter(60_000, ref<"action">("scans:poll"), { scanId: pending });
      return { pending, completed, unrelated, inbox, poll };
    });
    const unchanged = await t.run(async ctx => [await ctx.db.get(ids.completed), await ctx.db.get(ids.unrelated)]);
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(ctx => ctx.db.get(ids.pending))).toMatchObject({ status: "failed", phase: "failed", error: { code: "DEMO_RUN_CLOSED" } });
    expect(await t.run(async ctx => [await ctx.db.get(ids.completed), await ctx.db.get(ids.unrelated)])).toEqual(unchanged);
    expect(await t.run(ctx => ctx.db.get(ids.inbox))).toMatchObject({ unread: false, lastUpdateSummary: "Retained notification" });
    expect(await t.run(ctx => ctx.db.system.get(ids.poll))).toMatchObject({ state: { kind: "canceled" } });
    await finish(t);
  });

  it("rolls back the entire reset rather than silently skipping pending jobs beyond the atomic limit", async () => {
    const { t, as, run, other, eventId, room } = await setup();
    await t.run(async ctx => {
      for (let n = 0; n < 2001; n++) await ctx.scheduler.runAfter(60_000, mark, { demoRunId: other, memory: false, voice: false });
    });
    await expect(as().mutation(reset, { demoRunId: run })).rejects.toThrow("atomic demo reset");
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ state: "open", closedAt: null });
    expect(await t.run(ctx => ctx.db.get(room))).toMatchObject({ state: "open" });
    expect(await t.run(ctx => ctx.db.get(eventId))).toMatchObject({ active: true });
    expect(await t.run(ctx => ctx.db.query("log").collect())).toEqual([]);
    expect(closeRunAssistant).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes old call authorization and presence, keeps captions and disconnects only the run's LiveKit room", async () => {
    const { t, as, run, room, otherRoom, user } = await setup();
    const ids = await t.run(async ctx => {
      const member = { subject: "a", userId: String(user._id), companyId: String(user.companyId), name: "A", lang: "en" as const, role: "operator" as const, simulated: true };
      await ctx.db.insert("call_members", { ...member, roomId: String(room) });
      const otherMember = await ctx.db.insert("call_members", { ...member, roomId: String(otherRoom) });
      const presence = await ctx.db.insert("call_presence", { roomId: String(room), userId: String(user._id), inRoom: true, inCall: true, updatedAt: new Date().toISOString() });
      const phrase = await ctx.db.insert("call_phrases", { roomId: String(room), eventId: null, segId: "old", rev: 1,
        speaker: { userId: String(user._id), companyId: String(user.companyId), name: "A", identity: "user-a" },
        originalLang: "en", original: "Previous discussion", translations: {}, values: [], translationStatus: {}, errors: {},
        startedAtMs: Date.now(), simulated: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return { otherMember, presence, phrase };
    });
    const phrase = await t.run(ctx => ctx.db.get(ids.phrase));
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(await t.run(ctx => ctx.db.query("call_members").withIndex("by_room", q => q.eq("roomId", String(room))).collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.get(ids.otherMember))).not.toBeNull();
    expect(await t.run(ctx => ctx.db.get(ids.presence))).toMatchObject({ inRoom: false, inCall: false });
    expect(await t.run(ctx => ctx.db.get(ids.phrase))).toEqual(phrase);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://voice.example.test/twirp/livekit.RoomService/DeleteRoom");
    expect(JSON.parse(request!.body as string)).toEqual({ room: roomNameOf(String(room)) });
    expect(request!.method).toBe("POST");
    const token = (request!.headers as Record<string, string>).authorization.split(" ")[1];
    const payload = JSON.parse(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")));
    expect(payload).toMatchObject({ iss: "test-key", video: { roomCreate: true } });
    expect(payload.exp - payload.nbf).toBe(65);
  });

  it("keeps reset effective through provider failures, retries only incomplete cleanup and sanitizes errors", async () => {
    const { t, as, run } = await setup();
    vi.mocked(closeRunAssistant).mockRejectedValue(new Error("private-provider-error"));
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    const failed = await t.run(ctx => ctx.db.get(run));
    expect(failed).toMatchObject({ state: "closed", manifest: { memoryCleanupState: "failed", voiceCleanupState: "complete" } });
    expect(JSON.stringify(failed)).not.toContain("private-provider-error");
    vi.mocked(closeRunAssistant).mockResolvedValue({ closed: true });
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ manifest: { memoryCleanupState: "complete", voiceCleanupState: "complete" } });
    expect(closeRunAssistant).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable voice cleanup and retries it, treating an absent remote room as success", async () => {
    const { t, as, run } = await setup();
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ manifest: { voiceCleanupState: "failed", memoryCleanupState: "complete" } });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
    fetchMock.mockResolvedValue(new Response("provider-private-error", { status: 503 }));
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ manifest: { voiceCleanupState: "failed" } });
    fetchMock.mockResolvedValue(new Response("absent", { status: 404 }));
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ manifest: { voiceCleanupState: "complete" } });
    expect(closeRunAssistant).toHaveBeenCalledTimes(1);
  });

  it("never regresses completed cleanup when concurrent attempts finish out of order", async () => {
    const { t, as, run, other } = await setup();
    await as().mutation(reset, { demoRunId: run });
    await finish(t);
    await t.mutation(mark, { demoRunId: run, memory: false, voice: false });
    expect(await t.run(ctx => ctx.db.get(run))).toMatchObject({ manifest: { memoryCleanupState: "complete", voiceCleanupState: "complete" } });
    const calls = fetchMock.mock.calls.length;
    await t.action(cleanup, { demoRunId: other });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(await t.run(ctx => ctx.db.get(other))).toMatchObject({ state: "open", manifest: null });
  });

  it("retires SIM assignments, restores explicitly replaced owned slots and advances assignmentVersion once", async () => {
    const { t, as, run, user } = await setup();
    await t.run(async ctx => {
      await ctx.db.insert("satelliteOwners", { objectId: "10001", companyId: user.companyId });
      await ctx.db.insert("fleetAssignments", { objectId: "10001", userId: user._id, active: false });
      await ctx.db.patch(run, { manifest: { "launch:one": JSON.stringify({ state: "completed", objectId: "SIM-0001", userId: user._id,
        companyId: user.companyId, input: { replaceObjectId: "10001" } }) } });
    });
    const result = await as().mutation(reset, { demoRunId: run });
    const active = () => t.run(async ctx => (await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect()).filter(a => a.active).map(a => a.objectId));
    expect(await active()).toEqual(["10001"]);
    expect(result.assignmentVersion).toBe((user.assignmentVersion ?? 1) + 1);
    await finish(t);
    expect((await as().mutation(reset, { demoRunId: run })).assignmentVersion).toBe(result.assignmentVersion);
  });

  it("restores the original slot through successive SIM replacements without reactivating a closed SIM", async () => {
    const { t, as, run, user } = await setup();
    const secondEvent = await insertEvent(t, { ...redEvent, objectA: { ...redEvent.objectA, objectId: "SIM-0002" } });
    await t.run(async ctx => {
      await ctx.db.patch(secondEvent, { demoRunId: run });
      const assignment = (await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", "SIM-0001")).unique())!;
      await ctx.db.patch(assignment._id, { active: false });
      await ctx.db.insert("fleetAssignments", { objectId: "SIM-0002", userId: user._id, active: true });
      await ctx.db.insert("fleetAssignments", { objectId: "10001", userId: user._id, active: false });
      await ctx.db.insert("satelliteOwners", { objectId: "10001", companyId: user.companyId });
      const record = (objectId: string, replaceObjectId: string) => JSON.stringify({ state: "completed", objectId, userId: user._id, companyId: user.companyId, input: { replaceObjectId } });
      await ctx.db.patch(run, { manifest: { "launch:one": record("SIM-0001", "10001"), "launch:two": record("SIM-0002", "SIM-0001") } });
    });
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(async ctx => (await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect()).filter(a => a.active).map(a => a.objectId))).toEqual(["10001"]);
    await finish(t);
  });

  it("preserves assignments still used by a different open run", async () => {
    const { t, as, run, other, user } = await setup();
    const shared = await insertEvent(t, { ...redEvent, tcaUtc: "2026-10-26T03:14:07Z" });
    await t.run(ctx => ctx.db.patch(shared, { demoRunId: other }));
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(ctx => ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", "SIM-0001")).unique())).toMatchObject({ active: true });
    await finish(t);
  });

  it("does not restore a replaced slot transferred to another company and tolerates malformed legacy receipts", async () => {
    const { t, as, run, user } = await setup();
    await t.run(async ctx => {
      const companyId = await ctx.db.insert("companies", { key: "foreign", name: "Foreign", simulated: true });
      await ctx.db.insert("satelliteOwners", { objectId: "10001", companyId });
      await ctx.db.insert("fleetAssignments", { objectId: "10001", userId: user._id, active: false });
      await ctx.db.patch(run, { manifest: { "launch:bad": "not json", "launch:one": JSON.stringify({ state: "completed", objectId: "SIM-0001",
        userId: user._id, companyId: user.companyId, input: { replaceObjectId: "10001" } }) } });
    });
    await as().mutation(reset, { demoRunId: run });
    expect(await t.run(async ctx => (await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect()).filter(a => a.active))).toEqual([]);
    await finish(t);
  });
});
