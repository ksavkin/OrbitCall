import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateEvent } from "../fixtures/policies";
import { as, companyA, seed, userId } from "./decision";
import { insertEvent } from "./helpers";

const spans = makeFunctionReference<"query">("spans:list"), logs = makeFunctionReference<"query">("agentLogs:list");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());
type Test = Awaited<ReturnType<typeof seed>>;
async function run(s: Test, patch: Partial<Doc<"agentRuns">> = {}) {
  return s.t.run(ctx => ctx.db.insert("agentRuns", { eventId: s.eventId, inputKey: "PRIVATE_POLICY_9199",
    status: "succeeded", lastProgressAt: Date.now(), stalled: false, finishedAt: Date.now() + 80,
    model: "recorded-model", usage: { inputTokens: 120, outputTokens: 30 }, checkedOutput: "PRIVATE_MEMORY_8188", ...patch }));
}
async function host(s: Test, extra?: Id<"events">) {
  return s.t.run(async ctx => {
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [], demoRunId: null, simulated: true,
      createdAt: Date.now(), closedAt: null });
    for (const eventId of [s.eventId, ...(extra ? [extra] : [])]) await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: Date.now() });
    const span = { role: "coordination_host" as const, provider: "google" as const, model: "actual-gemini", inputVersion: "PRIVATE_INPUT_KEY",
      attempt: 1, startedAt: Date.now(), finishedAt: Date.now() + 100, status: "succeeded" as const,
      usage: { inputTokens: 40, outputTokens: 10 }, errorCode: null, errorMessage: null };
    const hostRunId = await ctx.db.insert("hostRuns", { roomId, trigger: "summary_requested", inputVersion: span.inputVersion, attempt: 1,
      status: "succeeded", span, check: { span: { ...span, role: "rationale_check", provider: "xai", model: "actual-grok", startedAt: Date.now() + 100,
        finishedAt: Date.now() + 140, usage: { inputTokens: 20, outputTokens: 5 } },
        result: { agrees: false, reason: "PRIVATE_OTHER_EVENT_7177", flaggedCandidateIds: ["PRIVATE_OTHER_CANDIDATE"] } },
      output: { inputVersion: span.inputVersion, clarifications: [], requestedRevisions: [], summaries: [
        { eventId: s.eventId, text: "PRIVATE_OTHER_EVENT_7177 may be mentioned even in this event's summary.", messageIds: ["PRIVATE_OTHER_MESSAGE"] },
        ...(extra ? [{ eventId: extra, text: "PRIVATE_UNASSIGNED_EVENT_6166", messageIds: [] }] : []),
      ] }, demoRunId: null, createdAt: Date.now(), finishedAt: Date.now() + 140 });
    return { roomId, hostRunId };
  });
}

it("exposes both actual API families with current assigned-event scope", async () => {
  const s = await seed(); await run(s);
  for (const fn of [spans, logs]) {
    await expect(s.t.query(fn, {})).rejects.toThrow();
    await expect(as(s.t, "eye").query(fn, {})).rejects.toThrow(/FORBIDDEN/);
    expect(await as(s.t, "unassigned").query(fn, {})).toEqual([]);
    await expect(as(s.t, "unassigned").query(fn, { eventId: s.eventId })).rejects.toThrow(/FORBIDDEN/);
    await expect(as(s.t, "c").query(fn, { eventId: s.eventId })).rejects.toThrow(/FORBIDDEN/);
    expect(await as(s.t, "a").query(fn, { eventId: s.eventId })).toHaveLength(1);
    expect(await as(s.t, "head").query(fn, {})).toHaveLength(1);
  }
});

it("returns measured legacy fields without inventing provider, cost, tools or public policy output", async () => {
  const s = await seed(); const id = await run(s);
  const [span] = await as(s.t, "a").query(spans, { eventId: s.eventId });
  expect(span).toMatchObject({ id, parent: null, eventId: s.eventId, agent: "analyst", target: "analyst", kind: "llm", status: "ok",
    progress: null, model: "recorded-model", tokensIn: 120, tokensOut: 30, costUsd: null, output: { runStatus: "succeeded" } });
  expect(span.ms).toBeGreaterThanOrEqual(0);
  for (const key of ["provider", "http", "input", "cacheRead"]) expect(span).not.toHaveProperty(key);
  const aId = await userId(s.t, "a");
  const companyId = await s.t.run(async ctx => (await ctx.db.get(aId))!.companyId);
  await run(s, { role: "operator_advocate", companyId });
  const rows = await as(s.t, "a").query(spans, {});
  expect(rows.some((r: { agent: string }) => r.agent === `advocate:${companyId}`)).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_POLICY|PRIVATE_MEMORY|checkedOutput|policyRevision/);
});

