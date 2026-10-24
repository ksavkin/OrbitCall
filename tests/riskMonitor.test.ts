import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import crons from "../convex/crons";
import { callClaude } from "../convex/lib/claude";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, insertEvent, pair, registerSnapshot, scheduledAnalystStarts, type Backend } from "./helpers";

vi.mock("../convex/lib/claude", async importOriginal => {
  const actual = await importOriginal<typeof import("../convex/lib/claude")>();
  return { ...actual, callClaude: vi.fn() };
});

// Answers with the first allowed template of every slot, whatever the evidence is.
const answer = async ({ user }: { user: string }) => ({
  raw: JSON.stringify({ lines: JSON.parse(user).slots.map((s: { kind: string; templates: string[] }) => ({ kind: s.kind, template: s.templates[0] })) }),
  model: "test-model", usage: { inputTokens: 10, outputTokens: 20 },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.mocked(callClaude).mockReset();
  vi.mocked(callClaude).mockImplementation(answer);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const hour = 3_600_000;
const recolor = (t: Backend) => t.mutation(internal.riskMonitor.recolor, {});
async function load(t: Backend, pairs: ReturnType<typeof pair>[]) {
  const snapshot = await registerSnapshot(t);
  return t.mutation(internal.ingest.upsertBatch, { snapshot, pairs });
}
// Which catalog numbers (objectA) the Analyst has runs for, with the number of runs.
const runsByObject = (t: Backend) => t.run(async ctx => {
  const counts: Record<string, number> = {};
  for (const run of await ctx.db.query("agentRuns").collect()) {
    const event = await ctx.db.get(run.eventId);
    const a = await ctx.db.get(event!.objectAId);
    counts[a!.objectId] = (counts[a!.objectId] ?? 0) + 1;
  }
  return counts;
});
const eventOf = (t: Backend, objectA: string) => t.run(async ctx => {
  for (const event of await ctx.db.query("events").collect()) {
    if ((await ctx.db.get(event.objectAId))!.objectId === objectA) return event;
  }
  throw new Error("no event");
});

describe("recolor", () => {
  it("recomputes color as time passes, deactivates past TCA, and patches only what changed", async () => {
    vi.stubEnv("ANALYST_AUTOSTART", "false");
    const t = backend();
    await load(t, [pair(100, 200, 10, 2e-4), pair(101, 201, 100, 8e-4), pair(102, 202, 2, 1e-6), pair(103, 203, 200, null)]);
    expect(await recolor(t)).toEqual({ checked: 4, recolored: 0, deactivated: 0, started: 0 });
    const before = await t.run(ctx => ctx.db.query("events").collect());

    vi.setSystemTime(FIXTURE_NOW + 30 * hour);
    // Queries read stored state: nothing moves until the cron runs.
    expect(await t.query(api.events.catalogPairs, {})).toHaveLength(4);
    expect(await recolor(t)).toEqual({ checked: 4, recolored: 2, deactivated: 2, started: 0 });
    const rows = await t.query(api.events.catalogPairs, {});
    expect(rows.map(r => [r.objectA.objectId, r.color])).toEqual([["101", "red"], ["103", "none"]]);

    const after = await t.run(ctx => ctx.db.query("events").collect());
    expect(after.map(e => e.updatedAt)).toEqual(before.map(e => e.updatedAt));
    expect(after.map(e => e.active)).toEqual([false, true, false, true]);
    expect(await recolor(t)).toEqual({ checked: 2, recolored: 0, deactivated: 0, started: 0 });
  });

  it("starts the analyst for an event that turns red later", async () => {
    const t = backend();
    await load(t, [pair(100, 200, 100, 8e-4)]);
    expect(await recolor(t)).toMatchObject({ recolored: 0, started: 0 });
    vi.setSystemTime(FIXTURE_NOW + 30 * hour);
    expect(await recolor(t)).toMatchObject({ recolored: 1, started: 1 });
    expect((await eventOf(t, "100")).color).toBe("red");
  });

  it("starts the analyst for the top three red real events only, and once per evidence", async () => {
    const t = backend();
    // 101, 103, 104 are the three highest Pc; 100 and 102 are red too. 105 is yellow (TCA beyond 72 h).
    await load(t, [
      pair(100, 200, 10, 1.5e-4), pair(101, 201, 10, 5e-4), pair(102, 202, 10, 2e-4),
      pair(103, 203, 10, 4e-4), pair(104, 204, 10, 3e-4), pair(105, 205, 100, 9e-4),
    ]);
    const simulated = await insertEvent(t);
    expect(await recolor(t)).toMatchObject({ started: 3 });
    expect(await scheduledAnalystStarts(t)).toHaveLength(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await runsByObject(t)).toEqual({ "101": 1, "103": 1, "104": 1 });
    expect(await t.run(ctx => ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", simulated)).collect())).toEqual([]);
    expect(callClaude).toHaveBeenCalledTimes(3);

    // Same evidence: succeeded runs are not started again.
    vi.setSystemTime(FIXTURE_NOW + 1000);
    expect(await recolor(t)).toMatchObject({ started: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(callClaude).toHaveBeenCalledTimes(3);

    // A higher-Pc red event enters the top three; only it starts.
    vi.setSystemTime(FIXTURE_NOW + 2000);
    await load(t, [pair(106, 206, 10, 6e-4)]);
    expect(await scheduledAnalystStarts(t)).toHaveLength(3);
    expect(await recolor(t)).toMatchObject({ started: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await runsByObject(t)).toEqual({ "101": 1, "103": 1, "104": 1, "106": 1 });

    // New evidence for a top event restarts that event only.
    vi.setSystemTime(FIXTURE_NOW + 3000);
    await load(t, [pair(101, 201, 10, 5e-4, 0.1)]);
    expect(await recolor(t)).toMatchObject({ started: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await runsByObject(t)).toEqual({ "101": 2, "103": 1, "104": 1, "106": 1 });
    expect(callClaude).toHaveBeenCalledTimes(5);
  });

  it("does not restart a failed run for the same evidence", async () => {
    vi.mocked(callClaude).mockRejectedValue(new Error("upstream down"));
    const t = backend();
    await load(t, [pair(100, 200, 10, 5e-4)]);
    expect(await recolor(t)).toMatchObject({ started: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [run] = await t.run(ctx => ctx.db.query("agentRuns").collect());
    expect(run.status).toBe("failed");
    expect(await recolor(t)).toMatchObject({ started: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it("respects ANALYST_AUTOSTART=false and waits for a configured model", async () => {
    const t = backend();
    await load(t, [pair(100, 200, 10, 5e-4)]);
    vi.stubEnv("ANALYST_AUTOSTART", "false");
    expect(await recolor(t)).toMatchObject({ started: 0 });
    vi.stubEnv("ANALYST_AUTOSTART", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await recolor(t)).toMatchObject({ started: 0 });
    expect(await scheduledAnalystStarts(t)).toHaveLength(0);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
    expect(await recolor(t)).toMatchObject({ started: 1 });
  });

  it("runs every five minutes", () => {
    expect(Object.entries(crons.crons).map(([name, job]) => ({ name, fn: job.name, schedule: job.schedule }))).toEqual([
      { name: "recolor catalog events", fn: "riskMonitor:recolor", schedule: { type: "interval", minutes: 5 } },
    ]);
  });
});
