import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {makeFunctionReference as ref} from "convex/server";
import {backend,insertEvent} from "./helpers";
import {internal} from "../convex/_generated/api";
import {advocateCandidates} from "../fixtures/policies";
import {verify} from "../convex/lib/orbitClient";
import {FIXTURE_NOW} from "../fixtures/events";
vi.mock("../convex/lib/orbitClient",async original=>({...await original<typeof import("../convex/lib/orbitClient")>(),verify:vi.fn()}));
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(FIXTURE_NOW);vi.resetAllMocks();});afterEach(()=>vi.useRealTimers());
const request=ref<"action">("verifications:request"), get=ref<"query">("verifications:get"), replay=ref<"query">("verifications:replay"), refresh=ref<"action">("verifications:refreshReplay");
const answer={kind:"live" as const,result:"awaiting_data" as const,label:"awaiting verification data",expected:{deltaAKm:0.5,sign:1 as const},observed:null,elementSetCount:0,series:[],thresholds:{z:5,minDeltaAKm:0.05,sizeTolerance:0.5,minSets:8},method:"robust baseline",limitations:[],missing:["eight element sets"],sources:[],simulated:true};
async function setup(){const t=backend(),eventId=await insertEvent(t);await t.mutation(internal.operators.provision,{key:"a",name:"A",simulated:true,objectIds:["SIM-0001"],members:[{tokenIdentifier:"a",role:"operator",assignedObjectIds:["SIM-0001"]},{tokenIdentifier:"other",role:"operator",assignedObjectIds:[]}]});
 const maneuverId=await t.run(async ctx=>{const p=await ctx.db.insert("proposals",{eventId,candidateId:"P1",label:"P1",latestRevision:1,demoRunId:null,createdAt:FIXTURE_NOW});const c=await ctx.db.insert("candidateRevisions",{...advocateCandidates[0],eventId,movingObjectId:"SIM-0001",burnTimeUtc:new Date(FIXTURE_NOW-24*3600000).toISOString().replace(".000Z","Z")});await ctx.db.insert("proposalRevisions",{proposalId:p,eventId,revision:1,candidateRevisionId:c,changeSummary:null,sourceMessageIds:[],rationale:null,schedulePreviewDiff:null,schedulePreviewHash:null,simulated:true,createdAt:FIXTURE_NOW});
 const id=await ctx.db.insert("maneuvers",{refs:[{eventId,proposalId:p,revision:1,selectionGeneration:1}],trajectoryPlanId:null,trajectoryPlanVersion:null,pinned:{snapshotId:"snapshot",evidenceKeys:[],policyRevisions:[],assignmentVersions:[]},intentKey:"one",status:"committed",filePath:"operators/a/schedule.json",diff:"checked diff",commitSha:"abc",writtenBy:"droid",rescreenJobId:null,rescreen:null,error:null,reviewRequired:false,demoRunId:null,updatedAt:FIXTURE_NOW});await ctx.db.insert("maneuverEvents",{maneuverId:id,eventId});await ctx.db.patch(eventId,{status:"scheduled"});return id;});return {t,eventId,maneuverId,as:(id="a")=>t.withIdentity({tokenIdentifier:id})};}
describe("verification evidence",()=>{
 it("requires event responsibility and a committed schedule before requesting live evidence",async()=>{const {t,as,eventId,maneuverId}=await setup();await expect(t.action(request,{eventId})).rejects.toThrow();await expect(as("other").action(request,{eventId})).rejects.toThrow();await t.run(ctx=>ctx.db.patch(maneuverId,{status:"preview"}));await expect(as().action(request,{eventId})).rejects.toThrow();expect(verify).not.toHaveBeenCalled();});
 it("stores awaiting data separately without turning a scheduled artifact into execution",async()=>{const {t,as,eventId}=await setup();vi.mocked(verify).mockResolvedValue(answer);await as().action(request,{eventId});expect(await as().query(get,{eventId})).toMatchObject({result:"awaiting_data",missing:["eight element sets"]});expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"awaiting_verification_data"});await as().action(request,{eventId});expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(1);});
 it("rejects results when the schedule changes while the service is working",async()=>{const {t,as,eventId,maneuverId}=await setup();vi.mocked(verify).mockImplementation(async()=>{await t.run(ctx=>ctx.db.patch(maneuverId,{reviewRequired:true}));return answer;});await expect(as().action(request,{eventId})).rejects.toThrow();expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(0);});
 it("keeps replay separate and visibly simulated, never as evidence for an incident",async()=>{const {t,as,eventId}=await setup();vi.mocked(verify).mockResolvedValue({...answer,kind:"replay"});await t.action(refresh,{});expect(await as().query(replay,{})).toMatchObject({kind:"replay",simulated:true});expect((await as().query(replay,{})).label).toMatch(/SIMULATED/);expect(await as().query(get,{eventId})).toBeNull();expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"scheduled"});});
});

