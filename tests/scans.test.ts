import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { internal } from "../convex/_generated/api";
import { backend, registerSnapshot, catalogObject } from "./helpers";
import { FIXTURE_NOW } from "../fixtures/events";
import { startScreen, getScreenJob } from "../convex/lib/orbitClient";
vi.mock("../convex/lib/orbitClient", async original => ({ ...await original<typeof import("../convex/lib/orbitClient")>(), startScreen: vi.fn(), getScreenJob: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); });
const start = ref<"mutation">("scans:startMine"), get = ref<"query">("scans:getMine"), run = ref<"action">("scans:run");
async function setup() {
 const t = backend(), snapshotId = await registerSnapshot(t);
 await t.run(async ctx => { await ctx.db.patch(snapshotId, { ommUrl: "/snapshots/gp-20261024T2134Z/catalog.json" }); await ctx.db.insert("spaceObjects", catalogObject("100")); });
 await t.mutation(internal.operators.provision, { key:"a",name:"A",simulated:false,objectIds:["100"],members:[
  {tokenIdentifier:"a",role:"operator",assignedObjectIds:["100"]}, {tokenIdentifier:"head",role:"head_of_ops",assignedObjectIds:[]},
  {tokenIdentifier:"other",role:"operator",assignedObjectIds:[]}] });
 return {t, as:(id="a")=>t.withIdentity({tokenIdentifier:id})};
}
function answers() {
 vi.mocked(startScreen).mockImplementation(async req => ({jobId:`screen-${req.scanId}`,status:"queued",created:true,statusUrl:"unused"}));
 vi.mocked(getScreenJob).mockImplementation(async (jobId, expected) => {
 const req = vi.mocked(startScreen).mock.calls[0][0];
 return {jobId,kind:"screen",status:"completed",phase:"done",progress:1,counters:{},coverage:null,requestHash:"hash",createdAt:new Date(FIXTURE_NOW).toISOString(),startedAt:null,finishedAt:null,resultRef:null,error:null,
 result:{...expected, evidenceVersion:null,fromUtc:req.fromUtc,toUtc:req.toUtc,thresholdKm:5,cached:false,runtimeS:1,
 coverage:{complete:true,timedOut:false,catalogScope:"pinned catalog",excludedObjects:0,reasons:[]},counts:{primaryObjects:1,catalogObjects:100,primariesCompleted:1,pairsChecked:99,eventsFound:1},missingPrimaryIds:[],unpropagatedObjectIds:[],dockedBodies:{},coLocated:[],objects:{},uncovered:[],method:"SGP4",limitations:[],
 events:[{objectA:"100",objectB:"200",tcaUtc:new Date(FIXTURE_NOW+3600000).toISOString(),missKm:0.4,relSpeedKmS:10,spread:{gpMissKm:0.4,supgpMissKm:null,minKm:null,maxKm:null,gpEpochUtc:null,supgpEpochUtc:null},primaries:["100"],attachedObjectIds:[],simulated:false}]}};
 });
}
describe("assigned fleet scans",()=>{
 it("rejects anonymous/read-only/empty fleets and hides another user's run",async()=>{
  const {t,as}=await setup();
  await expect(t.mutation(start,{requestId:"one"})).rejects.toThrow();
  await expect(as("head").mutation(start,{requestId:"one"})).rejects.toThrow();
  await expect(as("other").mutation(start,{requestId:"one"})).rejects.toThrow();
  const r=await as().mutation(start,{requestId:"one"});
  await expect(as("other").query(get,{scanId:r.scanId})).rejects.toThrow();
 });
 it("reuses the request and active run, sends only assigned IDs and the OMM snapshot, publishes once",async()=>{
  const {t,as}=await setup(); answers();
  const a=await as().mutation(start,{requestId:"one"}), b=await as().mutation(start,{requestId:"one"}), c=await as().mutation(start,{requestId:"two"});
  expect(b).toEqual({...a,reused:true}); expect(c.scanId).toBe(a.scanId);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(startScreen).toHaveBeenCalledTimes(1); expect(vi.mocked(startScreen).mock.calls[0][0]).toMatchObject({snapshotId:"gp-20261024T2134Z",primaryObjectIds:["100"]});
  expect(await as().query(get,{scanId:a.scanId})).toMatchObject({status:"completed",coverage:{complete:true},counts:{eventsFound:1}});
  await t.action(run,{scanId:a.scanId});
  expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(1);
 });
 it("fails closed when responsibility changes before work starts",async()=>{
  const {t,as}=await setup(); answers(); const r=await as().mutation(start,{requestId:"one"});
  await t.run(async ctx=> {const u=await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","a")).unique();await ctx.db.patch(u!._id,{assignmentVersion:2});});
  await t.finishAllScheduledFunctions(vi.runAllTimers); expect(startScreen).not.toHaveBeenCalled();
  expect(await t.run(ctx=>ctx.db.get(r.scanId))).toMatchObject({status:"failed",error:{code:"STALE_ASSIGNMENT"}});
 });
 it("records a sanitized failure and retries the same job ID",async()=>{
  const {t,as}=await setup(); answers(); vi.mocked(startScreen).mockRejectedValueOnce(new Error("secret"));
  const r=await as().mutation(start,{requestId:"one"}); await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await as().query(get,{})).toMatchObject({status:"failed",error:{code:"UPSTREAM_UNAVAILABLE"}});
  await as().mutation(start,{requestId:"one"}); await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(vi.mocked(startScreen).mock.calls[0][0]).toEqual(vi.mocked(startScreen).mock.calls[1][0]);
  expect(JSON.stringify(await as().query(get,{}))).not.toContain("secret");
 });
});

it("keeps incomplete coverage visible even when the service returns zero events",async()=>{
 const {t,as}=await setup(); answers();
 const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);job.result!.events=[];job.result!.counts.eventsFound=0;job.result!.counts.primariesCompleted=0;job.result!.coverage.complete=false;job.result!.coverage.timedOut=true;job.result!.missingPrimaryIds=["100"];return job;});
 await as().mutation(start,{requestId:"partial"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await as().query(get,{})).toMatchObject({status:"completed",counts:{eventsFound:0},coverage:{complete:false,missingPrimaryIds:["100"]}});
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
});
it("does not overwrite supplied reference probabilities with absent computed Pc",async()=>{
 const {t,as}=await setup(); answers();
 const snapshotId=await t.run(async ctx=>(await ctx.db.query("snapshots").first())!._id);
 const {eventId}=await t.mutation(internal.events.ingest,{snapshotId,simulated:false,objectA:catalogObject("100"),objectB:catalogObject("200"),tcaUtc:new Date(FIXTURE_NOW+3600000).toISOString(),missKm:0.7,relSpeedKmS:10,pcValue:0.00002});
 await as().mutation(start,{requestId:"reference"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({missKm:0.7,pcValue:0.00002});
});
