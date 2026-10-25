import { ConvexError,v } from "convex/values";
import { makeFunctionReference as ref } from "convex/server";
import { action,query,internalMutation } from "./_generated/server";
import type { Doc,Id } from "./_generated/dataModel";
import { requireFleetScope } from "./fleetQuery";
import { requireUser } from "./session";
import { setActiveAssignments } from "./lib/accounts";
import { findObject,ingestEncounter,isoUtc } from "./lib/events";
import { ommSnapshotId } from "./lib/publishCandidates";
import { simulate,orbitFailure,type SimulateResult } from "./lib/orbitClient";

function fail(code:string,message:string):never {throw new ConvexError({code,message});}
function enabled(){if(process.env.DEMO_LAUNCH!=="on")fail("FEATURE_DISABLED","Demo satellite launch is disabled.");}
const args={name:v.string(),ownerName:v.string(),ownerCountry:v.string(),targetObjectId:v.string(),tcaUtc:v.string(),scenarioPc:v.number(),requestId:v.optional(v.string()),replaceObjectId:v.optional(v.string())};
type Input={name:string;ownerName:string;ownerCountry:string;targetObjectId:string;tcaUtc:string;scenarioPc:number;requestId?:string;replaceObjectId?:string};
type Result={objectId:string;eventId:Id<"events">;demoRunId:Id<"demoRuns">;assignmentVersion:number};
type Reservation={state:"pending"|"failed"|"completed";input:Input;objectId:string;userId:Id<"users">;companyId:Id<"companies">;assignmentVersion:number;snapshotId:Id<"snapshots">;result?:Result;omm?:string};
const keyOf=(a:Input)=>`launch:${a.requestId??JSON.stringify([a.name,a.targetObjectId,a.tcaUtc,a.scenarioPc,a.replaceObjectId??null])}`;
const read=(d:Doc<"demoRuns">,key:string):Reservation|null=>typeof d.manifest?.[key]==="string"?JSON.parse(d.manifest[key] as string):null;
const reserveRef=ref<"mutation">("demoLaunch:reserve"),publishRef=ref<"mutation">("demoLaunch:publish"),failedRef=ref<"mutation">("demoLaunch:failed");
export const launchDefaults=query({args:{},handler:async ctx=>{
 enabled();const {user,company}=await requireUser(ctx);if(user.role!=="operator")fail("FORBIDDEN","Only operators can launch a demo satellite.");
 // Defaults are suggestions. Launch still verifies catalog membership and ownership server-side.
 const targets=await ctx.db.query("spaceObjects").withIndex("by_object_id").take(100);
 const target=targets.find(x=>/^\d{1,9}$/.test(x.objectId));
 return {name:"Demo satellite",ownerName:company.name,ownerCountry:company.country??"US",targetObjectId:target?.objectId??null,tcaUtc:isoUtc(Math.floor(Date.now()/1000)*1000+24*3600000),scenarioPc:0.001};
}});
export const reserve=internalMutation({args,handler:async(ctx,input)=>{
 enabled();const scope=await requireFleetScope(ctx);if(scope.user.role!=="operator")fail("FORBIDDEN","Only operators can launch a demo satellite.");
 for(const text of [input.name,input.ownerName,input.ownerCountry])if(!text.trim()||text.length>80)fail("VALIDATION","Use names and country labels of 1–80 characters.");
 if(input.requestId!==undefined&&!/^[A-Za-z0-9._:-]{1,100}$/.test(input.requestId))fail("VALIDATION","Invalid request ID.");
 if(!/^\d{1,9}$/.test(input.targetObjectId)||!await findObject(ctx,input.targetObjectId))fail("NOT_FOUND","Choose a real registered target satellite.");
 const tca=Date.parse(input.tcaUtc);if(!Number.isFinite(tca)||tca<=Date.now()||tca>Date.now()+72*3600000||isoUtc(tca)!==input.tcaUtc||!Number.isFinite(input.scenarioPc)||input.scenarioPc<0||input.scenarioPc>1)fail("VALIDATION","Choose a UTC encounter within 72 hours and a probability between zero and one.");
 const runs=await ctx.db.query("demoRuns").withIndex("by_state",q=>q.eq("state","open")).take(101);
 if(runs.length>100)fail("LIMIT_EXCEEDED","Too many open demonstrations.");
 let d=runs.find(x=>x.startedBy===scope.user._id);const key=keyOf(input);
 if(d){const prior=read(d,key);if(prior){if(JSON.stringify(prior.input)!==JSON.stringify(input))fail("CONFLICT","This request ID belongs to different launch settings.");if(prior.state!=="completed")fail("IN_PROGRESS","This launch is pending or failed; inspect it before starting a new request.");return {demoRunId:d._id,key,reservation:prior};}}
 if(d && Object.keys(d.manifest??{}).filter(k=>k.startsWith("launch:")).some(k=>read(d!,k)?.state==="pending"))fail("IN_PROGRESS","Finish the pending launch before reserving another satellite.");
 const count=d?Object.keys(d.manifest??{}).filter(k=>k.startsWith("launch:")).length:0;
 if(count>=2)fail("LIMIT_EXCEEDED","This demo run already reserved its two satellite launches; reset before another run.");
 if(input.replaceObjectId && !scope.objects.some(o=>o.objectId===input.replaceObjectId))fail("FORBIDDEN","The replaced slot must be in your current fleet.");
 if(scope.objects.length>=4&&!input.replaceObjectId)fail("VALIDATION","Choose the assigned satellite slot to replace, keeping four demo slots.");
 const snapshots=await ctx.db.query("snapshots").order("desc").take(100);
 const snapshot=snapshots.find(s=>!s.snapshotId.startsWith("fixture:")&&ommSnapshotId(s));if(!snapshot)fail("NOT_READY","A pinned OMM catalog is required.");
 if(!d){const id=await ctx.db.insert("demoRuns",{scenario:"operator-launch",state:"open",startedBy:scope.user._id,manifest:{snapshotId:ommSnapshotId(snapshot)!},startedAt:Date.now(),closedAt:null});d=(await ctx.db.get(id))!;}
 // Reserve a globally unique SIM ID in the existing catalog table before the external call. No assignment yet.
 const sims=await ctx.db.query("spaceObjects").withIndex("by_object_id",q=>q.gte("objectId","SIM-8000").lte("objectId","SIM-9999")).take(2001);
 const taken=new Set(sims.map(s=>s.objectId));let objectId:string|null=null;
 for(let n=8000;n<=9999;n++){const id=`SIM-${n}`;if(!taken.has(id)){objectId=id;break;}}
 if(!objectId)fail("LIMIT_EXCEEDED","No reserved demo IDs remain.");
 await ctx.db.insert("spaceObjects",{objectId,name:input.name,country:input.ownerCountry,launchDate:null});
 const reservation:Reservation={state:"pending",input,objectId,userId:scope.user._id,companyId:scope.company._id,assignmentVersion:scope.user.assignmentVersion??1,snapshotId:snapshot._id};
 await ctx.db.patch(d._id,{manifest:{...d.manifest,[key]:JSON.stringify(reservation)}});return {demoRunId:d._id,key,reservation};
}});
const ticket={demoRunId:v.id("demoRuns"),key:v.string()};
export const publish=internalMutation({args:{...ticket,result:v.any()},handler:async(ctx,{demoRunId,key,result:raw})=>{
 const d=await ctx.db.get(demoRunId),r=d&&read(d,key);if(!d||d.state!=="open"||!r)fail("INVALID_STATE","This demo run was closed.");
 if(r.result)return r.result;
 const user=await ctx.db.get(r.userId);if(!user||user.role!=="operator"||user.companyId!==r.companyId||(user.assignmentVersion??1)!==r.assignmentVersion)fail("STALE_ASSIGNMENT","Responsibility changed while the demo was calculated.");
 const result=raw as SimulateResult;
 if(result.objectId!==r.objectId||result.event.objectA!==r.input.targetObjectId||result.event.objectB!==r.objectId||!result.simulated||!result.event.simulated||result.event.tcaUtc!==r.input.tcaUtc)fail("INVALID_RESPONSE","The simulated result does not match the launch.");
 const source=await ctx.db.get(r.snapshotId);if(!source)fail("NOT_READY","Snapshot provenance is unavailable.");
 const snapshotId=await ctx.db.insert("snapshots",{snapshotId:`demo:${demoRunId}:${r.objectId}`,ommUrl:source.ommUrl,sources:[...source.sources.filter(s=>s.name!=="simulated"),{name:"simulated",url:null,epochUtc:r.input.tcaUtc,fetchedAt:isoUtc(Date.now())}]});
 const target=await findObject(ctx,r.input.targetObjectId);if(!target)fail("NOT_FOUND","The target is no longer registered.");
 const {eventId}=await ingestEncounter(ctx,{snapshotId,objectA:{objectId:target.objectId,name:target.name,country:target.country,launchDate:target.launchDate},objectB:{objectId:r.objectId,name:r.input.name,country:r.input.ownerCountry,launchDate:null},tcaUtc:r.input.tcaUtc,missKm:result.event.missKm,relSpeedKmS:result.event.relSpeedKmS,pcValue:r.input.scenarioPc,simulated:true});
 await ctx.db.patch(eventId,{demoRunId,status:"new"}); // workflow is classified by candidate publication, never guessed from a missing owner.
 await ctx.db.insert("satelliteOwners",{objectId:r.objectId,companyId:r.companyId});
 const assignments=await ctx.db.query("fleetAssignments").withIndex("by_user_object",q=>q.eq("userId",user._id)).collect();
 const ids=assignments.filter(a=>a.active&&a.objectId!==r.input.replaceObjectId).map(a=>a.objectId);
 const assignmentVersion=await setActiveAssignments(ctx,user,[...ids,r.objectId]);
 const value:Result={objectId:r.objectId,eventId,demoRunId,assignmentVersion};
 await ctx.db.patch(demoRunId,{manifest:{...d.manifest,[key]:JSON.stringify({...r,state:"completed",result:value,omm:JSON.stringify(result.omm)})}});
 await ctx.db.insert("log",{eventId,actor:{kind:"system"},action:"event_created",summary:"Flagged simulated encounter created from the orbital service.",texts:null,before:null,after:null,proposalId:null,revision:null,roomId:null,demoRunId,simulated:true,at:Date.now()});
 return value;
}});
export const failed=internalMutation({args:ticket,handler:async(ctx,{demoRunId,key})=>{const d=await ctx.db.get(demoRunId),r=d&&read(d,key);if(d&&r&&r.state==="pending")await ctx.db.patch(demoRunId,{manifest:{...d.manifest,[key]:JSON.stringify({...r,state:"failed"})}});}});
export const launchSatellite=action({args,handler:async(ctx,input):Promise<Result>=>{
 const ticket=await ctx.runMutation(reserveRef,input) as {demoRunId:Id<"demoRuns">;key:string;reservation:Reservation};
 if(ticket.reservation.result)return ticket.reservation.result;
 let result:SimulateResult;
 try{result=await simulate({targetObjectId:input.targetObjectId,tcaUtc:input.tcaUtc,name:input.name,objectId:ticket.reservation.objectId});}
 catch(error){await ctx.runMutation(failedRef,{demoRunId:ticket.demoRunId,key:ticket.key});throw new ConvexError(orbitFailure(error));}
 return ctx.runMutation(publishRef,{demoRunId:ticket.demoRunId,key:ticket.key,result});
}});
export const orbit=query({args:{objectId:v.string()},handler:async(ctx,{objectId})=>{
 enabled();const scope=await requireFleetScope(ctx);if(!scope.objects.some(o=>o.objectId===objectId))fail("FORBIDDEN","This satellite is outside your fleet.");
 const runs=await ctx.db.query("demoRuns").withIndex("by_state",q=>q.eq("state","open")).take(100);
 for(const d of runs)for(const key of Object.keys(d.manifest??{}).filter(k=>k.startsWith("launch:"))){const r=read(d,key);if(r?.objectId===objectId&&r.companyId===scope.company._id&&r.omm)return {demoRunId:d._id,simulated:true,omm:JSON.parse(r.omm)};}
 return null;
}});