it("fences a late older verification request even when the maneuver is unchanged",async()=>{
 const {as,eventId}=await setup();
 const reserve=ref<"mutation">("verifications:reserve"), store=ref<"mutation">("verifications:storeResult");
 const first=await as().mutation(reserve,{eventId,requestId:"first"});
 await as().mutation(reserve,{eventId,requestId:"second"});
 await expect(as().mutation(store,{eventId,requestId:"first",fingerprint:first.fingerprint,result:answer})).rejects.toThrow(/newer verification/);
 await as().mutation(store,{eventId,requestId:"second",fingerprint:first.fingerprint,result:answer});
 expect(await as().query(get,{eventId})).toMatchObject({result:"awaiting_data"});
});
it("sanitizes failed evidence requests and leaves the schedule unchanged",async()=>{
 const {t,as,eventId}=await setup();vi.mocked(verify).mockRejectedValue(new Error("secret credentials"));
 await expect(as().action(request,{eventId})).rejects.toThrow(/orbit service/);
 expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(0);
 expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"scheduled"});
});
it("never reads a previous schedule's result as evidence for a replacement",async()=>{
 const {t,as,eventId,maneuverId}=await setup();vi.mocked(verify).mockResolvedValue(answer);await as().action(request,{eventId});
 await t.run(ctx=>ctx.db.patch(maneuverId,{intentKey:"replacement"}));
 expect(await as().query(get,{eventId})).toBeNull();
});

