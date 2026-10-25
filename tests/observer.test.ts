import { describe, it, expect } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { backend, insertEvent } from "./helpers";
import { internal } from "../convex/_generated/api";
const view=ref<"query">("observer:publicView"), grant=ref<"mutation">("observer:authorize");
async function setup(){
 const t=backend();
 await t.mutation(internal.operators.provision,{key:"a",name:"A",simulated:true,objectIds:[],members:[
  {tokenIdentifier:"eye",role:"demo_observer",assignedObjectIds:[]},{tokenIdentifier:"other",role:"demo_observer",assignedObjectIds:[]},{tokenIdentifier:"op",role:"operator",assignedObjectIds:[]},{tokenIdentifier:"head",role:"head_of_ops",assignedObjectIds:[]}]});
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

describe("observer run lookup",()=>{
 const myRun=ref<"query">("observer:myRun");
 it("returns null until a run is granted, then the granted open run",async()=>{
  const {t,run,userId,as}=await setup();
  expect(await as().query(myRun,{})).toBeNull();
  await t.mutation(grant,{demoRunId:run,userId});
  expect(await as().query(myRun,{})).toEqual({demoRunId:run,scenario:"demo"});
  expect(await as("other").query(myRun,{})).toBeNull();
 });
 it("drops a closed run and follows a new grant after a reset",async()=>{
  const {t,run,userId,as}=await setup();await t.mutation(grant,{demoRunId:run,userId});
  await t.run(ctx=>ctx.db.patch(run,{state:"closed",closedAt:Date.now()}));
  expect(await as().query(myRun,{})).toBeNull();
  const next=await t.run(ctx=>ctx.db.insert("demoRuns",{scenario:"rerun",state:"open",startedBy:null,manifest:null,startedAt:Date.now(),closedAt:null}));
  await t.mutation(grant,{demoRunId:next,userId});
  expect(await as().query(myRun,{})).toEqual({demoRunId:next,scenario:"rerun"});
 });
 it("is refused to anyone but a demonstration observer and returns no manifest",async()=>{
  const {t,run,userId,as}=await setup();await t.mutation(grant,{demoRunId:run,userId});
  await expect(t.query(myRun,{})).rejects.toThrow();
  await expect(as("op").query(myRun,{})).rejects.toThrow(/FORBIDDEN|observer/);
  await expect(as("head").query(myRun,{})).rejects.toThrow(/FORBIDDEN|observer/);
  expect(JSON.stringify(await as().query(myRun,{}))).not.toMatch(/private-memory|observerUserId/);
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
  const approvalId=await ctx.db.insert("approvals",{eventId,side:"A",status:"approved",userId:op._id,companyId:op.companyId,proposalId,revision:c.revision,selectionGeneration:1,approvalRuleVersion:1,trajectoryPlanId:null,trajectoryPlanVersion:null,reason:null,demoRunId:run,current:true,at:Date.now(),assignmentVersion:op.assignmentVersion??1});
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
it("shows only evidence bound to the newest committed schedule, not an older plan or replay",async()=>{
 const s=await approved();
 const ids=await s.t.run(async ctx=>{
  const values={refs:[{eventId:s.eventId,proposalId:s.proposalId,revision:s.revision,selectionGeneration:1}],trajectoryPlanId:null,trajectoryPlanVersion:null,pinned:{snapshotId:"test",evidenceKeys:[],policyRevisions:[],assignmentVersions:[]},status:"committed" as const,filePath:"operators/a/schedule.json",diff:"diff",commitSha:"abc",writtenBy:"droid" as const,rescreenJobId:null,rescreen:null,error:null,reviewRequired:false,demoRunId:s.run,updatedAt:Date.now()};
  const old=await ctx.db.insert("maneuvers",{...values,intentKey:"old"});const current=await ctx.db.insert("maneuvers",{...values,intentKey:"current"});
  for(const maneuverId of [old,current])await ctx.db.insert("maneuverEvents",{maneuverId,eventId:s.eventId});
  const verificationId=await ctx.db.insert("verifications",{eventId:s.eventId,kind:"live",result:"consistent",label:"evidence consistent with plan",expected:{deltaAKm:0.5,sign:1},observed:{deltaAKm:0.5,z:10,epochUtc:"2026-10-25T01:00:00Z"},elementSetCount:8,series:[],thresholds:{z:5,minDeltaAKm:0.05,sizeTolerance:0.5,minSets:8},method:"fixture",limitations:[],missing:[],sources:[],demoRunId:s.run,simulated:true,createdAt:Date.now()});
  const log=await ctx.db.insert("log",{eventId:s.eventId,actor:{kind:"system"},action:"verified",summary:"Evidence",texts:null,before:null,after:{verificationId:String(verificationId),intentKey:"old"},proposalId:s.proposalId,revision:s.revision,roomId:null,demoRunId:s.run,simulated:true,at:Date.now()});
  return {old,current,log,verificationId};
 });
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].verification).toBeNull();
 await s.t.run(ctx=>ctx.db.patch(ids.old,{updatedAt:Date.now()+100000}));
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].verification).toBeNull();
 await s.t.run(ctx=>ctx.db.patch(ids.log,{after:{verificationId:String(ids.verificationId),intentKey:"current"}}));
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].verification).toMatchObject({result:"consistent"});
 await s.t.run(ctx=>ctx.db.patch(ids.current,{reviewRequired:true}));
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].verification).toBeNull();
});

