// @vitest-environment node
// The export and refresh actions run in a `"use node"` file that loads `pg`, so this file runs in Node.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { AnalystError } from "../convex/lib/analyst";
import { TIGER_SOURCES, connectTiger, observationKey, type SqlResult, type TigerConnection, type TigerObservation } from "../convex/lib/tiger";
import { sourceName } from "../convex/lib/validators";
import { exportKey, toSeriesPoints, toTigerObservation } from "../convex/lib/tigerExport";
import { exportWith, readHistory } from "../convex/historyActions";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, insertEvent, type Backend } from "./helpers";

vi.mock("../convex/lib/tiger", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/tiger")>(), connectTiger: vi.fn(),
}));

const SECRET_URL = "postgres://tsdbadmin:SECRET-password@abc123.tsdb.cloud.timescale.com:34567/tsdb";
const pgError = (code: string) => Object.assign(new Error(`connection to ${SECRET_URL} failed`), { code });
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

// An in-memory observations hypertable that answers the adapter's statements the way Postgres would:
// INSERT ... ON CONFLICT (observation_key, observed_at) DO NOTHING, and the ranked per-series SELECT.
type Row = {
  observation_key: string; event_id: string; run_id: string | null; observed_at: Date; source: string; metric: string;
  value: number | null; evidence_version: string; simulated: boolean;
};
const tiger = {
  rows: new Map<string, Row>(),
  statements: [] as string[],
  connects: 0,
  connectError: null as Error | null,
  // Fails the first statement whose text matches.
  failOn: null as { match: RegExp; error: Error } | null,
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const oldestFirst = (a: Row, b: Row) => a.observed_at.getTime() - b.observed_at.getTime() || compare(a.source, b.source)
  || compare(a.metric, b.metric) || compare(a.observation_key, b.observation_key);
const fakeConnection = (): TigerConnection => ({
  async sql(text: string, values: unknown[] = []): Promise<SqlResult> {
    tiger.statements.push(normalize(text));
    if (tiger.failOn?.match.test(text)) throw tiger.failOn.error;
    if (text.startsWith("INSERT")) {
      let inserted = 0;
      for (let i = 0; i < values.length; i += 9) {
        const [key, eventId, runId, observedAt, source, metric, value, evidenceVersion, simulated] = values.slice(i, i + 9);
        const pair = `${String(key)}\u0000${String(observedAt)}`;
        if (tiger.rows.has(pair)) continue;
        tiger.rows.set(pair, {
          observation_key: key as string, event_id: eventId as string, run_id: runId as string | null,
          observed_at: new Date(observedAt as string), source: source as string, metric: metric as string,
          value: value as number | null, evidence_version: evidenceVersion as string, simulated: simulated as boolean,
        });
        inserted += 1;
      }
      return { rows: [], rowCount: inserted };
    }
    if (text.startsWith("SELECT observation_key")) {
      let rows = [...tiger.rows.values()].filter(row => row.event_id === values[0]);
      const metric = /metric = \$(\d+)/.exec(text);
      if (metric) rows = rows.filter(row => row.metric === values[Number(metric[1]) - 1]);
      const run = /run_id = \$(\d+)/.exec(text);
      if (/run_id IS NULL/.test(text)) rows = rows.filter(row => row.run_id === null);
      else if (run) rows = rows.filter(row => row.run_id === values[Number(run[1]) - 1]);
      const limit = values[values.length - 1] as number;
      const ranked = [false, true].flatMap(simulated =>
        rows.filter(row => row.simulated === simulated).sort((a, b) => oldestFirst(b, a)).slice(0, limit));
      return { rows: ranked.sort(oldestFirst), rowCount: ranked.length };
    }
    return { rows: [], rowCount: null };
  },
  async end() {},
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  tiger.rows.clear(); tiger.statements = []; tiger.connects = 0; tiger.connectError = null; tiger.failOn = null;
  vi.mocked(connectTiger).mockReset().mockImplementation(async () => {
    tiger.connects += 1;
    if (tiger.connectError) throw tiger.connectError;
    return fakeConnection();
  });
});
afterEach(() => { vi.useRealTimers(); });

const token = (name: string) => `https://fixture.invalid|${name}`;
const as = (t: Backend, name: string) => t.withIdentity({ tokenIdentifier: token(name) });
const finish = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);
const scheduled = (t: Backend, name: string) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter(f => f.name === name));

