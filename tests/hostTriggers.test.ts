import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { putFixture } from "../convex/lib/events";
import { MAX_EVENTS, MAX_MESSAGES, validateHostContext, type HostContext, type HostOutput } from "../convex/lib/host";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { advocateCandidates, policyA } from "../fixtures/policies";
import { backend, type Backend } from "./helpers";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/test-gemini:generateContent";
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const LANGS = ["en", "ru", "zh"] as const;
const token = (name: string) => `https://fixture.invalid|${name}`;
const as = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: token(name) });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("GEMINI_API_KEY", "test-only-not-a-key"); vi.stubEnv("GEMINI_HOST_MODEL", "test-gemini");
  vi.stubEnv("XAI_API_KEY", "test-only-not-a-key"); vi.stubEnv("XAI_CHECKER_MODEL", "test-grok");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Distinct pair events whose TCAs run backwards in insertion order, so the context has to sort them.
const eventFacts = (k: number, count: number) => ({
  ...redEvent,
  objectA: { ...redEvent.objectA, objectId: `SIM-${2000 + k}` },
  objectB: { ...redEvent.objectA, objectId: `SIM-${3000 + k}` },
  tcaUtc: new Date(FIXTURE_NOW + (count - k) * 3_600_000).toISOString().replace(".000Z", "Z"),
});

interface Room { roomId: Id<"rooms">; companyIds: Id<"companies">[]; userIds: Id<"users">[]; eventIds: Id<"events">[] }

async function seedRoom(t: Backend, { companies = 2, events = 1 } = {}): Promise<Room> {
  return t.run(async ctx => {
    const companyIds: Id<"companies">[] = []; const userIds: Id<"users">[] = [];
    for (let i = 0; i < companies; i++) {
      const companyId = await ctx.db.insert("companies", { key: `co-${i}`, name: `Company ${i}`, simulated: true, language: LANGS[i % 3] });
      companyIds.push(companyId);
      userIds.push(await ctx.db.insert("users", { tokenIdentifier: token(`u${i}`), companyId, role: "operator", name: `User ${i}`, language: LANGS[i % 3] }));
    }
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds, demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
    const eventIds: Id<"events">[] = [];
    for (let k = 0; k < events; k++) {
      const eventId = await putFixture(ctx, "fixture:test", eventFacts(k, events), "red");
      eventIds.push(eventId);
      await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: FIXTURE_NOW });
    }
    for (const [i, userId] of userIds.entries()) {
      await ctx.db.insert("roomMembers", { roomId, userId, companyId: companyIds[i], inRoom: true, inCall: false, updatedAt: FIXTURE_NOW });
    }
    return { roomId, companyIds, userIds, eventIds };
  });
}

// Candidate revisions and the event's current set, as candidates.publish stores them.
async function publishSet(t: Backend, eventId: Id<"events">, companyAId: Id<"companies">, companyBId: Id<"companies">, ids = ["P1", "P3"]) {
  return t.run(async ctx => {
    const candidateRevisionIds: Id<"candidateRevisions">[] = [];
    for (const c of advocateCandidates.filter(c => ids.includes(c.candidateId))) {
      candidateRevisionIds.push(await ctx.db.insert("candidateRevisions", { eventId, ...c, assumptions: [...c.assumptions] }));
    }
    await ctx.db.insert("candidateSets", { eventId, companyAId, companyBId, version: 1, evidenceKey: "fixture", candidateRevisionIds, state: "open", reviewRequired: false });
    return candidateRevisionIds;
  });
}

type Author = Doc<"messages">["author"];
const human = (room: Room, i: number): Author => ({ kind: "human", userId: room.userIds[i], companyId: room.companyIds[i], name: `User ${i}` });
const hostAuthor: Author = { kind: "agent", role: "coordination_host", companyId: null };
async function say(t: Backend, roomId: Id<"rooms">, author: Author, text: string, minute: number, lang: "en" | "ru" | "zh" = "en") {
  return t.run(ctx => ctx.db.insert("messages", {
    roomId, eventId: null, author, kind: "text", originalText: text, originalLang: lang,
    translations: {}, translationStatus: {}, values: [], refs: {}, form: null, demoRunId: null, simulated: true,
    createdAt: FIXTURE_NOW + minute * 60_000,
  }));
}

