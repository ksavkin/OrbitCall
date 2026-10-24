import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogSources, insertEvent, insertSnapshot, pair, registerSnapshot } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

// Object ids encode the expected position in the queue: objectA 100 comes first, 112 last.
const queue = () => [
  pair(112, 212, 50, null, 1),          // Pc unavailable, latest TCA
  pair(106, 206, 5, 5e-6),              // rest with Pc, same Pc as 105 but later TCA
  pair(102, 202, 30, 3e-4),             // red, same Pc as 101 but later TCA
  pair(108, 208, 30, 1e-9),
  pair(103, 203, 100, 8e-4),            // yellow (Pc above 1e-4 but TCA beyond 72 h), higher Pc than 104
  pair(100, 200, 40, 5e-4),             // red, highest Pc
  pair(111, 211, 3, null, 5),           // Pc unavailable, same TCA as 110, larger miss
  pair(104, 204, 20, 2e-5),             // yellow
  pair(105, 205, 2, 5e-6),
  pair(109, 209, 4, 0),                 // a real zero is a value: after every positive Pc, before unavailable
  pair(107, 207, 6, 1e-7),
  pair(101, 201, 10, 3e-4),             // red, same Pc as 102, earliest TCA
  pair(110, 210, 3, null, 2),
  pair(113, 213, -1, 9e-4),             // already past TCA: not active
];

async function loaded() {
  const t = backend();
  const snapshot = await registerSnapshot(t);
  await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: queue() });
  await insertEvent(t); // a simulated fixture event, never part of the catalog
  return t;
}

describe("events.catalogPairs", () => {
  it("orders red, yellow, the rest by Pc, then Pc unavailable; skips fixtures and past TCA", async () => {
    const t = await loaded();
    const rows = await t.query(api.events.catalogPairs, { limit: 200 });
    expect(rows.map(r => r.objectA.objectId)).toEqual(Array.from({ length: 13 }, (_, i) => String(100 + i)));
    expect(rows.map(r => r.color)).toEqual([
      "red", "red", "red", "yellow", "yellow", "none", "none", "none", "none", "none", "none", "none", "none",
    ]);
    expect(rows.some(r => r.simulated)).toBe(false);
  });

  it("returns spec EventRows with nulls kept as null and Phase 1 defaults", async () => {
    const t = await loaded();
    const rows = await t.query(api.events.catalogPairs, { limit: 200 });
    const [first] = rows;
    expect(Object.keys(first).sort()).toEqual([
      "agentsStalled", "agentsWorking", "color", "eventId", "missKm", "mySide", "objectA", "objectB", "outcome", "pc",
      "relSpeedKmS", "reviewRequired", "roomOpen", "selected", "simulated", "situation", "sources", "status", "tcaUtc", "updatedAt",
    ]);
    expect(first).toMatchObject({
      mySide: null, status: "new", situation: null, selected: null, outcome: null,
      reviewRequired: false, roomOpen: false, agentsWorking: false, agentsStalled: false, simulated: false,
      tcaUtc: "2026-10-26T04:00:00Z", missKm: 0.5, relSpeedKmS: 10.5, updatedAt: "2026-10-24T12:00:00Z",
      sources: catalogSources,
      pc: {
        value: 5e-4, metric: "max_prob", source: "socrates", epochUtc: "2026-10-24T01:47:21Z",
        sourceUrl: "https://celestrak.org/SOCRATES/sort-minRange.csv", emergencyReportable: null,
      },
      objectA: {
        objectId: "100", name: "SAT 100", ownerName: null, ownerCompanyId: null, country: "US", purpose: null,
        launchDate: "2020-01-01", simulated: false, celestrakUrl: "https://celestrak.org/satcat/table-satcat.php?CATNR=100",
      },
    });
    const unavailable = rows.filter(r => r.pc.value === null);
    expect(unavailable.map(r => r.objectA.objectId)).toEqual(["110", "111", "112"]);
    expect(rows.find(r => r.objectA.objectId === "109")?.pc.value).toBe(0);
  });

  it("applies the limit: default 50, cap 200, zero is empty", async () => {
    const t = await loaded();
    expect((await t.query(api.events.catalogPairs, { limit: 3 })).map(r => r.objectA.objectId)).toEqual(["100", "101", "102"]);
    expect(await t.query(api.events.catalogPairs, { limit: 0 })).toEqual([]);
    expect(await t.query(api.events.catalogPairs, {})).toHaveLength(13);
    expect(await t.query(api.events.catalogPairs, { limit: Number.NaN })).toHaveLength(13);
    const snapshot = await registerSnapshot(t);
    const many = Array.from({ length: 220 }, (_, i) => pair(1000 + i, 2000 + i, 80 + i / 100, 1e-6));
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: many.slice(0, 100) });
    await t.mutation(internal.ingest.upsertBatch, { snapshot, pairs: many.slice(100) });
    expect(await t.query(api.events.catalogPairs, {})).toHaveLength(50);
    expect(await t.query(api.events.catalogPairs, { limit: 100000 })).toHaveLength(200);
  });

  it("reports working and stalled agents from the runs", async () => {
    const t = await loaded();
    const [top, second] = await t.query(api.events.catalogPairs, { limit: 2 });
    await t.mutation(internal.agentRuns.begin, { eventId: top.eventId });
    let rows = await t.query(api.events.catalogPairs, { limit: 2 });
    expect(rows.map(r => [r.agentsWorking, r.agentsStalled])).toEqual([[true, false], [false, false]]);
    vi.setSystemTime(FIXTURE_NOW + 61_000);
    const run = await t.run(ctx => ctx.db.query("agentRuns").first());
    await t.mutation(internal.agentRuns.watchdog, { runId: run!._id });
    rows = await t.query(api.events.catalogPairs, { limit: 2 });
    expect(rows.map(r => [r.agentsWorking, r.agentsStalled])).toEqual([[true, true], [false, false]]);
    expect(rows[1].eventId).toBe(second.eventId);
  });

  it("is empty before anything is loaded", async () => {
    expect(await backend().query(api.events.catalogPairs, {})).toEqual([]);
  });
});