// One red fixture event (side A: SIM-0001, side B: 25544) and no candidate set. Company A owns side A: operator "a"
// is assigned to it, "unassigned" is not, "head-a" is its head of ops, "observer" is a demo observer. Company B owns
// side B with operator "b". Company C owns an unrelated satellite with its own operator and head of ops.
async function setup() {
  const t = backend();
  const eventId = await insertEvent(t);
  await t.run(ctx => ctx.db.insert("spaceObjects", { objectId: "SIM-0099", name: "Unrelated", country: null, launchDate: null }));
  const { companyId } = await t.mutation(internal.operators.provision, {
    key: "history-a", name: "History A", simulated: true, objectIds: ["SIM-0001"], members: [
      { tokenIdentifier: token("a"), role: "operator", assignedObjectIds: ["SIM-0001"] },
      { tokenIdentifier: token("unassigned"), role: "operator", assignedObjectIds: [] },
      { tokenIdentifier: token("head-a"), role: "head_of_ops", assignedObjectIds: [] },
      { tokenIdentifier: token("observer"), role: "demo_observer", assignedObjectIds: [] },
    ],
  });
  await t.mutation(internal.operators.provision, {
    key: "history-b", name: "History B", simulated: true, objectIds: ["25544"], members: [
      { tokenIdentifier: token("b"), role: "operator", assignedObjectIds: ["25544"] },
    ],
  });
  await t.mutation(internal.operators.provision, {
    key: "history-c", name: "History C", simulated: true, objectIds: ["SIM-0099"], members: [
      { tokenIdentifier: token("c"), role: "operator", assignedObjectIds: ["SIM-0099"] },
      { tokenIdentifier: token("head-c"), role: "head_of_ops", assignedObjectIds: [] },
    ],
  });
  return { t, eventId, companyId };
}
const LEASE_MS = 5 * 60_000;
const demoRun = (t: Backend, scenario: string) => t.run(ctx => ctx.db.insert("demoRuns", {
  scenario, state: "open", startedBy: null, manifest: null, startedAt: FIXTURE_NOW, closedAt: null,
}));

type Input = {
  observedAt: string; source: TigerObservation["source"]; metric: string; value: number | null;
  evidenceVersion: string; simulated: boolean; runId: Id<"demoRuns"> | null;
};
const realMiss = (patch: Partial<Input> = {}): Input => ({
  observedAt: "2026-10-24T10:30:00Z", source: "socrates", metric: "missKm", value: 0.18,
  evidenceVersion: "socrates-2026-10-24", simulated: false, runId: null, ...patch,
});
const record = (t: Backend, eventId: Id<"events">, observation: Input) =>
  t.mutation(internal.history.recordObservation, { eventId, observation });
const exports = (t: Backend) => t.run(ctx => ctx.db.query("observationExports").collect());
const cache = (t: Backend, eventId: Id<"events">) =>
  t.run(ctx => ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique());

