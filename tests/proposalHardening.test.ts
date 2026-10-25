import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates } from "../fixtures/policies";
import { as, fn, pick, seed, selection, tick, withCard } from "./decision";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());

it("repairs existing candidate sets without recomputation or duplicate agent work", async () => {
  const { t, eventId } = await seed();
  await t.run(async ctx => {
    for (const table of ["proposalRevisions", "proposals"] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
  });
  expect(await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates, start: true }))
    .toEqual({ version: 1, changed: false });
  expect(await as(t, "a").query(fn.list, { eventId })).toHaveLength(4);
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates, start: true });
  expect(await t.run(ctx => ctx.db.query("proposalRevisions").collect())).toHaveLength(4);
  expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
});

it("an unchanged publish preserves a human approval and selection generation", async () => {
  const { t, eventId } = await seed();
  await pick(t, "a", eventId, "P2");
  await as(t, "a").mutation(fn.approve, await tick(t, eventId));
  const before = await selection(t, eventId);
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates, start: false });
  expect(await selection(t, eventId)).toEqual(before);
  expect((await as(t, "b").query(fn.status, { eventId })).approvals.A.status).toBe("approved");
});

it("changing another offered card resets approval of the selected card", async () => {
  const { t, eventId } = await seed();
  await pick(t, "a", eventId, "P2");
  await as(t, "a").mutation(fn.approve, await tick(t, eventId));
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: withCard("P4", { revision: 2, missAfterKm: 2.4 }), start: false });
  expect(await selection(t, eventId)).toMatchObject({ generation: 2, revision: 1, lastReset: { reason: "candidate_set_changed" } });
  const state = await as(t, "b").query(fn.status, { eventId });
  expect(state.approvals.A.status).toBe("pending");
  expect(state.turn).toBe("A");
  expect(await t.run(ctx => ctx.db.query("approvals").collect())).toEqual([expect.objectContaining({ current: false, status: "approved" })]);
});

it("backfills decided records without reopening or resetting the approved plan", async () => {
  const { t, eventId } = await seed();
  await pick(t, "a", eventId, "P2");
  await as(t, "a").mutation(fn.approve, await tick(t, eventId));
  await as(t, "b").mutation(fn.approve, await tick(t, eventId));
  const before = await selection(t, eventId);
  await t.run(async ctx => {
    const p4 = await ctx.db.query("proposals").withIndex("by_event_candidate", q => q.eq("eventId", eventId).eq("candidateId", "P4")).unique();
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", p4!._id)).unique();
    await ctx.db.delete(revision!._id);
  });
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, candidates: advocateCandidates, start: false });
  expect(await as(t, "a").query(fn.list, { eventId })).toHaveLength(4);
  expect(await selection(t, eventId)).toEqual(before);
  expect(await t.run(ctx => ctx.db.get(eventId))).toMatchObject({ status: "approved" });
});

