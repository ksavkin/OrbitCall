import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { backend, registerSnapshot, catalogObject } from "./helpers";
import { FIXTURE_NOW } from "../fixtures/events";
import { isoUtc } from "../convex/lib/events";
import { startScreen, getScreenJob } from "../convex/lib/orbitClient";
import { connectTiger } from "../convex/lib/tiger";
vi.mock("../convex/lib/orbitClient", async original => ({ ...await original<typeof import("../convex/lib/orbitClient")>(), startScreen: vi.fn(), getScreenJob: vi.fn() }));
// Tiger is never reached from these tests: a refused connection exercises the export failure path deterministically.
vi.mock("../convex/lib/tiger", async original => ({ ...await original<typeof import("../convex/lib/tiger")>(), connectTiger: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); vi.resetAllMocks(); vi.mocked(connectTiger).mockRejectedValue(Object.assign(new Error("refused"),{code:"ECONNREFUSED"})); });
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

it("fences late results and failures after another action recovers the lease",async()=>{
 const {t,as}=await setup(); const {scanId}=await as().mutation(start,{requestId:"lease"});
 const claim=ref<"mutation">("scans:claim"), save=ref<"mutation">("scans:save"), failed=ref<"mutation">("scans:failRun");
 const first=await t.mutation(claim,{scanId});
 expect(await t.mutation(claim,{scanId})).toBeNull();
 vi.setSystemTime(FIXTURE_NOW+31000);
 const second=await t.mutation(claim,{scanId,recovery:true});
 expect(second.leaseAt).toBeGreaterThan(first.leaseAt);
 await t.mutation(failed,{scanId,leaseAt:first.leaseAt,code:"OLD_FAILURE",message:"Old action failed"});
 await t.mutation(save,{scanId,leaseAt:first.leaseAt,job:{jobId:`screen-${scanId}`,status:"failed",error:{code:"OLD_FAILURE",message:"Old result"}}});
 expect(await as().query(get,{scanId})).toMatchObject({status:"running",phase:"loading",error:null});
 await t.mutation(failed,{scanId,leaseAt:second.leaseAt,code:"CURRENT_FAILURE",message:"Current action failed"});
 expect(await as().query(get,{scanId})).toMatchObject({status:"failed",error:{code:"CURRENT_FAILURE"}});
});
it.each(["wrong_pair","wrong_window","wrong_coverage"])("rejects %s instead of publishing a misleading fleet result",async kind=>{
 const {t,as}=await setup(); answers(); const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{
  const job=await original(...args);
  if(kind==="wrong_pair")job.result!.events[0].objectA="300";
  if(kind==="wrong_window")job.result!.events[0].tcaUtc=new Date(FIXTURE_NOW-3600000).toISOString();
  if(kind==="wrong_coverage")job.result!.counts.primaryObjects=2;
  return job;
 });
 await as().mutation(start,{requestId:kind});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await as().query(get,{})).toMatchObject({status:"failed"});
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
});
it("does not use simulated snapshot provenance for a real fleet scan",async()=>{
 const {t,as}=await setup();answers();
 await t.run(ctx=>ctx.db.insert("snapshots",{snapshotId:"demo:latest",ommUrl:"/snapshots/gp-20261025T1000Z/catalog.json",sources:[{name:"simulated",url:null,epochUtc:null,fetchedAt:"2026-10-25T10:00:00Z"}]}));
 await as().mutation(start,{requestId:"catalog"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(vi.mocked(startScreen).mock.calls[0][0].snapshotId).toBe("gp-20261024T2134Z");
});

async function demoFleet({keepReal=false}={}){
 const s=await setup();
 const data=await s.t.run(async ctx=>{
  const user=(await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","a")).unique())!;
  const demoRunId=await ctx.db.insert("demoRuns",{scenario:"operator-launch",state:"open",startedBy:user._id,manifest:null,startedAt:Date.now(),closedAt:null});
  await ctx.db.insert("spaceObjects",catalogObject("SIM-8000"));
  await ctx.db.insert("satelliteOwners",{objectId:"SIM-8000",companyId:user.companyId});
  await ctx.db.insert("fleetAssignments",{objectId:"SIM-8000",userId:user._id,active:true});
  if(!keepReal){const a=(await ctx.db.query("fleetAssignments").withIndex("by_user_object",q=>q.eq("userId",user._id).eq("objectId","100")).unique())!;await ctx.db.patch(a._id,{active:false});}
  const snapshotId=(await ctx.db.query("snapshots").first())!._id;
  return {demoRunId,snapshotId};
 });
 const {eventId}=await s.t.mutation(internal.events.ingest,{snapshotId:data.snapshotId,objectA:catalogObject("SIM-8000"),objectB:catalogObject("200"),tcaUtc:new Date(FIXTURE_NOW+2*3600000).toISOString(),missKm:0.2,relSpeedKmS:5,pcValue:0.001,simulated:true});
 await s.t.run(ctx=>ctx.db.patch(eventId,{demoRunId:data.demoRunId}));
 return {...s,...data,eventId};
}
function simulatedAnswer(){
 answers();const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);job.result!.counts.primaryObjects=vi.mocked(startScreen).mock.calls[0][0].primaryObjectIds.length;job.result!.counts.primariesCompleted=job.result!.counts.primaryObjects;job.result!.events[0]={...job.result!.events[0],objectA:"SIM-8000",objectB:"300",primaries:["SIM-8000"],simulated:true};return job;});
}
it("binds a launch fleet scan and new simulated incidents to the open run",async()=>{
 const {t,as,demoRunId}=await demoFleet({keepReal:true});simulatedAnswer();
 const {scanId}=await as().mutation(start,{requestId:"demo"});
 expect(await t.run(ctx=>ctx.db.query("scanRuns").withIndex("by_demo_run",q=>q.eq("demoRunId",demoRunId)).collect())).toMatchObject([{_id:scanId,demoRunId}]);
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(vi.mocked(startScreen).mock.calls[0][0]).toMatchObject({primaryObjectIds:["100","SIM-8000"],runId:String(demoRunId)});
 expect(await as().query(get,{scanId})).toMatchObject({status:"completed",demoRunId});
 const events=await t.run(ctx=>ctx.db.query("events").withIndex("by_demo_run",q=>q.eq("demoRunId",demoRunId)).collect());
 expect(events).toHaveLength(2);expect(events.every(e=>e.simulated)).toBe(true);
});
it.each(["unbound","closed","ambiguous"])("refuses a %s simulated fleet before scheduling",async kind=>{
 const {t,as,demoRunId,eventId}=await demoFleet();
 await t.run(async ctx=>{
  if(kind==="unbound")await ctx.db.patch(eventId,{demoRunId:undefined});
  if(kind==="closed")await ctx.db.patch(demoRunId,{state:"closed",closedAt:Date.now()});
  if(kind==="ambiguous"){
   const other=await ctx.db.insert("demoRuns",{scenario:"other",state:"open",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:null});
   const {_id,_creationTime,...e}=(await ctx.db.get(eventId))!;await ctx.db.insert("events",{...e,demoRunId:other,tcaMs:e.tcaMs+600000});
  }
 });
 await expect(as().mutation(start,{requestId:"bad-demo"})).rejects.toThrow(/unambiguous open/);
 expect(await t.run(ctx=>ctx.db.query("scanRuns").collect())).toHaveLength(0);
 expect(startScreen).not.toHaveBeenCalled();
});
it("stops a queued demo scan when its run closes even without assignment changes",async()=>{
 const {t,as,demoRunId}=await demoFleet();simulatedAnswer();const {scanId}=await as().mutation(start,{requestId:"reset"});
 await t.run(ctx=>ctx.db.patch(demoRunId,{state:"closed",closedAt:Date.now()}));
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(startScreen).not.toHaveBeenCalled();
 expect(await t.run(ctx=>ctx.db.get(scanId))).toMatchObject({status:"failed",demoRunId});
});
it("does not publish an in-flight scan after the demo closes",async()=>{
 const {t,as,demoRunId}=await demoFleet();simulatedAnswer();const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);await t.run(ctx=>ctx.db.patch(demoRunId,{state:"closed",closedAt:Date.now()}));return job;});
 const {scanId}=await as().mutation(start,{requestId:"reset-in-flight"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.get(scanId))).toMatchObject({status:"failed"});
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(1);
});
it("excludes unrelated simulated catalog remnants from real scans without altering measured counts",async()=>{
 const {t,as}=await setup();answers();const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);job.result!.events[0].objectB="SIM-9999";job.result!.events[0].simulated=true;return job;});
 const {scanId}=await as().mutation(start,{requestId:"real"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await as().query(get,{scanId})).toMatchObject({status:"completed",demoRunId:null,counts:{eventsFound:1},coverage:{complete:true,excludedObjects:0,reasons:[{reason:"publication_excluded_unrelated_simulated_encounters",count:1}]}});
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
 expect(await t.run(ctx=>ctx.db.query("spaceObjects").withIndex("by_object_id",q=>q.eq("objectId","SIM-9999")).unique())).toBeNull();
});
it.each(["foreign_open","foreign_closed"])("excludes a %s counterpart from this demonstration",async state=>{
 const {t,as,demoRunId,snapshotId}=await demoFleet();simulatedAnswer();
 const foreign=await t.run(ctx=>ctx.db.insert("demoRuns",{scenario:"foreign",state:state==="foreign_open"?"open":"closed",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:state==="foreign_open"?null:Date.now()}));
 const {eventId}=await t.mutation(internal.events.ingest,{snapshotId,objectA:catalogObject("SIM-9000"),objectB:catalogObject("900"),tcaUtc:new Date(FIXTURE_NOW+2*3600000).toISOString(),missKm:0.2,relSpeedKmS:5,pcValue:0.001,simulated:true});await t.run(ctx=>ctx.db.patch(eventId,{demoRunId:foreign}));
 const original=vi.mocked(getScreenJob).getMockImplementation()!;vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);job.result!.events[0].objectB="SIM-9000";return job;});
 const {scanId}=await as().mutation(start,{requestId:"isolated"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await as().query(get,{scanId})).toMatchObject({status:"completed",demoRunId,counts:{eventsFound:1},coverage:{reasons:[{reason:"publication_excluded_unrelated_simulated_encounters",count:1}]}});
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(2);
});
it("keeps real encounters untagged when a mixed real/demo fleet is screened",async()=>{
 const {t,as,demoRunId}=await demoFleet({keepReal:true});simulatedAnswer();
 const original=vi.mocked(getScreenJob).getMockImplementation()!;
 vi.mocked(getScreenJob).mockImplementation(async(...args)=>{const job=await original(...args);job.result!.events.push({...job.result!.events[0],objectA:"100",objectB:"200",primaries:["100"],simulated:false});job.result!.counts.eventsFound=2;return job;});
 await as().mutation(start,{requestId:"mixed"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 const events=await t.run(ctx=>ctx.db.query("events").collect());
 expect(events).toHaveLength(3);
 expect(events.filter(e=>e.simulated).every(e=>e.demoRunId===demoRunId)).toBe(true);
 expect(events.filter(e=>!e.simulated)).toHaveLength(1);
 expect(events.find(e=>!e.simulated)).not.toHaveProperty("demoRunId");
});
it("preserves a matching closed-run encounter instead of adopting it into the new run",async()=>{
 const {t,as,demoRunId,snapshotId}=await demoFleet();simulatedAnswer();
 const closed=await t.run(ctx=>ctx.db.insert("demoRuns",{scenario:"old",state:"closed",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:Date.now()}));
 const {eventId}=await t.mutation(internal.events.ingest,{snapshotId,objectA:catalogObject("SIM-8000"),objectB:catalogObject("300"),tcaUtc:new Date(FIXTURE_NOW+3600000).toISOString(),missKm:0.2,relSpeedKmS:5,pcValue:0.001,simulated:true});
 await t.run(ctx=>ctx.db.patch(eventId,{demoRunId:closed,active:false}));
 const before=await t.run(ctx=>ctx.db.get(eventId));
 const {scanId}=await as().mutation(start,{requestId:"preserve-closed"});await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await as().query(get,{scanId})).toMatchObject({status:"completed",demoRunId,coverage:{reasons:[{reason:"publication_excluded_conflicting_encounters",count:1}]}});
 expect(await t.run(ctx=>ctx.db.get(eventId))).toEqual(before);
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(2);
});

describe("scan history observations",()=>{
 const exportsOf=(t:Awaited<ReturnType<typeof setup>>["t"])=>t.run(ctx=>ctx.db.query("observationExports").collect());
 it("records one sourced missKm observation per published real encounter, and Tiger failure leaves the scan completed",async()=>{
  const {t,as}=await setup();answers();
  const {scanId}=await as().mutation(start,{requestId:"history"});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const scan=(await t.run(ctx=>ctx.db.get(scanId as Id<"scanRuns">)))!, [event]=await t.run(ctx=>ctx.db.query("events").collect());
  expect(scan).toMatchObject({status:"completed"});
  const rows=await exportsOf(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({eventId:event._id,demoRunId:null,source:"celestrak_gp",metric:"missKm",value:0.4,
   evidenceVersion:"gp-20261024T2134Z",simulated:false,observedAtMs:scan.fromMs,exportState:"failed"});
  expect(connectTiger).toHaveBeenCalled();
 });
 it("does not record again on a duplicate run or a replayed save with the spent lease",async()=>{
  const {t,as}=await setup();answers();
  const {scanId}=await as().mutation(start,{requestId:"dup"});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const before=await exportsOf(t);expect(before).toHaveLength(1);
  await t.action(run,{scanId});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const job=await vi.mocked(getScreenJob).mock.results[0].value, leaseAt=(await t.run(ctx=>ctx.db.get(scanId as Id<"scanRuns">)))!.updatedAt;
  await t.mutation(ref<"mutation">("scans:save"),{scanId,leaseAt,job});await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await exportsOf(t)).toHaveLength(1);
  expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect()).then(f=>f.filter(x=>x.name==="history:recordObservation"))).toHaveLength(1);
 });
 it("records nothing for a stale lease's completed result or a failed job",async()=>{
  const {t,as}=await setup();answers();
  const {scanId}=await as().mutation(start,{requestId:"fenced"});
  const claim=ref<"mutation">("scans:claim"),save=ref<"mutation">("scans:save");
  const first=await t.mutation(claim,{scanId});vi.setSystemTime(FIXTURE_NOW+31000);
  const second=await t.mutation(claim,{scanId,recovery:true});
  const r=(await t.run(ctx=>ctx.db.get(scanId as Id<"scanRuns">)))!;
  await startScreen({scanId:String(scanId),snapshotId:r.snapshotId,primaryObjectIds:r.primaryObjectIds,fromUtc:isoUtc(r.fromMs),toUtc:isoUtc(r.toMs)});
  const job=await getScreenJob(`screen-${scanId}`,{scanId:String(scanId),snapshotId:r.snapshotId});
  await t.mutation(save,{scanId,leaseAt:first.leaseAt,job});
  await t.mutation(save,{scanId,leaseAt:second.leaseAt,job:{jobId:`screen-${scanId}`,status:"failed",error:{code:"ERROR",message:"Screening failed."}}});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run(ctx=>ctx.db.get(scanId))).toMatchObject({status:"failed"});
  expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
  expect(await exportsOf(t)).toHaveLength(0);
 });
 it("records nothing for an encounter the scan matched instead of writing",async()=>{
  const {t,as}=await setup();answers();
  const snapshotId=await t.run(async ctx=>(await ctx.db.query("snapshots").first())!._id);
  await t.mutation(internal.events.ingest,{snapshotId,simulated:false,objectA:catalogObject("100"),objectB:catalogObject("200"),tcaUtc:new Date(FIXTURE_NOW+3600000).toISOString(),missKm:0.7,relSpeedKmS:10,pcValue:0.00002});
  await as().mutation(start,{requestId:"matched"});await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await as().query(get,{})).toMatchObject({status:"completed"});
  expect(await exportsOf(t)).toHaveLength(0);
 });
 it("records simulated encounters under the scan's open demo run only",async()=>{
  const {t,as,demoRunId}=await demoFleet({keepReal:true});simulatedAnswer();
  await as().mutation(start,{requestId:"demo-history"});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const rows=await exportsOf(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({source:"simulated",simulated:true,demoRunId,metric:"missKm",value:0.4});
 });
});
