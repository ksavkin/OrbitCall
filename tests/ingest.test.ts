import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogSources, insertEvent, pair, registerSnapshot, scheduledAnalystStarts } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const rows = () => [
  pair(100, 200, 10, 2e-4),     // red
  pair(101, 201, 20, 2e-5),     // yellow
  pair(102, 202, 30, 1e-7),     // none
  pair(103, 203, 40, null),     // Pc unavailable
];

describe("snapshot registration", () => {
  it("upserts by snapshotId and keeps the document", async () => {
    const t = backend();
    const first = await registerSnapshot(t);
    const second = await registerSnapshot(t, "socrates-test", catalogSources.slice(0, 2));
    expect(second).toBe(first);
    const stored = await t.run(ctx => ctx.db.query("snapshots").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].sources).toHaveLength(2);
    expect(await registerSnapshot(t, "socrates-other")).not.toBe(first);
  });

  it("reserves the fixture: prefix", async () => {
    await expect(registerSnapshot(backend(), "fixture:red")).rejects.toThrow("reserved");
  });
});

describe("bulk loading", () => {
  it("reloading the same file keeps every _id and updatedAt and starts no analyst", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    const first = await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: rows() });
    expect(first).toEqual({ inserted: 4, updated: 0, unchanged: 0, skipped: 0, errors: [] });
    const loaded = await t.run(ctx => ctx.db.query("events").collect());
    expect(loaded.map(e => e.color).sort()).toEqual(["none", "none", "red", "yellow"]);
    expect(loaded.every(e => e.active && !e.simulated)).toBe(true);

    vi.setSystemTime(FIXTURE_NOW + 3_600_000);
    await registerSnapshot(t);
    const again = await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: rows().reverse() });
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 4, skipped: 0, errors: [] });
    expect(await t.run(ctx => ctx.db.query("events").collect())).toEqual(loaded);
    expect(await t.run(ctx => ctx.db.query("spaceObjects").collect())).toHaveLength(8);
    expect(await scheduledAnalystStarts(t)).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.query("agentRuns").collect())).toHaveLength(0);
  });

  it("moves updatedAt only for the rows whose evidence changed", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: rows() });
    const before = await t.run(ctx => ctx.db.query("events").collect());
    vi.setSystemTime(FIXTURE_NOW + 3_600_000);
    const [red, ...rest] = rows();
    const result = await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: [{ ...red, missKm: 0.2 }, ...rest] });
    expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 3 });
    const after = await t.run(ctx => ctx.db.query("events").collect());
    expect(after.map(e => e._id)).toEqual(before.map(e => e._id));
    const changed = after.filter((e, i) => e.updatedAt !== before[i].updatedAt);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ missKm: 0.2, updatedAt: FIXTURE_NOW + 3_600_000 });
    expect(await scheduledAnalystStarts(t)).toHaveLength(0);
  });

  it("skips an invalid row, reports it, and loads the rest", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    const result = await t.mutation(internal.ingest.upsertBatch, {
      snapshot, pairs: [pair(300, 400, 5, 1.5), pair(301, 401, 5, 1e-4), { ...pair(302, 402, 5, 1e-4), tcaUtc: "soon" }],
    });
    expect(result).toMatchObject({ inserted: 1, skipped: 2 });
    expect(result.errors).toHaveLength(2);
    expect(await t.run(ctx => ctx.db.query("spaceObjects").collect())).toHaveLength(2);
  });

  it("shares objects between pairs of one batch without duplicating them", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: [pair(100, 200, 5, 1e-3), pair(100, 201, 6, 1e-3), pair(100, 200, 50, 1e-3)] });
    expect(await t.run(ctx => ctx.db.query("spaceObjects").collect())).toHaveLength(3);
    expect(await t.run(ctx => ctx.db.query("events").collect())).toHaveLength(3);
  });

  it("retires this snapshot's pairs that a reload no longer lists and keeps the rest", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    const other = await registerSnapshot(t, "socrates-other");
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: rows() });
    await t.mutation(internal.ingest.upsertBatch, { snapshot: other, pairs: [pair(300, 400, 10, 2e-4)] });
    const fixture = await insertEvent(t);
    const before = await t.run(ctx => ctx.db.query("events").collect());
    expect(before.filter(e => e.active)).toHaveLength(6);

    // The new file keeps the first two rows; the second one 30 s off is still the same encounter.
    const key = (p: ReturnType<typeof pair>) => ({ objectA: p.objectA.objectId, objectB: p.objectB.objectId, tcaUtc: p.tcaUtc });
    const [first, second] = rows();
    const listed = [key(first), { ...key(second), tcaUtc: new Date(Date.parse(second.tcaUtc) + 30_000).toISOString() }];
    expect(await t.mutation(internal.ingest.retireMissing, { snapshot, pairs: listed, limit: 1 })).toEqual({ checked: 4, retired: 1 });
    expect(await t.mutation(internal.ingest.retireMissing, { snapshot, pairs: listed })).toEqual({ checked: 3, retired: 1 });
    expect(await t.mutation(internal.ingest.retireMissing, { snapshot, pairs: listed })).toEqual({ checked: 2, retired: 0 });

    const after = await t.run(ctx => ctx.db.query("events").collect());
    expect(after.map(e => e._id)).toEqual(before.map(e => e._id));
    const retired = after.filter(e => !e.active);
    expect(retired.map(e => e.pcValue).sort()).toEqual([1e-7, null]);
    expect(retired.every(e => e.snapshotId === snapshot)).toBe(true);
    expect(after.find(e => e.snapshotId === other)!.active).toBe(true);
    expect(after.find(e => e._id === fixture)!.active).toBe(true);

    // A later file that lists the pair again brings it back under the same _id.
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: [rows()[2]] });
    const revived = await t.run(ctx => ctx.db.query("events").collect());
    expect(revived.filter(e => e.active)).toHaveLength(5);
    expect(revived.map(e => e._id)).toEqual(before.map(e => e._id));
  });

  it("rejects a snapshot that was never registered", async () => {
    const t = backend();
    const snapshot = await registerSnapshot(t);
    await t.run(ctx => ctx.db.delete(snapshot));
    await expect(t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: rows() })).rejects.toThrow("Snapshot not found");
  });
});
