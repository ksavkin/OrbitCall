import { describe, expect, it } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import { backend, catalogObject, pair, registerSnapshot } from "./helpers";
import { FIXTURE_NOW } from "../fixtures/events";
import { csvCell } from "../convex/reports";
const preview = makeFunctionReference<"query">("reports:preview");
const exportCsv = makeFunctionReference<"action">("reports:exportCsv");
const period = { periodStart: new Date(FIXTURE_NOW - 86400000).toISOString(), periodEnd: new Date(FIXTURE_NOW + 86400000).toISOString() };
async function setup() {
  const t = backend();
  const snap = await registerSnapshot(t);
  for (const [key, object] of [["a", "100"], ["b", "200"]]) {
    await t.run(ctx => ctx.db.insert("spaceObjects", catalogObject(object)));
    await t.mutation(internal.operators.provision, { key, name: key, simulated: false, objectIds: [object], members: [
      { tokenIdentifier: `https://fixture.invalid|${key}`, role: "operator", assignedObjectIds: [object] },
      { tokenIdentifier: `https://fixture.invalid|head-${key}`, role: "head_of_ops", assignedObjectIds: [] },
      { tokenIdentifier: `https://fixture.invalid|eye-${key}`, role: "demo_observer", assignedObjectIds: [] },
    ] });
  }
  const { eventId } = await t.mutation(internal.events.ingest, { snapshotId: snap, simulated: false, ...pair(100, 300, 3, null) });
  await t.mutation(internal.events.ingest, { snapshotId: snap, simulated: false, ...pair(200, 400, 3, 0.2) });
  await t.mutation(internal.events.ingest, { snapshotId: snap, simulated: true, ...pair(100, 500, 4, 0.2) });
  return { t, eventId, as: (name: string) => t.withIdentity({ tokenIdentifier: `https://fixture.invalid|${name}` }) };
}
describe("company report", () => {
  it("enforces identity and company scope for preview and export", async () => {
    const { t, as } = await setup();
    await expect(t.query(preview, period)).rejects.toThrow();
    await expect(as("eye-a").query(preview, period)).rejects.toThrow();
    await expect(as("missing").action(exportCsv, period)).rejects.toThrow();
    const a = await as("a").query(preview, period), b = await as("b").query(preview, period);
    expect(a.uniqueEvents).toBe(1); expect(a.records[0].objectA).toBe("100");
    expect(b.records[0].objectA).toBe("200");
    expect(await as("head-a").query(preview, period)).toEqual(a);
  });
  it("deduplicates reversed pair rows and excludes simulated evidence, without inventing execution", async () => {
    const { t, eventId, as } = await setup();
    await t.run(async ctx => {
      const e = (await ctx.db.get(eventId))!;
      const { _id, _creationTime, ...row } = e;
      await ctx.db.insert("events", { ...row, objectAId: row.objectBId, objectBId: row.objectAId, tcaMs: row.tcaMs + 1000 });
    });
    const r = await as("a").query(preview, period);
    expect(r.uniqueEvents).toBe(1); expect(r.records[0].supportingEventIds).toHaveLength(2);
    expect(r.eventsWithObservedExecution).toBe(0); expect(r.eventsWithScheduledManeuver).toBe(0);
    expect(r.records[0].suppliedProbability).toBeNull(); expect(r.fccFields).toBe("to_verify");
    expect(r.missingFields.some((x: { field: string }) => x.field === "sourceCoverage")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/policyRevision|currentFuelKg|rawResponse|tokenIdentifier/);
  });
  it("validates the period and returns an authorized CSV download", async () => {
    const { as } = await setup();
    await expect(as("a").query(preview, { ...period, periodEnd: period.periodStart })).rejects.toThrow();
    const file = await as("a").action(exportCsv, period);
    expect(file.url).toBeTruthy(); expect(file.filename).toMatch(/^orbitcall-draft-.*\.csv$/);
  });
  it("escapes formula cells and quotes", () => {
    expect(csvCell(' =HYPERLINK("x")')).toBe('"\' =HYPERLINK(""x"")"');
    expect(csvCell(null)).toBe('""'); expect(csvCell("hello,world")).toBe('"hello,world"');
  });
});

it("excludes simulated coordination attached to a real event",async()=>{
 const {t,as,eventId}=await setup();
 await t.run(async ctx=>{
  const user=(await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","https://fixture.invalid|a")).unique())!;
  const run=await ctx.db.insert("demoRuns",{scenario:"demo",state:"open",startedBy:user._id,manifest:null,startedAt:Date.now(),closedAt:null});
  const proposalId=await ctx.db.insert("proposals",{eventId,candidateId:"P1",label:"P1",latestRevision:1,demoRunId:run,createdAt:Date.now()});
  await ctx.db.insert("approvals",{eventId,side:"A",status:"approved",userId:user._id,companyId:user.companyId,proposalId,revision:1,selectionGeneration:1,approvalRuleVersion:1,trajectoryPlanId:null,trajectoryPlanVersion:null,reason:null,demoRunId:run,current:true,at:Date.now()});
  await ctx.db.insert("log",{eventId,actor:{kind:"human",userId:user._id,companyId:user.companyId,name:"A",side:"A"},action:"message",summary:"Demo discussion",texts:null,before:null,after:null,proposalId:null,revision:null,roomId:null,demoRunId:null,simulated:true,at:Date.now()});
 });
 expect((await as("a").query(preview,period)).eventsWithCoordination).toBe(0);
 await t.run(async ctx=>{const row=(await ctx.db.query("log").first())!;await ctx.db.patch(row._id,{simulated:false});});
 expect((await as("a").query(preview,period)).eventsWithCoordination).toBe(1);
});
