import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogObject, pair, registerSnapshot, type Backend } from "./helpers";

// fleetQuery.ts and myQueue.ts are new function files and convex/_generated is regenerated on main only (#6),
// so the tests reference them by path.
const listMine = makeFunctionReference<"query">("fleetQuery:listMine");
const myQueue = makeFunctionReference<"query">("myQueue:myQueue");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
const as = (t: Backend, name: string) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/" });
const code = async (p: Promise<unknown>) => {
  const outcome = await p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  if (outcome.ok) throw new Error(`Expected a failure, got ${JSON.stringify(outcome.value)}`);
  return (outcome.error as { data?: { code?: string } }).data?.code;
};

// North Orbital operates 48211-48214. Ana is assigned 48211 and 48212; Hoa is head of ops; Eye observes.
// South Space operates 25544; Bo is assigned to it.
const north = (ana: string[] = ["48211", "48212"]) => ({
  key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213", "48214"],
  members: [
    { tokenIdentifier: token("ana"), role: "operator" as const, assignedObjectIds: ana },
    { tokenIdentifier: token("hoa"), role: "head_of_ops" as const, assignedObjectIds: [] },
    { tokenIdentifier: token("eye"), role: "demo_observer" as const, assignedObjectIds: [] },
  ],
});
const south = {
  key: "south", name: "South Space", simulated: true, objectIds: ["25544"],
  members: [{ tokenIdentifier: token("bo"), role: "operator" as const, assignedObjectIds: ["25544"] }],
};

async function companies() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "48213", "48214", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  await t.mutation(internal.operators.provision, north());
  await t.mutation(internal.operators.provision, south);
  return t;
}

// Encounters around the fixture clock. Hours are from FIXTURE_NOW; a < b is not required: objectA is the first id.
const encounters = {
  red5: pair(40001, 48212, 5, 2e-4),         // red, Ana on side B, the earliest red
  red10hi: pair(48212, 40007, 10, 5e-4),     // red, same TCA as red10, higher Pc
  red10: pair(48211, 40000, 10, 3e-4),       // red
  cross: pair(48211, 25544, 15, 1.5e-4),     // red, North on side A and South on side B
  yellow: pair(48212, 40002, 30, 5e-5),      // yellow
  low2: pair(48211, 40003, 2, 1e-6),         // usable Pc below yellow: after every red and yellow despite its TCA
  internal: pair(48211, 48212, 20, 1e-6),    // both objects Ana's: internal review
  review6: pair(48213, 40008, 6, null),      // Pc unavailable: data review (company scope only)
  review8: pair(48213, 40004, 8, null),
  past: pair(48211, 40005, -3, 1e-4),        // TCA passed: history
  southOnly: pair(25544, 40006, 12, 2e-4),   // South's alone
};
type Name = keyof typeof encounters;

async function seed() {
  const t = await companies();
  const snapshotId = await registerSnapshot(t);
  const ids = {} as Record<Name, string>;
  for (const name of Object.keys(encounters) as Name[]) {
    const { eventId } = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters[name] });
    ids[name] = eventId;
  }
  return { t, snapshotId, ids };
}
type Row = { eventId: string; queueSection: string; rank: number; mySide: string | null; myObjectIds: string[];
  workflow: string; requiredApprovalSides: string[]; canAct: boolean; priorityReason: string; objectA: { objectId: string } };
const names = (rows: Row[], ids: Record<Name, string>) => rows.map(r => (Object.keys(ids) as Name[]).find(n => ids[n] === r.eventId) ?? r.eventId);
const queue = async (t: Backend, who: string, objectId?: string) => as(t, who).query(myQueue, objectId === undefined ? {} : { objectId }) as Promise<Row[]>;