it("keeps running, stalled, failed and superseded runs distinct without leaking raw errors", async () => {
  const s = await seed();
  await run(s, { status: "running", stage: "loading", stalled: false, finishedAt: undefined, model: undefined, usage: undefined });
  await run(s, { status: "running", stage: "calling_model", stalled: true, finishedAt: undefined });
  await run(s, { status: "failed", errorCode: "PRIVATE_ERROR_CODE", errorMessage: "Bearer PRIVATE_PROVIDER_ERROR" });
  await run(s, { status: "superseded" });
  const rows = await as(s.t, "a").query(spans, {});
  expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(["error", "running", "waiting", "waiting"]);
  expect(rows.find((r: { output: { stalled: boolean } }) => r.output.stalled)).toMatchObject({ status: "waiting", output: { runStatus: "running" } });
  expect(rows.find((r: { output: { runStatus: string } }) => r.output.runStatus === "superseded")).toMatchObject({ status: "waiting", name: expect.stringMatching(/superseded/i) });
  expect(JSON.stringify(await as(s.t, "a").query(logs, {}))).not.toMatch(/PRIVATE|Bearer/);
  const pending = rows.find((r: { output: { stage?: string } }) => r.output.stage === "loading");
  expect(pending.kind).toBe("handoff"); expect(pending).not.toHaveProperty("ms"); expect(pending).not.toHaveProperty("provider");
});

it("uses recorded Host and checker spans while excluding all room-wide result prose", async () => {
  const s = await seed();
  const other = await insertEvent(s.t, { ...advocateEvent, objectA: { ...advocateEvent.objectA, objectId: "SIM-3001" }, objectB: { ...advocateEvent.objectB, objectId: "SIM-5001" } });
  await run(s, { eventId: other });
  await host(s, other);
  const rows = await as(s.t, "a").query(spans, { eventId: s.eventId });
  expect(rows).toHaveLength(2);
  const main = rows.find((r: { agent: string }) => r.agent === "host"), check = rows.find((r: { agent: string }) => r.agent === "checker");
  expect(main).toMatchObject({ provider: "google", model: "actual-gemini", tokensIn: 40, tokensOut: 10, ms: 100, eventId: s.eventId });
  expect(check).toMatchObject({ provider: "xai", model: "actual-grok", tokensIn: 20, tokensOut: 5, ms: 40, parent: main.id, eventId: s.eventId });
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|flaggedCandidate|messageIds|"reason":|summaries/);
  expect(JSON.stringify(await as(s.t, "a").query(logs, {}))).not.toMatch(/PRIVATE/);
});

it("does not repeat a shared Host's measured tokens for each authorized linked event", async () => {
  const s = await seed();
  const other = await insertEvent(s.t, { ...advocateEvent, objectB: { ...advocateEvent.objectB, objectId: "SIM-5001" } });
  await host(s, other);
  const rows = await as(s.t, "a").query(spans, {});
  expect(rows).toHaveLength(2);
  expect(rows.every((r: { eventId: string | null }) => r.eventId === null)).toBe(true);
});

it("immediately removes revoked and foreign-owned assignments from both projections", async () => {
  const s = await seed(); await run(s); await host(s);
  await s.t.mutation(internal.operators.provision, companyA([]));
  for (const fn of [spans, logs]) expect(await as(s.t, "a").query(fn, {})).toEqual([]);
  await s.t.mutation(internal.operators.provision, companyA());
  await s.t.run(async ctx => {
    const owner = (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1001")).unique())!;
    const c = (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "c")).unique())!;
    await ctx.db.patch(owner._id, { companyId: c._id });
  });
  for (const fn of [spans, logs]) {
    expect(await as(s.t, "a").query(fn, {})).toEqual([]);
    expect(await as(s.t, "head").query(fn, {})).toEqual([]);
  }
});

