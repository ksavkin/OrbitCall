import { beforeEach,afterEach,describe,it,expect,vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { backend,registerSnapshot,catalogObject } from "./helpers";
import { internal } from "../convex/_generated/api";
import { simulate } from "../convex/lib/orbitClient";
import { FIXTURE_NOW } from "../fixtures/events";
vi.mock("../convex/lib/orbitClient",async original=>({...await original<typeof import("../convex/lib/orbitClient")>(),simulate:vi.fn()}));
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(FIXTURE_NOW);vi.stubEnv("DEMO_LAUNCH","on");vi.resetAllMocks();vi.mocked(simulate).mockImplementation(async r=>({objectId:r.objectId!,omm:{OBJECT_NAME:r.name},tle:["line1","line2"],simulated:true,event:{objectA:r.targetObjectId,objectB:r.objectId!,tcaUtc:r.tcaUtc,missKm:0.2,relSpeedKmS:9,simulated:true},assumptions:["simulated"]}));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
const launch=ref<"action">("demoLaunch:launchSatellite");
const args={name:"Demo satellite",ownerName:"Demo company",ownerCountry:"US",targetObjectId:"200",tcaUtc:new Date(FIXTURE_NOW+24*3600000).toISOString().replace(".000Z","Z"),scenarioPc:0.001,requestId:"one"};
async function setup(){const t=backend(),snap=await registerSnapshot(t);await t.run(async ctx=>{await ctx.db.patch(snap,{ommUrl:"/snapshots/gp-20261024T2134Z/catalog.json"});await ctx.db.insert("spaceObjects",catalogObject("200"));});
 await t.mutation(internal.operators.provision,{key:"a",name:"A",simulated:true,objectIds:[],members:[{tokenIdentifier:"a",role:"operator",assignedObjectIds:[]},{tokenIdentifier:"eye",role:"demo_observer",assignedObjectIds:[]}]});return {t,as:(id="a")=>t.withIdentity({tokenIdentifier:id})};}
describe("demo launch",()=>{
 it("requires an operator and enabled feature before an external request",async()=>{const {t,as}=await setup();await expect(t.action(launch,args)).rejects.toThrow();await expect(as("eye").action(launch,args)).rejects.toThrow();vi.stubEnv("DEMO_LAUNCH","");await expect(as().action(launch,args)).rejects.toThrow();expect(simulate).not.toHaveBeenCalled();});
 it("stores flagged OMM and one encounter, assigns only the caller and reuses a completed request",async()=>{const {t,as}=await setup();const result=await as().action(launch,args);expect(result.objectId).toMatch(/^SIM-/);expect(await as().action(launch,args)).toEqual(result);expect(simulate).toHaveBeenCalledTimes(1);
  const e=await t.run(ctx=>ctx.db.get(result.eventId));expect(e).toMatchObject({simulated:true,pcValue:0.001,demoRunId:result.demoRunId});
  expect(await t.run(ctx=>ctx.db.query("satelliteOwners").collect())).toHaveLength(1);
  expect((await as().query(ref<"query">("demoLaunch:orbit"),{objectId:result.objectId})).omm).toEqual({OBJECT_NAME:args.name});
 });
 it("refuses a changed request key and hides raw upstream failures",async()=>{const {as}=await setup();vi.mocked(simulate).mockRejectedValueOnce(new Error("private token"));await expect(as().action(launch,args)).rejects.toThrow(/orbit service/);await expect(as().action(launch,{...args,name:"different"})).rejects.toThrow(/different/);expect(simulate).toHaveBeenCalledTimes(1);});
 it("does not publish after reset while the numerical request is in flight",async()=>{const {t,as}=await setup();const original=vi.mocked(simulate).getMockImplementation()!;vi.mocked(simulate).mockImplementation(async r=>{await t.run(async ctx=>{const d=(await ctx.db.query("demoRuns").first())!;await ctx.db.patch(d._id,{state:"closed",closedAt:Date.now()});});return original(r);});await expect(as().action(launch,args)).rejects.toThrow();expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);expect(await t.run(ctx=>ctx.db.query("fleetAssignments").collect())).toHaveLength(0);});
});

it("does not publish after ownership changes without an assignment-version change",async()=>{
 const {t,as}=await setup();
 await t.run(async ctx=>{
  const user=(await ctx.db.query("users").withIndex("by_token_identifier",q=>q.eq("tokenIdentifier","a")).unique())!;
  await ctx.db.insert("fleetAssignments",{userId:user._id,objectId:"100",active:true});
  await ctx.db.insert("satelliteOwners",{companyId:user.companyId,objectId:"100"});
 });
 const original=vi.mocked(simulate).getMockImplementation()!;
 vi.mocked(simulate).mockImplementation(async r=>{
  await t.run(async ctx=>{const owner=(await ctx.db.query("satelliteOwners").first())!;await ctx.db.delete(owner._id);});
  return original(r);
 });
 await expect(as().action(launch,args)).rejects.toThrow(/ownership changed/);
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
 const run=await t.run(ctx=>ctx.db.query("demoRuns").first());
 expect(JSON.parse(run!.manifest!["launch:one"] as string).state).toBe("failed");
});
it("ignores an earlier failed reservation if its result arrives late",async()=>{
 const {t,as}=await setup();
 const reservation=await as().mutation(ref<"mutation">("demoLaunch:reserve"),args);
 const ticket={demoRunId:reservation.demoRunId,key:reservation.key};
 await t.mutation(ref<"mutation">("demoLaunch:failed"),ticket);
 const result=await vi.mocked(simulate).getMockImplementation()!({targetObjectId:args.targetObjectId,tcaUtc:args.tcaUtc,objectId:reservation.reservation.objectId,name:args.name});
 await expect(t.mutation(ref<"mutation">("demoLaunch:publish"),{...ticket,result})).rejects.toThrow(/no longer pending/);
 expect(await t.run(ctx=>ctx.db.query("events").collect())).toHaveLength(0);
});
it("does not mutate the reset manifest when a late upstream error arrives",async()=>{
 const {t,as}=await setup();
 const ticket=await as().mutation(ref<"mutation">("demoLaunch:reserve"),args);
 await t.run(ctx=>ctx.db.patch(ticket.demoRunId,{state:"closed",closedAt:Date.now()}));
 const before=await t.run(ctx=>ctx.db.get(ticket.demoRunId));
 await t.mutation(ref<"mutation">("demoLaunch:failed"),{demoRunId:ticket.demoRunId,key:ticket.key});
 expect(await t.run(ctx=>ctx.db.get(ticket.demoRunId))).toEqual(before);
});
it("persists the service's refined closest-approach time instead of assuming the requested time",async()=>{
 const {t,as}=await setup();const original=vi.mocked(simulate).getMockImplementation()!;
 const refined=new Date(Date.parse(args.tcaUtc)+2000).toISOString().replace(".000Z","Z");
 vi.mocked(simulate).mockImplementation(async r=>{const value=await original(r);value.event.tcaUtc=refined;return value;});
 const result=await as().action(launch,args);
 expect(await t.run(ctx=>ctx.db.get(result.eventId))).toMatchObject({tcaMs:Date.parse(refined)});
});