describe("fleetQuery.listMine", () => {
  it("needs a provisioned operator or head of ops", async () => {
    const t = await companies();
    expect(await code(t.query(listMine, {}))).toBe("UNAUTHENTICATED");
    expect(await code(as(t, "stranger").query(listMine, {}))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").query(listMine, {}))).toBe("FORBIDDEN");
  });

  it("lists an operator's assigned objects with their active incident counts", async () => {
    const { t } = await seed();
    const result = await as(t, "ana").query(listMine, {});
    expect(result.assignmentVersion).toBe(1);
    expect(result.satellites.map((s: { object: { objectId: string } }) => s.object.objectId)).toEqual(["48211", "48212"]);
    expect(result.satellites[0]).toEqual({
      object: {
        objectId: "48211", name: "SAT 48211", ownerName: null, ownerCompanyId: null, country: "US", purpose: null,
        launchDate: "2020-01-01", simulated: false, celestrakUrl: "https://celestrak.org/satcat/table-satcat.php?CATNR=48211",
      },
      assignedAt: expect.stringMatching(/^2026-10-24T12:00:00/),
      position: null, orbitEpochUtc: null, freshness: "unknown",
      unresolvedIncidentCount: 4,          // red10, cross, low2, internal; `past` is retired
      lastScanId: null, scanCoverage: "not_scanned",
    });
    expect(result.satellites[1].unresolvedIncidentCount).toBe(4);   // red5, red10hi, yellow, internal
  });

  it("gives a head of ops the whole company, including objects with no incident", async () => {
    const { t } = await seed();
    const result = await as(t, "hoa").query(listMine, {});
    expect(result.satellites.map((s: { object: { objectId: string }; unresolvedIncidentCount: number }) => [s.object.objectId, s.unresolvedIncidentCount]))
      .toEqual([["48211", 4], ["48212", 4], ["48213", 2], ["48214", 0]]);
  });

  it("shows another company only its own objects", async () => {
    const { t } = await seed();
    const result = await as(t, "bo").query(listMine, {});
    expect(result.satellites.map((s: { object: { objectId: string }; unresolvedIncidentCount: number }) => [s.object.objectId, s.unresolvedIncidentCount]))
      .toEqual([["25544", 2]]);          // cross and southOnly
  });

  it("keeps an empty fleet empty and ignores revoked assignments", async () => {
    const { t } = await seed();
    await t.mutation(internal.operators.provision, north([]));
    expect(await as(t, "ana").query(listMine, {})).toEqual({ assignmentVersion: 2, satellites: [] });
    await t.mutation(internal.operators.provision, north(["48212"]));
    expect((await as(t, "ana").query(listMine, {})).satellites.map((s: { object: { objectId: string } }) => s.object.objectId)).toEqual(["48212"]);
  });

  it("shows an assignment whose catalog row is missing as its id, never invented metadata", async () => {
    const t = await companies();
    await t.run(async ctx => {
      const ana = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token("ana"))).unique())!;
      await ctx.db.insert("fleetAssignments", { userId: ana._id, objectId: "SIM-9", active: true });
    });
    const result = await as(t, "ana").query(listMine, {});
    expect(result.satellites.map((s: { object: { objectId: string; name: string; simulated: boolean; celestrakUrl: string | null } }) => s.object))
      .toContainEqual(expect.objectContaining({ objectId: "SIM-9", name: "SIM-9", country: null, simulated: true, celestrakUrl: null }));
  });
});

