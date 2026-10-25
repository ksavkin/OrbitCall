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