const context = (t: Backend, roomId: Id<"rooms">, trigger: HostContext["trigger"] = "final_message") =>
  t.query(internal.hostTriggers.context, { roomId, trigger }) as Promise<HostContext>;
const request = (t: Backend, roomId: Id<"rooms">, trigger: HostContext["trigger"] = "final_message", inputVersion?: string) =>
  t.mutation(internal.hostTriggers.request, { roomId, trigger, ...(inputVersion === undefined ? {} : { inputVersion }) });
const runs = (t: Backend) => t.run(ctx => ctx.db.query("hostRuns").collect());
const scheduledRuns = (t: Backend) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter(f => f.name === "hostTriggers:run"));
const execute = (t: Backend, hostRunId: Id<"hostRuns">) => t.action(internal.hostTriggers.run, { hostRunId });

// A grounded host answer: one summary and one requested revision for the most urgent event.
const grounded = (c: HostContext): HostOutput => ({
  inputVersion: c.inputVersion, clarifications: [],
  requestedRevisions: c.events[0].candidates.length ? [{
    eventId: c.events[0].eventId, candidateId: c.events[0].candidates[0].candidateId,
    reason: "A participant asked to reconsider this option.", messageIds: [c.messages[0].messageId],
  }] : [],
  summaries: [{ eventId: c.events[0].eventId, text: "The operators are still discussing this encounter.", messageIds: [c.messages[0].messageId] }],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiResponse = (text: string) => json({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 140, totalTokenCount: 952 }, modelVersion: "test-gemini",
});
const grokResponse = (result: unknown) => json({
  model: "test-grok", choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
});
const agreement = { agrees: true, reason: "The summary matches the candidate facts.", flaggedCandidateIds: [] };

function stubProviders({ host = grounded, hostStatus, onHost }: {
  host?: (c: HostContext) => unknown; hostStatus?: number; onHost?: () => Promise<unknown>;
} = {}) {
  const calls = { host: [] as HostContext[], check: [] as { inputVersion: string; candidates: { candidateId: string }[]; explanation: string }[] };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) === GEMINI_URL) {
      const sent = JSON.parse(body.contents[0].parts[0].text) as HostContext;
      calls.host.push(sent);
      await onHost?.();
      if (hostStatus) return json({ error: { code: hostStatus, message: "secret diagnostic", status: "UNAVAILABLE" } }, hostStatus);
      return geminiResponse(JSON.stringify(host(sent)));
    }
    if (String(url) === XAI_URL) {
      calls.check.push(JSON.parse(body.messages[1].content));
      return grokResponse(agreement);
    }
    throw new Error(`Unexpected fetch to ${String(url)}`);
  }));
  return calls;
}

