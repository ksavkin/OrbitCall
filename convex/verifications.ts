import {ConvexError,v,type Infer} from "convex/values";
import {makeFunctionReference as ref} from "convex/server";
import {action,query,internalQuery,internalMutation,internalAction} from "./_generated/server";
import type {QueryCtx} from "./_generated/server";
import type {Doc,Id} from "./_generated/dataModel";
import {requireFleetScope} from "./fleetQuery";
import {verify,orbitFailure,type Verification,type VerifyRequest} from "./lib/orbitClient";
import {sourceName} from "./lib/validators";

function fail(code:string,message:string):never{throw new ConvexError({code,message});}
function stable(value:unknown):string {
 const sorted=(x:unknown):unknown=>Array.isArray(x)?x.map(sorted):x!==null&&typeof x==="object"?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)])):x;
 return JSON.stringify(sorted(value));
}
async function reader(ctx:QueryCtx,eventId:Id<"events">,write=false){
 const scope=await requireFleetScope(ctx),e=await ctx.db.get(eventId);
 const owned=new Set(scope.companyObjects.map(o=>o.objectId));
 const allowed=new Set(scope.objects.map(o=>o.objectId).filter(id=>owned.has(id)));
 const objects=e?await Promise.all([ctx.db.get(e.objectAId),ctx.db.get(e.objectBId)]):[];
 if(!e||!objects.some(o=>o&&allowed.has(o.objectId))||(write&&scope.user.role!=="operator"))fail("FORBIDDEN","You are not responsible for this incident.");
 return e;
}
async function latestManeuver(ctx:QueryCtx,e:Doc<"events">){
 const links=await ctx.db.query("maneuverEvents").withIndex("by_event",q=>q.eq("eventId",e._id)).take(101);
 if(links.length>100)fail("LIMIT_EXCEEDED","Too many schedule versions to verify automatically.");
 const rows=await Promise.all(links.map(l=>ctx.db.get(l.maneuverId)));
 return rows.filter((m):m is Doc<"maneuvers">=>!!m&&m.status==="committed"&&m.demoRunId===(e.demoRunId??null)&&m.refs.some(r=>r.eventId===e._id)).sort((a,b)=>b._creationTime-a._creationTime||b._id.localeCompare(a._id))[0]??null;
}
async function plan(ctx:QueryCtx,eventId:Id<"events">){
 const e=await reader(ctx,eventId,true),m=await latestManeuver(ctx,e);
 if(!m||m.reviewRequired)fail("NOT_READY","Verification needs a committed schedule that is not awaiting review.");
 if(e.demoRunId){const d=await ctx.db.get(e.demoRunId);if(!d||d.state!=="open"||d.closedAt!==null)fail("INVALID_STATE","This demonstration was closed.");}
 const signed=m.refs.find(r=>r.eventId===eventId)!;
 const revision=await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision",q=>q.eq("proposalId",signed.proposalId).eq("revision",signed.revision)).unique();
 const c=revision&&await ctx.db.get(revision.candidateRevisionId);
 if(!revision||revision.eventId!==eventId||!c||c.eventId!==eventId||c.kind!=="maneuver"||!c.movingObjectId||!c.burnTimeUtc||!c.deltaVMs||!c.direction)fail("NOT_READY","The scheduled numerical revision is unavailable.");
 const objects=await Promise.all([ctx.db.get(e.objectAId),ctx.db.get(e.objectBId)]);
 if(!objects.some(o=>o?.objectId===c.movingObjectId))fail("INVALID_STATE","The scheduled mover is outside the incident.");
 const request:VerifyRequest={objectId:c.movingObjectId,expected:{burnTimeUtc:c.burnTimeUtc,deltaVMs:c.deltaVMs,direction:c.direction},kind:"live"};
 return {eventId,maneuverId:m._id,intentKey:m.intentKey,demoRunId:e.demoRunId??null,simulated:c.movingObjectId.startsWith("SIM-"),
  fingerprint:JSON.stringify([m._id,m.intentKey,m.refs,m.pinned,m.updatedAt,m.commitSha,c]),request};
}
type Plan=Awaited<ReturnType<typeof plan>>;
const reserveRef=ref<"mutation",{eventId:Id<"events">;requestId:string},Plan>("verifications:reserve"),storeRef=ref<"mutation">("verifications:storeResult");
export const input=internalQuery({args:{eventId:v.id("events")},handler:(ctx,{eventId})=>plan(ctx,eventId)});
export const reserve=internalMutation({args:{eventId:v.id("events"),requestId:v.string()},handler:async(ctx,{eventId,requestId})=>{
 const current=await plan(ctx,eventId);
 const history=await ctx.db.query("log").withIndex("by_event_at",q=>q.eq("eventId",eventId)).take(499);
 // Leave room for both the request marker and its completion before contacting the service.
 if(history.length>498)fail("LIMIT_EXCEEDED","Verification audit history needs pagination before another request.");
 await ctx.db.insert("log",{eventId,actor:{kind:"system"},action:"status_changed",summary:"Verification evidence requested for the committed maneuver.",texts:null,before:null,
  after:{verificationRequestId:requestId,intentKey:current.intentKey},proposalId:null,revision:null,roomId:null,demoRunId:current.demoRunId,simulated:current.simulated,at:Date.now()});
 return current;
}});
const names=new Set(["celestrak_gp","celestrak_supgp","socrates","cdm_public","gp_history","keeptrack","simulated","celestrak_satcat"]);
function storedResult(r:Verification){
 const omitted=r.sources.some(s=>!s.name||!names.has(s.name));
 return {kind:r.kind,result:r.result,label:r.kind==="replay"&&r.simulated?`SIMULATED replay: ${r.label}`:r.label,expected:r.expected,observed:r.observed,
  elementSetCount:r.elementSetCount,series:r.series,thresholds:r.thresholds,method:r.method,
  limitations:[...r.limitations,...(omitted?["Some source types are unsupported by the current provenance schema; inspect the upstream evidence before relying on this result."]:[])],missing:r.missing,
  sources:r.sources.filter(s=>s.name&&names.has(s.name)).map(s=>({name:s.name as Infer<typeof sourceName>,url:s.url??null,epochUtc:s.epochUtc??null,fetchedAt:s.fetchedAt??null})),simulated:r.simulated};
}
async function evidenceForIntent(ctx:QueryCtx,event:Doc<"events">,maneuver:Doc<"maneuvers">){
 const eventId=event._id,intentKey=maneuver.intentKey,demoRunId=event.demoRunId??null;
 const signed=maneuver.refs.find(r=>r.eventId===eventId)!;
 const logs=await ctx.db.query("log").withIndex("by_event_at",q=>q.eq("eventId",eventId)).order("desc").take(501);
 if(logs.length>500)fail("LIMIT_EXCEEDED","Verification audit history needs pagination before it can be read safely.");
 const line=logs.find(l=>l.action==="verified"&&l.after?.intentKey===intentKey&&typeof l.after.verificationId==="string"&&
  l.demoRunId===demoRunId&&l.proposalId===signed.proposalId&&l.revision===signed.revision);
 if(!line)return null;
 const id=ctx.db.normalizeId("verifications",line.after!.verificationId as string);if(!id)return null;
 const row=await ctx.db.get(id);return row?.eventId===eventId&&row.kind==="live"&&row.demoRunId===demoRunId&&row.simulated===line.simulated?row:null;
}
export const storeResult=internalMutation({args:{eventId:v.id("events"),fingerprint:v.string(),requestId:v.string(),result:v.any()},handler:async(ctx,{eventId,fingerprint,requestId,result:raw})=>{
 const current=await plan(ctx,eventId);if(current.fingerprint!==fingerprint)fail("STALE_REVISION","The scheduled plan changed during verification.");
 const requests=await ctx.db.query("log").withIndex("by_event_at",q=>q.eq("eventId",eventId)).order("desc").take(501);
 if(requests.length>500)fail("LIMIT_EXCEEDED","Verification request history needs pagination.");
 const latest= requests.find(l=>l.after?.intentKey===current.intentKey&&typeof l.after.verificationRequestId==="string");
 if(latest?.after?.verificationRequestId!==requestId)fail("STALE_REVISION","A newer verification request superseded this result.");
 const r=raw as Verification;
 if(r.kind!=="live"||r.simulated!==current.simulated)fail("INVALID_RESPONSE","Verification evidence has the wrong origin.");
 if(r.result!=="awaiting_data"&&Date.parse(current.request.expected.burnTimeUtc)>Date.now())fail("INVALID_RESPONSE","A future burn cannot have execution evidence.");
 const fields=storedResult(r),event=(await ctx.db.get(eventId))!,maneuver=(await ctx.db.get(current.maneuverId))!;
 const same=(row:Doc<"verifications">)=>{const {_id,_creationTime,eventId:_eventId,demoRunId,createdAt,...old}=row;return stable(old)===stable(fields);};
 // One request has one immutable result. A duplicate delivery may reuse it, never replace its verdict.
 const completed=requests.find(l=>l.action==="verified"&&l.after?.intentKey===current.intentKey&&l.after?.verificationRequestId===requestId);
 if(completed){
  const id=typeof completed.after?.verificationId==="string"?ctx.db.normalizeId("verifications",completed.after.verificationId):null;
  const row=id&&await ctx.db.get(id);
  if(!row||row.eventId!==eventId||row.demoRunId!==current.demoRunId||!same(row))fail("CONFLICT","This verification request already has a different recorded result.");
  return {verificationId:row._id,reused:true};
 }
 if(requests.length>=500)fail("LIMIT_EXCEEDED","Verification audit history has no room for another result.");
 const prior=await evidenceForIntent(ctx,event,maneuver),reused=!!prior&&same(prior);
 const verificationId=reused?prior!._id:await ctx.db.insert("verifications",{...fields,eventId,demoRunId:current.demoRunId,createdAt:Date.now()});
 const status=r.result==="awaiting_data"?"awaiting_verification_data":r.result==="consistent"?"verified":"flagged";
 await ctx.db.patch(eventId,{status,updatedAt:Date.now()});
 const m=(await ctx.db.get(current.maneuverId))!,signed=m.refs.find(x=>x.eventId===eventId)!;
 await ctx.db.insert("log",{eventId,actor:{kind:"system"},action:"verified",summary:r.label,texts:null,before:null,
  after:{verificationId:String(verificationId),verificationRequestId:requestId,intentKey:current.intentKey,result:r.result},proposalId:signed.proposalId,revision:signed.revision,roomId:null,demoRunId:current.demoRunId,simulated:r.simulated,at:Date.now()});
 return {verificationId,reused};
}});
export const request=action({args:{eventId:v.id("events")},handler:async(ctx,{eventId})=>{
 const requestId=crypto.randomUUID();
 const input=await ctx.runMutation(reserveRef,{eventId,requestId});let result:Verification;
 try{result=await verify(input.request);}catch(error){throw new ConvexError(orbitFailure(error));}
 return ctx.runMutation(storeRef,{eventId,fingerprint:input.fingerprint,requestId,result});
}});
export const get=query({args:{eventId:v.id("events")},handler:async(ctx,{eventId})=>{
 const e=await reader(ctx,eventId),m=await latestManeuver(ctx,e);if(!m)return null;
 const row=await evidenceForIntent(ctx,e,m);if(!row)return null;
 const {_id,_creationTime,eventId:_eventId,demoRunId,createdAt,...publicResult}=row;
 return {verificationId:_id,...publicResult,createdAt:new Date(createdAt).toISOString(),reviewRequired:m.reviewRequired};
}});
export const replay=query({args:{},handler:async ctx=>{
 await requireFleetScope(ctx);
 const rows=await ctx.db.query("verifications").withIndex("by_kind",q=>q.eq("kind","replay")).order("desc").take(20);
 const r=rows.find(x=>x.eventId===null&&x.demoRunId===null);if(!r)return null;
 const {_id,_creationTime,eventId,demoRunId,createdAt,...publicResult}=r;return {verificationId:_id,...publicResult,createdAt:new Date(createdAt).toISOString()};
}});
// The only bundled replay is explicitly simulated. No claim of historical observed execution is made.
export const refreshReplay=internalAction({args:{},handler:async ctx=>{
 let result:Verification;try{result=await verify({objectId:"25544",replay:"iss-simulated-reboost",kind:"replay",expected:{burnTimeUtc:"2026-10-22T18:00:00Z",deltaVMs:0.5,direction:"prograde"}});}catch(error){throw new ConvexError(orbitFailure(error));}
 if(result.kind!=="replay"||!result.simulated)fail("INVALID_RESPONSE","The bundled replay must stay labeled simulated.");
 return ctx.runMutation(ref<"mutation">("verifications:storeReplay"),{result});
}});
export const storeReplay=internalMutation({args:{result:v.any()},handler:async(ctx,{result:raw})=>{
 const r=raw as Verification;if(r.kind!=="replay"||!r.simulated)fail("INVALID_RESPONSE","Expected the labeled simulated replay.");
 const fields=storedResult(r),previous=await ctx.db.query("verifications").withIndex("by_event",q=>q.eq("eventId",null)).order("desc").first();
 if(previous){const {_id,_creationTime,eventId,demoRunId,createdAt,...old}=previous;if(stable(old)===stable(fields))return _id;}
 return ctx.db.insert("verifications",{...fields,eventId:null,demoRunId:null,createdAt:Date.now()});
}});