describe("myQueue.myQueue", () => {
  it("needs a provisioned operator or head of ops", async () => {
    const t = await companies();
    expect(await code(t.query(myQueue, {}))).toBe("UNAUTHENTICATED");
    expect(await code(as(t, "stranger").query(myQueue, {}))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").query(myQueue, {}))).toBe("FORBIDDEN");
  });

  it("returns only the caller's fleet events, in section and spec order with ranks", async () => {
    const { t, ids } = await seed();
    const rows = await queue(t, "ana");
    // Active: red by TCA (Pc breaks the tie), then yellow, then usable Pc by TCA. No data review for Ana. History last.
    expect(names(rows, ids)).toEqual(["red5", "red10hi", "red10", "cross", "yellow", "low2", "internal", "past"]);
    expect(rows.map(r => [r.queueSection, r.rank])).toEqual([
      ["active", 1], ["active", 2], ["active", 3], ["active", 4], ["active", 5], ["active", 6], ["active", 7], ["history", 1],
    ]);
    expect(rows[0].priorityReason).toBe("Red: Pc 2.0e-4, closest approach 2026-10-24T17:00:00Z, miss 0.5 km.");
    expect(rows[7].priorityReason).toBe("Closest approach passed at 2026-10-24T09:00:00Z.");
    expect(names(rows, ids)).not.toContain("review6");
    expect(names(rows, ids)).not.toContain("southOnly");
  });

  it("resolves the viewer's side on the server, and an all-own pair as an internal review", async () => {
    const { t, ids } = await seed();
    const byName = Object.fromEntries((await queue(t, "ana")).map(r => [names([r], ids)[0], r]));
    expect(byName.red5).toMatchObject({ mySide: "B", myObjectIds: ["48212"], workflow: "bilateral", requiredApprovalSides: ["A", "B"], canAct: true });
    expect(byName.red10).toMatchObject({ mySide: "A", myObjectIds: ["48211"], canAct: true });
    expect(byName.internal).toMatchObject({ mySide: null, myObjectIds: ["48211", "48212"], workflow: "internal_review", requiredApprovalSides: [], canAct: false });
    expect(byName.past).toMatchObject({ mySide: "A", queueSection: "history", canAct: false });
    // The same canonical event, seen from the other company.
    const bo = Object.fromEntries((await queue(t, "bo")).map(r => [names([r], ids)[0], r]));
    expect(Object.keys(bo).sort()).toEqual(["cross", "southOnly"]);
    expect(bo.cross).toMatchObject({ mySide: "B", myObjectIds: ["25544"], canAct: true, rank: 2 });
    expect(bo.southOnly).toMatchObject({ mySide: "A", rank: 1 });
  });

  it("gives a head of ops the company queue read-only, with data review ordered by TCA then miss", async () => {
    const { t, ids } = await seed();
    const rows = await queue(t, "hoa");
    expect(names(rows, ids)).toEqual(["red5", "red10hi", "red10", "cross", "yellow", "low2", "internal", "review6", "review8", "past"]);
    expect(rows.filter(r => r.queueSection === "data_review").map(r => r.rank)).toEqual([1, 2]);
    expect(rows.every(r => !r.canAct)).toBe(true);
    expect(rows.find(r => r.eventId === ids.review6)?.priorityReason).toBe("Probability unavailable; closest approach 2026-10-24T18:00:00Z, miss 0.5 km.");
  });

  it("filters by one object of the caller's scope and refuses any other", async () => {
    const { t, ids } = await seed();
    expect(names(await queue(t, "ana", "48212"), ids)).toEqual(["red5", "red10hi", "yellow", "internal"]);
    expect(await code(queue(t, "ana", "48213"))).toBe("FORBIDDEN");      // company object, not assigned to Ana
    expect(await code(queue(t, "ana", "25544"))).toBe("FORBIDDEN");      // another company's
    expect(await code(queue(t, "ana", "99999"))).toBe("FORBIDDEN");      // unknown: not revealed either way
    expect(names(await queue(t, "hoa", "48213"), ids)).toEqual(["review6", "review8"]);
    expect(await queue(t, "hoa", "48214")).toEqual([]);
  });

  it("keeps one row per encounter when the same pair is loaded again", async () => {
    const { t, snapshotId, ids } = await seed();
    await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters.red10 });
    const rows = await queue(t, "ana");
    expect(rows.filter(r => r.eventId === ids.red10)).toHaveLength(1);
    expect(rows).toHaveLength(8);
  });

  it("follows assignment changes", async () => {
    const { t, ids } = await seed();
    await t.mutation(internal.operators.provision, north(["48211"]));
    const rows = await queue(t, "ana");
    expect(names(rows, ids)).toEqual(["red10", "cross", "low2", "internal", "past"]);
    expect(rows.find(r => r.eventId === ids.internal)).toMatchObject({ mySide: "A", myObjectIds: ["48211"], workflow: "bilateral", canAct: true });
    await t.mutation(internal.operators.provision, north([]));
    expect(await queue(t, "ana")).toEqual([]);
  });
});
