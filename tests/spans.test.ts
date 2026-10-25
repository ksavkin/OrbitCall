import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateEvent } from "../fixtures/policies";
import { as, companyA, seed, userId } from "./decision";
import { insertEvent } from "./helpers";
import { rationaleTemplates, type RationaleResult } from "../convex/lib/rationale";
import type { PublicSpan } from "../convex/spans";

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


// Exercise the real immutable receipt writer so these fixtures track the publication contract.
async function rationale(s: Test, options: { failedCheck?: boolean; superseded?: boolean; disagrees?: boolean } = {}) {
  const claim = await s.t.mutation(internal.lib.rationale.begin, { eventId: s.eventId });
  if (!claim) throw new Error("Expected a rationale claim");
  const startedAt = Date.now();
  const results: RationaleResult[] = claim.cards.map(card => {
    const inputVersion = `${claim.inputVersion}:${card.candidateId}`;
    return { candidateId: card.candidateId, raw: JSON.stringify({ template: rationaleTemplates(card)[0] }),
      span: { role: "candidate_rationale", provider: "anthropic", model: "measured-claude", inputVersion, attempt: claim.attempt,
        startedAt, finishedAt: startedAt + 30, status: "succeeded", usage: { inputTokens: 19, outputTokens: 11 }, errorCode: null, errorMessage: null },
      check: { span: { role: "rationale_check", provider: "xai", model: "measured-grok", inputVersion, attempt: claim.attempt,
        startedAt: startedAt + 30, finishedAt: startedAt + 50, status: "succeeded", usage: { inputTokens: 37, outputTokens: 13 }, errorCode: null, errorMessage: null },
      result: { agrees: !options.disagrees, reason: "PRIVATE_CHECKER_REASON_7070", flaggedCandidateIds: options.disagrees ? [card.candidateId] : [] } } };
  });
  if (options.failedCheck) {
    results[0].check!.span.status = "failed"; results[0].check!.span.errorCode = "PRIVATE_CODE";
    results[0].check!.span.errorMessage = "PRIVATE_PROVIDER_ERROR"; results[0].check!.result = null;
  }
  if (options.superseded) await s.t.run(ctx => ctx.db.patch(s.eventId, { missKm: 0.19 }));
  vi.setSystemTime(startedAt + 50);
  const outcome = await s.t.mutation(internal.lib.rationale.finish, { requestId: claim.requestId, results });
  const end = await s.t.run(async ctx => (await ctx.db.query("log").collect()).find(row => row.after?.requestId === claim.requestId)!);
  return { claim, end, outcome, startedAt };
}

it("projects each recorded candidate explanation and independent check with stable IDs and actual metadata", async () => {
  const s = await seed(); const { claim, outcome, startedAt } = await rationale(s, { disagrees: true });
  expect(outcome).toEqual({ status: "succeeded", published: 4 });
  const rows: PublicSpan[] = await as(s.t, "a").query(spans, { eventId: s.eventId });
  expect(rows).toHaveLength(8);
  expect(new Set(rows.map(row => row.id)).size).toBe(8);
  for (const card of claim.cards) {
    const id = `${claim.requestId}:candidate:${card.candidateId}`;
    expect(rows.find(row => row.id === `${id}:analyst`)).toMatchObject({ parent: null, agent: "analyst", target: "analyst", kind: "llm",
      status: "ok", model: "measured-claude", provider: "anthropic", t0: startedAt, t1: startedAt + 30, ms: 30,
      tokensIn: 19, tokensOut: 11, progress: null, costUsd: null,
      output: { runStatus: "succeeded", callStatus: "succeeded", stage: "candidate_rationale", candidateId: card.candidateId, attempt: 1, numbersChecked: true, details: "not_exposed" } });
    expect(rows.find(row => row.id === `${id}:checker`)).toMatchObject({ parent: `${id}:analyst`, agent: "checker", target: "checker", kind: "check",
      status: "ok", model: "measured-grok", provider: "xai", t0: startedAt + 30, t1: startedAt + 50, ms: 20,
      tokensIn: 37, tokensOut: 13, output: { runStatus: "succeeded", callStatus: "succeeded", stage: "rationale_check", candidateId: card.candidateId, attempt: 1 } });
  }
  // A successful check is not necessarily agreement. Historical receipts do not store that verdict.
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|inputVersion|agrees|reason|flaggedCandidate|template|protectedWindows/);
  expect(await as(s.t, "b").query(spans, {})).toEqual(rows);
  expect(await as(s.t, "head").query(logs, {})).toHaveLength(8);
  expect(JSON.stringify(await as(s.t, "a").query(logs, {}))).not.toMatch(/PRIVATE|rationale-[a-f0-9]{64}/);
  expect(await s.t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual([]);
});