describe("recordObservation", () => {
  it("is idempotent: the same observation twice is one export row and one scheduled export", async () => {
    const { t, eventId } = await setup();
    const first = await record(t, eventId, realMiss());
    const second = await record(t, eventId, realMiss({ observedAt: "2026-10-24T10:30:00.000Z" }));
    expect(first).toEqual({ observationKey: first.observationKey, status: "queued" });
    expect(second).toEqual({ observationKey: first.observationKey, status: "unchanged" });
    const rows = await exports(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId, demoRunId: null, observedAtMs: Date.parse("2026-10-24T10:30:00Z"), source: "socrates", metric: "missKm",
      value: 0.18, evidenceVersion: "socrates-2026-10-24", simulated: false, exportState: "pending", attempts: 0, lastError: null,
    });
    expect(await scheduled(t, "historyActions:exportObservation")).toHaveLength(1);
  });

  it("builds the exact key the Tiger client builds, including the time partition", async () => {
    const { t, eventId } = await setup();
    const { observationKey: key } = await record(t, eventId, realMiss({ observedAt: "2026-10-24T10:30:00.250Z" }));
    expect(key).toBe(observationKey({ ...realMiss({ observedAt: "2026-10-24T10:30:00.250Z" }), eventId }));
    expect(key).toBe(`${eventId}||socrates|missKm|socrates-2026-10-24|2026-10-24T10:30:00.250Z`);
    expect((await exports(t))[0].observationKey).toBe(key);
  });

  it("rejects different content under an existing key and leaves the stored row alone", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await expect(record(t, eventId, realMiss({ value: 0.25 }))).rejects.toThrow("INVALID_STATE");
    await expect(record(t, eventId, realMiss({ value: null }))).rejects.toThrow("INVALID_STATE");
    await expect(record(t, eventId, realMiss({ simulated: true }))).rejects.toThrow("INVALID_STATE");
    const rows = await exports(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0.18);
    expect(await scheduled(t, "historyActions:exportObservation")).toHaveLength(1);
  });

  it("rejects invalid observations before anything is stored", async () => {
    const { t, eventId } = await setup();
    for (const bad of [
      realMiss({ observedAt: "2026-10-24T10:30:00.123456Z" }), realMiss({ observedAt: "2026-10-24 10:30" }),
      realMiss({ metric: "miss km" }), realMiss({ value: Number.NaN }), realMiss({ value: Number.POSITIVE_INFINITY }),
      realMiss({ evidenceVersion: "v|1" }), realMiss({ evidenceVersion: "" }),
      realMiss({ source: "simulated", simulated: false }),
    ]) {
      await expect(record(t, eventId, bad)).rejects.toThrow("INVALID_INPUT");
    }
    await t.run(ctx => ctx.db.delete(eventId));
    await expect(record(t, eventId, realMiss())).rejects.toThrow("NOT_FOUND");
    expect(await exports(t)).toHaveLength(0);
    expect(await scheduled(t, "historyActions:exportObservation")).toHaveLength(0);
  });

  it("accepts simulated evidence only under the event's current demo run, and real evidence only without a run", async () => {
    const { t, eventId } = await setup();
    const [current, old] = [await demoRun(t, "current"), await demoRun(t, "old")];
    const sim = (runId: Id<"demoRuns"> | null) => realMiss({ source: "simulated", simulated: true, evidenceVersion: "sim-v1", runId });
    // An event outside any demo run takes simulated evidence without a run label.
    expect((await record(t, eventId, sim(null))).status).toBe("queued");
    await expect(record(t, eventId, sim(current))).rejects.toThrow("INVALID_INPUT");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: current }));
    expect((await record(t, eventId, sim(current))).status).toBe("queued");
    await expect(record(t, eventId, sim(old))).rejects.toThrow("INVALID_INPUT");
    await expect(record(t, eventId, sim(null))).rejects.toThrow("INVALID_INPUT");
    // A simulated spacecraft screened against a real source is simulated evidence and follows the same rule.
    await expect(record(t, eventId, realMiss({ simulated: true, runId: old }))).rejects.toThrow("INVALID_INPUT");
    await expect(record(t, eventId, realMiss({ runId: current }))).rejects.toThrow("INVALID_INPUT");
    expect((await record(t, eventId, realMiss())).status).toBe("queued");
    expect(await exports(t)).toHaveLength(3);
  });

  it("queues a pending export again once its lease has expired, and not before", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    const { updatedAt } = (await exports(t))[0];
    vi.setSystemTime(updatedAt + LEASE_MS);
    expect((await record(t, eventId, realMiss())).status).toBe("unchanged");
    expect(await scheduled(t, "historyActions:exportObservation")).toHaveLength(1);
    vi.setSystemTime(updatedAt + LEASE_MS + 1);
    expect((await record(t, eventId, realMiss())).status).toBe("retried");
    expect(await scheduled(t, "historyActions:exportObservation")).toHaveLength(2);
    expect((await exports(t))[0]).toMatchObject({ exportState: "pending", attempts: 0 });
    expect((await exports(t))[0].updatedAt).toBeGreaterThan(updatedAt + LEASE_MS);
    // Both scheduled exports may run; Tiger skips the repeat and the row settles once.
    await finish(t);
    expect(tiger.rows.size).toBe(1);
    expect((await exports(t))[0]).toMatchObject({ exportState: "exported", attempts: 1 });
  });
});

