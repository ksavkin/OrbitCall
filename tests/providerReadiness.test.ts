// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { callClaude } from "../convex/lib/claude";
import { connectTiger, type TigerConnection } from "../convex/lib/tiger";
import { backend, insertEvent } from "./helpers";
import { FIXTURE_NOW } from "../fixtures/events";

// Real action/validator/SQL-adapter paths, fake provider transports. No live requests in CI.
vi.mock("../convex/lib/claude", async original => ({
  ...await original<typeof import("../convex/lib/claude")>(), callClaude: vi.fn(),
}));
vi.mock("../convex/lib/tiger", async original => ({
  ...await original<typeof import("../convex/lib/tiger")>(), connectTiger: vi.fn(),
}));

const SECRET = "never-persist-provider-secret";
const confirmation = "RUN_LIVE_PROVIDER_CHECKS" as const;
const data = {
  memory: null as { id: string; content: string; created_at: string } | null,
  gemini: "good", grok: "good", memoryMode: "good", deleteFails: false,
  rows: [] as Record<string, unknown>[],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
  const address = String(url);
  const body = options?.body ? JSON.parse(String(options.body)) : null;
  if (address.includes("generativelanguage.googleapis.com")) {
    if (data.gemini === "fail") return json({ error: { code: 401, message: SECRET } }, 401);
    const context = JSON.parse(body.contents[0].parts[0].text);
    const output = { inputVersion: context.inputVersion, clarifications: [], requestedRevisions: [], summaries:
      data.gemini === "empty" ? [] : [{ eventId: context.events[0].eventId, messageIds: [context.messages[0].messageId],
        text: data.gemini === "invalid" ? "The predicted separation is 99999 km." : "The operator prefers a discussion after the imaging pass." }] };
    return json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }],
      modelVersion: "test-gemini-actual", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 3 } });
  }
  if (address.includes("api.x.ai")) {
    const result = { agrees: data.grok !== "disagree", reason: "The explanation does not claim candidate facts.", flaggedCandidateIds: [] };
    return json({ model: "test-grok-actual", choices: [{ finish_reason: "stop", message: {
      content: data.grok === "invalid" ? SECRET : JSON.stringify(result),
    } }], usage: { prompt_tokens: 7, completion_tokens: 8 } });
  }
  if (address === "https://app.backboard.io/api/assistants" && options?.method === "POST") {
    if (data.memoryMode === "createLost") throw new Error(SECRET);
    return json({ assistant_id: "test-readiness-assistant" });
  }
  if (address.endsWith("/memories") && options?.method === "POST") {
    data.memory = { id: "test-memory", content: body.content, created_at: new Date(FIXTURE_NOW).toISOString() };
    return json({ memory_id: "test-memory" });
  }
  if (address.endsWith("/memories/search")) {
    const memory = data.memory && { ...data.memory };
    if (memory && data.memoryMode === "foreign") memory.content = memory.content.replace(/"companyId":"[^"]+"/, '"companyId":"foreign-company"');
    return json({ memories: data.memoryMode === "empty" ? [] : [memory] });
  }
  if (address.startsWith("https://app.backboard.io/api/assistants/") && options?.method === "DELETE") {
    if (data.deleteFails) return json({ error: SECRET }, 503);
    return json({ deleted: true });
  }
  throw new Error(`Unmocked provider request: ${address}`);
});
const tiger: TigerConnection = {
  async sql(text, values = []) {
    if (text.startsWith("INSERT")) {
      const [key, eventId, runId, observedAt, source, metric, value, evidenceVersion, simulated] = values;
      const existing = data.rows.find(row => row.observation_key === key);
      if (!existing) data.rows.push({ observation_key: key, event_id: eventId, run_id: runId,
        observed_at: new Date(String(observedAt)), source, metric, value, evidence_version: evidenceVersion, simulated });
      return { rows: [], rowCount: existing ? 0 : 1 };
    }
    if (text.startsWith("SELECT observation_key")) {
      const runMatch = /run_id = \$(\d+)/.exec(text);
      const runId = runMatch ? values[Number(runMatch[1]) - 1] : null;
      const rows = data.rows.filter(row => row.event_id === values[0] && row.run_id === runId);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: null };
  },
  async end() {},
};

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  for (const key of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "BACKBOARD_API_KEY"]) vi.stubEnv(key, "test-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-claude"); vi.stubEnv("GEMINI_HOST_MODEL", "test-gemini"); vi.stubEnv("XAI_CHECKER_MODEL", "test-grok");
  vi.mocked(callClaude).mockReset().mockImplementation(async prompt => ({
    raw: JSON.stringify({ lines: JSON.parse(prompt.user).slots.map((slot: { kind: string; templates: string[] }) =>
      ({ kind: slot.kind, template: slot.templates[0] })) }), model: "test-claude-actual", usage: { inputTokens: 11, outputTokens: 12 },
  }));
  data.memory = null; data.gemini = "good"; data.grok = "good"; data.memoryMode = "good"; data.deleteFails = false; data.rows = [];
  vi.mocked(connectTiger).mockReset().mockResolvedValue(tiger);
  fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const requests = (part: string, method = "POST") => fetchMock.mock.calls.filter(([url, options]) => String(url).includes(part) && options?.method === method);

