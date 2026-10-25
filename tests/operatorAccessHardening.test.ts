import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { FIXTURE_NOW } from "../fixtures/events";
import { as, fn, pick, seed, userId } from "./decision";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());

it("observers use only their authorized projection, never operator decision endpoints", async () => {
  const { t, eventId } = await seed();
  for (const query of [fn.list, fn.status]) {
    await expect(as(t, "eye").query(query, { eventId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  }
  const eye = await userId(t, "eye");
  const demoRunId = await t.run(async ctx => {
    const run = await ctx.db.insert("demoRuns", { scenario: "authorized", state: "open", startedBy: null,
      manifest: { observerUserId: String(eye) }, startedAt: FIXTURE_NOW, closedAt: null });
    await ctx.db.patch(eventId, { demoRunId: run });
    return run;
  });
  const view = makeFunctionReference<"query">("observer:publicView");
  expect((await as(t, "eye").query(view, { demoRunId })).events).toHaveLength(1);
  await expect(as(t, "eye").query(fn.list, { eventId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await t.run(ctx => ctx.db.patch(demoRunId, { state: "closed", closedAt: FIXTURE_NOW }));
  expect((await as(t, "eye").query(view, { demoRunId })).events).toEqual([]);
  await expect(pick(t, "a", eventId, "P2")).rejects.toMatchObject({ data: { code: "INVALID_STATE" } });
});

it("candidate-set ownership cannot grant action after the satellite changes owner", async () => {
  const { t, eventId } = await seed();
  const nextOwner = await t.run(async ctx => (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "c")).unique())!._id);
  await t.run(async ctx => {
    const row = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", "SIM-1001")).unique();
    await ctx.db.patch(row!._id, { companyId: nextOwner });
  });
  await expect(pick(t, "a", eventId, "P2")).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});
