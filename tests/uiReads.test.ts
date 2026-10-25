import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateEvent } from "../fixtures/policies";
import { insertEvent, type Backend } from "./helpers";
import { as, code, fn, pick, proposalId, seed, tick, userId } from "./decision";

// UI read models: log.list, config.flags, the extended proposal card and rooms.forEvent. log.ts and config.ts are
// new function files and convex/_generated is regenerated on main only, so the tests reference them by path.
const logList = makeFunctionReference<"query">("log:list");
const flags = makeFunctionReference<"query">("config:flags");
const forEvent = makeFunctionReference<"query">("rooms:forEvent");
const roomGet = makeFunctionReference<"query">("rooms:get");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function cancelQueued(t: Backend) {
  await t.run(async ctx => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

type Actor =
  | { kind: "human"; userId: string; name: string; side: "A" | "B" | null }
  | { kind: "agent"; role: string; side: "A" | "B" | null }
  | { kind: "system" };
type Entry = {
  logId: string; at: string; eventId: string | null; actor: Actor; action: string; summary: string;
  texts: Record<string, string> | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  proposalId: string | null; revision: number | null; simulated: boolean;
};
type Page = { entries: Entry[]; nextCursor: string | null };
const list = (t: Backend, name: string, args: { eventId?: Id<"events">; cursor?: string } = {}) =>
  as(t, name).query(logList, args) as Promise<Page>;

type LogRow = Omit<Doc<"log">, "_id" | "_creationTime">;
const logRow = (eventId: Id<"events"> | null, at: number, patch: Partial<LogRow> = {}): LogRow => ({
  eventId, actor: { kind: "system" }, action: "status_changed", summary: `System line at ${at}`, texts: null,
  before: null, after: null, proposalId: null, revision: null, roomId: null, demoRunId: null, simulated: true, at, ...patch,
});
const insertLog = (t: Backend, row: LogRow) => t.run(ctx => ctx.db.insert("log", row));
const companyOf = async (t: Backend, name: string) => {
  const id = await userId(t, name);
  return t.run(async ctx => (await ctx.db.get(id))!.companyId);
};

// An event of company C only (SIM-3001 against an uncatalogued object), with no tie to A or B.
const otherEvent = (t: Backend) => insertEvent(t, {
  ...advocateEvent, tcaUtc: "2026-10-25T06:00:00Z",
  objectA: { ...advocateEvent.objectA, objectId: "SIM-3001", name: "Company C fixture" },
  objectB: { ...advocateEvent.objectA, objectId: "SIM-3999", name: "Unowned fixture" },
});

describe("log.list", () => {
  it("returns shared entries of the event in the projected shape, hiding private policy changes and foreign agents", async () => {
    const { t, eventId } = await seed();
    const b = await userId(t, "b");
    const [companyA, companyB] = [await companyOf(t, "a"), await companyOf(t, "b")];
    const at = (i: number) => FIXTURE_NOW + 60_000 + i * 1000;
    const P2 = await proposalId(t, eventId, "P2");
    const ids = {
      approvedByB: await insertLog(t, logRow(eventId, at(1), {
        actor: { kind: "human", userId: b, companyId: companyB, name: "B", side: "B" }, action: "approved",
        summary: "Side B approved P2 revision 1.", proposalId: P2, revision: 1,
        before: { status: "pending" }, after: { status: "approved" }, texts: { en: "Side B approved P2 revision 1." } })),
      policyByB: await insertLog(t, logRow(eventId, at(2), {
        actor: { kind: "human", userId: b, companyId: companyB, name: "B", side: "B" }, action: "policy_changed",
        summary: "Company B changed fuel reserve." })),
      agentOfA: await insertLog(t, logRow(eventId, at(3), {
        actor: { kind: "agent", role: "operator_advocate", companyId: companyA, side: "A" }, action: "negotiation",
        summary: "Advocate A private line." })),
      sharedAgent: await insertLog(t, logRow(eventId, at(4), {
        actor: { kind: "agent", role: "coordination_host", companyId: null, side: null }, action: "negotiation",
        summary: "Coordination Host shared line." })),
      system: await insertLog(t, logRow(eventId, at(5), { summary: "Shared system line." })),
    };
    const forA = (await list(t, "a", { eventId })).entries;
    const forB = (await list(t, "b", { eventId })).entries;
    const idsOf = (entries: Entry[]) => new Set(entries.map(e => e.logId));
    const seenA = idsOf(forA), seenB = idsOf(forB);

    for (const id of [ids.approvedByB, ids.sharedAgent, ids.system]) {
      expect(seenA.has(id)).toBe(true);
      expect(seenB.has(id)).toBe(true);
    }
    // Another company's policy change and another company's agent line are never shared.
    expect(seenA.has(ids.policyByB)).toBe(false);
    expect(seenB.has(ids.agentOfA)).toBe(false);
    // The author's own company still reads them.
    expect(seenB.has(ids.policyByB)).toBe(true);
    expect(seenA.has(ids.agentOfA)).toBe(true);

    const approved = forA.find(e => e.logId === ids.approvedByB)!;
    expect(approved).toEqual({
      logId: ids.approvedByB, at: expect.any(String), eventId, action: "approved",
      actor: { kind: "human", userId: b, name: "B", side: "B" },
      summary: "Side B approved P2 revision 1.", texts: { en: "Side B approved P2 revision 1." },
      before: { status: "pending" }, after: { status: "approved" }, proposalId: P2, revision: 1, simulated: true,
    });
    expect(Date.parse(approved.at)).toBe(at(1));
    expect(approved.at).toMatch(/^2026-10-24T\d\d:\d\d:\d\d(\.\d+)?Z$/);
    expect(forA.find(e => e.logId === ids.sharedAgent)!.actor).toEqual({ kind: "agent", role: "coordination_host", side: null });
    expect(forB.find(e => e.logId === ids.system)!.actor).toEqual({ kind: "system" });
    expect(JSON.stringify([forA, forB])).not.toContain("companyId");
    // Newest first.
    const mine = forA.filter(e => Object.values(ids).includes(e.logId as Id<"log">)).map(e => e.logId);
    expect(mine).toEqual([ids.system, ids.sharedAgent, ids.agentOfA, ids.approvedByB]);
  });

  it("shows the approval reset written by a reselection to both sides", async () => {
    const { t, eventId } = await seed();
    await pick(t, "a", eventId, "P2");
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await pick(t, "b", eventId, "P4");
    const stored = await t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).collect());
    const reset = stored.find(r => r.action === "approvals_reset");
    expect(reset).toBeDefined();
    for (const name of ["a", "b", "head"]) {
      const entries = (await list(t, name, { eventId })).entries;
      expect(entries.find(e => e.logId === reset!._id)).toMatchObject({ action: "approvals_reset", actor: { kind: "system" }, eventId });
    }
  });

  it("pages 50 entries at a time, newest first, without overlap", async () => {
    const { t, eventId } = await seed();
    const total = 110;
    await t.run(async ctx => {
      for (let i = 0; i < total; i++) await ctx.db.insert("log", logRow(eventId, FIXTURE_NOW + 10_000 + i * 1000, { summary: `Line ${i}` }));
    });
    const stored = await t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).collect());
    const first = await list(t, "a", { eventId });
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries[0].summary).toBe(`Line ${total - 1}`);
    expect(first.entries[49].summary).toBe(`Line ${total - 50}`);
    const second = await list(t, "a", { eventId, cursor: first.nextCursor! });
    expect(second.entries).toHaveLength(50);
    expect(second.nextCursor).not.toBeNull();
    expect(second.entries[0].summary).toBe(`Line ${total - 51}`);
    const pages = [first.entries, second.entries];
    let cursor = second.nextCursor;
    while (cursor !== null) {
      const page = await list(t, "a", { eventId, cursor });
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(50);
      pages.push(page.entries);
      cursor = page.nextCursor;
      expect(pages.length).toBeLessThan(10);
    }
    const all = pages.flat();
    expect(new Set(all.map(e => e.logId)).size).toBe(all.length);
    expect(new Set(all.map(e => e.logId))).toEqual(new Set(stored.map(r => r._id)));
    const times = all.map(e => Date.parse(e.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it("without an event lists only shared rows of the caller's own events", async () => {
    const { t, eventId } = await seed();
    const other = await otherEvent(t);
    const mine = await insertLog(t, logRow(eventId, FIXTURE_NOW + 1000, { summary: "Shared line of the A-B event." }));
    const theirs = await insertLog(t, logRow(other, FIXTURE_NOW + 2000, { summary: "Line of the C event." }));
    const global = await insertLog(t, logRow(null, FIXTURE_NOW + 3000, { summary: "Line without an event." }));
    const companyB = await companyOf(t, "b");
    const policy = await insertLog(t, logRow(eventId, FIXTURE_NOW + 4000, {
      actor: { kind: "human", userId: await userId(t, "b"), companyId: companyB, name: "B", side: "B" }, action: "policy_changed",
      summary: "Company B changed a policy category." }));

    const forA = (await list(t, "a")).entries.map(e => e.logId);
    expect(forA).toContain(mine);
    expect(forA).not.toContain(theirs);
    expect(forA).not.toContain(global);
    expect(forA).not.toContain(policy);
    const forC = (await list(t, "c")).entries.map(e => e.logId);
    expect(forC).toContain(theirs);
    expect(forC).not.toContain(mine);
    expect(forC).not.toContain(global);
    const forB = (await list(t, "b")).entries.map(e => e.logId);
    expect(forB).toContain(mine);
    expect(forB).toContain(policy);
    expect(forB).not.toContain(theirs);
    expect((await list(t, "a")).entries.every(e => e.eventId !== null)).toBe(true);
  });

  it("guards the event filter: parties only, observers and strangers refused", async () => {
    const { t, eventId } = await seed();
    const other = await otherEvent(t);
    await insertLog(t, logRow(eventId, FIXTURE_NOW + 1000));
    expect((await list(t, "head", { eventId })).entries.length).toBeGreaterThan(0);
    expect(await code(list(t, "eye", { eventId }))).toBe("FORBIDDEN");
    expect(await code(list(t, "c", { eventId }))).toBe("FORBIDDEN");
    expect(await code(list(t, "a", { eventId: other }))).toBe("FORBIDDEN");
    expect(await code(t.query(logList, { eventId }))).toBe("UNAUTHENTICATED");
    expect(await code(t.query(logList, {}))).toBe("UNAUTHENTICATED");
  });
});

describe("config.flags", () => {
  const names = ["DEMO_LAUNCH", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "SCHEDULE_SERVICE_URL",
    "SCHEDULE_SERVICE_TOKEN", "XAI_API_KEY"] as const;
  const secret = (tag: string, length = 40) => `${tag}-${"q".repeat(length)}`.slice(0, length);
  const allOn = {
    DEMO_LAUNCH: "on", LIVEKIT_URL: "wss://voice-fixture.livekit.example", LIVEKIT_API_KEY: "APIfixturekey123",
    LIVEKIT_API_SECRET: secret("livekitsecret"), SCHEDULE_SERVICE_URL: "https://schedule-fixture.example/api",
    SCHEDULE_SERVICE_TOKEN: secret("scheduletoken", 32), XAI_API_KEY: secret("xaikey"),
  };
  type Flags = { demoLaunch: boolean; voice: boolean; droid: boolean; secondModel: boolean };
  const stub = (values: Partial<Record<(typeof names)[number], string>>) => {
    for (const name of names) vi.stubEnv(name, values[name] ?? "");
  };
  const read = (t: Backend) => t.query(flags, {}) as Promise<Flags>;
  beforeEach(() => stub({}));

  it("reports every feature off with nothing configured, without authentication", async () => {
    const { t } = await seed();
    const result = await read(t);
    expect(Object.keys(result).sort()).toEqual(["demoLaunch", "droid", "secondModel", "voice"]);
    expect(result).toEqual({ demoLaunch: false, voice: false, droid: false, secondModel: false });
  });

  it("reports every feature on when fully configured and never echoes a configured value", async () => {
    const { t } = await seed();
    stub(allOn);
    const result = await read(t);
    expect(result).toEqual({ demoLaunch: true, voice: true, droid: true, secondModel: true });
    const text = JSON.stringify(result);
    for (const value of Object.values(allOn)) if (value !== "on") expect(text).not.toContain(value);
    expect(text).not.toContain("example");
    expect(await as(t, "eye").query(flags, {})).toEqual(result);
  });

  it("turns the demo launch on only for the exact value on", async () => {
    const { t } = await seed();
    for (const [value, expected] of [["on", true], ["true", false], ["ON", false], ["1", false], ["", false]] as const) {
      stub({ ...allOn, DEMO_LAUNCH: value });
      expect((await read(t)).demoLaunch).toBe(expected);
    }
  });

  it("needs all three voice credentials", async () => {
    const { t } = await seed();
    for (const missing of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const) {
      stub({ ...allOn, [missing]: "" });
      expect(await read(t)).toEqual({ demoLaunch: true, voice: false, droid: true, secondModel: true });
    }
  });

  it("needs a valid https schedule service URL (or local http) and a token of at least 32 characters", async () => {
    const { t } = await seed();
    const cases: [string, string, boolean][] = [
      ["https://schedule-fixture.example/api", secret("t", 32), true],
      ["http://localhost:3000", secret("t", 32), true],
      ["https://schedule-fixture.example/api", secret("t", 31), false],
      ["https://schedule-fixture.example/api", "", false],
      ["http://schedule-fixture.example/api", secret("t", 32), false],
      ["not a url", secret("t", 32), false],
      ["", secret("t", 32), false],
    ];
    for (const [url, tokenValue, expected] of cases) {
      stub({ ...allOn, SCHEDULE_SERVICE_URL: url, SCHEDULE_SERVICE_TOKEN: tokenValue });
      const result = await read(t);
      expect({ url, length: tokenValue.length, droid: result.droid }).toEqual({ url, length: tokenValue.length, droid: expected });
      expect(JSON.stringify(result)).not.toContain(tokenValue || "never-empty");
    }
  });

  it("turns the second model on only with an xAI key", async () => {
    const { t } = await seed();
    stub({ ...allOn, XAI_API_KEY: "" });
    expect((await read(t)).secondModel).toBe(false);
    stub({ XAI_API_KEY: secret("xai") });
    expect(await read(t)).toEqual({ demoLaunch: false, voice: false, droid: false, secondModel: true });
  });
});

describe("proposals.list latest revision details", () => {
  type Latest = Record<string, unknown> & {
    revision: number; candidateId: string; schedulePreviewDiff: string | null; changeSummary: string | null;
    sourceMessageIds: string[];
    rationale: { text: string; numbersChecked: true; secondModel: { agrees: boolean; note: string } | null } | null;
  };
  type Card = Record<string, unknown> & { label: string; latest: Latest };
  const added = ["candidateId", "schedulePreviewDiff", "changeSummary", "sourceMessageIds", "rationale"];
  const withoutAdded = (cards: Card[]) => cards.map(c => ({
    ...c, latest: Object.fromEntries(Object.entries(c.latest).filter(([k]) => !added.includes(k))) }));
  const revisionOf = (t: Backend, id: Id<"proposals">) => t.run(async ctx =>
    (await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", id).eq("revision", 1)).unique())!._id);

  it("carries the stored diff, change summary, source messages and only a checked rationale", async () => {
    const { t, eventId } = await seed();
    const before = await as(t, "a").query(fn.list, { eventId }) as Card[];
    const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
    await cancelQueued(t);
    const { messageId: first } = await as(t, "a").mutation(api.messages.send, { roomId, eventId, text: "Prefer a later burn." });
    vi.setSystemTime(FIXTURE_NOW + 1000);
    const { messageId: second } = await as(t, "b").mutation(api.messages.send, { roomId, eventId, text: "We can move instead." });
    await cancelQueued(t);
    const [P2, P3, P4] = await Promise.all(["P2", "P3", "P4"].map(id => proposalId(t, eventId, id)));
    const diff = "--- a/schedule.yaml\n+++ b/schedule.yaml\n@@\n+- burn: P2\n";
    const [r2, r3, r4] = [await revisionOf(t, P2), await revisionOf(t, P3), await revisionOf(t, P4)];
    await t.run(async ctx => {
      await ctx.db.patch(r2, {
        schedulePreviewDiff: diff, changeSummary: "Burn moved after the imaging window.", sourceMessageIds: [first, second],
        rationale: { text: "P2 keeps both reserves.", numbersChecked: true, secondModel: { agrees: false, note: "Margin is thin." } },
      });
      await ctx.db.patch(r3, {
        changeSummary: "Side A moves.", rationale: { text: "P3 is cheapest.", numbersChecked: true, secondModel: null },
      });
      await ctx.db.patch(r4, {
        rationale: { text: "Unchecked claim 9.99 kg.", numbersChecked: false, secondModel: null },
      });
    });
    const cards = await as(t, "b").query(fn.list, { eventId }) as Card[];
    expect(cards.map(c => c.label)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(cards.map(c => c.latest.candidateId)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(cards[0].latest).toMatchObject({ schedulePreviewDiff: null, changeSummary: null, sourceMessageIds: [], rationale: null });
    expect(cards[1].latest).toMatchObject({
      schedulePreviewDiff: diff, changeSummary: "Burn moved after the imaging window.", sourceMessageIds: [first, second],
      rationale: { text: "P2 keeps both reserves.", numbersChecked: true, secondModel: { agrees: false, note: "Margin is thin." } },
    });
    expect(cards[1].latest.rationale).toEqual({ text: "P2 keeps both reserves.", numbersChecked: true, secondModel: { agrees: false, note: "Margin is thin." } });
    expect(cards[2].latest).toMatchObject({ schedulePreviewDiff: null, changeSummary: "Side A moves.", sourceMessageIds: [] });
    expect(cards[2].latest.rationale).toEqual({ text: "P3 is cheapest.", numbersChecked: true, secondModel: null });
    // An unchecked rationale never reaches the card.
    expect(cards[3].latest.rationale).toBeNull();
    expect(JSON.stringify(cards)).not.toContain("Unchecked claim");
    // Existing fields are unchanged.
    expect(withoutAdded(cards)).toEqual(withoutAdded(before));
    expect(withoutAdded(await as(t, "a").query(fn.list, { eventId }) as Card[])).toEqual(withoutAdded(before));
  });
});

describe("rooms.forEvent", () => {
  type Ref = { roomId: string; state: "open" | "closed"; closedAt: string | null } | null;
  const read = (t: Backend, name: string, eventId: Id<"events">) => as(t, name).query(forEvent, { eventId }) as Promise<Ref>;

  it("is null before a room, returns the open room, and keeps returning it once closed", async () => {
    const { t, eventId } = await seed();
    expect(await read(t, "a", eventId)).toBeNull();
    expect(await read(t, "b", eventId)).toBeNull();
    const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
    await cancelQueued(t);
    expect(await read(t, "a", eventId)).toEqual({ roomId, state: "open", closedAt: null });
    expect(await read(t, "b", eventId)).toEqual({ roomId, state: "open", closedAt: null });
    expect(await read(t, "head", eventId)).toEqual({ roomId, state: "open", closedAt: null });

    await pick(t, "a", eventId, "P2");
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    vi.setSystemTime(FIXTURE_NOW + 5000);
    expect(await as(t, "b").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: true });
    await cancelQueued(t);
    expect((await t.run(ctx => ctx.db.get(roomId)))!.state).toBe("closed");

    const closed = await read(t, "a", eventId);
    expect(closed).toEqual({ roomId, state: "closed", closedAt: expect.any(String) });
    expect(Date.parse(closed!.closedAt!)).toBe(FIXTURE_NOW + 5000);
    expect(await read(t, "b", eventId)).toEqual(closed);
    // rooms.get still answers only with an open room.
    expect(await as(t, "a").query(roomGet, { eventId })).toBeNull();
  });

  it("follows the rooms.get party rules", async () => {
    const { t, eventId } = await seed();
    await as(t, "a").mutation(fn.startWorkflow, { eventId });
    await cancelQueued(t);
    const other = await otherEvent(t);
    expect(await code(read(t, "c", eventId))).toBe("FORBIDDEN");
    expect(await code(read(t, "eye", eventId))).toBe("FORBIDDEN");
    expect(await code(read(t, "a", other))).toBe("FORBIDDEN");
    expect(await code(t.query(forEvent, { eventId }))).toBe("UNAUTHENTICATED");
    // The same callers are refused by rooms.get.
    expect(await code(as(t, "c").query(roomGet, { eventId }))).toBe("FORBIDDEN");
    expect(await code(as(t, "eye").query(roomGet, { eventId }))).toBe("FORBIDDEN");
  });
});
