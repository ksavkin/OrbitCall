import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { findObject, ingestEncounter, isoUtc, loadFacts } from "./lib/events";
import { inputKey } from "./lib/analyst";
import { ommSnapshotId } from "./lib/publishCandidates";
import type { Candidate } from "./lib/policies";
import { publishCandidates } from "./candidates";
import { SEEDED_SCENARIO, seededRunOf } from "./lib/seeded";

// Seeded cases for the live demo, where venue Wi-Fi cannot carry the screening and model calls. One bilateral
// conjunction per pair of the three operator companies, between satellites already in their fleets. The cases stay
// hidden until an operator's scan "finds" them (scanStep, a timed stand-in for the orbit service). "Run agents" then
// plays the Analyst and both Advocates as timed runs on the agent graph and publishes the plan cards (play). Rooms,
// notices, selection, approvals and the voice call are the production code paths, unchanged.
// `npx convex run seedCases:seed` before a run-through; seeding again retires the previous cases first.

// Company keys in pair order: the first company's satellite is side A.
const PAIRS: [string, string][] = [["asd", "jade"], ["jade", "sever"], ["sever", "asd"]];
// Per case: hours to closest approach, miss distance, relative speed, collision probability.
const GEOMETRY = [
  { hours: 20, missKm: 0.142, relSpeedKmS: 9.84, pc: 2.4e-3 },
  { hours: 26, missKm: 0.187, relSpeedKmS: 11.27, pc: 1.1e-3 },
  { hours: 32, missKm: 0.216, relSpeedKmS: 7.63, pc: 6.8e-4 },
];
// Display names for fleet satellites still carrying a placeholder launch name.
const NAMES: Record<string, string> = { asd: "ASD Horizon-1", jade: "Jade Tianlu-1", sever: "Sever-D1" };
const ASSUMPTIONS = ["Indicative impulsive burn from the screening geometry.", "Confirm with a fresh screening before execution."];
const MODEL = "claude-sonnet-5-5";
const caseKey = (eventId: Id<"events">) => `case:${eventId}`;

async function closeSeededRuns(ctx: MutationCtx, now: number) {
  const open = await ctx.db.query("demoRuns").withIndex("by_state", q => q.eq("state", "open")).collect();
  for (const run of open.filter(r => r.scenario === SEEDED_SCENARIO)) {
    await ctx.db.patch(run._id, { state: "closed", closedAt: now });
    for (const event of await ctx.db.query("events").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      await ctx.db.patch(event._id, { active: false, updatedAt: now });
      const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
      if (set) await ctx.db.patch(set._id, { state: "closed" });
      for (const approval of await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect()) {
        await ctx.db.patch(approval._id, { current: false });
      }
    }
    for (const room of await ctx.db.query("rooms").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      await ctx.db.patch(room._id, { state: "closed", closedAt: room.closedAt ?? now });
      for (const member of await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect()) {
        await ctx.db.patch(member._id, { inRoom: false, inCall: false, updatedAt: now });
      }
    }
    for (const row of await ctx.db.query("inbox").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) await ctx.db.delete(row._id);
  }
}

// The satellite an operator of this company is assigned now, preferring the company's own synthetic one.
async function fleetSatellite(ctx: MutationCtx, key: string): Promise<Doc<"spaceObjects">> {
  const company = await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", key)).unique();
  if (!company) throw new ConvexError({ code: "NOT_FOUND", message: `Company ${key} is not provisioned.` });
  const assigned: string[] = [];
  for (const { objectId } of await ctx.db.query("satelliteOwners").withIndex("by_company", q => q.eq("companyId", company._id)).collect()) {
    for (const row of await ctx.db.query("fleetAssignments").withIndex("by_object", q => q.eq("objectId", objectId)).collect()) {
      const user = row.active ? await ctx.db.get(row.userId) : null;
      if (user?.role === "operator" && user.companyId === company._id) { assigned.push(objectId); break; }
    }
  }
  const objectId = assigned.find(id => id.startsWith("SIM-")) ?? assigned[0];
  const object = objectId ? await findObject(ctx, objectId) : null;
  if (!object) throw new ConvexError({ code: "NOT_FOUND", message: `No assigned operator satellite for ${key}.` });
  if (/demo|simul/i.test(object.name) && NAMES[key]) await ctx.db.patch(object._id, { name: NAMES[key] });
  return (await ctx.db.get(object._id))!;
}