describe("export and refresh", () => {
  it("exports once, marks the row exported, and publishes a new cache version", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    const [row] = await exports(t);
    expect(row).toMatchObject({ exportState: "exported", attempts: 1, lastError: null });
    expect(tiger.rows.size).toBe(1);
    expect(tiger.statements.filter(s => s.startsWith("INSERT"))[0]).toContain("ON CONFLICT (observation_key, observed_at) DO NOTHING");
    const first = await cache(t, eventId);
    expect(first).toMatchObject({ seriesVersion: 1, stale: false, error: null });
    // Running the scheduled steps advances the fake clock by a few milliseconds.
    expect(first!.fetchedAt).toBeGreaterThanOrEqual(FIXTURE_NOW);
    expect(first!.points).toEqual([{ atUtc: "2026-10-24T10:30:00Z", pc: null, missKm: 0.18, source: "socrates", simulated: false }]);

    // A second metric at the same instant joins the same point; the version advances.
    await record(t, eventId, realMiss({ metric: "pc", value: 2.1e-4 }));
    await finish(t);
    const second = await cache(t, eventId);
    expect(second!.seriesVersion).toBe(2);
    expect(second!.points).toEqual([{ atUtc: "2026-10-24T10:30:00Z", pc: 2.1e-4, missKm: 0.18, source: "socrates", simulated: false }]);
  });

  it("does not export a row twice when the export runs again", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    const [row] = await exports(t);
    await t.action(internal.historyActions.exportObservation, { exportId: row._id });
    expect(tiger.statements.filter(s => s.startsWith("INSERT"))).toHaveLength(1);
    expect((await exports(t))[0].attempts).toBe(1);
  });

  it("on failure marks the row failed and the chart stale, retries a bounded number of times, and changes no approval", async () => {
    const { t, eventId, companyId } = await setup();
    // A valid, current human approval and selection that the history path must never touch.
    const approvalsBefore = await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token("a"))).unique();
      const proposalId = await ctx.db.insert("proposals", {
        eventId, candidateId: "P1", label: "Raise orbit", latestRevision: 1, demoRunId: null, createdAt: FIXTURE_NOW,
      });
      await ctx.db.insert("selections", {
        eventId, proposalId, revision: 1, generation: 1, by: { kind: "human", userId: user!._id }, at: FIXTURE_NOW, lastReset: null,
      });
      await ctx.db.insert("approvals", {
        eventId, side: "A", status: "approved", userId: user!._id, companyId, proposalId, revision: 1, selectionGeneration: 1,
        approvalRuleVersion: 1, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null, demoRunId: null,
        current: true, at: FIXTURE_NOW,
      });
      return {
        approvals: await ctx.db.query("approvals").collect(), selections: await ctx.db.query("selections").collect(),
        event: await ctx.db.get(eventId),
      };
    });

    tiger.connectError = pgError("ECONNREFUSED");
    await record(t, eventId, realMiss());
    await finish(t);
    const [row] = await exports(t);
    expect(row.exportState).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(tiger.connects).toBe(3);
    expect(row.lastError).toMatch(/^UPSTREAM_UNAVAILABLE: /);
    expect(row.lastError).not.toContain("SECRET");
    expect(row.lastError).not.toContain("timescale");
    expect(await cache(t, eventId)).toMatchObject({ stale: true, seriesVersion: 0, points: [], error: row.lastError });
    expect(await as(t, "a").query(api.history.series, { eventId })).toEqual({
      real: [], simulated: [], stale: true, error: row.lastError, fetchedAt: null, seriesVersion: null,
    });
    const after = await t.run(async ctx => ({
      approvals: await ctx.db.query("approvals").collect(), selections: await ctx.db.query("selections").collect(),
      event: await ctx.db.get(eventId),
    }));
    expect(after).toEqual(approvalsBefore);

    // Recording the same observation again after the retries ran out starts a new bounded round.
    tiger.connectError = null;
    expect((await record(t, eventId, realMiss())).status).toBe("retried");
    await finish(t);
    expect((await exports(t))[0]).toMatchObject({ exportState: "exported", attempts: 1, lastError: null });
    expect(await cache(t, eventId)).toMatchObject({ stale: false, seriesVersion: 1, error: null });
  });

  it("does not retry a failure that a retry cannot fix", async () => {
    const { t, eventId } = await setup();
    vi.mocked(connectTiger).mockRejectedValue(new AnalystError("HISTORY_NOT_CONFIGURED", "Set TIGER_DATABASE_URL in this Convex deployment."));
    await record(t, eventId, realMiss());
    await finish(t);
    expect((await exports(t))[0]).toMatchObject({ exportState: "failed", attempts: 1 });
    expect((await exports(t))[0].lastError).toMatch(/^HISTORY_NOT_CONFIGURED: /);
    expect((await cache(t, eventId))!.stale).toBe(true);
  });

  it("does not schedule a second export while a retry is still pending", async () => {
    const { t, eventId } = await setup();
    tiger.connectError = pgError("ECONNREFUSED");
    await record(t, eventId, realMiss());
    // Start only the first attempt; the retry it schedules stays pending.
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    expect((await exports(t))[0]).toMatchObject({ exportState: "failed", attempts: 1 });
    expect((await record(t, eventId, realMiss())).status).toBe("unchanged");
    expect((await scheduled(t, "historyActions:exportObservation")).filter(f => f.state.kind === "pending")).toHaveLength(1);
  });

  it("claims one export at a time and keeps concurrent duplicate deliveries inside the retry limit", async () => {
    const { t, eventId } = await setup();
    tiger.connectError = pgError("ECONNREFUSED");
    await record(t, eventId, realMiss());
    const [row] = await exports(t);
    await Promise.all([
      t.action(internal.historyActions.exportObservation, { exportId: row._id }),
      t.action(internal.historyActions.exportObservation, { exportId: row._id }),
    ]);
    await finish(t);
    expect((await exports(t))[0]).toMatchObject({ exportState: "failed", attempts: 3 });
    expect(tiger.connects).toBe(3);
    await t.action(internal.historyActions.exportObservation, { exportId: row._id });
    expect(tiger.connects).toBe(3);
  });

  it("ignores a lost attempt's failure after an explicit lease recovery starts a new round", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    vi.mocked(connectTiger).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + LEASE_MS + 1);
      expect((await record(t, eventId, realMiss())).status).toBe("retried");
      throw new AnalystError("HISTORY_NOT_CONFIGURED", "Old attempt failed.");
    });
    await finish(t);
    expect((await exports(t))[0]).toMatchObject({ exportState: "exported", attempts: 1, lastError: null });
    expect((await cache(t, eventId))!.stale).toBe(false);
  });

  it("keeps the last good points and marks them stale when a later export or read fails", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    tiger.failOn = { match: /^INSERT/, error: pgError("57014") };
    await record(t, eventId, realMiss({ observedAt: "2026-10-24T11:30:00Z", value: 0.2 }));
    await finish(t);
    const stale = await cache(t, eventId);
    expect(stale).toMatchObject({ stale: true, seriesVersion: 1 });
    expect(stale!.points).toHaveLength(1);
    expect(stale!.error).toMatch(/^UPSTREAM_UNAVAILABLE: .*timed out/);

    // A failed read keeps the cache too; a refresh never clears staleness while an export is still failed.
    tiger.failOn = { match: /^SELECT observation_key/, error: pgError("ECONNRESET") };
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(await cache(t, eventId)).toMatchObject({ stale: true, seriesVersion: 1 });
    tiger.failOn = null;
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(await cache(t, eventId)).toMatchObject({ stale: true, seriesVersion: 2 });
  });

  const point = { atUtc: "2026-10-24T10:30:00Z", pc: null, missKm: 0.18, source: "socrates", simulated: false };
  const store = async (t: Backend, eventId: Id<"events">, fetchedAt: number, baseVersion: number, points = [point]) =>
    t.mutation(internal.history.storeSeries, { ...(await t.query(internal.history.seriesScope, { eventId }))!, eventId, points, fetchedAt, baseVersion });
  const failRead = async (t: Backend, eventId: Id<"events">, fetchedAt: number, baseVersion: number) =>
    t.mutation(internal.history.markSeriesFailed, { ...(await t.query(internal.history.seriesScope, { eventId }))!, eventId, code: "UPSTREAM_UNAVAILABLE", message: "Retry later.", fetchedAt, baseVersion });

  it("orders reads by start time and the cache version they started from, so an older read never wins a tie", async () => {
    const { t, eventId } = await setup();
    expect(await store(t, eventId, FIXTURE_NOW, 0)).toEqual({ stored: true });
    // Started earlier: dropped.
    expect(await store(t, eventId, FIXTURE_NOW - 1, 0, [])).toEqual({ stored: false });
    // Same start time, but started before version 1 was published: dropped.
    expect(await store(t, eventId, FIXTURE_NOW, 0, [])).toEqual({ stored: false });
    expect(await cache(t, eventId)).toMatchObject({ seriesVersion: 1, points: [point] });
    // Same start time, started after version 1 was published: stored.
    expect(await store(t, eventId, FIXTURE_NOW, 1, [])).toEqual({ stored: true });
    expect(await cache(t, eventId)).toMatchObject({ seriesVersion: 2, points: [] });
    expect(await store(t, eventId, FIXTURE_NOW + 1, 0)).toEqual({ stored: true });
    expect((await cache(t, eventId))!.seriesVersion).toBe(3);
  });

  it("ignores a failed read that is older than the cached one", async () => {
    const { t, eventId } = await setup();
    await store(t, eventId, FIXTURE_NOW, 0);
    expect(await failRead(t, eventId, FIXTURE_NOW - 1, 0)).toEqual({ marked: false });
    expect(await failRead(t, eventId, FIXTURE_NOW, 0)).toEqual({ marked: false });
    expect(await cache(t, eventId)).toMatchObject({ stale: false, error: null, seriesVersion: 1 });
    expect(await failRead(t, eventId, FIXTURE_NOW, 1)).toEqual({ marked: true });
    expect(await cache(t, eventId)).toMatchObject({ stale: true, error: "UPSTREAM_UNAVAILABLE: Retry later.", seriesVersion: 1, points: [point] });
  });

  it("marks the cache stale while any export of the event is still pending", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await store(t, eventId, FIXTURE_NOW, 0);
    expect(await cache(t, eventId)).toMatchObject({ stale: true, error: null, seriesVersion: 1 });
    await finish(t);
    expect(await cache(t, eventId)).toMatchObject({ stale: false, seriesVersion: 2 });
  });
});