const reserve=ref<"mutation">("verifications:reserve"), store=ref<"mutation">("verifications:storeResult");
function observed(result:"consistent"|"mismatch"){
 const expected=Number((2*(advocateCandidates[0].deltaVMs!/1000)/Math.sqrt(398600.8/6900**3)).toFixed(4));
 const change=result==="consistent"?expected:-expected;
 return {...answer,expected:{deltaAKm:expected,sign:1 as const},result,label:result==="consistent"?"evidence consistent with plan":"mismatch",missing:[],elementSetCount:8,
  observed:{deltaAKm:change,z:Number((change/0.01).toFixed(2)),epochUtc:new Date(FIXTURE_NOW-13*3600000).toISOString()},
  series:Array.from({length:8},(_,i)=>({epochUtc:new Date(FIXTURE_NOW-(i<4?48-i*6:22-(i-4)*6)*3600000).toISOString(),smaKm:i<4?6900:6900+change})),
  sources:[{name:"gp_history",url:null,epochUtc:new Date(FIXTURE_NOW-600000).toISOString(),fetchedAt:null}],
  limitations:["Public observations are evidence, not proof of execution."]};
}
it.each(["consistent","mismatch"] as const)("stores client-validated %s evidence bound to the committed intent",async result=>{
 const {t,as,eventId}=await setup();
 const real=await vi.importActual<typeof import("../convex/lib/orbitClient")>("../convex/lib/orbitClient");
 vi.stubEnv("ORBIT_SERVICE_URL","https://orbit.test");vi.stubEnv("ORBIT_SERVICE_TOKEN","test-only");
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(observed(result)))));
 vi.mocked(verify).mockImplementation(real.verify);
 try {
  const value=await as().action(request,{eventId});
  expect(await as().query(get,{eventId})).toMatchObject({verificationId:value.verificationId,result,observed:{deltaAKm:observed(result).observed.deltaAKm}});
  expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:result==="consistent"?"verified":"flagged"});
  expect(await t.run(async ctx=>(await ctx.db.query("log").collect()).find(l=>l.action==="verified"))).toMatchObject({after:{verificationId:String(value.verificationId),intentKey:"one",result}});
  expect(await t.run(ctx=>ctx.db.query("maneuvers").first())).toMatchObject({status:"committed",commitSha:"abc"});
 } finally {vi.unstubAllEnvs();vi.unstubAllGlobals();}
});
it("does not accept malformed observed evidence through the actual orbital client",async()=>{
 const {t,as,eventId}=await setup();const real=await vi.importActual<typeof import("../convex/lib/orbitClient")>("../convex/lib/orbitClient");
 vi.stubEnv("ORBIT_SERVICE_URL","https://orbit.test");vi.stubEnv("ORBIT_SERVICE_TOKEN","test-only");
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({...observed("consistent"),elementSetCount:1}))));vi.mocked(verify).mockImplementation(real.verify);
 try{await expect(as().action(request,{eventId})).rejects.toThrow();expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(0);expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"scheduled"});}
 finally{vi.unstubAllEnvs();vi.unstubAllGlobals();}
});
it("makes a completed verification request immutable even when delivered twice",async()=>{
 const {t,as,eventId}=await setup();const ticket=await as().mutation(reserve,{eventId,requestId:"immutable"});
 const first=await as().mutation(store,{eventId,requestId:"immutable",fingerprint:ticket.fingerprint,result:observed("consistent")});
 expect(await as().mutation(store,{eventId,requestId:"immutable",fingerprint:ticket.fingerprint,result:observed("consistent")})).toEqual({...first,reused:true});
 await expect(as().mutation(store,{eventId,requestId:"immutable",fingerprint:ticket.fingerprint,result:answer})).rejects.toThrow(/already has a different/);
 expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(1);
 expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"verified"});
});
it("records completion of a request even when it reuses identical earlier evidence",async()=>{
 const {as,eventId}=await setup();const first=await as().mutation(reserve,{eventId,requestId:"first"});
 await as().mutation(store,{eventId,requestId:"first",fingerprint:first.fingerprint,result:answer});
 const second=await as().mutation(reserve,{eventId,requestId:"second"});
 expect(await as().mutation(store,{eventId,requestId:"second",fingerprint:second.fingerprint,result:answer})).toMatchObject({reused:true});
 await expect(as().mutation(store,{eventId,requestId:"second",fingerprint:second.fingerprint,result:observed("consistent")})).rejects.toThrow(/already has a different/);
});
it("does not let an update to an old maneuver replace the newer schedule's evidence",async()=>{
 const {t,as,eventId,maneuverId}=await setup();vi.mocked(verify).mockResolvedValue(answer);await as().action(request,{eventId});
 await t.run(async ctx=>{const old=(await ctx.db.get(maneuverId))!;const {_id,_creationTime,...row}=old;const id=await ctx.db.insert("maneuvers",{...row,intentKey:"replacement",updatedAt:FIXTURE_NOW+1000});await ctx.db.insert("maneuverEvents",{eventId,maneuverId:id});await ctx.db.patch(maneuverId,{updatedAt:FIXTURE_NOW+2000});});
 expect(await as().query(get,{eventId})).toBeNull();
});
it("refuses evidence after responsibility is revoked during the service request",async()=>{
 const {t,as,eventId}=await setup();vi.mocked(verify).mockImplementation(async()=>{await t.run(async ctx=>{const a=(await ctx.db.query("fleetAssignments").first())!;await ctx.db.patch(a._id,{active:false});});return observed("consistent");});
 await expect(as().action(request,{eventId})).rejects.toThrow(/responsible/);
 expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(0);
 expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"scheduled"});
});
it("refuses an evidence row whose audit binding belongs to another run",async()=>{
 const {t,as,eventId}=await setup();vi.mocked(verify).mockResolvedValue(answer);await as().action(request,{eventId});
 await t.run(async ctx=>{const run=await ctx.db.insert("demoRuns",{scenario:"other",state:"open",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:null});const row=(await ctx.db.query("verifications").first())!;await ctx.db.patch(row._id,{demoRunId:run});});
 expect(await as().query(get,{eventId})).toBeNull();
});
it("keeps repeated replay refreshes idempotent and refuses replay as live incident evidence",async()=>{
 const {t,as,eventId}=await setup();vi.mocked(verify).mockResolvedValue({...observed("consistent"),kind:"replay"});
 await t.action(refresh,{});await t.action(refresh,{});
 expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(1);
 await expect(as().action(request,{eventId})).rejects.toThrow(/wrong origin/);
 expect(await t.run(ctx=>ctx.db.get(eventId))).toMatchObject({status:"scheduled"});
 expect(await as().query(get,{eventId})).toBeNull();
});
it("does not publish a result after its demo run closes during verification",async()=>{
 const {t,as,eventId,maneuverId}=await setup();
 const run=await t.run(async ctx=>{const id=await ctx.db.insert("demoRuns",{scenario:"demo",state:"open",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:null});await ctx.db.patch(eventId,{demoRunId:id});await ctx.db.patch(maneuverId,{demoRunId:id});return id;});
 vi.mocked(verify).mockImplementation(async()=>{await t.run(ctx=>ctx.db.patch(run,{state:"closed",closedAt:Date.now()}));return observed("consistent");});
 await expect(as().action(request,{eventId})).rejects.toThrow(/closed/);
 expect(await t.run(ctx=>ctx.db.query("verifications").collect())).toHaveLength(0);
});
it("refuses an over-limit history before spending an upstream verification request",async()=>{
 const {t,as,eventId}=await setup();vi.mocked(verify).mockResolvedValue(answer);
 await t.run(async ctx=>{for(let i=0;i<499;i++)await ctx.db.insert("log",{eventId,actor:{kind:"system"},action:"status_changed",summary:"Prior event update",texts:null,before:null,after:null,proposalId:null,revision:null,roomId:null,demoRunId:null,simulated:true,at:Date.now()});});
 await expect(as().action(request,{eventId})).rejects.toThrow(/pagination/);
 expect(verify).not.toHaveBeenCalled();
});
