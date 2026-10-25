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
 const maneuverId=await t.run(async ctx=>{const p=await ctx.db.insert("proposals",{eventId,candidateId:"P1",label:"P1",latestRevision:1,demoRunId:null,createdAt:FIXTURE_NOW});const c=await ctx.db.insert("candidateRevisions",{...advocateCandidates[0],eventId,movingObjectId:"SIM-0001",burnTimeUtc:new Date(FIXTURE_NOW-3600000).toISOString().replace(".000Z","Z")});await ctx.db.insert("proposalRevisions",{proposalId:p,eventId,revision:1,candidateRevisionId:c,changeSummary:null,sourceMessageIds:[],rationale:null,schedulePreviewDiff:null,schedulePreviewHash:null,simulated:true,createdAt:FIXTURE_NOW});
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
