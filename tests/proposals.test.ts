import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent } from "../fixtures/policies";
import { insertEvent } from "./helpers";
import { as, code, fn, pick, proposalId, seed, selection, tick, userId, withCard } from "./decision";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

type Card = { label: string; isSelected: boolean; revisionCount: number; latest: { revision: number; kind: string; movingSide: string | null } };

describe("proposal cards", () => {
  it("mirrors a published candidate set into cards and classifies the event", async () => {
    const { t, eventId } = await seed();
    const cards = await as(t, "b").query(fn.list, { eventId }) as Card[];
    expect(cards.map(c => [c.label, c.latest.revision, c.revisionCount, c.isSelected])).toEqual([
      ["P1", 1, 1, false], ["P2", 1, 1, false], ["P3", 1, 1, false], ["P4", 1, 1, false]]);
    expect(cards[3].latest.movingSide).toBe("B");
    expect(await t.run(ctx => ctx.db.get(eventId))).toMatchObject({
      status: "proposal", workflow: "bilateral", requiredApprovalSides: ["A", "B"], approvalRuleVersion: 1 });
    expect(await as(t, "eye").query(fn.list, { eventId })).toEqual(cards);
    expect(await as(t, "head").query(fn.list, { eventId })).toEqual(cards);
    expect(await code(as(t, "c").query(fn.list, { eventId }))).toBe("FORBIDDEN");
    expect(await code(t.query(fn.list, { eventId }))).toBe("UNAUTHENTICATED");
  });

  it("keeps one card per candidate and adds a revision when the candidate changes", async () => {
    const { t, eventId } = await seed();
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false, candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }) });
    const cards = await as(t, "a").query(fn.list, { eventId }) as Card[];
    expect(cards.map(c => [c.label, c.latest.revision, c.revisionCount])).toEqual([["P1", 1, 1], ["P2", 2, 2], ["P3", 1, 1], ["P4", 1, 1]]);
    expect(await t.run(async ctx => (await ctx.db.query("proposals").collect()).length)).toBe(4);
  });
});

describe("proposals.select", () => {
  it("shares one selection, never approves, and is idempotent for the current card", async () => {
    const { t, eventId } = await seed();
    const P2 = await proposalId(t, eventId, "P2");
    expect(await as(t, "a").mutation(fn.select, { eventId, proposalId: P2, revision: 1, expectedGeneration: 0 })).toBeNull();
    expect(await selection(t, eventId)).toMatchObject({ proposalId: P2, revision: 1, generation: 1,
      by: { kind: "human", userId: await userId(t, "a") }, lastReset: null });
    expect((await as(t, "b").query(fn.list, { eventId }) as Card[]).map(c => c.isSelected)).toEqual([false, true, false, false]);
    expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
    await as(t, "a").mutation(fn.select, { eventId, proposalId: P2, revision: 1, expectedGeneration: 1 });
    expect((await selection(t, eventId))!.generation).toBe(1);
    expect(await pick(t, "b", eventId, "P4")).toBe(2);
  });

  it("rejects stale, foreign and malformed selections, and callers without an assignment", async () => {
    const { t, eventId } = await seed();
    const P2 = await proposalId(t, eventId, "P2");
    const args = { eventId, proposalId: P2, revision: 1, expectedGeneration: 0 };
    expect(await code(as(t, "a").mutation(fn.select, { ...args, revision: 2 }))).toBe("STALE_REVISION");
    expect(await code(as(t, "a").mutation(fn.select, { ...args, expectedGeneration: 1 }))).toBe("STALE_REVISION");
    expect(await code(as(t, "a").mutation(fn.select, { ...args, revision: 0 }))).toBe("VALIDATION");
    expect(await code(as(t, "a").mutation(fn.select, { ...args, expectedGeneration: -1 }))).toBe("VALIDATION");
    const other = await insertEvent(t, { ...advocateEvent, tcaUtc: "2026-10-25T09:00:00Z" });
    await t.mutation(internal.candidates.publish, { eventId: other, baseVersion: null, candidates: advocateCandidates, start: false });
    expect(await code(as(t, "a").mutation(fn.select, { ...args, eventId: other }))).toBe("NOT_FOUND");
    for (const name of ["head", "eye", "unassigned", "c"]) expect(await code(as(t, name).mutation(fn.select, args))).toBe("FORBIDDEN");
    expect(await code(t.mutation(fn.select, args))).toBe("UNAUTHENTICATED");
  });

  it("follows the selected card to its new revision and clears it when the card is withdrawn", async () => {
    const { t, eventId } = await seed();
    await pick(t, "a", eventId, "P2");
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false, candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }) });
    expect(await selection(t, eventId)).toMatchObject({ revision: 2, generation: 2, by: { kind: "agents" } });
    expect(await code(as(t, "a").mutation(fn.select, { eventId, proposalId: await proposalId(t, eventId, "P2"), revision: 1, expectedGeneration: 2 })))
      .toBe("STALE_REVISION");
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 2, start: false,
      candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }).filter(c => c.candidateId !== "P2") });
    expect(await selection(t, eventId)).toMatchObject({ proposalId: null, revision: null, generation: 3 });
  });

  it("refuses to change the selection of a decided plan", async () => {
    const { t, eventId } = await seed();
    await pick(t, "a", eventId, "P2");
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await as(t, "b").mutation(fn.approve, await tick(t, eventId));
    expect(await code(as(t, "a").mutation(fn.select, {
      eventId, proposalId: await proposalId(t, eventId, "P1"), revision: 1, expectedGeneration: 1 }))).toBe("INVALID_STATE");
  });
});