describe("history.series", () => {
  it("serves real and simulated series separately, the current demo run only for simulated points, nulls kept", async () => {
    const { t, eventId } = await setup();
    const [currentRun, oldRun] = [await demoRun(t, "current"), await demoRun(t, "old")];
    const sim = (patch: Partial<Input>) => realMiss({ source: "simulated", simulated: true, evidenceVersion: "sim-v1", runId: currentRun, ...patch });
    // Recorded while the event belonged to the old run, before the reset moved it to the current one.
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: oldRun }));
    await record(t, eventId, sim({ observedAt: "2026-10-24T08:00:00Z", value: 9, runId: oldRun }));
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: currentRun }));
    for (const observation of [
      realMiss({ observedAt: "2026-10-24T09:00:00Z", value: 0.3 }),
      realMiss({ observedAt: "2026-10-24T09:00:00Z", metric: "pc", value: null }),
      realMiss({ observedAt: "2026-10-24T10:00:00Z", source: "cdm_public", metric: "pc", value: 1.5e-4 }),
      sim({ observedAt: "2026-10-24T09:30:00Z", value: 0.05 }),
      sim({ observedAt: "2026-10-24T09:30:00Z", metric: "pc", value: 3e-3 }),
    ]) await record(t, eventId, observation);
    await finish(t);
    const series = await as(t, "a").query(api.history.series, { eventId });
    expect(series).toEqual({
      real: [
        { atUtc: "2026-10-24T09:00:00Z", pc: null, missKm: 0.3, source: "socrates" },
        { atUtc: "2026-10-24T10:00:00Z", pc: 1.5e-4, missKm: null, source: "cdm_public" },
      ],
      simulated: [{ atUtc: "2026-10-24T09:30:00Z", pc: 3e-3, missKm: 0.05, source: "simulated" }],
      // Refreshes that started in the same millisecond from an older cache version are dropped, so the count varies.
      stale: false, error: null, fetchedAt: expect.any(Number), seriesVersion: expect.any(Number),
    });
  });

  it("returns an empty, unversioned series before the first read", async () => {
    const { t, eventId } = await setup();
    expect(await as(t, "a").query(api.history.series, { eventId })).toEqual({
      real: [], simulated: [], stale: false, error: null, fetchedAt: null, seriesVersion: null,
    });
  });

  it("serves assigned operators of either side and the owning company's head of ops, with no candidate set", async () => {
    const { t, eventId } = await setup();
    expect(await t.run(ctx => ctx.db.query("candidateSets").collect())).toHaveLength(0);
    for (const name of ["a", "b", "head-a"]) {
      expect((await as(t, name).query(api.history.series, { eventId })).seriesVersion).toBeNull();
    }
  });

  it("refuses callers who are not signed in or not assigned to the incident", async () => {
    const { t, eventId } = await setup();
    await expect(t.query(api.history.series, { eventId })).rejects.toThrow("UNAUTHENTICATED");
    await expect(as(t, "stranger").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
    await expect(as(t, "unassigned").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
    await expect(as(t, "observer").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
    // Another company, with an active assignment and a head of ops of its own, but on neither object of this event.
    await expect(as(t, "c").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
    await expect(as(t, "head-c").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
    await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token("a"))).unique();
      const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user!._id)).first();
      await ctx.db.patch(assignment!._id, { active: false });
    });
    await expect(as(t, "a").query(api.history.series, { eventId })).rejects.toThrow("FORBIDDEN");
  });
});

