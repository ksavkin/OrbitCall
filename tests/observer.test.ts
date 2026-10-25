import { describe, it, expect } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { backend, insertEvent } from "./helpers";
import { internal } from "../convex/_generated/api";
const view=ref<"query">("observer:publicView"), grant=ref<"mutation">("observer:authorize");
async function setup(){
 const t=backend();
 await t.mutation(internal.operators.provision,{key:"a",name:"A",simulated:true,objectIds:[],members:[
  {tokenIdentifier:"eye",role:"demo_observer",assignedObjectIds:[]},{tokenIdentifier:"other",role:"demo_observer",assignedObjectIds:[]},{tokenIdentifier:"op",role:"operator",assignedObjectIds:[]}]});
 const eventId=await insertEvent(t);
 const run=await t.run(async ctx=>{const id=await ctx.db.insert("demoRuns",{scenario:"demo",state:"open",startedBy:null,manifest:{secret:"private-memory"},startedAt:Date.now(),closedAt:null});await ctx.db.patch(eventId,{demoRunId:id});return id;});
 const userId=await t.run(async ctx=>(await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","eye")).unique())!._id);
 return {t,run,eventId,userId,as:(id="eye")=>t.withIdentity({tokenIdentifier:id})};
}
describe("observer projection",()=>{
 it("requires server-granted access to this exact run",async()=>{
  const {t,run,userId,as}=await setup();
  await expect(t.query(view,{demoRunId:run})).rejects.toThrow();
  await expect(as().query(view,{demoRunId:run})).rejects.toThrow();
  await t.mutation(grant,{demoRunId:run,userId});
  await expect(as("other").query(view,{demoRunId:run})).rejects.toThrow();
  await expect(as("op").query(view,{demoRunId:run})).rejects.toThrow();
  expect((await as().query(view,{demoRunId:run})).events).toHaveLength(1);
 });
 it("returns an allowlist with no raw manifest, identities, private context or decision controls",async()=>{
  const {t,run,userId,as}=await setup();await t.mutation(grant,{demoRunId:run,userId});
  const r=await as().query(view,{demoRunId:run});
  expect(Object.keys(r).sort()).toEqual(["demoRunId","events","scans","scenario","state","truncated"].sort());
  expect(JSON.stringify(r)).not.toMatch(/private-memory|tokenIdentifier|policy|checkedOutput|rawResponse|approveUrl/);
  expect(r.events[0]).toMatchObject({simulated:true,selection:null,approval:{approved:0,required:0,allRequiredApproved:false}});
 });
 it("does not mix a different run or keep a reset demonstration live",async()=>{
  const {t,run,userId,as}=await setup();await t.mutation(grant,{demoRunId:run,userId});
  await insertEvent(t,{...(await import("../fixtures/events")).redEvent,tcaUtc:"2026-10-26T12:00:00Z"});
  expect((await as().query(view,{demoRunId:run})).events).toHaveLength(1);
  await t.run(ctx=>ctx.db.patch(run,{state:"closed",closedAt:Date.now()}));
  expect(await as().query(view,{demoRunId:run})).toMatchObject({state:"closed",events:[],scans:[]});
 });
});

async function approved() {
 const s=await setup(); const {t,run,eventId,userId}=s;
 await t.mutation(grant,{demoRunId:run,userId});
 const ids=await t.run(async ctx=>{
  const e=(await ctx.db.get(eventId))!;
  const a=(await ctx.db.get(e.objectAId))!;
  const op=(await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","op")).unique())!;
  await ctx.db.insert("satelliteOwners",{objectId:a.objectId,companyId:op.companyId});
  await ctx.db.insert("fleetAssignments",{objectId:a.objectId,userId:op._id,active:true});
  await ctx.db.patch(eventId,{workflow:"unilateral_debris",requiredApprovalSides:["A"],approvalRuleVersion:1});
  const {testCandidates}=await import("../fixtures/candidates");
  const {inputKey}=await import("../convex/lib/analyst"),{loadFacts}=await import("../convex/lib/events");
  const c={...testCandidates[0],candidateId:"P1",assumptions:[...testCandidates[0].assumptions]}, candidateId=await ctx.db.insert("candidateRevisions",{...c,eventId});
  const setId=await ctx.db.insert("candidateSets",{eventId,companyAId:op.companyId,companyBId:null,version:1,evidenceKey:inputKey(await loadFacts(ctx,e)),candidateRevisionIds:[candidateId],state:"open",reviewRequired:false});
  const proposalId=await ctx.db.insert("proposals",{eventId,candidateId:c.candidateId,label:c.label,latestRevision:c.revision,demoRunId:run,createdAt:Date.now()});
  await ctx.db.insert("proposalRevisions",{eventId,proposalId,revision:c.revision,candidateRevisionId:candidateId,changeSummary:null,sourceMessageIds:[],rationale:null,schedulePreviewDiff:null,schedulePreviewHash:null,simulated:true,createdAt:Date.now()});
  await ctx.db.insert("selections",{eventId,proposalId,revision:c.revision,generation:1,by:{kind:"human",userId:op._id},at:Date.now(),lastReset:null});
  const approvalId=await ctx.db.insert("approvals",{eventId,side:"A",status:"approved",userId:op._id,companyId:op.companyId,proposalId,revision:c.revision,selectionGeneration:1,approvalRuleVersion:1,trajectoryPlanId:null,trajectoryPlanVersion:null,reason:null,demoRunId:run,current:true,at:Date.now()});
  return {setId,approvalId,proposalId,revision:c.revision};
 });
 return {...s,...ids};
}
it.each(["evidence","candidate","review"])("does not present obsolete approvals after %s changes",async change=>{
 const s=await approved();
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].approval.allRequiredApproved).toBe(true);
 await s.t.run(async ctx=>{
  if(change==="evidence")await ctx.db.patch(s.eventId,{missKm:5});
  if(change==="candidate")await ctx.db.patch(s.setId,{candidateRevisionIds:[]});
  if(change==="review")await ctx.db.patch(s.setId,{reviewRequired:true});
 });
 const event=(await s.as().query(view,{demoRunId:s.run})).events[0];
 expect(event.approval).toMatchObject({approved:0,allRequiredApproved:false});
 if(change!=="review")expect(event.candidates).toEqual([]);
});
it("rejects an approval attached to an obsolete shared trajectory plan",async()=>{
 const s=await approved();
 await s.t.run(async ctx=>{
  const id=await ctx.db.insert("trajectoryPlans",{objectId:"SIM-0001",planVersion:2,state:"authorizing",affectedEventIds:[s.eventId],eventRefs:[{eventId:s.eventId,proposalId:s.proposalId,revision:s.revision,selectionGeneration:1}],maneuverId:null,demoRunId:s.run,createdAt:Date.now(),updatedAt:Date.now()});
  await ctx.db.patch(s.approvalId,{trajectoryPlanId:id,trajectoryPlanVersion:1});
 });
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].approval.allRequiredApproved).toBe(false);
});
it("lets a newer veto dominate a previously current approval",async()=>{
 const s=await approved();
 await s.t.run(async ctx=>{const row=(await ctx.db.get(s.approvalId))!;const {_id,_creationTime,...data}=row;await ctx.db.insert("approvals",{...data,status:"vetoed"});});
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].approval.allRequiredApproved).toBe(false);
});