it("retains measured successful drafts when a checker fails, with a distinct overall failure", async () => {
  const s = await seed(); const { outcome, claim } = await rationale(s, { failedCheck: true });
  expect(outcome.status).toBe("failed");
  const rows: PublicSpan[] = await as(s.t, "a").query(spans, {});
  expect(rows).toHaveLength(8);
  expect(rows.find(row => row.id === `${claim.requestId}:candidate:${claim.cards[0].candidateId}:analyst`))
    .toMatchObject({ status: "ok", output: { runStatus: "failed", callStatus: "succeeded" } });
  expect(rows.find(row => row.output.callStatus === "failed"))
    .toMatchObject({ status: "error", model: "measured-grok", tokensIn: 37, tokensOut: 13, output: { runStatus: "failed" }, error: expect.any(String) });
  expect(rows.every(row => row.output.numbersChecked === undefined)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  expect((await as(s.t, "a").query(logs, {})).every((row: { level: string }) => row.level === "error")).toBe(true);
});

it("retains superseded rationale metadata as stale history without making it a checked publication", async () => {
  const s = await seed(); const { outcome } = await rationale(s, { superseded: true });
  expect(outcome.status).toBe("superseded");
  await s.t.run(ctx => ctx.db.patch(s.eventId, { active: false }));
  const rows: PublicSpan[] = await as(s.t, "a").query(spans, {});
  expect(rows).toHaveLength(8);
  expect(rows.every(row => row.status === "waiting" && row.output.runStatus === "superseded" && row.output.callStatus === "succeeded")).toBe(true);
  expect(rows.every(row => row.output.numbersChecked === undefined)).toBe(true);
  expect((await as(s.t, "a").query(logs, {})).every((row: { level: string }) => row.level === "warn")).toBe(true);
});

it("represents an unfinished rationale batch as orchestration, retains it ahead of recent work and marks a lost attempt stalled", async () => {
  const s = await seed(); const claim = await s.t.mutation(internal.lib.rationale.begin, { eventId: s.eventId });
  const started = await s.t.run(ctx => ctx.db.get(claim!.requestId));
  vi.setSystemTime(started!.at + 10 * 60_000);
  await run(s);
  const [row] = await as(s.t, "a").query(spans, { limit: 1 });
  expect(row).toMatchObject({ id: `${claim!.requestId}:rationale`, kind: "handoff", status: "waiting", output: { runStatus: "running", attempt: 1, stalled: true } });
  for (const key of ["model", "provider", "tokensIn", "tokensOut", "t1", "ms"]) expect(row).not.toHaveProperty(key);
  expect(row.output).not.toHaveProperty("candidateId");
  expect(row.output).not.toHaveProperty("numbersChecked");
});

it("keeps rationale attempts scoped to current assigned ownership and excludes other demo histories", async () => {
  const s = await seed(); await rationale(s);
  for (const fn of [spans, logs]) {
    expect(await as(s.t, "unassigned").query(fn, {})).toEqual([]);
    await expect(as(s.t, "c").query(fn, { eventId: s.eventId })).rejects.toThrow(/FORBIDDEN/);
    await expect(as(s.t, "eye").query(fn, {})).rejects.toThrow(/FORBIDDEN/);
  }
  await s.t.mutation(internal.operators.provision, companyA([]));
  expect(await as(s.t, "a").query(spans, {})).toEqual([]);
  await s.t.run(async ctx => {
    const demoRunId = await ctx.db.insert("demoRuns", { scenario: "other", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(s.eventId, { demoRunId });
  });
  expect(await as(s.t, "b").query(spans, { eventId: s.eventId })).toEqual([]);
});

it.each(["json", "duplicate", "foreign source", "wrong role", "negative usage", "reversed timing", "missing draft", "oversized"])(
  "does not expose malformed rationale provider metadata: %s", async defect => {
    const s = await seed(); const { end } = await rationale(s);
    const recorded = JSON.parse(String(end.after!.spans));
    if (defect === "duplicate") recorded[2] = recorded[0];
    if (defect === "foreign source") recorded[0].inputVersion = `rationale-${"b".repeat(64)}:P1`;
    if (defect === "wrong role") recorded[0].role = "operator_advocate";
    if (defect === "negative usage") recorded[0].usage.inputTokens = -1;
    if (defect === "reversed timing") recorded[0].finishedAt = recorded[0].startedAt - 1;
    if (defect === "missing draft") recorded.shift();
    await s.t.run(ctx => ctx.db.patch(end._id, { after: { ...end.after,
      spans: defect === "json" ? "PRIVATE_INVALID_JSON" : defect === "oversized" ? " ".repeat(32_001) : JSON.stringify(recorded) } }));
    const rows = await as(s.t, "a").query(spans, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("handoff");
    expect(rows[0]).not.toHaveProperty("tokensIn");
    expect(rows[0]).not.toHaveProperty("provider");
    expect(rows[0].output).not.toHaveProperty("numbersChecked");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });

it("does not link a finished receipt to another batch or expose extra raw fields", async () => {
  const s = await seed(); const { claim, end } = await rationale(s);
  const recorded = JSON.parse(String(end.after!.spans));
  recorded[0].prompt = "PRIVATE_PROMPT"; recorded[1].errorMessage = "PRIVATE_TOKEN"; recorded[1].result = { reason: "PRIVATE_REASON" };
  await s.t.run(ctx => ctx.db.patch(end._id, { summary: "PRIVATE_SUMMARY", after: { ...end.after, spans: JSON.stringify(recorded) } }));
  expect(JSON.stringify(await as(s.t, "a").query(spans, {}))).not.toContain("PRIVATE");
  await s.t.run(ctx => ctx.db.patch(end._id, { after: { ...end.after, requestId: "foreign_request" } }));
  expect(await as(s.t, "a").query(spans, {})).toEqual([expect.objectContaining({ id: `${claim.requestId}:rationale`, kind: "handoff", output: expect.objectContaining({ runStatus: "running" }) })]);
});

it("fails visibly on oversized audit history rather than silently dropping an old rationale attempt", async () => {
  const s = await seed(); const claim = await s.t.mutation(internal.lib.rationale.begin, { eventId: s.eventId });
  await s.t.run(async ctx => {
    const { _id, _creationTime, ...row } = (await ctx.db.get(claim!.requestId))!;
    for (let i = 0; i < 1000; i++) await ctx.db.insert("log", { ...row, actor: { kind: "system" }, after: null });
  });
  for (const fn of [spans, logs]) await expect(as(s.t, "a").query(fn, { eventId: s.eventId, limit: 1 })).rejects.toThrow(/LIMIT_EXCEEDED/);
});


it("keeps bounded retry attempts separate without repeating measured usage within either API", async () => {
  const s = await seed(); const first = await rationale(s, { failedCheck: true });
  const second = await rationale(s);
  expect(second.claim.attempt).toBe(2);
  const rows: PublicSpan[] = await as(s.t, "a").query(spans, {});
  expect(rows).toHaveLength(16);
  expect(new Set(rows.map(row => row.id)).size).toBe(16);
  expect(rows.filter(row => row.id.startsWith(String(first.claim.requestId)))).toHaveLength(8);
  expect(rows.filter(row => row.id.startsWith(String(second.claim.requestId)))).toHaveLength(8);
  expect(rows.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0)).toBe(2 * 4 * (19 + 37));
  expect(await as(s.t, "a").query(spans, { eventId: s.eventId })).toEqual(rows);
  expect(await as(s.t, "a").query(spans, { eventId: s.eventId, limit: 3 })).toHaveLength(3);
  expect(await as(s.t, "a").query(logs, {})).toHaveLength(16);
});