describe("history freshness across exports and demo resets", () => {
  const sim = (runId: Id<"demoRuns">): Input => realMiss({
    source: "simulated", simulated: true, runId, evidenceVersion: "sim-v1",
  });
  const close = (t: Backend, runId: Id<"demoRuns">) =>
    t.run(ctx => ctx.db.patch(runId, { state: "closed", closedAt: Date.now() }));

  it("marks an existing chart stale as soon as another observation is committed", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    await record(t, eventId, realMiss({ observedAt: "2026-10-24T11:00:00Z", value: 0.2 }));
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({ stale: true });
  });

  it("rejects new observations after the demo run is closed", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closed");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await close(t, runId);
    await expect(record(t, eventId, sim(runId))).rejects.toThrow("INVALID_STATE");
    expect(await exports(t)).toHaveLength(0);
  });

  it("does not start queued exports or cache reads after reset", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closed");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await record(t, eventId, sim(runId));
    await close(t, runId);
    await finish(t);
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(tiger.connects).toBe(0);
    expect((await exports(t))[0].exportState).not.toBe("exported");
  });

  it("does not publish or retry an export that settles after reset", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closing");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await record(t, eventId, sim(runId));
    const db = fakeConnection();
    vi.mocked(connectTiger).mockResolvedValue({
      ...db, async sql(text, values) {
        if (text.startsWith("INSERT")) await close(t, runId);
        return db.sql(text, values);
      },
    });
    await finish(t);
    expect((await exports(t))[0].exportState).not.toBe("exported");
    expect(await scheduled(t, "historyActions:refreshSeries")).toHaveLength(0);
  });

  it("discards a Tiger read when the run closes while SQL is running", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closing");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await record(t, eventId, sim(runId));
    await finish(t);
    const before = await cache(t, eventId);
    const db = fakeConnection();
    vi.mocked(connectTiger).mockResolvedValue({
      ...db, async sql(text, values) {
        if (text.startsWith("SELECT observation_key")) await close(t, runId);
        return db.sql(text, values);
      },
    });
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(await cache(t, eventId)).toEqual(before);
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({ simulated: [], stale: true });
  });

  it("hides the previous run's cached simulation immediately when an event changes runs", async () => {
    const { t, eventId } = await setup();
    const [oldRun, newRun] = [await demoRun(t, "old"), await demoRun(t, "new")];
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: oldRun }));
    await record(t, eventId, sim(oldRun));
    await finish(t);
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: newRun }));
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({ simulated: [], stale: true });
    await record(t, eventId, { ...sim(newRun), value: 0.4 });
    await finish(t);
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({
      simulated: [{ missKm: 0.4 }], stale: false,
    });
  });

  it("keeps archived real observations visible when the simulated run closes", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closed");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await record(t, eventId, realMiss());
    await record(t, eventId, sim(runId));
    await finish(t);
    await close(t, runId);
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({
      real: [{ missKm: 0.18, source: "socrates" }], simulated: [], stale: true,
    });
  });

  it("ignores a failed read after reset without changing the archived cache", async () => {
    const { t, eventId } = await setup();
    const runId = await demoRun(t, "closing");
    await t.run(ctx => ctx.db.patch(eventId, { demoRunId: runId }));
    await record(t, eventId, sim(runId));
    await finish(t);
    const before = await cache(t, eventId);
    const db = fakeConnection();
    vi.mocked(connectTiger).mockResolvedValue({
      ...db, async sql(text, values) {
        if (text.startsWith("SELECT observation_key")) {
          await close(t, runId);
          throw pgError("ECONNRESET");
        }
        return db.sql(text, values);
      },
    });
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(await cache(t, eventId)).toEqual(before);
  });

  it("cannot clear a newer read failure with an older successful response", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    const older = (await t.query(internal.history.seriesScope, { eventId }))!;
    const before = (await cache(t, eventId))!;
    await t.mutation(internal.history.markSeriesFailed, {
      eventId, ...older, fetchedAt: FIXTURE_NOW + 20, code: "UPSTREAM_UNAVAILABLE", message: "Retry later.",
    });
    expect(await t.mutation(internal.history.storeSeries, {
      eventId, ...older, fetchedAt: FIXTURE_NOW + 10, points: before.points,
    })).toEqual({ stored: false });
    expect(await cache(t, eventId)).toMatchObject({ stale: true, error: "UPSTREAM_UNAVAILABLE: Retry later." });
  });

  it("does not let an earlier read mark a newly committed observation fresh", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss());
    await finish(t);
    const before = await cache(t, eventId);
    const db = fakeConnection();
    let changed = false;
    vi.mocked(connectTiger).mockResolvedValue({
      ...db, async sql(text, values) {
        const result = await db.sql(text, values);
        if (text.startsWith("SELECT observation_key") && !changed) {
          changed = true;
          await record(t, eventId, realMiss({ observedAt: "2026-10-24T11:00:00Z", value: 0.2 }));
        }
        return result;
      },
    });
    await t.action(internal.historyActions.refreshSeries, { eventId });
    expect(await cache(t, eventId)).toMatchObject({ seriesVersion: before!.seriesVersion, stale: true });
    await finish(t);
    expect(await as(t, "a").query(api.history.series, { eventId })).toMatchObject({ stale: false });
    expect((await cache(t, eventId))!.points).toHaveLength(2);
  });
});

