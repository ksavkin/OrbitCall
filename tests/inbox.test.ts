import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogObject, pair, registerSnapshot, type Backend } from "./helpers";

// inbox.ts and rooms.ts are new function files and convex/_generated is regenerated on main only (#6), so the
// tests reference them by path.
const list = makeFunctionReference<"query">("inbox:list");
const get = makeFunctionReference<"query">("inbox:get");
const markRead = makeFunctionReference<"mutation">("inbox:markRead");
const startWorkflow = makeFunctionReference<"mutation">("rooms:startWorkflow");
const join = makeFunctionReference<"mutation">("rooms:join");
const leave = makeFunctionReference<"mutation">("rooms:leave");

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
const north = {
  key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213", "48214"],
  country: "US", language: "en" as const, contact: "ops@north.example",
  members: [
    { tokenIdentifier: token("ana"), role: "operator" as const, assignedObjectIds: ["48211", "48212"], name: "Ana Ortiz" },
    { tokenIdentifier: token("hoa"), role: "head_of_ops" as const, assignedObjectIds: [], name: "Hoa Tran" },
    { tokenIdentifier: token("eye"), role: "demo_observer" as const, assignedObjectIds: [] },
  ],
};
const south = {
  key: "south", name: "South Space", simulated: true, objectIds: ["25544"], contact: "ops@south.example", language: "ru" as const,
  members: [{ tokenIdentifier: token("bo"), role: "operator" as const, assignedObjectIds: ["25544"] }],
};

const encounters = {
  red5: pair(40001, 48212, 5, 2e-4),         // red, Ana on side B
  cross: pair(48211, 25544, 15, 1.5e-4),     // red, North on side A and South on side B
  yellow: pair(48212, 40002, 30, 5e-5),      // yellow
  internal: pair(48211, 48212, 20, 1e-6),    // both objects Ana's: internal review
  review6: pair(48213, 40008, 6, null),      // Pc unavailable (company scope only)
  past: pair(48211, 40005, -3, 1e-4),        // TCA passed
  southOnly: pair(25544, 40006, 12, 2e-4),   // South's alone
};
type Name = keyof typeof encounters;

async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "48213", "48214", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  await t.mutation(internal.operators.provision, north);
  await t.mutation(internal.operators.provision, south);
  const snapshotId = await registerSnapshot(t);
  const ids = {} as Record<Name, string>;
  for (const name of Object.keys(encounters) as Name[]) {
    const { eventId } = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters[name] });
    ids[name] = eventId;
  }
  return { t, snapshotId, ids };
}

type Owner = { companyId: string; name: string; country: string | null; language: string | null; contact: string | null; simulated: boolean };
type Entry = {
  eventId: string; unread: boolean; section: string; title: string; status: string; situation: null; mySide: string | null;
  workflow: string; lastUpdateAt: string; lastUpdateSummary: string; missing: string[];
  sides: { side: string; mine: boolean; object: { objectId: string }; owner: Owner | null }[];
  room: { roomId: string; joined: boolean; otherSideJoined: boolean; otherSidePresenceAt: string | null } | null;
};
const inbox = async (t: Backend, who: string) => (await as(t, who).query(list, {})) as Entry[];
const names = (rows: Entry[], ids: Record<Name, string>) => rows.map(r => (Object.keys(ids) as Name[]).find(n => ids[n] === r.eventId));
const entry = async (t: Backend, who: string, eventId: string) => (await inbox(t, who)).find(e => e.eventId === eventId)!;
const companyIds = (t: Backend) => t.run(async ctx =>
  Object.fromEntries((await ctx.db.query("companies").collect()).map(c => [c.key, c._id as string])));