// Older launch rehearsals left active encounters on the same satellites; they would make the run ambiguous.
async function retireOtherEncounters(ctx: MutationCtx, object: Doc<"spaceObjects">, now: number) {
  const rows = [
    ...await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", object._id)).collect(),
    ...await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", object._id)).collect(),
  ];
  for (const event of rows) if (event.active && event.simulated) await ctx.db.patch(event._id, { active: false, updatedAt: now });
}

/** `npx convex run seedCases:seed`: retires earlier seeded cases and seeds three hidden ones for scans to find. */
export const seed = internalMutation({
  args: {},
  handler: async ctx => {
    const now = Date.now();
    await closeSeededRuns(ctx, now);
    const snapshots = await ctx.db.query("snapshots").order("desc").take(100);
    const catalog = snapshots.find(s => !s.snapshotId.startsWith("fixture:") && !s.sources.some(x => x.name === "simulated") && ommSnapshotId(s));
    const manifest: Record<string, string | number | boolean | null> = { snapshotId: catalog ? ommSnapshotId(catalog) : null };
    const demoRunId = await ctx.db.insert("demoRuns", { scenario: SEEDED_SCENARIO, state: "open", startedBy: null, manifest, startedAt: now, closedAt: null });
    const stamp = isoUtc(Math.floor(now / 1000) * 1000);
    const snapshotId = await ctx.db.insert("snapshots", { snapshotId: `seeded:${demoRunId}`, ommUrl: catalog?.ommUrl,
      sources: [...(catalog?.sources ?? []).filter(s => s.name !== "socrates"), { name: "simulated" as const, url: null, epochUtc: stamp, fetchedAt: stamp }] });
    const satellites = new Map<string, Doc<"spaceObjects">>();
    for (const key of new Set(PAIRS.flat())) satellites.set(key, await fleetSatellite(ctx, key));
    for (const object of satellites.values()) await retireOtherEncounters(ctx, object, now);
    const eventIds: Id<"events">[] = [];
    for (const [i, [keyA, keyB]] of PAIRS.entries()) {
      const a = satellites.get(keyA)!, b = satellites.get(keyB)!, g = GEOMETRY[i];
      const tcaMs = Math.floor(now / 1000) * 1000 + g.hours * 3_600_000;
      const pick = (o: Doc<"spaceObjects">) => ({ objectId: o.objectId, name: o.name, country: o.country, launchDate: o.launchDate });
      const { eventId } = await ingestEncounter(ctx, { snapshotId, objectA: pick(a), objectB: pick(b), tcaUtc: isoUtc(tcaMs),
        missKm: g.missKm, relSpeedKmS: g.relSpeedKmS, pcValue: g.pc, simulated: true });
      if (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique()) {
        throw new ConvexError({ code: "RATE_LIMITED", message: "Seeded again within a minute of the last seed; wait a minute and retry." });
      }
      // Hidden until a scan finds it.
      await ctx.db.patch(eventId, { demoRunId, status: "new", active: false });
      const burn = (hoursBefore: number) => isoUtc(tcaMs - hoursBefore * 3_600_000);
      const base = { revision: 1, indicative: true as const, missBeforeKm: g.missKm, simulated: true, assumptions: ASSUMPTIONS };
      const candidates: Candidate[] = [
        { ...base, candidateId: "P1", label: "P1", kind: "maneuver", movingSide: "A", movingObjectId: a.objectId, burnTimeUtc: burn(3.5),
          deltaVMs: 0.12, direction: "prograde", estimatedFuelKg: 0.018, missAfterKm: 2.84, reviewCondition: null },
        { ...base, candidateId: "P2", label: "P2", kind: "maneuver", movingSide: "B", movingObjectId: b.objectId, burnTimeUtc: burn(5),
          deltaVMs: 0.18, direction: "retrograde", estimatedFuelKg: 0.026, missAfterKm: 3.41, reviewCondition: null },
        { ...base, candidateId: "P3", label: "P3", kind: "maneuver", movingSide: "A", movingObjectId: a.objectId, burnTimeUtc: burn(9),
          deltaVMs: 0.07, direction: "retrograde", estimatedFuelKg: 0.011, missAfterKm: 1.92, reviewCondition: null },
        { ...base, candidateId: "P4", label: "P4", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null,
          deltaVMs: null, direction: null, estimatedFuelKg: null, missAfterKm: null,
          reviewCondition: "Reassess when the next tracking update arrives." },
      ];
      manifest[caseKey(eventId)] = JSON.stringify(candidates);
      eventIds.push(eventId);
    }
    await ctx.db.patch(demoRunId, { manifest });
    return { demoRunId, eventIds };
  },
});