describe("Coordination Host context", () => {
  it("includes every linked event of a three-company room, most urgent first", async () => {
    const t = backend();
    const room = await seedRoom(t, { companies: 3, events: 3 });
    for (let i = 0; i < 3; i++) await say(t, room.roomId, human(room, i), `Message from company ${i}.`, i, LANGS[i]);
    const c = await context(t, room.roomId);
    expect(c.members).toEqual(room.companyIds.map((companyId, i) => ({ companyId, language: LANGS[i] }))
      .sort((a, b) => a.companyId < b.companyId ? -1 : 1));
    expect(c.events.map(e => e.eventId)).toEqual([...room.eventIds].reverse());
    expect(c.events.map(e => e.objectAId)).toEqual(["SIM-2002", "SIM-2001", "SIM-2000"]);
    expect(c.events.map(e => Date.parse(e.tcaUtc))).toEqual([...c.events.map(e => Date.parse(e.tcaUtc))].sort((a, b) => a - b));
    expect(c.messages.map(m => [m.companyId, m.language])).toEqual(room.companyIds.map((id, i) => [id, LANGS[i]]));
    expect(c.roomId).toBe(room.roomId);
    expect(c.trigger).toBe("final_message");
    expect(c.inputVersion).toMatch(/^host-v1:[0-9a-f]{32}$/);
    expect(() => validateHostContext(c)).not.toThrow();
  });

  it("sends original text only from people and advocates, never the host's own or system lines", async () => {
    const t = backend();
    const room = await seedRoom(t);
    const own = await say(t, room.roomId, human(room, 0), "Можем сдвинуть манёвр?", 0, "ru");
    await t.run(ctx => ctx.db.patch(own, { translations: { en: "Can we move the maneuver?" }, translationStatus: { en: "ok" } }));
    const advocate = await say(t, room.roomId, { kind: "agent", role: "operator_advocate", companyId: room.companyIds[1] }, "Company 1 prefers waiting.", 1);
    const before = await context(t, room.roomId);
    await say(t, room.roomId, hostAuthor, "Summary from the host.", 2);
    await say(t, room.roomId, { kind: "agent", role: "coordination_host", companyId: room.companyIds[0] }, "Host line for one company.", 3);
    await say(t, room.roomId, { kind: "system" }, "Both approvals reset.", 4);
    const after = await context(t, room.roomId);
    expect(after.messages).toEqual([
      { messageId: own, companyId: room.companyIds[0], language: "ru", text: "Можем сдвинуть манёвр?", createdAt: "2026-10-24T12:00:00Z" },
      { messageId: advocate, companyId: room.companyIds[1], language: "en", text: "Company 1 prefers waiting.", createdAt: "2026-10-24T12:01:00Z" },
    ]);
    // Its own lines never change the input version, so the host cannot trigger itself.
    expect(after.inputVersion).toBe(before.inputVersion);
  });

  it("keeps only the latest MAX_MESSAGES messages, oldest first", async () => {
    const t = backend();
    const room = await seedRoom(t);
    for (let i = 0; i < MAX_MESSAGES + 3; i++) await say(t, room.roomId, human(room, i % 2), `Line ${i}`, i);
    const c = await context(t, room.roomId);
    expect(c.messages).toHaveLength(MAX_MESSAGES);
    expect(c.messages[0].text).toBe("Line 3");
    expect(c.messages.at(-1)!.text).toBe(`Line ${MAX_MESSAGES + 2}`);
  });

  it("sends current candidates, shareable feasibility and recorded approvals, and no policy", async () => {
    const t = backend();
    const room = await seedRoom(t, { events: 2 });
    const [later, sooner] = room.eventIds;
    const [a, b] = room.companyIds;
    const [p1, p3] = await publishSet(t, sooner, a, b);
    // The same candidate IDs in another event stay distinct: the host sees immutable revision IDs.
    const [, laterWait] = await publishSet(t, later, a, b);
    await say(t, room.roomId, human(room, 0), "We prefer the first option.", 0);
    await t.run(async ctx => {
      await ctx.db.insert("policies", { companyId: a, revision: 1, satellites: [policyA], updatedAt: FIXTURE_NOW });
      await ctx.db.insert("negotiationMessages", { eventId: sooner, side: "A", kind: "assessment", categories: ["fuel"], entries: [
        { candidateId: "P1", revision: 1, outcome: "preferred", categories: ["fuel"], recommended: true },
        { candidateId: "P2", revision: 1, outcome: "feasible", categories: [], recommended: false },
      ] });
      await ctx.db.insert("negotiationMessages", { eventId: sooner, side: "B", kind: "assessment", categories: [], entries: [
        { candidateId: "P1", revision: 1, outcome: "infeasible", categories: ["mission_window"], recommended: false },
      ] });
      // B's policy changed after its assessment, so B's outcomes are no longer current.
      await ctx.db.insert("negotiationMessages", { eventId: sooner, side: "B", kind: "policy_changed", categories: [], entries: [] });
      const proposalId = await ctx.db.insert("proposals", { eventId: sooner, candidateId: "P1", label: "P1", latestRevision: 1, demoRunId: null, createdAt: FIXTURE_NOW });
      await ctx.db.insert("proposalRevisions", { proposalId, eventId: sooner, revision: 1, candidateRevisionId: p1, changeSummary: null,
        sourceMessageIds: [], rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null, simulated: true, createdAt: FIXTURE_NOW });
      const approval = { eventId: sooner, userId: room.userIds[0], companyId: a, proposalId, revision: 1, selectionGeneration: 1,
        approvalRuleVersion: 1, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null, demoRunId: null, at: FIXTURE_NOW };
      await ctx.db.insert("approvals", { ...approval, side: "A", status: "approved", current: true });
      await ctx.db.insert("approvals", { ...approval, side: "B", status: "approved", current: false, userId: room.userIds[1], companyId: b });
      await ctx.db.insert("approvals", { ...approval, side: "B", status: "pending", current: true, userId: room.userIds[1], companyId: b });
    });
    const c = await context(t, room.roomId);
    expect(c.events.map(e => e.eventId)).toEqual([sooner, later]);
    expect(c.events[0].candidates.map(x => [x.candidateId, x.label, x.revision])).toEqual([[p1, "P1", 1], [p3, "P3", 1]]);
    expect(c.events[0].candidates[0]).toEqual({ candidateId: p1, revision: 1, label: "P1", kind: "maneuver", movingObjectId: "SIM-1001",
      burnTimeUtc: "2026-10-24T21:14:07Z", deltaVMs: 0.2, missAfterKm: 3.2 });
    expect(c.events[1].candidates.map(x => x.candidateId)).toContain(laterWait);
    expect(c.events[0].feasibility).toEqual([{ companyId: a, candidateId: p1, revision: 1, outcome: "preferred", categories: ["fuel"] }]);
    expect(c.events[0].approvals).toEqual([{ companyId: a, candidateId: p1, revision: 1 }]);
    expect(c.events[1]).toMatchObject({ feasibility: [], approvals: [] });
    expect(() => validateHostContext(c)).not.toThrow();
    const sent = JSON.stringify(c);
    for (const secret of ["PRIVATE_A", "currentFuelKg", "minFuelReserveKg", "8.125", "acceptablePc", "assumptions", "recommended"]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("changes the input version on a new message, a new candidate set, an approval or a new selection", async () => {
    const t = backend();
    const room = await seedRoom(t);
    const [eventId] = room.eventIds;
    await say(t, room.roomId, human(room, 0), "First.", 0);
    const versions = [(await context(t, room.roomId)).inputVersion];
    expect((await context(t, room.roomId, "summary_requested")).inputVersion).toBe(versions[0]);
    await say(t, room.roomId, human(room, 1), "Second.", 1);
    versions.push((await context(t, room.roomId)).inputVersion);
    await publishSet(t, eventId, room.companyIds[0], room.companyIds[1]);
    versions.push((await context(t, room.roomId)).inputVersion);
    await t.run(ctx => ctx.db.insert("selections", { eventId, proposalId: null, revision: null, generation: 1, by: { kind: "agents" }, at: FIXTURE_NOW, lastReset: null }));
    versions.push((await context(t, room.roomId)).inputVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("Coordination Host trigger", () => {
  it("dedupes one room, input version and trigger into one run and one scheduled job", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const first = await request(t, room.roomId);
    expect(await request(t, room.roomId)).toBe(first);
    expect(await runs(t)).toHaveLength(1);
    expect(await scheduledRuns(t)).toHaveLength(1);
    expect((await scheduledRuns(t))[0].args[0]).toEqual({ hostRunId: first });
    expect((await runs(t))[0]).toMatchObject({ roomId: room.roomId, trigger: "final_message", attempt: 1, status: "running",
      inputVersion: (await context(t, room.roomId)).inputVersion, span: null, output: null, check: null, demoRunId: null, finishedAt: null });
    // Another trigger on the same inputs is its own run.
    expect(await request(t, room.roomId, "summary_requested")).not.toBe(first);
    expect(await runs(t)).toHaveLength(2);
  });

  it("starts a new run when a new message changes the input version", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const first = await request(t, room.roomId);
    await say(t, room.roomId, human(room, 1), "We are checking.", 1);
    const second = await request(t, room.roomId);
    expect(second).not.toBe(first);
    const [a, b] = await runs(t);
    expect(a.inputVersion).not.toBe(b.inputVersion);
    expect(b.attempt).toBe(1);
  });

  it("does nothing for a caller that saw an older input version", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const { inputVersion } = await context(t, room.roomId);
    await say(t, room.roomId, human(room, 1), "We are checking.", 1);
    expect(await request(t, room.roomId, "final_message", inputVersion)).toBeNull();
    expect(await runs(t)).toHaveLength(0);
    const current = (await context(t, room.roomId)).inputVersion;
    expect(await request(t, room.roomId, "final_message", current)).not.toBeNull();
  });

  it("rejects an unknown room", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await t.run(ctx => ctx.db.delete(room.roomId));
    await expect(request(t, room.roomId)).rejects.toThrow("NOT_FOUND");
  });

  it("stores the checked host output and the Grok check, and never changes proposals", async () => {
    const t = backend();
    const room = await seedRoom(t);
    const [p1] = await publishSet(t, room.eventIds[0], room.companyIds[0], room.companyIds[1]);
    await say(t, room.roomId, human(room, 0), "Can we reconsider the first option?", 0);
    const calls = stubProviders();
    const before = await t.run(async ctx => ({
      sets: await ctx.db.query("candidateSets").collect(), revisions: await ctx.db.query("candidateRevisions").collect(),
      proposals: await ctx.db.query("proposals").collect(),
    }));
    const hostRunId = (await request(t, room.roomId))!;
    await execute(t, hostRunId);
    const row = (await t.run(ctx => ctx.db.get(hostRunId)))!;
    expect(row.status).toBe("succeeded");
    expect(row.finishedAt).not.toBeNull();
    expect(row.span).toMatchObject({ role: "coordination_host", provider: "google", model: "test-gemini", inputVersion: row.inputVersion,
      attempt: 1, status: "succeeded", usage: { inputTokens: 812, outputTokens: 140 } });
    expect(row.output).toEqual(grounded(calls.host[0]));
    expect(row.output!.requestedRevisions[0].candidateId).toBe(p1);
    expect(row.check).toMatchObject({ span: { role: "rationale_check", provider: "xai", model: "test-grok", status: "succeeded", attempt: 1 }, result: agreement });
    expect(calls.check).toHaveLength(1);
    expect(calls.check[0].inputVersion).toBe(row.inputVersion);
    expect(calls.check[0].candidates.map(c => c.candidateId)).toEqual(calls.host[0].events[0].candidates.map(c => c.candidateId));
    expect(calls.check[0].explanation).toContain("The operators are still discussing this encounter.");
    const after = await t.run(async ctx => ({
      sets: await ctx.db.query("candidateSets").collect(), revisions: await ctx.db.query("candidateRevisions").collect(),
      proposals: await ctx.db.query("proposals").collect(),
    }));
    expect(after).toEqual(before);
    // A finished run is not run again.
    await execute(t, hostRunId);
    expect(calls.host).toHaveLength(1);
    expect(await request(t, room.roomId)).toBe(hostRunId);
  });

  it("skips the checker when the host wrote no summary", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Is everyone here?", 0);
    const calls = stubProviders({ host: c => ({ inputVersion: c.inputVersion, clarifications: [
      { question: "Is everyone present?", eventId: null, messageIds: [c.messages[0].messageId] }], requestedRevisions: [], summaries: [] }) });
    const hostRunId = (await request(t, room.roomId))!;
    await execute(t, hostRunId);
    expect(calls.check).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.get(hostRunId))).toMatchObject({ status: "succeeded", check: null });
  });

  it("supersedes a result whose inputs changed while the host was running", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const calls = stubProviders({ onHost: () => say(t, room.roomId, human(room, 1), "Wait, new constraint.", 1) });
    const hostRunId = (await request(t, room.roomId))!;
    await execute(t, hostRunId);
    expect(calls.host).toHaveLength(1);
    const row = (await t.run(ctx => ctx.db.get(hostRunId)))!;
    expect(row.status).toBe("superseded");
    expect(row.output).toBeNull();
    expect(row.span).toMatchObject({ status: "succeeded", provider: "google" });
    expect(row.finishedAt).not.toBeNull();
  });

  it("supersedes a run without calling the host when its inputs changed before it started", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const calls = stubProviders();
    const hostRunId = (await request(t, room.roomId))!;
    await say(t, room.roomId, human(room, 1), "Wait.", 1);
    await execute(t, hostRunId);
    expect(calls.host).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.get(hostRunId))).toMatchObject({ status: "superseded", span: null, output: null });
  });

  it("skips a final message trigger with no shared messages, but not a candidate change", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, hostAuthor, "Host line only.", 0);
    const calls = stubProviders({ host: c => ({ inputVersion: c.inputVersion, clarifications: [], requestedRevisions: [], summaries: [] }) });
    const skipped = (await request(t, room.roomId))!;
    await execute(t, skipped);
    expect(calls.host).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.get(skipped))).toMatchObject({ status: "superseded", span: null });
    const changed = (await request(t, room.roomId, "candidates_changed"))!;
    await execute(t, changed);
    expect(calls.host).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.get(changed))).toMatchObject({ status: "succeeded" });
  });

  it("stores a failed host attempt with a sanitized span and allows bounded retries", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const calls = stubProviders({ hostStatus: 503 });
    const ids: Id<"hostRuns">[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const hostRunId = (await request(t, room.roomId))!;
      expect(ids).not.toContain(hostRunId);
      ids.push(hostRunId);
      await execute(t, hostRunId);
      const row = (await t.run(ctx => ctx.db.get(hostRunId)))!;
      expect(row).toMatchObject({ status: "failed", attempt, output: null, check: null,
        span: { status: "failed", errorCode: "UPSTREAM_UNAVAILABLE", attempt, provider: "google" } });
      expect(JSON.stringify(row)).not.toContain("secret diagnostic");
    }
    expect(calls.check).toHaveLength(0);
    // The attempt bound is reached: the latest failure is returned and nothing new is scheduled.
    expect(await request(t, room.roomId)).toBe(ids[2]);
    expect(await runs(t)).toHaveLength(3);
    expect(await scheduledRuns(t)).toHaveLength(3);
  });

  it("fails a run left running past the timeout and retries it", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    const stuck = (await request(t, room.roomId))!;
    vi.setSystemTime(FIXTURE_NOW + 11 * 60_000);
    const retry = await request(t, room.roomId);
    expect(retry).not.toBe(stuck);
    expect(await t.run(ctx => ctx.db.get(stuck))).toMatchObject({ status: "failed", span: null });
    expect(await t.run(ctx => ctx.db.get(retry!))).toMatchObject({ status: "running", attempt: 2 });
    // The stuck job finishing late cannot overwrite its failed row.
    stubProviders();
    await execute(t, stuck);
    expect(await t.run(ctx => ctx.db.get(stuck))).toMatchObject({ status: "failed", span: null });
  });

  it("sends every event of a room at MAX_EVENTS and fails a larger room visibly without calling the model", async () => {
    const t = backend();
    const room = await seedRoom(t, { companies: 6, events: MAX_EVENTS + 1 });
    await say(t, room.roomId, human(room, 5), "We are all here.", 0);
    const c = await context(t, room.roomId);
    expect(c.events).toHaveLength(MAX_EVENTS + 1);
    expect(c.events.map(e => e.eventId)).toEqual([...room.eventIds].reverse());
    const calls = stubProviders();
    const tooLarge = (await request(t, room.roomId))!;
    await execute(t, tooLarge);
    expect(calls.host).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.get(tooLarge))).toMatchObject({ status: "failed", output: null,
      span: { status: "failed", errorCode: "INVALID_INPUT", errorMessage: "The host context is too large." } });

    await t.run(async ctx => {
      const link = await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", room.eventIds[0])).unique();
      await ctx.db.delete(link!._id);
    });
    const full = (await request(t, room.roomId))!;
    await execute(t, full);
    expect(calls.host).toHaveLength(1);
    expect(calls.host[0].events).toHaveLength(MAX_EVENTS);
    expect(calls.host[0].members).toHaveLength(6);
    expect(await t.run(ctx => ctx.db.get(full))).toMatchObject({ status: "succeeded" });
  });
});