describe("inbox.list / inbox.markRead", () => {
  it("needs a provisioned operator or head of ops", async () => {
    const { t, ids } = await seed();
    expect(await code(t.query(list, {}))).toBe("UNAUTHENTICATED");
    expect(await code(t.mutation(markRead, { eventId: ids.cross }))).toBe("UNAUTHENTICATED");
    for (const who of ["stranger", "eye"]) {
      expect(await code(as(t, who).query(list, {}))).toBe("FORBIDDEN");
      expect(await code(as(t, who).mutation(markRead, { eventId: ids.cross }))).toBe("FORBIDDEN");
    }
  });

  it("lists only the caller's incidents, newest update first", async () => {
    const { t, snapshotId, ids } = await seed();
    expect(names(await inbox(t, "ana"), ids).sort()).toEqual(["cross", "internal", "past", "red5", "yellow"]);
    expect(names(await inbox(t, "bo"), ids).sort()).toEqual(["cross", "southOnly"]);
    expect(names(await inbox(t, "hoa"), ids).sort()).toEqual(["cross", "internal", "past", "red5", "review6", "yellow"]);
    expect((await inbox(t, "ana")).every(e => e.unread)).toBe(true);

    vi.setSystemTime(FIXTURE_NOW + 60_000);
    await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters.cross, missKm: 0.7 });
    const [first] = await inbox(t, "ana");
    expect(first.eventId).toBe(ids.cross);
    expect(first.lastUpdateAt).toBe("2026-10-24T12:01:00Z");
  });

  it("derives section, title, summary, side and workflow", async () => {
    const { t, ids } = await seed();
    const ana = await inbox(t, "ana");
    const of = (name: Name) => ana.find(e => e.eventId === ids[name])!;
    expect(of("past")).toMatchObject({ section: "previous", lastUpdateSummary: "Closest approach passed at 2026-10-24T09:00:00Z." });
    expect(of("red5")).toMatchObject({ section: "attention", mySide: "B", title: "SAT 48212 × SAT 40001" });
    expect(of("internal")).toMatchObject({ mySide: null, title: "SAT 48211 × SAT 48212" });
    const review6 = await entry(t, "hoa", ids.review6);
    expect(review6.section).toBe("watch");
    expect(review6.lastUpdateSummary).toMatch(/^Probability unavailable; /);
    for (const e of ana) expect([e.status, e.situation, e.workflow]).toEqual(["new", null, null]);
  });

  it("marks an entry read for the caller only and never approves or resolves anything", async () => {
    const { t, ids } = await seed();
    const event = () => t.run(ctx => ctx.db.get(ids.cross as never));
    const before = await event();
    expect(await as(t, "ana").mutation(markRead, { eventId: ids.cross })).toBeNull();
    expect((await entry(t, "ana", ids.cross)).unread).toBe(false);
    expect((await entry(t, "bo", ids.cross)).unread).toBe(true);
    expect((await entry(t, "hoa", ids.cross)).unread).toBe(true);
    expect(await event()).toEqual(before);
    const reads = () => t.run(async ctx => (await ctx.db.query("inbox").collect()).length);
    expect(await reads()).toBe(1);
    await as(t, "ana").mutation(markRead, { eventId: ids.cross });
    expect(await reads()).toBe(1);
  });

  it("flags the same entry unread again when evidence or risk changes", async () => {
    const { t, snapshotId, ids } = await seed();
    await as(t, "ana").mutation(markRead, { eventId: ids.cross });
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters.cross, missKm: 0.7 });
    expect((await entry(t, "ana", ids.cross)).unread).toBe(true);
    await as(t, "ana").mutation(markRead, { eventId: ids.cross });
    expect((await entry(t, "ana", ids.cross)).unread).toBe(false);

    vi.setSystemTime(FIXTURE_NOW + 16 * 3_600_000);
    await t.mutation(internal.riskMonitor.recolor, {});
    const retired = await entry(t, "ana", ids.cross);
    expect(retired.section).toBe("previous");
    expect(retired.unread).toBe(true);
  });
});