/** The open seeded run's hidden or shown encounters that involve any of these objects. */
export async function seededEventsFor(ctx: QueryCtx, run: Doc<"demoRuns">, objectIds: string[]) {
  const events = await ctx.db.query("events").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect();
  const out: Doc<"events">[] = [];
  for (const event of events) {
    const [a, b] = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
    if (a && b && (objectIds.includes(a.objectId) || objectIds.includes(b.objectId))) out.push(event);
  }
  return out;
}

/** The seeded run a fleet scan stands in for, when one is open and holds a case on this fleet. */
export async function seededRunForFleet(ctx: QueryCtx, objectIds: string[]) {
  const runs = await ctx.db.query("demoRuns").withIndex("by_state", q => q.eq("state", "open")).collect();
  for (const run of runs.filter(r => r.scenario === SEEDED_SCENARIO && r.closedAt === null)) {
    if ((await seededEventsFor(ctx, run, objectIds)).length) return run;
  }
  return null;
}

// A full screening pass in about ten seconds: the phases and counters the orbit service reports, then the found cases.
const SCAN_STEPS: { phase: "loading" | "screening" | "matching_sources" | "publishing"; progress: number | null }[] = [
  { phase: "loading", progress: null }, { phase: "screening", progress: 0.18 }, { phase: "screening", progress: 0.46 },
  { phase: "screening", progress: 0.79 }, { phase: "matching_sources", progress: 0.92 }, { phase: "publishing", progress: 0.98 },
];
const SCAN_STEP_MS = 1_600;

export const scanStep = internalMutation({
  args: { scanId: v.id("scanRuns"), step: v.number() },
  handler: async (ctx, { scanId, step }) => {
    const r = await ctx.db.get(scanId);
    if (!r || (r.status !== "queued" && r.status !== "running")) return;
    const run = await seededRunOf(ctx, r.demoRunId);
    const now = Date.now();
    if (!run) {
      await ctx.db.patch(scanId, { status: "failed", phase: "failed", error: { code: "STALE_REVISION", message: "The demo cases were reset; start a new scan." }, finishedAt: now, updatedAt: now });
      return;
    }
    const previous = await ctx.db.query("scanRuns").withIndex("by_status", q => q.eq("status", "completed")).order("desc").first();
    const catalogObjects = previous && previous.counts.catalogObjects > 1000 ? previous.counts.catalogObjects : 18_412;
    const primaries = r.primaryObjectIds.length;
    if (step < SCAN_STEPS.length) {
      const { phase, progress } = SCAN_STEPS[step];
      const done = progress ?? 0;
      await ctx.db.patch(scanId, { status: "running", phase, progress, startedAt: r.startedAt ?? now, updatedAt: now,
        counts: { primaryObjects: primaries, catalogObjects, primariesCompleted: Math.floor(primaries * done),
          pairsChecked: Math.round(primaries * catalogObjects * 72 * done), eventsFound: 0 } });
      await ctx.scheduler.runAfter(SCAN_STEP_MS, internal.seedCases.scanStep, { scanId, step: step + 1 });
      return;
    }
    const found = await seededEventsFor(ctx, run, r.primaryObjectIds);
    for (const event of found) if (!event.active) await ctx.db.patch(event._id, { active: event.tcaMs > now, updatedAt: now });
    await ctx.db.patch(scanId, { status: "completed", phase: "done", progress: 1, finishedAt: now, updatedAt: now,
      counts: { primaryObjects: primaries, catalogObjects, primariesCompleted: primaries, pairsChecked: primaries * catalogObjects * 72, eventsFound: found.length },
      coverage: { complete: true, catalogScope: "Full public catalog", excludedObjects: 0, reasons: [], missingPrimaryIds: [] } });
  },
});

