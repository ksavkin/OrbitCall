import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import type { Backend } from "./helpers";
import { as, code, fn, pick, proposalId, seed, tick, userId } from "./decision";

// Decision log rows (LOG-2): each selection, approval and veto leaves one shared, human-attributed log row that both
// sides read through log.list. log.ts is a new function file, so the test references it by path.
const logList = makeFunctionReference<"query">("log:list");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Entry = {
  logId: string; action: string; summary: string; actor: Record<string, unknown>;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  proposalId: string | null; revision: number | null; simulated: boolean;
};
const decisions = async (t: Backend, name: string, eventId: Id<"events">) =>
  ((await as(t, name).query(logList, { eventId })) as { entries: Entry[] }).entries
    .filter(e => ["selected", "approved", "vetoed"].includes(e.action));
const later = () => vi.advanceTimersByTime(1000);
const human = async (t: Backend, name: string, side: "A" | "B") =>
  ({ kind: "human", userId: await userId(t, name), name: name.toUpperCase(), side });

describe("decision log", () => {
  it("records a selection and both approvals once each, newest first, for both sides", async () => {
    const { t, eventId } = await seed();
    const p2 = await proposalId(t, eventId, "P2");
    await pick(t, "a", eventId, "P2");
    // Re-clicking the current card writes nothing.
    await as(t, "a").mutation(fn.select, { eventId, proposalId: p2, revision: 1, expectedGeneration: 1 });
    later();
    const args = await tick(t, eventId);
    await as(t, "a").mutation(fn.approve, args);
    // Approving the same tick again is idempotent, even after the turn moved to B.
    await as(t, "a").mutation(fn.approve, args);
    later();
    await as(t, "b").mutation(fn.approve, args);

    const [a, b] = [await human(t, "a", "A"), await human(t, "b", "B")];
    const expected = [
      { action: "approved", summary: "Side B approved P2 revision 1. The plan is agreed.", actor: b, proposalId: p2, revision: 1,
        before: { status: "proposal" }, after: { status: "approved", selectionGeneration: 1, approvalRuleVersion: 1, trajectoryPlanVersion: null } },
      { action: "approved", summary: "Side A approved P2 revision 1.", actor: a, proposalId: p2, revision: 1,
        before: { status: "proposal" }, after: { status: "proposal", selectionGeneration: 1, approvalRuleVersion: 1, trajectoryPlanVersion: null } },
      { action: "selected", summary: "Side A selected P2 revision 1.", actor: a, proposalId: p2, revision: 1,
        before: { generation: 0 }, after: { generation: 1 } },
    ];
    for (const reader of ["a", "b"]) {
      const rows = await decisions(t, reader, eventId);
      expect(rows.map(({ action, summary, actor, proposalId, revision, before, after }) =>
        ({ action, summary, actor, proposalId, revision, before, after }))).toEqual(expected);
      // The stored company stays server-side.
      for (const row of rows) expect(row.actor).not.toHaveProperty("companyId");
    }
    const stored = await t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).collect());
    expect(stored.filter(r => r.action === "selected" || r.action === "approved")).toHaveLength(3);
    expect(stored.find(r => r.action === "selected")!.actor).toMatchObject({ kind: "human", companyId: expect.any(String) });
  });

  it("records a veto without its reason, then the new selection after it", async () => {
    const { t, eventId } = await seed();
    const p2 = await proposalId(t, eventId, "P2");
    const p3 = await proposalId(t, eventId, "P3");
    await pick(t, "a", eventId, "P2");
    later();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    later();
    await as(t, "b").mutation(fn.veto, { ...await tick(t, eventId), reason: "PRIVATE_REASON keeps our reserve." });
    later();
    // The veto returned the event to the agents; the selection stays and is now generation 2.
    await pick(t, "a", eventId, "P3");

    for (const reader of ["a", "b"]) {
      const rows = await decisions(t, reader, eventId);
      expect(rows.map(r => [r.action, r.summary, r.proposalId, r.revision])).toEqual([
        ["selected", "Side A selected P3 revision 1.", p3, 1],
        ["vetoed", "Side B vetoed P2 revision 1.", p2, 1],
        ["approved", "Side A approved P2 revision 1.", p2, 1],
        ["selected", "Side A selected P2 revision 1.", p2, 1],
      ]);
      expect(rows[1]).toMatchObject({ actor: await human(t, "b", "B"), before: { status: "proposal", generation: 1 }, after: { status: "agents", generation: 2 } });
      expect(rows[0]).toMatchObject({ before: { generation: 2 }, after: { generation: 3 } });
      expect(JSON.stringify(await as(t, reader).query(logList, { eventId }))).not.toContain("PRIVATE_REASON");
    }
    // The reason is kept on the approval row only.
    const veto = await t.run(async ctx => (await ctx.db.query("approvals").collect()).find(r => r.status === "vetoed"));
    expect(veto?.reason).toBe("PRIVATE_REASON keeps our reserve.");
  });

  it("names the open room and writes nothing for a refused decision", async () => {
    const { t, eventId } = await seed();
    await as(t, "a").mutation(fn.startWorkflow, { eventId });
    await pick(t, "a", eventId, "P2");
    // Off-turn: side B cannot approve before A.
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    const rows = await t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).collect());
    const decided = rows.filter(r => r.action === "selected" || r.action === "approved" || r.action === "vetoed");
    expect(decided.map(r => r.action)).toEqual(["selected"]);
    const room = await t.run(async ctx => (await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).first())!.roomId);
    expect(decided[0]).toMatchObject({ roomId: room, simulated: true, demoRunId: null });
  });
});
