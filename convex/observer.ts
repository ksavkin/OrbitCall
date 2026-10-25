import { ConvexError, v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { requireUser } from "./session";

// Called observer.publicView because issue #6 allocates this module; the frontend adapter is Round 3.
// A provisioned observer role alone is insufficient. The server grants one specific run in its scalar manifest.
export const authorize=internalMutation({args:{demoRunId:v.id("demoRuns"),userId:v.id("users")},handler:async(ctx,{demoRunId,userId})=>{
 const [run,user]=await Promise.all([ctx.db.get(demoRunId),ctx.db.get(userId)]);
 if(!run || run.state!=="open" || !user || user.role!=="demo_observer") throw new ConvexError({code:"FORBIDDEN",message:"An open run and a provisioned observer are required."});
 await ctx.db.patch(demoRunId,{manifest:{...run.manifest,observerUserId:String(userId)}});
}});
export const publicView=query({args:{demoRunId:v.id("demoRuns")},handler:async(ctx,{demoRunId})=>{
 const {user}=await requireUser(ctx), run=await ctx.db.get(demoRunId);
 if(user.role!=="demo_observer" || !run || run.manifest?.observerUserId!==String(user._id)) throw new ConvexError({code:"FORBIDDEN",message:"This observer is not authorized for that demonstration."});
 const base={demoRunId,scenario:run.scenario,state:run.state};
 if(run.state==="closed" || run.closedAt!==null) return {...base,events:[],scans:[],truncated:false};
 const rows=await ctx.db.query("events").withIndex("by_demo_run",q=>q.eq("demoRunId",demoRunId)).take(101);
 const scans=await ctx.db.query("scanRuns").withIndex("by_demo_run",q=>q.eq("demoRunId",demoRunId)).take(21);
 let truncated=rows.length>100 || scans.length>20;
 const events=[];
 for(const e of rows.slice(0,100)) {
  const [a,b,selection,proposals,approvals,links,verifications]=await Promise.all([
   ctx.db.get(e.objectAId),ctx.db.get(e.objectBId),ctx.db.query("selections").withIndex("by_event",q=>q.eq("eventId",e._id)).unique(),
   ctx.db.query("proposals").withIndex("by_event",q=>q.eq("eventId",e._id)).take(5),
   ctx.db.query("approvals").withIndex("by_event_current",q=>q.eq("eventId",e._id).eq("current",true)).take(21),
   ctx.db.query("maneuverEvents").withIndex("by_event",q=>q.eq("eventId",e._id)).take(21),
   ctx.db.query("verifications").withIndex("by_event",q=>q.eq("eventId",e._id)).order("desc").take(21),
  ]);
  truncated ||= proposals.length>4 || approvals.length>20 || links.length>20 || verifications.length>20;
  const cards=[];
  for(const p of proposals.slice(0,4)) {
   if(p.demoRunId!==demoRunId) continue;
   const revision=await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision",q=>q.eq("proposalId",p._id).eq("revision",p.latestRevision)).unique();
   const c=revision&&await ctx.db.get(revision.candidateRevisionId);
   if(c && c.eventId===e._id) cards.push({proposalId:p._id,candidateId:p.candidateId,revision:p.latestRevision,label:p.label,
    kind:c.kind,movingObjectId:c.movingObjectId,burnTimeUtc:c.burnTimeUtc,deltaVMs:c.deltaVMs,direction:c.direction,missAfterKm:c.missAfterKm,simulated:c.simulated});
  }
  const required=e.requiredApprovalSides??[], valid=new Set<string>();
  for(const approval of approvals) {
   if(approval.status!=="approved"||approval.demoRunId!==demoRunId||approval.proposalId!==selection?.proposalId||approval.revision!==selection.revision||
    approval.selectionGeneration!==selection.generation||approval.approvalRuleVersion!==e.approvalRuleVersion||!required.includes(approval.side)) continue;
   const approver=await ctx.db.get(approval.userId), object=approval.side==="A"?a:b;
   if(!approver||approver.role!=="operator"||approver.companyId!==approval.companyId||!object)continue;
   const owner=await ctx.db.query("satelliteOwners").withIndex("by_object",q=>q.eq("objectId",object.objectId)).unique();
   const assignment=await ctx.db.query("fleetAssignments").withIndex("by_user_object",q=>q.eq("userId",approver._id).eq("objectId",object.objectId)).unique();
   if(owner?.companyId===approval.companyId&&assignment?.active)valid.add(approval.side);
  }
  const selected=cards.find(c=>c.proposalId===selection?.proposalId && c.revision===selection.revision)??null;
  const jobs=[];
  for(const link of links.slice(0,20)) {const m=await ctx.db.get(link.maneuverId);if(m?.demoRunId===demoRunId)jobs.push({maneuverId:m._id,status:m.status,reviewRequired:m.reviewRequired,
   rescreen:m.rescreen?{passed:m.rescreen.passed,objectsChecked:m.rescreen.objectsChecked,horizonH:m.rescreen.horizonH}:null,commitSha:m.commitSha});}
  const verification=verifications.find(x=>x.demoRunId===demoRunId);
  events.push({eventId:e._id,objects:[a,b].map(o=>o?{objectId:o.objectId,name:o.name}:null),tcaUtc:new Date(e.tcaMs).toISOString(),
   missKm:e.missKm,probability:e.pcValue,status:e.status??"new",simulated:e.simulated,candidates:cards,selection:selected,
   approval:{approved:selected?valid.size:0,required:required.length,allRequiredApproved:!!selected&&e.workflow!=="internal_review"&&required.length>0&&required.every(s=>valid.has(s))},
   jobs,verification:verification?{kind:verification.kind,result:verification.result,label:verification.label,simulated:verification.simulated,elementSetCount:verification.elementSetCount}:null});
 }
 return {...base,events,scans:scans.slice(0,20).map(s=>({scanId:s._id,status:s.status,phase:s.phase,progress:s.progress,counts:s.counts,coverage:s.coverage})),truncated};
}});