// The Incident Analyst's checked summary, one of the templates lib/analyst.ts permits for this evidence.
const SUMMARY = JSON.stringify({ lines: [
  { kind: "objects", template: "Conjunction under review: {{objectA}} and {{objectB}}." },
  { kind: "encounter", template: "Closest approach {{tcaUtc}}: miss distance {{missKm}} km; relative speed {{relSpeedKmS}} km/s." },
  { kind: "probability", template: "Screened collision probability: {{probability}} from {{probabilitySource}}; epoch {{probabilityEpoch}}." },
  { kind: "sources", template: "Sources: {{sourceEvidence}}. A complete GP/SupGP comparison is unavailable." },
  { kind: "decision", template: "This summary supplies evidence only; maneuver choice and authorization require operator review." },
] });
const PLAY_MS = [3_500, 3_000, 3_000];

/**
 * "Run agents" on a seeded case: the Analyst, then each side's Advocate, as timed runs on the agent graph, then the
 * plan cards through candidates.publish. Scheduled once per case by rooms.startWorkflow; no step calls out.
 */
export const play = internalMutation({
  args: { eventId: v.id("events"), step: v.number() },
  handler: async (ctx, { eventId, step }) => {
    const event = await ctx.db.get(eventId);
    const run = event && await seededRunOf(ctx, event.demoRunId);
    if (!event || !run) return;
    const now = Date.now();
    const runs = await ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", eventId)).collect();
    const finish = async (role: "incident_analyst" | "operator_advocate", extra: Partial<Doc<"agentRuns">> = {}) => {
      for (const r of runs) if (r.role === role && r.status === "running") {
        await ctx.db.patch(r._id, { status: "succeeded", stage: undefined, finishedAt: now, lastProgressAt: now,
          usage: { inputTokens: 1_000 + Math.round(Math.random() * 400), outputTokens: 220 + Math.round(Math.random() * 80) }, ...extra });
      }
    };
    const owners = await Promise.all([event.objectAId, event.objectBId].map(async id => {
      const object = await ctx.db.get(id);
      return object && (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique())?.companyId;
    }));
    const advocate = (companyId: Id<"companies"> | null | undefined) => companyId ? ctx.db.insert("agentRuns", { eventId,
      inputKey: `seeded:${eventId}:${companyId}`, status: "running", role: "operator_advocate", companyId, stage: "calling_model",
      lastProgressAt: now, stalled: false, model: MODEL }) : null;
    if (step === 0) {
      if (runs.length) return;
      await ctx.db.insert("agentRuns", { eventId, inputKey: inputKey(await loadFacts(ctx, event)), status: "running",
        role: "incident_analyst", stage: "calling_model", lastProgressAt: now, stalled: false, model: MODEL });
    } else if (step === 1) {
      await finish("incident_analyst", { checkedOutput: SUMMARY });
      await advocate(owners[0]);
    } else if (step === 2) {
      await finish("operator_advocate");
      await advocate(owners[1]);
    } else if (step === 3) {
      await finish("operator_advocate");
      const candidates = run.manifest?.[caseKey(eventId)];
      if (typeof candidates === "string") {
        await publishCandidates(ctx, { eventId, baseVersion: null, candidates: JSON.parse(candidates), start: false });
        // Publication supersedes earlier Advocate runs; these assessed exactly the cards just published.
        for (const r of runs) if (r.role === "operator_advocate") await ctx.db.patch(r._id, { status: "succeeded" });
      }
      return;
    }
    await ctx.scheduler.runAfter(PLAY_MS[step], internal.seedCases.play, { eventId, step: step + 1 });
  },
});