describe("isolated live-provider diagnostic (mocked transports)", () => {
  it("records checked results, actual models and usage, and closes only its own fixture", async () => {
    const t = backend();
    const unrelatedId = await insertEvent(t);
    const unrelatedBefore = await t.run(ctx => ctx.db.get(unrelatedId));
    const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.status).toBe("passed"); expect(report.cleanup).toBe("complete");
    expect(report.results.map(result => result.provider)).toEqual(["claude", "gemini", "grok", "backboard", "tiger"]);
    expect(report.results.every(result => result.status === "succeeded")).toBe(true);
    expect(report.results[0]).toMatchObject({ model: "test-claude-actual", usage: { inputTokens: 11, outputTokens: 12 } });
    expect(report.results[1]).toMatchObject({ model: "test-gemini-actual", usage: { inputTokens: 10, outputTokens: 23 } });
    expect(report.results[2]).toMatchObject({ model: "test-grok-actual", usage: { inputTokens: 7, outputTokens: 8 } });
    const saved = await t.query(internal.providerReadiness.report, { runId: report.runId });
    for (const result of report.results) expect(JSON.parse(String(saved.manifest?.[`readiness:${result.provider}`]))).toEqual(result);
    expect(saved.manifest?.["readiness:mode"]).toBe("live_calls_synthetic_input");
    const state = await t.query(internal.providerReadiness.snapshot, { runId: report.runId });
    expect(state.run.state).toBe("closed"); expect(state.assistant?.closedAt).toBeGreaterThanOrEqual(FIXTURE_NOW);
    expect(await t.run(ctx => ctx.db.get(state.eventId))).toMatchObject({ active: false, simulated: true });
    expect(await t.run(ctx => ctx.db.get(state.roomId))).toMatchObject({ state: "closed" });
    expect(state.exported).toMatchObject({ exportState: "exported", simulated: true, demoRunId: report.runId, attempts: 1 });
    expect(state.series?.points).toEqual([{ atUtc: saved.manifest?.["readiness:observedAt"], missKm: 1.25,
      pc: null, simulated: true, source: "simulated" }]);
    expect(await t.run(ctx => ctx.db.get(unrelatedId))).toEqual(unrelatedBefore);
    for (const table of ["approvals", "proposals", "candidateSets", "maneuvers", "policies", "fleetAssignments"] as const) {
      expect(await t.run(ctx => ctx.db.query(table).collect())).toEqual([]);
    }
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(requests("generativelanguage.googleapis.com")).toHaveLength(1);
    expect(requests("api.x.ai")).toHaveLength(1);
    expect(requests("/memories/search")).toHaveLength(1);
    expect(requests("/assistants/", "DELETE")).toHaveLength(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(requests("/assistants/", "DELETE")).toHaveLength(2);
  });

  it("runs the independent checks while Claude is still pending", async () => {
    const t = backend();
    const original = vi.mocked(callClaude).getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(callClaude).mockImplementation(async prompt => { await pending; return original(prompt); });
    const running = t.action(internal.providerReadiness.run, { confirmation });
    // Flush microtasks without timers or any network request. Gemini, Grok and Backboard should be independent.
    for (let step = 0; step < 1000 && requests("/memories/search").length === 0; step++) await Promise.resolve();
    expect(requests("generativelanguage.googleapis.com")).toHaveLength(1);
    expect(requests("api.x.ai")).toHaveLength(1);
    expect(requests("/memories/search")).toHaveLength(1);
    release();
    expect((await running).status).toBe("passed");
  });

  it("records failures independently without publishing raw provider errors or database URLs", async () => {
    vi.mocked(callClaude).mockRejectedValueOnce(new Error(SECRET));
    data.gemini = "fail"; data.grok = "invalid";
    vi.mocked(connectTiger).mockRejectedValue(new Error(`postgres://account:${SECRET}@private.example/database`));
    const t = backend();
    const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.status).toBe("failed"); expect(report.cleanup).toBe("complete");
    expect(report.results.map(result => result.status)).toEqual(["failed", "failed", "failed", "succeeded", "failed"]);
    expect(report.results[0].errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(report.results[1].errorCode).toBe("MODEL_ACCESS_DENIED");
    expect(report.results[2].errorCode).toBe("INVALID_OUTPUT");
    const saved = await t.query(internal.providerReadiness.report, { runId: report.runId });
    expect(JSON.stringify(saved)).not.toContain(SECRET); expect(JSON.stringify(report)).not.toContain("private.example");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The closed run fences the export retry that the production history action may have queued.
    expect(vi.mocked(connectTiger)).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "foreign"])("does not count %s Backboard recall as proof of the write", async mode => {
    data.memoryMode = mode;
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.results.find(result => result.provider === "backboard")).toMatchObject({ status: "failed", errorCode: "MEMORY_NOT_RECALLED" });
    expect(report.cleanup).toBe("complete"); expect(requests("/memories/search")).toHaveLength(1);
  });

  it.each(["invalid", "empty"])("rejects a %s Gemini summary through the checked application contract", async mode => {
    data.gemini = mode;
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.results.find(result => result.provider === "gemini")).toMatchObject({
      status: "failed", errorCode: mode === "empty" ? "HOST_SUMMARY_MISSING" : "CONSTRAINT_CHECK_FAILED", resultJson: null,
    });
  });

  it("records Grok disagreement as a successful checked call without changing decisions", async () => {
    data.grok = "disagree";
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    const grok = report.results.find(result => result.provider === "grok")!;
    expect(grok.status).toBe("succeeded"); expect(JSON.parse(grok.resultJson!).agrees).toBe(false);
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  });

  it("retains cleanup failure and retries only the diagnostic's known namespace", async () => {
    data.deleteFails = true;
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.status).toBe("passed"); expect(report.cleanup).toBe("failed");
    expect((await t.query(internal.providerReadiness.snapshot, { runId: report.runId })).assistant?.closedAt).toBeNull();
    data.deleteFails = false;
    await t.action(internal.providerReadiness.cleanup, { runId: report.runId });
    expect((await t.query(internal.providerReadiness.report, { runId: report.runId })).manifest?.["readiness:cleanup"]).toBe("complete");
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE").every(([url]) =>
      String(url).startsWith("https://app.backboard.io/api/assistants/test-readiness-assistant"))).toBe(true);
  });

  it("does not claim cleanup when an assistant create returned no identifiable result", async () => {
    data.memoryMode = "createLost";
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.status).toBe("failed"); expect(report.cleanup).toBe("failed");
    expect(requests("/assistants/", "DELETE")).toHaveLength(0);
    expect((await t.query(internal.providerReadiness.report, { runId: report.runId })).manifest?.["readiness:assistantCreation"]).toBe("pending");
  });

  it("reports missing Backboard configuration without attempting creation or claiming an unknown namespace", async () => {
    vi.stubEnv("BACKBOARD_API_KEY", "");
    const t = backend(); const report = await t.action(internal.providerReadiness.run, { confirmation });
    expect(report.results.find(result => result.provider === "backboard")).toMatchObject({
      status: "failed", errorCode: "MEMORY_NOT_CONFIGURED",
    });
    expect(report.cleanup).toBe("complete"); expect(requests("app.backboard.io")).toHaveLength(0);
  });

  it("closes an interrupted fixture and rejects foreign-run cleanup", async () => {
    const t = backend();
    const fixture = await t.mutation(internal.providerReadiness.prepare, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.providerReadiness.report, { runId: fixture.runId })).manifest?.["readiness:status"]).toBe("interrupted");
    const foreign = await t.run(ctx => ctx.db.insert("demoRuns", {
      scenario: "ordinary-demo", state: "open", startedBy: null, manifest: null, startedAt: FIXTURE_NOW, closedAt: null,
    }));
    await expect(t.action(internal.providerReadiness.cleanup, { runId: foreign })).rejects.toThrow("INVALID_STATE");
    expect((await t.run(ctx => ctx.db.get(foreign)))?.state).toBe("open");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fences a late result after cleanup and keeps a late assistant available for scoped cleanup", async () => {
    const t = backend(); const fixture = await t.mutation(internal.providerReadiness.prepare, {});
    await t.action(internal.providerReadiness.cleanup, { runId: fixture.runId });
    await t.mutation(internal.providerReadiness.saveResult, { runId: fixture.runId, result: {
      provider: "grok", status: "succeeded", model: "test", usage: null, durationMs: 1, errorCode: null, resultJson: "{}",
    } });
    expect((await t.query(internal.providerReadiness.report, { runId: fixture.runId })).manifest?.["readiness:grok"]).toBeUndefined();
    await t.mutation(internal.providerReadiness.registerAssistant, { runId: fixture.runId, assistantId: "test-readiness-assistant" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests("/assistants/", "DELETE").length).toBeGreaterThanOrEqual(2);
    expect((await t.query(internal.providerReadiness.snapshot, { runId: fixture.runId })).assistant?.closedAt).not.toBeNull();
  });

  it("repeats scoped cleanup after a write completes later than the interruption cleanup", async () => {
    const t = backend(); const fixture = await t.mutation(internal.providerReadiness.prepare, {});
    await t.mutation(internal.providerReadiness.reserveAssistant, { runId: fixture.runId });
    await t.mutation(internal.providerReadiness.registerAssistant, { runId: fixture.runId, assistantId: "test-readiness-assistant" });
    expect(await t.mutation(internal.providerReadiness.memoryWrite, { runId: fixture.runId, state: "begin" })).toBe(true);
    await t.action(internal.providerReadiness.cleanup, { runId: fixture.runId });
    let state = await t.query(internal.providerReadiness.snapshot, { runId: fixture.runId });
    expect(state.run.state).toBe("closed"); expect(state.run.manifest?.["readiness:cleanup"]).toBe("pending");
    expect(state.assistant?.closedAt).toBeNull();
    expect(await t.mutation(internal.providerReadiness.memoryWrite, { runId: fixture.runId, state: "begin" })).toBe(false);
    const before = requests("/assistants/", "DELETE").length;
    await t.mutation(internal.providerReadiness.memoryWrite, { runId: fixture.runId, state: "settled" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    state = await t.query(internal.providerReadiness.snapshot, { runId: fixture.runId });
    expect(state.run.manifest?.["readiness:cleanup"]).toBe("complete");
    expect(state.assistant?.closedAt).not.toBeNull();
    expect(requests("/assistants/", "DELETE").length).toBeGreaterThan(before);
  });
});
