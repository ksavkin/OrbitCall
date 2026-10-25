import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import type { Backend } from "./helpers";
import { as, code, fn, pick, seed, selection, tick } from "./decision";

// The two hooks into the Maneuver Scheduler (spec §4.1): every selection requests the Factory preview, and the approval
// that completes consensus requests scheduling. While the worker is configured, a maneuver needs its diff to be approved.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const scheduled = async (t: Backend, name: string) =>
  (await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).filter(f => f.name === name).map(f => f.args[0]);
async function previewCurrent(t: Backend, eventId: Id<"events">) {
  const s = (await selection(t, eventId))!;
  await t.run(async ctx => {
    const revision = (await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", s.proposalId!).eq("revision", s.revision!)).unique())!;
    expect((await ctx.db.get(revision.candidateRevisionId))!.kind).toBe("maneuver");
    await ctx.db.patch(revision._id, { schedulePreviewDiff: "--- /dev/null\n+++ b/operators/x/schedule.json\n", schedulePreviewHash: "f".repeat(64) });
  });
}

it("requests a preview for every selection change and scheduling once on consensus", async () => {
  const { t, eventId } = await seed();
  await pick(t, "a", eventId, "P2");
  await pick(t, "a", eventId, "P4");
  expect(await scheduled(t, "maneuvers:requestPreview")).toEqual([{ eventId }, { eventId }]);
  await as(t, "a").mutation(fn.approve, await tick(t, eventId));
  expect(await scheduled(t, "maneuvers:requestSchedule")).toEqual([]);
  await as(t, "b").mutation(fn.approve, await tick(t, eventId));
  expect(await scheduled(t, "maneuvers:requestSchedule")).toEqual([{ eventId }]);
});

it("gates a maneuver approval on its prepared diff only while the worker is configured", async () => {
  const { t, eventId } = await seed();
  await pick(t, "a", eventId, "P2");
  vi.stubEnv("SCHEDULE_SERVICE_URL", "https://scheduler.test");
  // A URL without a valid token is not a configured worker: nothing could ever prepare the diff.
  expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
  await t.run(async ctx => { for (const a of await ctx.db.query("approvals").collect()) await ctx.db.delete(a._id); });
  vi.stubEnv("SCHEDULE_SERVICE_TOKEN", "fixture-token-of-at-least-thirty-two-chars");
  expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
  await previewCurrent(t, eventId);
  expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
  vi.unstubAllEnvs();
  const other = await seed();
  await pick(other.t, "a", other.eventId, "P2");
  expect(await as(other.t, "a").mutation(fn.approve, await tick(other.t, other.eventId))).toMatchObject({ allRequiredApproved: false });
});
