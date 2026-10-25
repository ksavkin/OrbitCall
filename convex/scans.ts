import { ConvexError, v } from "convex/values";
import { makeFunctionReference as ref } from "convex/server";
import { mutation, query, internalMutation, internalAction } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFleetScope } from "./fleetQuery";
import { findObject, findEncounter, ingestEncounter, isoUtc } from "./lib/events";
import { ommSnapshotId } from "./lib/publishCandidates";
import { startScreen, getScreenJob, orbitFailure, type OrbitJob, type ScreenResult } from "./lib/orbitClient";

// Round 2: durable request reservation and bounded polling. History export is connected in Round 3.
const scanArgs = { scanId: v.id("scanRuns") };
const runArgs = { ...scanArgs, recovery: v.optional(v.boolean()) };
const runRef = ref<"action">("scans:run"), claimRef = ref<"mutation">("scans:claim");
const saveRef = ref<"mutation">("scans:save"), failRef = ref<"mutation">("scans:failRun");
const pending = (r: Doc<"scanRuns">) => r.status === "queued" || r.status === "running";
function fail(code: string, message: string): never { throw new ConvexError({ code, message }); }
async function validScope(ctx: QueryCtx, r: Doc<"scanRuns">) {
 const user = await ctx.db.get(r.requestedBy);
 if (!user || user.role !== "operator" || (user.assignmentVersion ?? 1) !== r.assignmentVersion) return false;
 if (r.demoRunId) { const d = await ctx.db.get(r.demoRunId); if (!d || d.state !== "open" || d.closedAt !== null) return false; }
 for (const id of r.primaryObjectIds) {
  const a = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q=>q.eq("userId",user._id).eq("objectId",id)).unique();
  const o = await ctx.db.query("satelliteOwners").withIndex("by_object",q=>q.eq("objectId",id)).unique();
  if (!a?.active || o?.companyId !== user.companyId) return false;
 }
 return true;
}
async function failStored(ctx: MutationCtx, r: Doc<"scanRuns">, code: string, message: string) {
 await ctx.db.patch(r._id,{status:"failed",phase:"failed",error:{code,message},finishedAt:Date.now(),updatedAt:Math.max(Date.now(),r.updatedAt)});
}
export const startMine = mutation({
 args:{requestId:v.string()}, handler:async(ctx,{requestId})=>{
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) fail("VALIDATION","Use a request ID of 1–100 letters, digits or ._:-.");
  const scope=await requireFleetScope(ctx);
  if (scope.user.role!=="operator") fail("FORBIDDEN","Only assigned operators start scans.");
  const owned=new Set(scope.companyObjects.map(o=>o.objectId));
  const ids=scope.objects.map(o=>o.objectId).filter(id=>owned.has(id));
  if (!ids.length) fail("EMPTY_FLEET","Assign a satellite before scanning.");
  if (ids.length>50) fail("LIMIT_EXCEEDED","A scan supports at most 50 assigned satellites.");
  const existing=await ctx.db.query("scanRuns").withIndex("by_user_request",q=>q.eq("requestedBy",scope.user._id).eq("requestId",requestId)).unique();
  if (existing) {
   if (!await validScope(ctx,existing)) fail("STALE_ASSIGNMENT","Responsibility changed; start a new scan.");
   if (existing.status==="failed") {
    await ctx.db.patch(existing._id,{status:"queued",phase:"queued",error:null,finishedAt:null,updatedAt:Math.max(Date.now(),existing.updatedAt)});
    await ctx.scheduler.runAfter(0,runRef,{scanId:existing._id});
   }
   return {scanId:existing._id,reused:true};
  }
  const recent=await ctx.db.query("scanRuns").withIndex("by_user",q=>q.eq("requestedBy",scope.user._id)).order("desc").take(20);
  for(const r of recent.filter(pending)) {
   if(await validScope(ctx,r)) return {scanId:r._id,reused:true};
   await failStored(ctx,r,"STALE_ASSIGNMENT","Responsibility changed; this scan was stopped.");
  }
  if(recent[0] && Date.now()-recent[0]._creationTime<30_000) fail("RATE_LIMITED","Wait briefly before starting another scan.");
  const snapshots=await ctx.db.query("snapshots").order("desc").take(100);
  const snapshot=snapshots.find(s=>!s.snapshotId.startsWith("fixture:") && !s.sources.some(source=>source.name==="simulated") && ommSnapshotId(s));
  if(!snapshot) fail("NOT_READY","No pinned OMM catalog is available.");
  const fromMs=Math.floor(Date.now()/1000)*1000;
  const scanId=await ctx.db.insert("scanRuns",{requestedBy:scope.user._id,requestId,assignmentVersion:scope.user.assignmentVersion??1,
   primaryObjectIds:ids,snapshotId:ommSnapshotId(snapshot)!,fromMs,toMs:fromMs+72*3600000,status:"queued",phase:"queued",progress:null,
   counts:{primaryObjects:ids.length,catalogObjects:0,primariesCompleted:0,pairsChecked:0,eventsFound:0},
   coverage:{complete:false,catalogScope:"Not screened yet",excludedObjects:0,reasons:[],missingPrimaryIds:[]},
   jobId:null,startedAt:null,finishedAt:null,error:null,demoRunId:null,updatedAt:Date.now()});
  await ctx.scheduler.runAfter(0,runRef,{scanId}); return {scanId,reused:false};
 }
});
export const getMine=query({args:{scanId:v.optional(v.id("scanRuns"))},handler:async(ctx,{scanId})=>{
 const {user}=await requireFleetScope(ctx);
 const r=scanId?await ctx.db.get(scanId):await ctx.db.query("scanRuns").withIndex("by_user",q=>q.eq("requestedBy",user._id)).order("desc").first();
 if(!r) return null;
 if(r.requestedBy!==user._id) fail("FORBIDDEN","This is another operator's scan.");
 if(!await validScope(ctx,r)) fail("STALE_ASSIGNMENT","The assignments for this scan have changed.");
 const {_id,_creationTime,requestedBy,...publicRun}=r;
 return {scanId:_id,...publicRun};
}});
// claim has a short lease, preventing duplicate action deliveries from making independent submissions/poll chains.
export const claim=internalMutation({args:runArgs,handler:async(ctx,{scanId,recovery})=>{
 const r=await ctx.db.get(scanId); if(!r || !pending(r)) return null;
 if(recovery && (r.phase!=="loading" || Date.now()-r.updatedAt<30_000)) return null;
 if(!await validScope(ctx,r)) {await failStored(ctx,r,"STALE_ASSIGNMENT","Responsibility changed; this scan was stopped.");return null;}
 if(Date.now()-r._creationTime>30*60000) {await failStored(ctx,r,"TIMED_OUT","The scan exceeded its polling deadline.");return null;}
 if(r.phase==="loading" && Date.now()-r.updatedAt<30_000) return null;
 const leaseAt=Math.max(Date.now(),r.updatedAt+1);
 await ctx.db.patch(scanId,{status:"running",phase:"loading",startedAt:r.startedAt??Date.now(),updatedAt:leaseAt});
 // Watchdog recovers a lost action; all calls keep the same service job ID.
 await ctx.scheduler.runAfter(30_001,runRef,{scanId,recovery:true});
 return {run:r,leaseAt};
}});
export const failRun=internalMutation({args:{...scanArgs,leaseAt:v.number(),code:v.string(),message:v.string()},handler:async(ctx,{scanId,leaseAt,code,message})=>{
 const r=await ctx.db.get(scanId); if(r && pending(r) && r.phase==="loading" && r.updatedAt===leaseAt) await failStored(ctx,r,code,message);
}});
export const save=internalMutation({args:{...scanArgs,leaseAt:v.number(),job:v.any()},handler:async(ctx,{scanId,leaseAt,job:raw})=>{
 // Internal only: the action passes an orbitClient-validated response.
 const job=raw as OrbitJob<ScreenResult>, r=await ctx.db.get(scanId);
 if(!r || !pending(r) || r.phase!=="loading" || r.updatedAt!==leaseAt) return;
 if(!await validScope(ctx,r)) {await failStored(ctx,r,"STALE_ASSIGNMENT","Responsibility changed before publication.");return;}
 if(job.jobId!==`screen-${scanId}`) fail("INVALID_RESPONSE","Unexpected scan job.");
 if(job.status==="failed") {await failStored(ctx,r,job.error?.code??"ERROR",job.error?.message??"Screening failed.");return;}
 const result=job.result;
 if(result && result.events.length>1000) fail("LIMIT_EXCEEDED","This scan exceeds the current publication limit; no partial events were published.");
 if(job.status==="completed" && result) {
  if(result.counts.primaryObjects!==r.primaryObjectIds.length || result.missingPrimaryIds.some(id=>!r.primaryObjectIds.includes(id))) fail("INVALID_RESPONSE","Scan coverage does not match the requested fleet.");
  if(result.scanId!==String(scanId)||result.snapshotId!==r.snapshotId||result.fromUtc!==isoUtc(r.fromMs)||result.toUtc!==isoUtc(r.toMs)) fail("INVALID_RESPONSE","Scan inputs changed.");
  const snapshots=await ctx.db.query("snapshots").order("desc").take(100);
  const source=snapshots.find(s=>!s.sources.some(source=>source.name==="simulated") && ommSnapshotId(s)===r.snapshotId);
  if(!source) fail("NOT_READY","The pinned catalog provenance is unavailable.");
  // Keep source reference encounters intact. The frozen schema has no separate numerical/reference measurements;
  // matching existing records is preferable to overwriting supplied probability with a nonexistent computed Pc.
  for(const e of result.events) {
   if(!e.primaries.some(id=>r.primaryObjectIds.includes(id) && [e.objectA,e.objectB].includes(id)) ||
    Date.parse(e.tcaUtc)<r.fromMs || Date.parse(e.tcaUtc)>r.toMs) fail("INVALID_RESPONSE","Event is outside the scanned fleet or window.");
   const a=await findObject(ctx,e.objectA), b=await findObject(ctx,e.objectB);
   const prior=a&&b&&(await findEncounter(ctx,a._id,b._id,Date.parse(e.tcaUtc))??await findEncounter(ctx,b._id,a._id,Date.parse(e.tcaUtc)));
   if(prior) continue;
   const object=(id:string,stored:Doc<"spaceObjects">|null)=>({objectId:id,name:stored?.name??result.objects[id]?.name??id,country:stored?.country??null,launchDate:stored?.launchDate??null});
   await ingestEncounter(ctx,{snapshotId:source._id,objectA:object(e.objectA,a),objectB:object(e.objectB,b),tcaUtc:e.tcaUtc,
    missKm:e.missKm,relSpeedKmS:e.relSpeedKmS,pcValue:null,simulated:e.simulated});
  }
  await ctx.db.patch(scanId,{status:"completed",phase:"done",progress:1,jobId:job.jobId,counts:result.counts,
   coverage:{complete:result.coverage.complete,catalogScope:result.coverage.catalogScope,excludedObjects:result.coverage.excludedObjects,
    reasons:result.coverage.reasons,missingPrimaryIds:result.missingPrimaryIds},finishedAt:Date.now(),updatedAt:Math.max(Date.now(),r.updatedAt)});
 } else {
  const counts={...r.counts}; for(const k of Object.keys(counts) as (keyof typeof counts)[]) if(Number.isFinite(job.counters[k])) counts[k]=job.counters[k];
  await ctx.db.patch(scanId,{status:"running",phase:job.phase,progress:job.progress,jobId:job.jobId,counts,updatedAt:Math.max(Date.now(),r.updatedAt)});
  await ctx.scheduler.runAfter(5000,runRef,{scanId});
 }
}});
export const run=internalAction({args:runArgs,handler:async(ctx,{scanId,recovery})=>{
 const claimed=await ctx.runMutation(claimRef,{scanId,...(recovery ? {recovery} : {})}) as {run:Doc<"scanRuns">;leaseAt:number}|null; if(!claimed) return;
 const {run:r,leaseAt}=claimed;
 try {
  if(!r.jobId) await startScreen({scanId:String(scanId),snapshotId:r.snapshotId,primaryObjectIds:r.primaryObjectIds,fromUtc:isoUtc(r.fromMs),toUtc:isoUtc(r.toMs)});
  const job=await getScreenJob(`screen-${scanId}`,{scanId:String(scanId),snapshotId:r.snapshotId});
  await ctx.runMutation(saveRef,{scanId,leaseAt,job});
 } catch(error) {await ctx.runMutation(failRef,{scanId,leaseAt,...orbitFailure(error)});}
}});
