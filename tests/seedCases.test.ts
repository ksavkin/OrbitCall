import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backend, registerSnapshot } from "./helpers";
import { api, internal } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";

// The seeded demo path: a scan finds the hidden cases, Run agents plays timed agent runs and publishes the cards,
// and the production select/approve path decides them. No orbit-service or model request is made.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const COMPANIES = [["asd", "ASD", "SIM-8003", "us"], ["jade", "Jade", "SIM-8002", "cn"], ["sever", "Sever", "SIM-8001", "ru"]] as const;

async function setup() {
  const t = backend();
  const snapshot = await registerSnapshot(t);
  await t.run(async ctx => {
    await ctx.db.patch(snapshot, { ommUrl: "/snapshots/gp-20261024T2134Z/catalog.json" });
    for (const [, , objectId] of COMPANIES) await ctx.db.insert("spaceObjects", { objectId, name: "Demo satellite", country: null, launchDate: null });
  });
  for (const [key, name, objectId, token] of COMPANIES) {
    await t.mutation(internal.operators.provision, { key, name, simulated: true, objectIds: [objectId],
      members: [{ tokenIdentifier: token, role: "operator", assignedObjectIds: [objectId] }] });
  }
  return { t, as: (token: string) => t.withIdentity({ tokenIdentifier: token }) };
}
const run = (t: ReturnType<typeof backend>) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe("seeded demo cases", () => {
  it("are found by a scan, played by Run agents and decided on the production path", async () => {
    const { t, as } = await setup();
    const { eventIds } = await t.mutation(internal.seedCases.seed, {});
    expect(eventIds).toHaveLength(3);
    expect((await t.run(ctx => Promise.all(eventIds.map(id => ctx.db.get(id))))).every(e => e && !e.active)).toBe(true);

    const { scanId } = await as("us").mutation(api.scans.startMine, { requestId: "demo-1" });
    await run(t);
    const scan = await as("us").query(api.scans.getMine, { scanId });
    expect(scan).toMatchObject({ status: "completed", counts: { eventsFound: 2 } });
    const events = await t.run(ctx => Promise.all(eventIds.map(id => ctx.db.get(id))));
    // US×CN and RU×US are on the US fleet; CN×RU stays hidden until China or Russia scans.
    expect(events.map(e => e!.active)).toEqual([true, false, true]);
    expect((await t.run(ctx => ctx.db.query("spaceObjects").collect())).every(o => !/demo/i.test(o.name))).toBe(true);

    const eventId = eventIds[0];
    await as("us").mutation(api.rooms.startWorkflow, { eventId });
    await run(t);
    const runs = await t.run(ctx => ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", eventId)).collect());
    expect(runs.map(r => [r.role, r.status])).toEqual([
      ["incident_analyst", "succeeded"], ["operator_advocate", "succeeded"], ["operator_advocate", "succeeded"]]);
    expect((await t.query(api.agentSummaries.get, { eventId })).summaryLines).toHaveLength(5);
    const cards = await as("cn").query(api.proposals.list, { eventId });
    expect(cards.map(c => c.label)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const card = cards[1];
    await as("us").mutation(api.proposals.select, { eventId, proposalId: card.proposalId, revision: card.latest.revision, expectedGeneration: 0 });
    const event = (await t.run(ctx => ctx.db.get(eventId)))!;
    const args = { eventId, proposalId: card.proposalId, revision: card.latest.revision, selectionGeneration: 1, approvalRuleVersion: event.approvalRuleVersion! };
    await as("us").mutation(api.approvals.approve, args);
    expect(await as("cn").mutation(api.approvals.approve, args)).toMatchObject({ allRequiredApproved: true });
    expect((await t.run(ctx => ctx.db.get(eventId)))!.status).toBe("approved");
  });

  it("retires the previous seed when seeded again", async () => {
    const { t } = await setup();
    const first = await t.mutation(internal.seedCases.seed, {});
    vi.advanceTimersByTime(120_000);
    await t.mutation(internal.seedCases.seed, {});
    expect((await t.run(ctx => ctx.db.get(first.demoRunId)))!.state).toBe("closed");
  });
});
