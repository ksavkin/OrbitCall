import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogObject, pair, registerSnapshot, type Backend } from "./helpers";

// rooms.ts is a new function file and convex/_generated is regenerated on main only (#6), so the tests reference
// it by path.
const startWorkflow = makeFunctionReference<"mutation">("rooms:startWorkflow");
const get = makeFunctionReference<"query">("rooms:get");
const byId = makeFunctionReference<"query">("rooms:byId");
const listMine = makeFunctionReference<"query">("rooms:listMine");
const join = makeFunctionReference<"mutation">("rooms:join");
const leave = makeFunctionReference<"mutation">("rooms:leave");
const setInCall = makeFunctionReference<"mutation">("rooms:setInCall");
const closeIfResolved = makeFunctionReference<"mutation">("rooms:closeIfResolved");

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
  key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212", "48213", "48214"], language: "en" as const,
  members: [
    { tokenIdentifier: token("ana"), role: "operator" as const, assignedObjectIds: ana, name: "Ana Ortiz" },
    { tokenIdentifier: token("hoa"), role: "head_of_ops" as const, assignedObjectIds: [] },
    { tokenIdentifier: token("eye"), role: "demo_observer" as const, assignedObjectIds: [] },
  ],
});
const south = {
  key: "south", name: "South Space", simulated: true, objectIds: ["25544"],
  members: [{ tokenIdentifier: token("bo"), role: "operator" as const, assignedObjectIds: ["25544"], language: "ru" as const }],
};

// The mirrored row of `cross`: objects reversed, TCA 30 s later, so ingestion keeps it as a separate event.
const crossMirror = {
  ...pair(25544, 48211, 15, 1.5e-4),
  tcaUtc: new Date(FIXTURE_NOW + 15 * 3_600_000 + 30_000).toISOString().replace(".000Z", "Z"),
};
const encounters = {
  cross: pair(48211, 25544, 15, 1.5e-4),     // red, North on side A and South on side B
  crossMirror,                                // the same encounter as South ingested it
  far: pair(48211, 25544, 40, 2e-4),         // same pair, outside the 60 s window
  red10: pair(48211, 40000, 10, 3e-4),       // red, South is not a party
  internalRed: pair(48211, 48212, 9, 3e-4),  // red, both objects North's
  past: pair(48211, 40005, -3, 1e-4),        // TCA passed: retired
};
type Name = keyof typeof encounters;

async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "48213", "48214", "25544"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  await t.mutation(internal.operators.provision, north());
  await t.mutation(internal.operators.provision, south);
  const snapshotId = await registerSnapshot(t);
  const ids = {} as Record<Name, Id<"events">>;
  for (const name of Object.keys(encounters) as Name[]) {
    const { eventId } = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...encounters[name] });
    ids[name] = eventId;
  }
  const people = await t.run(async ctx => {
    const users = await ctx.db.query("users").collect();
    const companies = await ctx.db.query("companies").collect();
    return {
      user: Object.fromEntries(users.map(u => [u.tokenIdentifier.split("|")[1], u._id])) as Record<string, Id<"users">>,
      company: Object.fromEntries(companies.map(c => [c.key, c._id])) as Record<string, Id<"companies">>,
    };
  });
  return { t, snapshotId, ids, ...people };
}
const rows = <T extends "rooms" | "roomEvents" | "roomMembers" | "call_members" | "inbox" | "messages">(t: Backend, table: T) =>
  t.run(ctx => ctx.db.query(table).collect());
const classify = (t: Backend, eventIds: Id<"events">[]) => t.run(async ctx => {
  for (const id of eventIds) await ctx.db.patch(id, { workflow: "bilateral", requiredApprovalSides: ["A", "B"] });
});

type Projection = {
  roomId: string; state: string; closedAt: string | null; myCompanyId: string;
  companies: { companyId: string; name: string; simulated: boolean }[];
  members: { userId: string; companyId: string; name: string | null; inRoom: boolean; inCall: boolean }[];
  linkedEvents: { eventId: string; mySide: string | null; workflow: string | null; canAct: boolean }[];
};

