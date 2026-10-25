import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { callClaude } from "../convex/lib/claude";
import { backend, catalogSources, draft, insertEvent } from "./helpers";

vi.mock("../convex/lib/claude", async original => ({
  ...await original<typeof import("../convex/lib/claude")>(), callClaude: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.mocked(callClaude).mockReset();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function demo() {
  const t = backend();
  const eventId = await insertEvent(t);
  const demoRunId = await t.run(async ctx => {
    const run = await ctx.db.insert("demoRuns", { scenario: "reset race", state: "open", startedBy: null,
      manifest: null, startedAt: Date.now(), closedAt: null });
    await ctx.db.patch(eventId, { demoRunId: run });
    return run;
  });
  return { t, eventId, demoRunId };
}

const states = ["closed", "missing", "closedAt"] as const;
describe("Analyst demo reset guard", () => {
  it.each(states)("does not claim work or call a provider when the demo is %s before start", async state => {
    const { t, eventId, demoRunId } = await demo();
    await t.run(async ctx => {
      if (state === "missing") await ctx.db.delete(demoRunId);
      else await ctx.db.patch(demoRunId, { state: state === "closed" ? "closed" : "open", closedAt: Date.now() });
    });
    expect(await t.mutation(internal.agentRuns.begin, { eventId })).toBeNull();
    await t.action(internal.agents.analyst.start, { eventId });
    expect(callClaude).not.toHaveBeenCalled();
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  it.each(states)("supersedes a late result when the demo becomes %s without changing the incident evidence", async state => {
    const { t, eventId, demoRunId } = await demo();
    const before = await t.run(ctx => ctx.db.get(eventId));
    const claimed = await t.mutation(internal.agentRuns.begin, { eventId });
    expect(claimed).not.toBeNull();
    await t.run(async ctx => {
      if (state === "missing") await ctx.db.delete(demoRunId);
      else await ctx.db.patch(demoRunId, { state: state === "closed" ? "closed" : "open", closedAt: Date.now() });
    });
    expect(await t.mutation(internal.agentRuns.finish, {
      runId: claimed!.runId, raw: draft(claimed!.input), model: "test-model", usage: { inputTokens: 1, outputTokens: 1 },
    })).toEqual({ published: false });
    const run = await t.run(ctx => ctx.db.get(claimed!.runId));
    expect(run).toMatchObject({ status: "superseded", stalled: false });
    expect(run?.finishedAt).toBeGreaterThanOrEqual(run!._creationTime);
    expect(run?.checkedOutput).toBeUndefined();
    expect((await t.query(internal.agentRuns.inspect, { eventId })).summary).toBeNull();
    expect(await t.run(ctx => ctx.db.get(eventId))).toEqual(before);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.agentRuns.inspect, { eventId })).agentsWorking).toBe(false);
  });

  it("rejects the model result when reset occurs inside an already running Analyst action", async () => {
    const { t, eventId, demoRunId } = await demo();
    vi.mocked(callClaude).mockImplementationOnce(async () => {
      await t.run(ctx => ctx.db.patch(demoRunId, { state: "closed", closedAt: Date.now() }));
      return { raw: draft(), model: "test-model", usage: { inputTokens: 10, outputTokens: 20 } };
    });
    await t.action(internal.agents.analyst.start, { eventId });
    const result = await t.query(internal.agentRuns.inspect, { eventId });
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(result.summary).toBeNull();
    expect(result.runs[0].status).toBe("superseded");
    expect(result.agentsWorking).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it.each(["fixture", "real", "open_demo"] as const)("preserves normal publication and deduplication for %s incidents", async kind => {
    const t = backend();
    const eventId = await insertEvent(t, kind === "real" ? {
      ...redEvent,
      objectA: { ...redEvent.objectA, objectId: "10001", simulated: false },
      simulated: false,
      pc: { ...redEvent.pc, source: "socrates" },
      sources: catalogSources,
    } : redEvent);
    if (kind === "open_demo") await t.run(async ctx => {
      const run = await ctx.db.insert("demoRuns", { scenario: "open", state: "open", startedBy: null,
        manifest: null, startedAt: Date.now(), closedAt: null });
      await ctx.db.patch(eventId, { demoRunId: run });
    });
    const before = await t.run(ctx => ctx.db.get(eventId));
    const claimed = await t.mutation(internal.agentRuns.begin, { eventId });
    expect(claimed).not.toBeNull();
    expect(await t.mutation(internal.agentRuns.finish, {
      runId: claimed!.runId, raw: draft(claimed!.input), model: "test-model", usage: { inputTokens: 1, outputTokens: 1 },
    })).toEqual({ published: true });
    expect((await t.query(internal.agentRuns.inspect, { eventId })).summary).toHaveLength(5);
    expect(await t.mutation(internal.agentRuns.begin, { eventId })).toBeNull();
    expect(await t.run(ctx => ctx.db.get(eventId))).toEqual(before);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
