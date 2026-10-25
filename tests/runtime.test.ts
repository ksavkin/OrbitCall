import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { backend, draft, ingestArgs, insertEvent, insertSnapshot } from "./helpers";
import { callClaude } from "../convex/lib/claude";

vi.mock("../convex/lib/claude", async importOriginal => {
  const actual = await importOriginal<typeof import("../convex/lib/claude")>();
  return { ...actual, callClaude: vi.fn() };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.mocked(callClaude).mockReset();
  vi.mocked(callClaude).mockResolvedValue({ raw: draft(), model: "test-model", usage: { inputTokens: 10, outputTokens: 20 } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("agent run lifecycle", () => {
  it("publishes a checked summary through the real action path and does not change the incident decision", async () => {
    const t = backend();
    const eventId = await insertEvent(t);
    const before = await t.run(ctx => ctx.db.get(eventId));
    await t.action(internal.agents.analyst.start, { eventId });
    const result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.summary).toHaveLength(5);
    expect(result.runs[0].status).toBe("succeeded");
    expect(result.agentsWorking).toBe(false);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(await t.run(ctx => ctx.db.get(eventId))).toEqual(before);
    await t.action(internal.agents.analyst.start, { eventId });
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent claims", async () => {
    const t = backend(); const eventId = await insertEvent(t);
    const results = await Promise.all([
      t.mutation(internal.agentRuns.begin, { eventId }),
      t.mutation(internal.agentRuns.begin, { eventId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsWorking).toBe(true);
  });

  it("does not publish a run against changed input, even if no replacement has started", async () => {
    const t = backend(); const eventId = await insertEvent(t);
    const old = await t.mutation(internal.agentRuns.begin, { eventId });
    await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.4 }));
    const result = await t.mutation(internal.agentRuns.finish, {
      runId: old!.runId, raw: draft(), model: "test-model", usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(result.published).toBe(false);
    expect((await t.query(internal.agentRuns.inspect, { eventId })).summary).toBeNull();
  });

  it("does not let a slower superseded run overwrite the new result", async () => {
    const t = backend(); const eventId = await insertEvent(t);
    const old = await t.mutation(internal.agentRuns.begin, { eventId });
    await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.4 }));
    vi.setSystemTime(FIXTURE_NOW + 1);
    await t.action(internal.agents.analyst.start, { eventId });
    await t.mutation(internal.agentRuns.finish, {
      runId: old!.runId, raw: draft(), model: "old-model", usage: { inputTokens: 1, outputTokens: 1 },
    });
    const result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.summary?.[1]).toContain("0.4 km");
    expect(result.runs.map(r => r.status)).toEqual(["succeeded", "superseded"]);
  });

  it("flags a run at sixty seconds and reschedules the watchdog after real progress", async () => {
    const t = backend(); const eventId = await insertEvent(t);
    const claimed = await t.mutation(internal.agentRuns.begin, { eventId });
    vi.setSystemTime(FIXTURE_NOW + 59_000);
    await t.mutation(internal.agentRuns.watchdog, { runId: claimed!.runId });
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsStalled).toBe(false);
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    await t.mutation(internal.agentRuns.watchdog, { runId: claimed!.runId });
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsStalled).toBe(true);
    await t.mutation(internal.agentRuns.progress, { runId: claimed!.runId, stage: "checking" });
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsStalled).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsStalled).toBe(true);
  });

  it("records missing configuration without making a model call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = backend(); const eventId = await insertEvent(t);
    await t.action(internal.agents.analyst.start, { eventId });
    const result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.runs[0].errorCode).toBe("MODEL_NOT_CONFIGURED");
    expect(result.agentsWorking).toBe(false);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("rejects incorrect summaries and allows a new attempt without duplicate summary records", async () => {
    vi.mocked(callClaude).mockResolvedValueOnce({ raw: draft().replace("{{missKm}}", "18"), model: "test-model", usage: { inputTokens: 1, outputTokens: 1 } });
    const t = backend(); const eventId = await insertEvent(t);
    await t.action(internal.agents.analyst.start, { eventId });
    let result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.summary).toBeNull();
    expect(result.runs[0].errorCode).toBe("NUMBER_CHECK_FAILED");
    expect(result.agentsWorking).toBe(false);
    vi.setSystemTime(FIXTURE_NOW + 1);
    await t.action(internal.agents.analyst.start, { eventId });
    result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.runs[0].attempt).toBe(2);
    expect(result.summary).toHaveLength(5);
    expect((await t.run(ctx => ctx.db.query("agentRuns").collect())).filter(run => run.checkedOutput)).toHaveLength(1);
  });

  it("sanitizes unknown upstream failures", async () => {
    vi.mocked(callClaude).mockRejectedValueOnce(new Error("authorization: secret-key"));
    const t = backend(); const eventId = await insertEvent(t);
    await t.action(internal.agents.analyst.start, { eventId });
    const result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(result.runs[0].errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("publishing revalidates raw output inside the database transaction", async () => {
    const t = backend(); const eventId = await insertEvent(t);
    const claimed = await t.mutation(internal.agentRuns.begin, { eventId });
    await expect(t.mutation(internal.agentRuns.finish, {
      runId: claimed!.runId, raw: draft().replace("{{missKm}}", "{{relSpeedKmS}}"),
      model: "test-model", usage: { inputTokens: 1, outputTokens: 1 },
    })).rejects.toThrow();
    expect((await t.query(internal.agentRuns.inspect, { eventId })).summary).toBeNull();
  });

  it("ingestion schedules the Analyst once for a newly red event", async () => {
    const t = backend();
    const snapshotId = await insertSnapshot(t);
    const first = await t.mutation(internal.events.ingest, ingestArgs(snapshotId));
    const second = await t.mutation(internal.events.ingest, ingestArgs(snapshotId));
    expect(first.scheduled).toBe(true); expect(second.scheduled).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect((await t.query(internal.agentRuns.inspect, { eventId: first.eventId })).summary).toHaveLength(5);
  });

  it("ingestion keeps one event per pair within sixty seconds of TCA and one record per object", async () => {
    const t = backend();
    const snapshotId = await insertSnapshot(t);
    const first = await t.mutation(internal.events.ingest, ingestArgs(snapshotId));
    const shifted = { ...redEvent, tcaUtc: "2026-10-25T03:15:07Z", missKm: 0.2 };
    const near = await t.mutation(internal.events.ingest, ingestArgs(snapshotId, shifted));
    const far = await t.mutation(internal.events.ingest, ingestArgs(snapshotId, { ...redEvent, tcaUtc: "2026-10-25T03:16:08Z" }));
    expect(near.eventId).toBe(first.eventId);
    expect(far.eventId).not.toBe(first.eventId);
    expect(await t.run(ctx => ctx.db.query("spaceObjects").collect())).toHaveLength(2);
    expect((await t.run(ctx => ctx.db.get(first.eventId)))?.missKm).toBe(0.2);
  });

  it("serves the current checked summary without sign-in and hides it once the evidence changes", async () => {
    const t = backend();
    const eventId = await insertEvent(t);
    await t.action(internal.agents.analyst.start, { eventId });
    const result = await t.query(api.agentSummaries.get, { eventId });
    expect(result.summaryLines).toHaveLength(5);
    expect(result.numbersChecked).toBe(true);
    expect(result.run?.attempt).toBe(1);
    expect(JSON.stringify(result)).not.toContain("inputKey");
    expect(JSON.stringify(result)).not.toContain("{{");
    await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.5 }));
    const updated = await t.query(api.agentSummaries.get, { eventId });
    expect(updated.summaryLines).toEqual([]);
    expect(updated.numbersChecked).toBe(false);
    expect(updated.run).toBeNull();
  });

  it("retry waits for a stall; a stuck old attempt cannot publish afterward", async () => {
    const t = backend();
    const eventId = await insertEvent(t);
    await t.run(async ctx => {
      const companyId = await ctx.db.insert("companies", { key: "retry", name: "Retry operator", simulated: true });
      const userId = await ctx.db.insert("users", { tokenIdentifier: "retry", companyId, role: "operator", name: "Retry", language: "en" });
      await ctx.db.insert("satelliteOwners", { objectId: redEvent.objectA.objectId, companyId });
      await ctx.db.insert("fleetAssignments", { userId, objectId: redEvent.objectA.objectId, active: true });
    });
    const operator = t.withIdentity({ tokenIdentifier: "retry" });
    const claimed = await t.mutation(internal.agentRuns.begin, { eventId });
    await expect(operator.mutation(api.agents.rerun, { eventId })).rejects.toThrow("INVALID_STATE");
    vi.setSystemTime(FIXTURE_NOW + 61_000);
    await t.mutation(internal.agentRuns.watchdog, { runId: claimed!.runId });
    await operator.mutation(api.agents.rerun, { eventId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.agentRuns.inspect, { eventId })).runs[0].status).toBe("succeeded");
    expect((await t.mutation(internal.agentRuns.finish, {
      runId: claimed!.runId, raw: draft(), model: "old-model", usage: { inputTokens: 1, outputTokens: 1 },
    })).published).toBe(false);
  });
});