describe("rooms.startWorkflow", () => {
  it("opens one room per encounter and joins every assigned operator of both sides", async () => {
    const { t, ids, user, company } = await seed();
    const first = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    expect(first.created).toBe(true);
    expect([...first.joined].sort()).toEqual([user.ana, user.bo].sort());
    expect(await as(t, "bo").mutation(startWorkflow, { eventId: ids.crossMirror })).toEqual({ roomId: first.roomId, created: false, joined: [] });

    const [room] = await rows(t, "rooms");
    expect(room.companyIds).toEqual([company.north, company.south].sort());
    expect((await rows(t, "roomEvents")).map(l => l.eventId).sort()).toEqual([ids.cross, ids.crossMirror].sort());
    expect((await rows(t, "roomMembers")).map(m => [m.userId, m.companyId, m.inRoom, m.inCall]).sort()).toEqual([
      [user.ana, company.north, true, false], [user.bo, company.south, true, false],
    ].sort());
    // The voice call authorizes through call_members, keyed by the rooms id as a string.
    expect((await rows(t, "call_members")).map(m => [m.roomId, m.subject, m.userId, m.companyId, m.lang]).sort()).toEqual([
      [String(first.roomId), "ana", String(user.ana), String(company.north), "en"],
      [String(first.roomId), "bo", String(user.bo), String(company.south), "ru"],
    ]);

    for (const who of ["ana", "bo"]) {
      for (const eventId of [ids.cross, ids.crossMirror]) expect((await as(t, who).query(get, { eventId }))?.roomId).toBe(first.roomId);
    }
    const far = await as(t, "ana").mutation(startWorkflow, { eventId: ids.far });
    expect(far.roomId).not.toBe(first.roomId);
  });

  it("notifies the operators joined by someone else, never the one who started", async () => {
    const { t, ids, user } = await seed();
    await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const inbox = await rows(t, "inbox");
    expect(inbox.every(r => r.userId === user.bo && r.unread)).toBe(true);
    expect(inbox.map(r => r.eventId).sort()).toEqual([ids.cross, ids.crossMirror].sort());
    expect(inbox[0].lastUpdateSummary).toMatch(/^You were added to the coordination room for /);
  });

  it("returns null from rooms.get before a workflow starts", async () => {
    const { t, ids } = await seed();
    expect(await as(t, "ana").query(get, { eventId: ids.cross })).toBeNull();
  });

  it("rejects callers who are not operators of a party object, then inactive incidents", async () => {
    const { t, ids } = await seed();
    expect(await code(t.mutation(startWorkflow, { eventId: ids.cross }))).toBe("UNAUTHENTICATED");
    expect(await code(as(t, "stranger").mutation(startWorkflow, { eventId: ids.cross }))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").mutation(startWorkflow, { eventId: ids.cross }))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").query(get, { eventId: ids.cross }))).toBe("FORBIDDEN");
    expect(await code(as(t, "bo").mutation(startWorkflow, { eventId: ids.red10 }))).toBe("FORBIDDEN");
    expect(await code(as(t, "bo").mutation(startWorkflow, { eventId: ids.past }))).toBe("FORBIDDEN");   // party check first
    expect(await code(as(t, "hoa").mutation(startWorkflow, { eventId: ids.cross }))).toBe("FORBIDDEN");
    expect(await code(as(t, "ana").mutation(startWorkflow, { eventId: ids.past }))).toBe("INVALID_STATE");
    expect(await rows(t, "rooms")).toHaveLength(0);
  });
});