describe("catalog.snapshot", () => {
  it("is null when there is no snapshot, and ignores fixture snapshots", async () => {
    const t = backend();
    expect(await t.query(api.catalog.snapshot, {})).toBeNull();
    await insertSnapshot(t);
    await insertEvent(t);
    expect(await t.query(api.catalog.snapshot, {})).toBeNull();
  });

  it("returns the newest real snapshot with the GP source as takenAt and gpUrl", async () => {
    const t = backend();
    await registerSnapshot(t, "socrates-older");
    vi.setSystemTime(FIXTURE_NOW + 1000);
    await registerSnapshot(t, "socrates-newer", catalogSources.map(s => s.name === "celestrak_gp" ? { ...s, fetchedAt: "2026-10-25T08:00:00Z" } : s));
    vi.setSystemTime(FIXTURE_NOW + 2000);
    await insertSnapshot(t); // a newer fixture does not win
    const snapshot = await t.query(api.catalog.snapshot, {});
    expect(snapshot).toEqual({
      snapshotId: "socrates-newer", takenAt: "2026-10-25T08:00:00Z", ommUrl: null,
      gpUrl: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
      sources: catalogSources.map(s => s.name === "celestrak_gp" ? { ...s, fetchedAt: "2026-10-25T08:00:00Z" } : s),
    });
  });

  it("falls back to the SOCRATES fetch time and a null gpUrl without a GP source", async () => {
    const t = backend();
    await registerSnapshot(t, "socrates-only", [catalogSources[0]]);
    expect(await t.query(api.catalog.snapshot, {})).toMatchObject({
      snapshotId: "socrates-only", takenAt: "2026-10-24T08:00:00Z", gpUrl: null, ommUrl: null,
    });
  });
});