it("bounds limits and retains active work before recent terminal runs", async () => {
  const s = await seed(); const active = await run(s, { status: "running", finishedAt: undefined, stalled: true });
  for (let i = 0; i < 205; i++) await run(s);
  expect(await as(s.t, "a").query(spans, { limit: 1 })).toEqual([expect.objectContaining({ id: active })]);
  for (const fn of [spans, logs]) {
    expect(await as(s.t, "a").query(fn, { limit: 9999 })).toHaveLength(200);
    for (const limit of [0, -1, 0.5]) await expect(as(s.t, "a").query(fn, { limit })).rejects.toThrow(/VALIDATION/);
  }
});

it("includes retired authorized history and discovers incidents where the fleet object is side B", async () => {
  const s = await seed();
  const other = await insertEvent(s.t, { ...advocateEvent, objectA: { ...advocateEvent.objectB, objectId: "SIM-5001" }, objectB: advocateEvent.objectA });
  await s.t.run(ctx => ctx.db.patch(other, { active: false }));
  const id = await run(s, { eventId: other });
  expect(await as(s.t, "a").query(spans, {})).toEqual([expect.objectContaining({ id, eventId: other })]);
  expect(await as(s.t, "head").query(logs, { eventId: other })).toEqual([expect.objectContaining({ eventId: other, spanId: id })]);
});

it("keeps a pending Host as recorded orchestration without fabricating model calls", async () => {
  const s = await seed(); const { hostRunId } = await host(s);
  await s.t.run(ctx => ctx.db.patch(hostRunId, { status: "running", span: null, check: null, output: null, finishedAt: null }));
  const [row] = await as(s.t, "a").query(spans, {});
  expect(row).toMatchObject({ agent: "host", kind: "handoff", status: "running", progress: null, costUsd: null,
    output: { runStatus: "running", details: "not_exposed" } });
  for (const key of ["model", "provider", "tokensIn", "tokensOut", "ms", "t1", "http"]) expect(row).not.toHaveProperty(key);
});

it("preserves the actual successful Host call when its independent check fails", async () => {
  const s = await seed(); const { hostRunId } = await host(s);
  await s.t.run(async ctx => {
    const row = (await ctx.db.get(hostRunId))!;
    await ctx.db.patch(hostRunId, { status: "failed", check: { span: { ...row.check!.span, status: "failed",
      errorCode: "PRIVATE_CODE", errorMessage: "PRIVATE_CHECK_ERROR" }, result: null } });
  });
  const rows = await as(s.t, "a").query(spans, {});
  expect(rows.find((r: { agent: string }) => r.agent === "host")).toMatchObject({ status: "ok", output: { runStatus: "failed", callStatus: "succeeded" } });
  expect(rows.find((r: { agent: string }) => r.agent === "checker")).toMatchObject({ status: "error", output: { runStatus: "failed", callStatus: "failed" } });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

it("does not associate earlier room runs or another demo run with a newly linked incident", async () => {
  const s = await seed(); const { roomId, hostRunId } = await host(s);
  await s.t.run(async ctx => {
    const link = (await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", s.eventId)).first())!;
    await ctx.db.patch(link._id, { linkedAt: Date.now() + 500 });
  });
  expect(await as(s.t, "a").query(spans, {})).toEqual([]);
  await s.t.run(async ctx => {
    const link = (await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", s.eventId)).first())!;
    await ctx.db.patch(link._id, { linkedAt: Date.now() });
    const demoRunId = await ctx.db.insert("demoRuns", { scenario: "other", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(hostRunId, { demoRunId });
    await ctx.db.patch(roomId, { demoRunId });
  });
  expect(await as(s.t, "a").query(spans, {})).toEqual([]);
});

it("fails visibly on an oversized room history instead of silently losing old active work", async () => {
  const s = await seed(); const { hostRunId } = await host(s);
  await s.t.run(async ctx => {
    const original = (await ctx.db.get(hostRunId))!;
    const { _id, _creationTime, ...row } = original;
    for (let i = 0; i < 1000; i++) await ctx.db.insert("hostRuns", row);
  });
  await expect(as(s.t, "a").query(spans, { eventId: s.eventId, limit: 1 })).rejects.toThrow(/LIMIT_EXCEEDED/);
});