describe("Room host runs", () => {
  it("lists a room's host runs, newest first, to its members only", async () => {
    const t = backend();
    const room = await seedRoom(t);
    await say(t, room.roomId, human(room, 0), "Can we move the burn?", 0);
    stubProviders();
    const first = (await request(t, room.roomId))!;
    await execute(t, first);
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    const second = (await request(t, room.roomId, "summary_requested"))!;
    const list = await as(t, "u1").query(api.hostTriggers.listForRoom, { roomId: room.roomId });
    expect(list.map(r => r.hostRunId)).toEqual([second, first]);
    expect(list[1]).toMatchObject({ trigger: "final_message", status: "succeeded", attempt: 1, span: { provider: "google", model: "test-gemini" },
      check: { span: { provider: "xai" } } });
    expect(list[1].output?.summaries).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "running", output: null, finishedAt: null });

    await t.run(async ctx => {
      const companyId = await ctx.db.insert("companies", { key: "outsider", name: "Outsider", simulated: true });
      await ctx.db.insert("users", { tokenIdentifier: token("outsider"), companyId, role: "operator" });
    });
    await expect(t.query(api.hostTriggers.listForRoom, { roomId: room.roomId })).rejects.toThrow("UNAUTHENTICATED");
    await expect(as(t, "outsider").query(api.hostTriggers.listForRoom, { roomId: room.roomId })).rejects.toThrow("FORBIDDEN");
  });
});