describe("inbox owners, contacts and inbox.get", () => {
  it("shows each side with its owner's shareable contact and nothing private", async () => {
    const { t, ids } = await seed();
    const company = await companyIds(t);
    const cross = await entry(t, "ana", ids.cross);
    expect(cross.sides[0]).toMatchObject({
      side: "A", mine: true, object: { objectId: "48211" },
      owner: { companyId: company.north, name: "North Orbital", country: "US", language: "en", contact: "ops@north.example", simulated: false },
    });
    expect(cross.sides[1]).toMatchObject({
      side: "B", mine: false, object: { objectId: "25544" },
      owner: { companyId: company.south, name: "South Space", country: null, language: "ru", contact: "ops@south.example", simulated: true },
    });
    for (const s of cross.sides) expect(Object.keys(s.owner!).sort()).toEqual(["companyId", "contact", "country", "language", "name", "simulated"]);
    expect(cross.missing.filter(m => m.startsWith("owner:"))).toEqual([]);

    const red5 = await entry(t, "ana", ids.red5);
    expect(red5.sides[0].owner).toBeNull();
    expect(red5.missing).toContain("owner:A");

    await t.mutation(internal.operators.provision, { ...south, contact: "" });
    expect((await entry(t, "ana", ids.cross)).missing).toContain("contact:B");
  });

  it("lists what is unavailable", async () => {
    const { t, ids } = await seed();
    expect((await entry(t, "hoa", ids.review6)).missing).toContain("pc");
    for (const e of await inbox(t, "hoa")) expect(e.missing).toEqual(expect.arrayContaining(["spread", "room"]));
  });

  it("opens one incident and hides the rest", async () => {
    const { t, ids } = await seed();
    expect(await as(t, "ana").query(get, { eventId: ids.cross })).toEqual(await entry(t, "ana", ids.cross));
    expect(await code(as(t, "ana").query(get, { eventId: ids.southOnly }))).toBe("NOT_FOUND");
    expect(await code(as(t, "ana").query(get, { eventId: ids.review6 }))).toBe("NOT_FOUND");
    expect((await as(t, "hoa").query(get, { eventId: ids.review6 })).eventId).toBe(ids.review6);
    expect(await code(as(t, "ana").mutation(markRead, { eventId: ids.southOnly }))).toBe("NOT_FOUND");
    expect(await code(as(t, "ana").mutation(markRead, { eventId: ids.review6 }))).toBe("NOT_FOUND");
    expect(await t.run(async ctx => (await ctx.db.query("inbox").collect()).length)).toBe(0);
  });
});

describe("inbox room presence and notices", () => {
  it("shows whether the other side is in the room; colleagues never count", async () => {
    const { t, ids } = await seed();
    const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const room = async (who: string) => (await entry(t, who, ids.cross)).room;
    // Start workflow joins both sides.
    expect(await room("ana")).toEqual({ roomId, joined: true, otherSideJoined: true, otherSidePresenceAt: expect.stringMatching(/^2026-10-24T12:00:00/) });
    expect((await entry(t, "ana", ids.cross)).missing).not.toContain("room");
    await as(t, "bo").mutation(leave, { roomId });
    expect(await room("ana")).toMatchObject({ joined: true, otherSideJoined: false, otherSidePresenceAt: null });
    expect(await room("bo")).toMatchObject({ joined: false, otherSideJoined: true });
    await as(t, "ana").mutation(leave, { roomId });
    expect((await room("bo"))?.otherSideJoined).toBe(false);
    await as(t, "bo").mutation(join, { roomId });
    expect((await room("ana"))?.otherSideJoined).toBe(true);
    expect((await room("hoa"))?.otherSideJoined).toBe(true);
    expect((await room("hoa"))?.joined).toBe(false);
  });

  it("no room, no flag", async () => {
    const { t, ids } = await seed();
    await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const yellow = await entry(t, "ana", ids.yellow);
    expect(yellow.room).toBeNull();
    expect(yellow.missing).toContain("room");
  });

  it("tells the operator joined by someone else, until they read it", async () => {
    const { t, ids } = await seed();
    await as(t, "bo").mutation(markRead, { eventId: ids.cross });
    expect((await entry(t, "bo", ids.cross)).unread).toBe(false);
    vi.setSystemTime(FIXTURE_NOW + 5_000);
    await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const notice = await entry(t, "bo", ids.cross);
    expect(notice).toMatchObject({ unread: true, lastUpdateAt: "2026-10-24T12:00:05Z" });
    expect(notice.lastUpdateSummary).toMatch(/^You were added to the coordination room for 48211 \u00d7 25544\.$/);
    expect((await inbox(t, "bo"))[0].eventId).toBe(ids.cross);   // the notice is the newest update
    await as(t, "bo").mutation(markRead, { eventId: ids.cross });
    const read = await entry(t, "bo", ids.cross);
    expect(read.unread).toBe(false);
    expect(read.lastUpdateSummary).toMatch(/^Red: /);
  });
});