it.each(["changed", "missing"])("hides %s approval assignment-version pins", async kind => {
 const s=await approved();
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].approval.allRequiredApproved).toBe(true);
 await s.t.run(async ctx=>{
  const approval=(await ctx.db.get(s.approvalId))!;
  if(kind==="missing")await ctx.db.patch(approval._id,{assignmentVersion:undefined});
  else await ctx.db.patch(approval.userId,{assignmentVersion:99});
 });
 expect((await s.as().query(view,{demoRunId:s.run})).events[0].approval).toMatchObject({approved:0,allRequiredApproved:false});
});

describe("observer access and allowlist", () => {
  it("refuses a signed-out caller, a head of operations and an observer granted a different run", async () => {
    const { t, run, userId, as } = await setup();
    await t.mutation(grant, { demoRunId: run, userId });
    await expect(t.query(view, { demoRunId: run })).rejects.toThrow("UNAUTHENTICATED");
    await expect(as("head").query(view, { demoRunId: run })).rejects.toThrow("FORBIDDEN");
    const otherRun = await t.run(ctx => ctx.db.insert("demoRuns", {
      scenario: "demo", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null,
    }));
    await expect(as().query(view, { demoRunId: otherRun })).rejects.toThrow("FORBIDDEN");
    // A grant is per observer and per run: another observer's grant on run 2 admits neither this one there nor itself on run 1.
    await t.mutation(grant, { demoRunId: otherRun, userId: (await t.run(async ctx =>
      (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", "other")).unique())!._id)) });
    await expect(as().query(view, { demoRunId: otherRun })).rejects.toThrow("FORBIDDEN");
    await expect(as("other").query(view, { demoRunId: run })).rejects.toThrow("FORBIDDEN");
  });

  it("returns only allowlisted keys and no private record, identity or control on a fully populated projection", async () => {
    const s = await approved();
    const secrets = await s.t.run(async ctx => {
      const approval = (await ctx.db.get(s.approvalId))!;
      const op = (await ctx.db.get(approval.userId))!;
      await ctx.db.patch(op._id, { name: "SENTINEL-OPERATOR-NAME" });
      await ctx.db.patch(op.companyId, { contact: "sentinel-ops@example.test" });
      await ctx.db.patch(s.approvalId, { reason: "SENTINEL-APPROVAL-REASON" });
      const policyId = await ctx.db.insert("policies", {
        companyId: op.companyId, revision: 1, updatedAt: Date.now(),
        satellites: [{
          objectId: "SENTINEL-POLICY-OBJECT", minFuelReserveKg: 4242.42, currentFuelKg: 1, dryMassKg: 1, ispS: 1,
          protectedWindows: [], preferredWindows: [], acceptablePc: 0.000123456, missionPriority: "high",
        }],
      });
      const runId = await ctx.db.insert("agentRuns", {
        eventId: s.eventId, inputKey: "k", status: "succeeded", role: "operator_advocate", companyId: op.companyId,
        lastProgressAt: Date.now(), stalled: false, checkedOutput: "SENTINEL-PRIVATE-TRACE",
      });
      await ctx.db.insert("advocateContexts", {
        runId, side: "A", policyId, policyRevision: 1, candidateSetId: s.setId, candidateVersion: 1, evidenceKey: "SENTINEL-CONTEXT",
      });
      await ctx.db.insert("memoryAssistants", {
        demoRunId: s.run, companyId: op.companyId, assistantId: "SENTINEL-MEMORY-ASSISTANT", createdAt: Date.now(), closedAt: null,
      });
      // A committed schedule with matching evidence, so jobs and verification are filled too.
      const maneuverId = await ctx.db.insert("maneuvers", {
        refs: [{ eventId: s.eventId, proposalId: s.proposalId, revision: s.revision, selectionGeneration: 1 }],
        trajectoryPlanId: null, trajectoryPlanVersion: null,
        pinned: { snapshotId: "test", evidenceKeys: [], policyRevisions: [], assignmentVersions: [] },
        intentKey: "intent", status: "committed", filePath: "operators/a/SENTINEL-FILE.json", diff: "SENTINEL-DIFF",
        commitSha: "abc", writtenBy: "droid", rescreenJobId: "SENTINEL-JOB", error: null, reviewRequired: false,
        rescreen: {
          snapshotId: "test", evidenceKeys: [], passed: true, objectsChecked: 10, horizonH: 72, originalMissAfterKm: 1,
          newConjunctions: [], refusalReason: null,
        },
        demoRunId: s.run, updatedAt: Date.now(),
      });
      await ctx.db.insert("maneuverEvents", { maneuverId, eventId: s.eventId });
      const verificationId = await ctx.db.insert("verifications", {
        eventId: s.eventId, kind: "live", result: "consistent", label: "evidence consistent with plan",
        expected: { deltaAKm: 0.5, sign: 1 }, observed: { deltaAKm: 0.5, z: 10, epochUtc: "2026-10-25T01:00:00Z" },
        elementSetCount: 8, series: [], thresholds: { z: 5, minDeltaAKm: 0.05, sizeTolerance: 0.5, minSets: 8 },
        method: "SENTINEL-METHOD", limitations: [], missing: [], sources: [], demoRunId: s.run, simulated: true, createdAt: Date.now(),
      });
      await ctx.db.insert("log", {
        eventId: s.eventId, actor: { kind: "system" }, action: "verified", summary: "SENTINEL-LOG", texts: null, before: null,
        after: { verificationId: String(verificationId), intentKey: "intent" }, proposalId: s.proposalId, revision: s.revision,
        roomId: null, demoRunId: s.run, simulated: true, at: Date.now(),
      });
      await ctx.db.insert("scanRuns", {
        requestedBy: op._id, requestId: "SENTINEL-REQUEST", assignmentVersion: 1, primaryObjectIds: ["SENTINEL-PRIMARY"],
        snapshotId: "test", fromMs: 0, toMs: 1, status: "completed", phase: "done", progress: 1,
        counts: { primaryObjects: 1, catalogObjects: 2, primariesCompleted: 1, pairsChecked: 2, eventsFound: 1 },
        coverage: { complete: true, catalogScope: "all", excludedObjects: 0, reasons: [{ reason: "decayed", count: 1 }], missingPrimaryIds: [] },
        jobId: "SENTINEL-SCAN-JOB", startedAt: 0, finishedAt: 1, error: null, demoRunId: s.run, updatedAt: Date.now(),
      });
      return [String(op._id), String(op.companyId), String(policyId), String(runId), "op"];
    });
    const r = await s.as().query(view, { demoRunId: s.run });
    // Populated: every branch of the projection is exercised, not an empty fixture.
    expect(r.events[0]).toMatchObject({ selection: { proposalId: s.proposalId }, approval: { allRequiredApproved: true } });
    expect(r.events[0].jobs).toHaveLength(1);
    expect(r.events[0].verification).toMatchObject({ result: "consistent" });
    expect(r.scans).toHaveLength(1);

    const keys = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") for (const [k, val] of Object.entries(x)) { keys.add(k); walk(val); }
    };
    walk(r);
    expect([...keys].sort()).toEqual([
      "approval", "approved", "allRequiredApproved", "burnTimeUtc", "candidateId", "candidates", "catalogObjects",
      "catalogScope", "commitSha", "complete", "count", "counts", "coverage", "deltaVMs", "demoRunId", "direction",
      "elementSetCount", "eventId", "events", "eventsFound", "excludedObjects", "horizonH", "jobs", "kind", "label",
      "maneuverId", "missAfterKm", "missKm", "missingPrimaryIds", "movingObjectId", "name", "objectId", "objects",
      "objectsChecked", "pairsChecked", "passed", "phase", "primariesCompleted", "primaryObjects", "probability",
      "progress", "proposalId", "reason", "reasons", "required", "rescreen", "result", "reviewRequired", "revision",
      "scanId", "scans", "scenario", "selection", "simulated", "state", "status", "tcaUtc", "truncated", "verification",
    ].sort());

    const text = JSON.stringify(r);
    expect(text).not.toMatch(/SENTINEL|sentinel|private-memory|4242\.42|0\.000123456/);
    for (const id of secrets) expect(text).not.toContain(`"${id}"`);
    // No identity, approval control or per-viewer field ever appears.
    expect(text).not.toMatch(/userId|companyId|tokenIdentifier|email|canAct|mySide|myTurn|approveUrl|manifest|observerUserId/);
  });
});

describe("observer event cap", () => {
  it("reads at most six whole events and reports a seventh as truncated", async () => {
    const { t, run, eventId, userId, as } = await setup();
    await t.mutation(grant, { demoRunId: run, userId });
    const { redEvent } = await import("../fixtures/events");
    // Distinct TCAs, so the fixture's same-encounter dedupe keeps each event apart.
    const addEvent = async (hours: number) => {
      const id = await insertEvent(t, { ...redEvent, tcaUtc: new Date(Date.parse("2026-11-01T00:00:00Z") + hours * 3600_000).toISOString() });
      await t.run(ctx => ctx.db.patch(id, { demoRunId: run }));
      return id;
    };
    const ids = [eventId];
    for (let i = 1; i < 6; i++) ids.push(await addEvent(i));
    const six = await as().query(view, { demoRunId: run });
    expect(six.events.map((e: { eventId: string }) => e.eventId)).toEqual(ids);
    expect(six.truncated).toBe(false);
    await addEvent(6);
    const seven = await as().query(view, { demoRunId: run });
    expect(seven.events).toEqual(six.events);
    expect(seven.truncated).toBe(true);
  });
});