describe("rooms.byId / rooms.listMine / presence", () => {
  it("projects shared fields, members and stored classification", async () => {
    const { t, ids, user, company } = await seed();
    const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const ana = await as(t, "ana").query(byId, { roomId }) as Projection;
    expect(Object.keys(ana).sort()).toEqual(["closedAt", "companies", "createdAt", "linkedEvents", "members", "myCompanyId",
      "roomId", "simulated", "state"]);
    for (const c of ana.companies) expect(Object.keys(c).sort()).toEqual(["companyId", "name", "simulated"]);
    expect(ana.myCompanyId).toBe(company.north);
    expect(ana.members.find(m => m.userId === user.ana)).toMatchObject({ name: "Ana Ortiz", inRoom: true });
    // Unclassified events authorize nothing.
    expect(ana.linkedEvents.map(e => [e.eventId, e.mySide, e.workflow, e.canAct])).toEqual([
      [ids.cross, "A", null, false], [ids.crossMirror, "B", null, false],
    ]);
    await classify(t, [ids.cross, ids.crossMirror]);
    expect(((await as(t, "ana").query(byId, { roomId })) as Projection).linkedEvents.map(e => e.canAct)).toEqual([true, true]);
    expect(((await as(t, "bo").query(byId, { roomId })) as Projection).linkedEvents.map(e => [e.mySide, e.canAct])).toEqual([["B", true], ["A", true]]);
    expect(((await as(t, "hoa").query(byId, { roomId })) as Projection).linkedEvents.map(e => e.canAct)).toEqual([false, false]);
  });

  it("rejects non-members, observers and unknown rooms alike", async () => {
    const { t, ids } = await seed();
    const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: ids.red10 });
    expect(await code(as(t, "bo").query(byId, { roomId }))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").query(byId, { roomId }))).toBe("FORBIDDEN");
    expect(await code(t.query(byId, { roomId }))).toBe("UNAUTHENTICATED");
    const gone = await t.run(async ctx => {
      const id = await ctx.db.insert("rooms", { state: "open", companyIds: [], demoRunId: null, simulated: false, createdAt: 0, closedAt: null });
      await ctx.db.delete(id);
      return id;
    });
    const failure = (id: Id<"rooms">) => as(t, "bo").query(byId, { roomId: id }).then(() => null, (e: { data: unknown }) => e.data);
    expect(await failure(gone)).toEqual(await failure(roomId));
  });

  it("keeps presence per member; a head of ops only reads", async () => {
    const { t, ids, user } = await seed();
    const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    const bo = async () => ((await as(t, "ana").query(byId, { roomId })) as Projection).members.find(m => m.userId === user.bo)!;
    await as(t, "bo").mutation(leave, { roomId });
    expect(await bo()).toMatchObject({ inRoom: false, inCall: false });
    await as(t, "bo").mutation(setInCall, { roomId, inCall: true });
    expect(await bo()).toMatchObject({ inRoom: true, inCall: true });
    await as(t, "bo").mutation(join, { roomId });
    expect(await bo()).toMatchObject({ inRoom: true, inCall: true });
    expect(await code(as(t, "hoa").mutation(join, { roomId }))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").mutation(join, { roomId }))).toBe("FORBIDDEN");
  });

  it("lists the caller's open rooms and follows assignment changes", async () => {
    const { t, ids } = await seed();
    const cross = (await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross })).roomId;
    const red10 = (await as(t, "ana").mutation(startWorkflow, { eventId: ids.red10 })).roomId;
    const internalRed = (await as(t, "ana").mutation(startWorkflow, { eventId: ids.internalRed })).roomId;
    const list = async (who: string) => ((await as(t, who).query(listMine, {})) as Projection[]).map(r => r.roomId);
    expect(await list("ana")).toEqual([internalRed, red10, cross]);
    expect(await list("bo")).toEqual([cross]);
    expect(await list("hoa")).toEqual([internalRed, red10, cross]);
    await t.mutation(internal.operators.provision, north(["48212"]));
    expect(await list("ana")).toEqual([internalRed]);
    expect(await code(as(t, "ana").query(byId, { roomId: red10 }))).toBe("FORBIDDEN");
    await t.mutation(internal.operators.provision, north([]));
    expect(await list("ana")).toEqual([]);
  });
});

describe("rooms close on resolution", () => {
  it("closes once every linked incident is resolved, keeps history readable, and a new workflow opens a new room", async () => {
    const { t, ids } = await seed();
    const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    expect(await t.mutation(closeIfResolved, { eventId: ids.cross })).toBeNull();
    await t.run(ctx => ctx.db.patch(ids.cross, { status: "approved" }));
    expect(await t.mutation(closeIfResolved, { eventId: ids.cross })).toBeNull();   // the mirrored row is not resolved yet
    await t.run(ctx => ctx.db.patch(ids.crossMirror, { status: "approved" }));
    expect(await t.mutation(closeIfResolved, { eventId: ids.cross })).toBe(roomId);
    expect(await t.mutation(closeIfResolved, { eventId: ids.cross })).toBeNull();   // idempotent

    const room = await as(t, "bo").query(byId, { roomId }) as Projection;
    expect(room.state).toBe("closed");
    expect(room.closedAt).toMatch(/^2026-10-24T12:00:00/);
    expect((await rows(t, "messages")).map(m => [m.kind, m.author.kind])).toEqual([["system", "system"]]);
    expect(await code(as(t, "bo").mutation(join, { roomId }))).toBe("INVALID_STATE");
    expect(await as(t, "ana").query(get, { eventId: ids.cross })).toBeNull();
    expect(await as(t, "ana").query(listMine, {})).toEqual([]);

    const again = await as(t, "ana").mutation(startWorkflow, { eventId: ids.cross });
    expect(again.created).toBe(true);
    expect(again.roomId).not.toBe(roomId);
  });
});