describe("Tiger export mapping", () => {
  const base = { eventId: "event-1", runId: null, observedAt: "2026-10-24T10:30:00Z", source: "socrates" as const, metric: "missKm", evidenceVersion: "v3" };

  it("builds the same key as tiger.observationKey and rejects the same inputs", () => {
    for (const input of [
      base, { ...base, runId: "run-7" }, { ...base, observedAt: "2026-10-24T10:30:00.000Z" },
      { ...base, observedAt: "2026-10-24T10:30:00.1Z" }, { ...base, observedAt: "2026-10-24T10:30:00.250Z" },
      { ...base, source: "simulated" as const, metric: "pc" }, { ...base, metric: "max_prob" },
    ]) expect(exportKey(input)).toBe(observationKey(input));
    for (const bad of [
      { ...base, eventId: "evt|x" }, { ...base, eventId: " " }, { ...base, runId: "" }, { ...base, runId: "run|7" },
      { ...base, observedAt: "2026-02-30T10:30:00Z" }, { ...base, observedAt: "2026-10-24T10:30:00+00:00" },
      { ...base, observedAt: "2026-10-24T10:30:00.1234Z" }, { ...base, source: "spacetrack" as never },
      { ...base, metric: "Miss" }, { ...base, evidenceVersion: "a\nb" }, { ...base, evidenceVersion: "x".repeat(129) },
    ]) {
      expect(() => observationKey(bad)).toThrow();
      expect(() => exportKey(bad)).toThrow();
    }
  });

  it("maps a stored export row to the Tiger row with its canonical time and run label", async () => {
    const { t, eventId } = await setup();
    await record(t, eventId, realMiss({ observedAt: "2026-10-24T10:30:00.500Z", value: null }));
    const [row] = await exports(t);
    expect(toTigerObservation(row)).toEqual({
      observationKey: row.observationKey, eventId, runId: null, observedAt: "2026-10-24T10:30:00.500Z", source: "socrates",
      metric: "missKm", value: null, evidenceVersion: "socrates-2026-10-24", simulated: false,
    });
  });

  it("pivots metrics into points without merging sources, evidence versions, or runs, and ignores other metrics", () => {
    const point = (patch: Partial<TigerObservation>): TigerObservation => {
      const row = { ...base, value: 1, simulated: false, ...patch };
      return { ...row, observationKey: observationKey(row) };
    };
    expect(toSeriesPoints([
      point({ metric: "missKm", value: 0.4 }), point({ metric: "pc", value: null }), point({ metric: "relSpeedKmS", value: 10 }),
      point({ metric: "pc", value: 1e-4, source: "cdm_public" }),
      point({ metric: "missKm", value: 0.5, evidenceVersion: "v4" }),
      point({ metric: "relSpeedKmS", observedAt: "2026-10-24T11:00:00Z" }),
    ])).toEqual([
      { atUtc: "2026-10-24T10:30:00Z", pc: null, missKm: 0.4, source: "socrates", simulated: false },
      { atUtc: "2026-10-24T10:30:00Z", pc: 1e-4, missKm: null, source: "cdm_public", simulated: false },
      { atUtc: "2026-10-24T10:30:00Z", pc: null, missKm: 0.5, source: "socrates", simulated: false },
    ]);
  });

  it("exports through the table setup and one idempotent insert, and reads real history apart from run-scoped simulation", async () => {
    const observation = toTigerObservation({
      observationKey: `event-1||socrates|missKm|v3|2026-10-24T10:30:00Z`, eventId: "event-1" as Id<"events">, demoRunId: null,
      observedAtMs: Date.parse("2026-10-24T10:30:00Z"), source: "socrates", metric: "missKm", value: 0.18, evidenceVersion: "v3",
      simulated: false, exportState: "pending", attempts: 0, lastError: null, updatedAt: 0,
      _id: "x" as Id<"observationExports">, _creationTime: 0,
    });
    const db = fakeConnection();
    await expect(exportWith(db, observation)).resolves.toEqual({ written: 1, skipped: 0 });
    await expect(exportWith(db, observation)).resolves.toEqual({ written: 0, skipped: 1 });
    expect(tiger.statements.slice(0, 6).map(s => s.split(" ")[0])).toEqual(["BEGIN", "SELECT", "CREATE", "SELECT", "CREATE", "COMMIT"]);
    expect(tiger.statements[6]).toMatch(/^INSERT INTO observations .* ON CONFLICT \(observation_key, observed_at\) DO NOTHING$/);

    tiger.statements = [];
    await readHistory(db, "event-1", "run-7");
    expect(tiger.statements).toHaveLength(2);
    expect(tiger.statements[0]).toContain("WHERE event_id = $1 AND run_id IS NULL) AS ranked");
    expect(tiger.statements[1]).toContain("WHERE event_id = $1 AND run_id = $2) AS ranked");
    // Outside a demo run one read serves both series.
    tiger.statements = [];
    await readHistory(db, "event-1", null);
    expect(tiger.statements).toHaveLength(1);
    expect(tiger.statements[0]).toContain("WHERE event_id = $1 AND run_id IS NULL) AS ranked");
  });

  it("knows exactly the source names the Tiger client accepts", () => {
    expect(sourceName.members.map(member => member.value).sort()).toEqual([...TIGER_SOURCES].sort());
  });
});

describe("approval boundary", () => {
  // The default-runtime files cannot load `pg`; the history path reaches only its own two tables.
  const code = (file: string) => readFileSync(new URL(`../convex/${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("keeps Node-only modules out of the mutation files and names no approval or workflow table", () => {
    for (const file of ["history.ts", "lib/tigerExport.ts"]) {
      expect(code(file)).not.toMatch(/^import (?!type )[^;]*from "(\.\.?\/)+(lib\/)?tiger"/m);
      expect(code(file)).not.toMatch(/from "pg"|from "node:/);
    }
    for (const file of ["history.ts", "historyActions.ts", "lib/tigerExport.ts"]) {
      expect(code(file)).not.toMatch(/approv|selections|proposals|maneuvers|candidateSets"/i);
      for (const [, table] of code(file).matchAll(/ctx\.db\.insert\("(\w+)"/g)) expect(["observationExports", "historySeries"]).toContain(table);
    }
  });
});
