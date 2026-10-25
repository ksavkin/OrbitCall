import { internalAction, internalMutation, internalQuery, query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { makeFunctionReference as ref } from "convex/server";
import { v, ConvexError } from "convex/values";
import { side } from "./lib/policyValidators";
import { STALLED_AFTER_MS, inputKey } from "./lib/analyst";
import { loadFacts } from "./lib/events";
import { advocateKey, companyOf, currentAssessment, currentEvidenceKey, latestAdvocate, loadCandidates, requiredSides } from "./lib/coordination";
import { checkRecommendation, evaluateCandidates, shareEvaluations, sharedMemoryNote, storedMemoryNote } from "./lib/advocate";
import { requireParty } from "./lib/operatorAccess";
import { runFlags, stageOf, supersede } from "./lib/runs";
import { getCandidates, orbitConfigured } from "./lib/orbitClient";
import {
  cardsFor, evidenceVersionOf, geometryMatches, ommSnapshotId, publishFailure, sameCards, sharedMoverEventIds, wholeSecondUtc,
  type PublishInput, type PublishOutcome, type SharedMover, type SkipReason,
} from "./lib/publishCandidates";
import type { Side } from "./lib/policies";
import { buildMemoryItem, memorySourceFingerprint } from "./lib/advocateMemory";
import { countingApprovals, allApproved, assignmentVersionOf } from "./lib/approvalState";
import { isResolved } from "./lib/decision";
import { notify } from "./rooms";

const FOLLOWUP_HISTORY_LIMIT = 1000;
const rationaleStart = ref<"action", { eventId: Id<"events"> }, { status: string; published: number }>("agents/rationale:start");
const scopeLimit = () => { throw new ConvexError({ code: "LIMIT_EXCEEDED", message: "The coordination scope is too large; narrow the incident history." }); };
async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
}
function storedResponsibility(run: Doc<"agentRuns">) {
  try { const value = JSON.parse(run.checkedOutput ?? "{}").responsibility; return typeof value === "string" ? value : null; }
  catch { return null; }
}

// The private run stores only a digest of public responsibility records, never policy values. Both sides
// are pinned because an old counterpart assessment is not evidence of the newly responsible company's view.
async function responsibility(ctx: QueryCtx, event: Doc<"events">, set: Doc<"candidateSets">, reading = false) {
  if ((!reading && (isResolved(event) || event.tcaMs <= Date.now() || set.state !== "open" || !await openDemo(ctx, event))) || set.reviewRequired) return null;
  const sides = requiredSides(set);
  if (!sides.length || event.workflow === "internal_review" || (event.requiredApprovalSides && event.requiredApprovalSides.join() !== sides.join())) return null;
  const operators = new Map<Id<"users">, Doc<"users">>();
  const records = [];
  for (const s of ["A", "B"] as const) {
    const object = await ctx.db.get(s === "A" ? event.objectAId : event.objectBId);
    if (!object) return null;
    const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
    if ((owner?.companyId ?? null) !== companyOf(set, s)) return null;
    const assignments = await ctx.db.query("fleetAssignments").withIndex("by_object", q => q.eq("objectId", object.objectId)).take(FOLLOWUP_HISTORY_LIMIT + 1);
    if (assignments.length > FOLLOWUP_HISTORY_LIMIT) scopeLimit();
    const users = await Promise.all(assignments.map(async assignment => {
      const user = await ctx.db.get(assignment.userId);
      if (assignment.active && user?.role === "operator" && user.companyId === owner?.companyId) operators.set(user._id, user);
      return { id: assignment._id, userId: assignment.userId, active: assignment.active,
        role: user?.role ?? null, companyId: user?.companyId ?? null, version: user ? assignmentVersionOf(user) : null };
    }));
    records.push({ side: s, objectId: object.objectId, companyId: owner?.companyId ?? null, users: users.sort((a, b) => a.id.localeCompare(b.id)) });
  }
  return { operators: [...operators.values()], fingerprint: await fingerprint({ eventId: event._id, demoRunId: event.demoRunId ?? null,
    workflow: event.workflow ?? null, approvalRuleVersion: event.approvalRuleVersion ?? null, sides, records }) };
}

async function currentRooms(ctx: QueryCtx, event: Doc<"events">) {
  const links = await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", event._id)).take(FOLLOWUP_HISTORY_LIMIT + 1);
  if (links.length > FOLLOWUP_HISTORY_LIMIT) scopeLimit();
  const rooms: Doc<"rooms">[] = [];
  for (const id of new Set(links.map(link => link.roomId))) {
    const room = await ctx.db.get(id);
    if (room?.state === "open" && room.closedAt === null && room.demoRunId === (event.demoRunId ?? null) && room.simulated === event.simulated) rooms.push(room);
  }
  return rooms;
}
async function followupHistory(ctx: QueryCtx, eventId: Id<"events">) {
  const rows = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).order("desc").take(FOLLOWUP_HISTORY_LIMIT + 1);
  if (rows.length > FOLLOWUP_HISTORY_LIMIT) scopeLimit();
  return rows;
}
async function negotiationLog(ctx: MutationCtx, event: Doc<"events">, summary: string, after: NonNullable<Doc<"log">["after"]>) {
  return ctx.db.insert("log", {
    eventId: event._id, actor: { kind: "agent", role: "operator_advocate", companyId: null, side: null },
    action: "negotiation", summary, texts: null, before: null, after,
    proposalId: null, revision: null, roomId: null, demoRunId: event.demoRunId ?? null, simulated: event.simulated, at: Date.now(),
  });
}
async function announce(ctx: MutationCtx, event: Doc<"events">, operators: Doc<"users">[], rooms: Doc<"rooms">[], text: string) {
  for (const room of rooms) await ctx.db.insert("messages", {
    roomId: room._id, eventId: event._id, author: { kind: "agent", role: "operator_advocate", companyId: null }, kind: "negotiation",
    originalText: text, originalLang: "en", translations: {}, translationStatus: {}, values: [], refs: { eventId: event._id }, form: null,
    demoRunId: event.demoRunId ?? null, simulated: event.simulated, createdAt: Date.now(),
  });
  for (const user of operators) await notify(ctx, user._id, event, text);
}

/** Reusable post-publication hook; callers that publish in their own transaction can call this helper there. */
export async function requestPublicationFollowups(ctx: MutationCtx, args: { eventId: Id<"events">; version: number; evidenceKey: string }) {
  const event = await ctx.db.get(args.eventId);
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", args.eventId)).unique();
  if (!event || !set || set.version !== args.version || set.evidenceKey !== args.evidenceKey || await currentEvidenceKey(ctx, set) !== args.evidenceKey) return { scheduled: false };
  const scope = await responsibility(ctx, event, set);
  if (!scope) return { scheduled: false };
  const key = await fingerprint({ setId: set._id, version: set.version, evidenceKey: set.evidenceKey });
  if ((await followupHistory(ctx, event._id)).some(row => row.after?.kind === "candidate_followups" && row.after.key === key && row.after.state === "scheduled")) return { scheduled: false };
  const rooms = await currentRooms(ctx, event);
  for (const room of rooms) await ctx.scheduler.runAfter(0, internal.hostTriggers.request, { roomId: room._id, trigger: "candidates_changed" });
  if (set.candidateRevisionIds.length) await ctx.scheduler.runAfter(0, rationaleStart, { eventId: event._id });
  else await announce(ctx, event, scope.operators, rooms,
    "No computed candidate options are available for this incident. Review the missing evidence or constraints and contact the responsible operators through the incident's contact details.");
  await negotiationLog(ctx, event, set.candidateRevisionIds.length ? "Changed candidate options requested checked explanations and a Coordination Host review."
    : "No computed candidate options are available; the responsible operators were notified.", {
    kind: "candidate_followups", key, state: "scheduled", candidateVersion: set.version,
    outcome: set.candidateRevisionIds.length ? "candidates_changed" : "no_candidates", roomIds: JSON.stringify(rooms.map(room => room._id)),
  });
  return { scheduled: true };
}
export const publicationFollowups = internalMutation({
  args: { eventId: v.id("events"), version: v.number(), evidenceKey: v.string() },
  handler: requestPublicationFollowups,
});
export const publicationFollowupFailed = internalMutation({
  args: { eventId: v.id("events"), version: v.number(), demoRunId: v.union(v.id("demoRuns"), v.null()) },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (event && (event.demoRunId ?? null) === args.demoRunId) await negotiationLog(ctx, event,
      "Candidate options were published, but the follow-up agents could not be requested. The existing candidates remain available.",
      { kind: "candidate_followups", state: "failed", candidateVersion: args.version });
  },
});

async function freshAssessment(ctx: QueryCtx, set: Doc<"candidateSets">, s: Side, evidenceKey: string, scope: string | null) {
  const assessment = scope ? await currentAssessment(ctx, set, s, evidenceKey) : null;
  if (!assessment?.runId) return null;
  const run = await ctx.db.get(assessment.runId);
  const context = run && await ctx.db.query("advocateContexts").withIndex("by_run", q => q.eq("runId", run._id)).unique();
  const policy = run?.companyId ? await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", run.companyId!)).unique() : null;
  return run && context && storedResponsibility(run) === scope && (policy?.revision ?? 0) === context.policyRevision &&
    (policy?._id ?? null) === context.policyId && advocateKey(set, s, context.policyRevision) === run.inputKey ? assessment : null;
}

async function publishNegotiationOutcome(ctx: MutationCtx, event: Doc<"events">, set: Doc<"candidateSets">) {
  const scope = await responsibility(ctx, event, set);
  if (!scope || await currentEvidenceKey(ctx, set) !== set.evidenceKey || !set.candidateRevisionIds.length) return;
  const sides = requiredSides(set);
  const assessments = await Promise.all(sides.map(s => freshAssessment(ctx, set, s, set.evidenceKey, scope.fingerprint)));
  if (assessments.some(row => !row)) return;
  const candidates = await loadCandidates(ctx, set);
  // Missing or provisional outcomes are not a deadlock. Every current option needs an explicit hard rejection
  // from at least one required side, and each side must have completed the whole current revision set.
  if (assessments.some(row => row!.entries.length !== candidates.length || candidates.some(c => !row!.entries.some(e => e.candidateId === c.candidateId && e.revision === c.revision)))) return;
  if (candidates.some(c => c.burnTimeUtc !== null && Date.parse(c.burnTimeUtc) <= Date.now()) ||
    candidates.some(c => !assessments.some(row => row!.entries.some(e => e.candidateId === c.candidateId && e.outcome === "infeasible")))) return;
  const checked = assessments.map((row, index) => ({ side: sides[index], entries: row!.entries }));
  const key = await fingerprint({ setId: set._id, version: set.version, evidenceKey: set.evidenceKey, responsibility: scope.fingerprint, checked });
  if ((await followupHistory(ctx, event._id)).some(row => row.after?.kind === "no_mutually_acceptable_option" && row.after.key === key)) return;
  const categories = [...new Set(checked.flatMap(row => row.entries.filter(e => e.outcome === "infeasible").flatMap(e => e.categories)))].sort();
  const labels: Record<string, string> = { fuel: "fuel constraints", mission_window: "mission windows", risk: "risk constraints", priority: "mission priority", other: "other operational constraints" };
  const text = `${sides.length === 1 ? "The Operator Advocate found no acceptable option" : "The Operator Advocates found no mutually acceptable option"} among the current candidates. Each option conflicts with at least one current requirement.${categories.length ? ` Areas raised by the checks: ${categories.map(c => labels[c]).join(", ")}.` : ""} Continue the discussion or contact the responsible operators using the incident's contact details; no plan was approved or scheduled.`;
  await announce(ctx, event, scope.operators, await currentRooms(ctx, event), text);
  await negotiationLog(ctx, event, text, { kind: "no_mutually_acceptable_option", key, candidateVersion: set.version,
    categories: JSON.stringify(categories), assessments: JSON.stringify(checked) });
}

async function openDemo(ctx: QueryCtx, event: Doc<"events">) {
  if (!event.demoRunId) return true;
  const run = await ctx.db.get(event.demoRunId);
  return !!run && run.state === "open" && run.closedAt === null;
}

export const begin = internalMutation({
  args: { eventId: v.id("events"), side },
  handler: async (ctx, { eventId, side }) => {
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const event = await ctx.db.get(eventId);
    if (!set || !event || set.state !== "open" || set.candidateRevisionIds.length === 0 || !await openDemo(ctx, event)) return null;
    const scope = await responsibility(ctx, event, set);
    if (!scope) return null;
    const facts = await loadFacts(ctx, event);
    if (set.evidenceKey !== inputKey(facts)) return null;
    const companyId = companyOf(set, side);
    if (!companyId) return null;
    // Only this company's policy is read; the other side enters as checked shareable messages.
    const policyRow = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
    const policyRevision = policyRow?.revision ?? 0;
    const key = advocateKey(set, side, policyRevision);
    const previous = await latestAdvocate(ctx, eventId, companyId);
    if (previous?.inputKey === key && storedResponsibility(previous) === scope.fingerprint && ["running", "succeeded"].includes(previous.status)) return null;
    if (previous?.status === "running") await supersede(ctx, previous._id);
    const candidates = await loadCandidates(ctx, set);
    const objectId = side === "A" ? facts.objectA.objectId : facts.objectB.objectId;
    const policy = policyRow?.satellites.find(p => p.objectId === objectId) ?? null;
    const other = await freshAssessment(ctx, set, side === "A" ? "B" : "A", set.evidenceKey, scope.fingerprint);
    const runId = await ctx.db.insert("agentRuns", {
      eventId, role: "operator_advocate", companyId, inputKey: key, status: "running", stage: "loading",
      lastProgressAt: Date.now(), stalled: false,
      checkedOutput: JSON.stringify({ responsibility: scope.fingerprint }),
    });
    await ctx.db.insert("advocateContexts", {
      runId, side, policyId: policyRow?._id ?? null, policyRevision,
      candidateSetId: set._id, candidateVersion: set.version, evidenceKey: set.evidenceKey,
    });
    await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
    return { runId, input: { facts, candidates, side, policy, evaluations: evaluateCandidates(facts, candidates, side, policy, Date.now()),
      counterpart: (other?.entries ?? []).map(({ candidateId, outcome, categories, recommended }) => ({ candidateId, outcome, categories, recommended })) } };
  },
});

export const finish = internalMutation({
  args: { runId: v.id("agentRuns"), raw: v.string(), model: v.string(), usage: v.object({ inputTokens: v.number(), outputTokens: v.number() }) },
  handler: async (ctx, { runId, raw, model, usage }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.role !== "operator_advocate" || run.status !== "running" || !run.companyId) return { published: false };
    const context = await ctx.db.query("advocateContexts").withIndex("by_run", q => q.eq("runId", runId)).unique();
    const set = context && await ctx.db.get(context.candidateSetId);
    const event = await ctx.db.get(run.eventId);
    if (event && !await openDemo(ctx, event)) { await supersede(ctx, runId); return { published: false }; }
    const latest = await latestAdvocate(ctx, run.eventId, run.companyId);
    const policyRow = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", run.companyId!)).unique();
    const facts = event && await loadFacts(ctx, event);
    const scope = event && set && await responsibility(ctx, event, set);
    if (!context || !set || !facts || set.state !== "open" || latest?._id !== runId ||
      !scope || storedResponsibility(run) !== scope.fingerprint ||
      set.version !== context.candidateVersion || set.evidenceKey !== inputKey(facts) ||
      (policyRow?.revision ?? 0) !== context.policyRevision || (policyRow?._id ?? null) !== context.policyId ||
      advocateKey(set, context.side, context.policyRevision) !== run.inputKey) {
      await supersede(ctx, runId); return { published: false };
    }
    // Source corrections and authority changes can happen while Claude is running without changing orbital inputs.
    if (!await memorySourcesCurrent(ctx, run)) {
      await supersede(ctx, runId); return { published: false };
    }
    const policy = policyRow?.satellites.find(p => p.objectId === (context.side === "A" ? facts.objectA.objectId : facts.objectB.objectId)) ?? null;
    const evaluations = evaluateCandidates(facts, await loadCandidates(ctx, set), context.side, policy, Date.now());
    const other = await freshAssessment(ctx, set, context.side === "A" ? "B" : "A", set.evidenceKey, scope.fingerprint);
    const recommendation = checkRecommendation(raw, evaluations, Boolean(policy), other?.entries ?? []);
    await ctx.db.insert("negotiationMessages", {
      eventId: run.eventId, side: context.side, kind: "assessment", runId,
      entries: shareEvaluations(evaluations, recommendation), categories: [],
      candidateVersion: set.version, evidenceKey: set.evidenceKey,
    });
    await ctx.db.patch(runId, { status: "succeeded", stage: undefined, finishedAt: Date.now(), stalled: false, model, usage });
    if (context.side === "A" && set.companyBId) {
      // B may have started before A finished, or answered while A's previous attempt failed.
      // Invalidate that response atomically and give B the newly published shared outcomes.
      const response = await latestAdvocate(ctx, run.eventId, set.companyBId);
      if (response && ["running", "succeeded"].includes(response.status)) await supersede(ctx, response._id);
      await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId: run.eventId, side: "B" });
    }
    await publishNegotiationOutcome(ctx, event!, set);
    return { published: true };
  },
});

export const fail = internalMutation({
  args: { runId: v.id("agentRuns"), code: v.string(), message: v.string() },
  handler: async (ctx, { runId, code, message }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.role !== "operator_advocate" || run.status !== "running") return;
    await ctx.db.patch(runId, { status: "failed", stage: undefined, finishedAt: Date.now(), stalled: false,
      errorCode: code, errorMessage: message });
    const context = await ctx.db.query("advocateContexts").withIndex("by_run", q => q.eq("runId", runId)).unique();
    const set = context && await ctx.db.get(context.candidateSetId);
    const event = await ctx.db.get(run.eventId);
    if (context?.side === "A" && set?.companyBId && event && await openDemo(ctx, event)) await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId: run.eventId, side: "B" });
  },
});

// The side that opens a round: A for a pair, the only registered side for debris; null without a candidate set.
export const openingSide = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return set ? requiredSides(set)[0] ?? null : null;
  },
});

// Same workflow rules as candidates.publish, checked before the orbit call so an unpublishable event costs nothing.
export const publishInput = internalQuery({
  args: { eventId: v.id("events"), nowMs: v.number() },
  handler: async (ctx, { eventId, nowMs }): Promise<{ skipped: SkipReason } | { input: PublishInput }> => {
    const event = await ctx.db.get(eventId);
    if (!event) return { skipped: "NOT_FOUND" };
    if (!event.active || event.tcaMs <= nowMs) return { skipped: "EVENT_INACTIVE" };
    if (event.demoRunId) {
      const run = await ctx.db.get(event.demoRunId);
      if (!run || run.state !== "open" || run.closedAt !== null) return { skipped: "DEMO_RUN_CLOSED" };
    }
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    if (set && set.state !== "open") return { skipped: "SET_NOT_OPEN" };
    const facts = await loadFacts(ctx, event);
    const objectIds = [facts.objectA.objectId, facts.objectB.objectId];
    const [companyAId, companyBId] = await Promise.all(objectIds.map(async objectId =>
      (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique())?.companyId ?? null));
    let activeSide: Side = "A", counterpartSide: Side | null = "B";
    if (event.workflow === "unilateral_debris") {
      const active = companyAId && !companyBId ? "A" : companyBId && !companyAId ? "B" : null;
      if (!active || (event.requiredApprovalSides && event.requiredApprovalSides.join() !== active)) return { skipped: "WORKFLOW_UNSUPPORTED" };
      activeSide = active; counterpartSide = null;
    } else if (event.workflow === "internal_review" || !companyAId || !companyBId || companyAId === companyBId) {
      // A missing active counterpart stays bilateral and is never treated as debris (spec §1).
      return { skipped: "WORKFLOW_UNSUPPORTED" };
    }
    const snapshot = await ctx.db.get(event.snapshotId);
    if (!snapshot) return { skipped: "NOT_FOUND" };
    const ommId = ommSnapshotId(snapshot);
    if (!ommId) return { skipped: "OMM_SNAPSHOT_UNKNOWN" };
    // Every stored revision, not only the current set's, so a returning card gets a new revision instead of a rollback.
    const previous = await ctx.db.query("candidateRevisions").withIndex("by_event_candidate_revision", q => q.eq("eventId", eventId)).collect();
    const currentCards = set ? (await loadCandidates(ctx, set)).map(({ candidateId, revision }) => ({ candidateId, revision })) : [];
    const allowedMovingObjectIds = counterpartSide ? objectIds : [activeSide === "A" ? objectIds[0] : objectIds[1]];
    return { input: {
      facts, evidenceKey: inputKey(facts), eventSnapshotId: snapshot.snapshotId, snapshotId: ommId,
      evidenceVersion: evidenceVersionOf(facts), activeSide, counterpartSide, allowedMovingObjectIds,
      demoRunId: event.demoRunId ?? null,
      baseVersion: set?.version ?? null, previous, currentCards,
      sharedMovers: await linkedMovers(ctx, eventId, allowedMovingObjectIds, nowMs),
    } };
  },
});

// Movers of this event that are also objects of another active event linked in the same open room.
async function linkedMovers(ctx: QueryCtx, eventId: Id<"events">, movers: string[], nowMs: number): Promise<SharedMover[]> {
  const linked = new Map<string, Set<string>>();
  for (const link of await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect()) {
    if ((await ctx.db.get(link.roomId))?.state !== "open") continue;
    for (const other of await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", link.roomId)).collect()) {
      const event = other.eventId === eventId ? null : await ctx.db.get(other.eventId);
      if (!event?.active || event.tcaMs <= nowMs) continue;
      for (const object of await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)])) {
        if (object && movers.includes(object.objectId)) linked.set(object.objectId, (linked.get(object.objectId) ?? new Set()).add(event._id));
      }
    }
  }
  return movers.filter(id => linked.has(id)).map(objectId => ({ objectId, eventIds: [...linked.get(objectId)!].sort() }));
}

const isStale = (error: unknown) => error instanceof ConvexError && error.data?.code === "STALE_REVISION";

// Orbit /candidates, then the card mapper, then candidates.publish pinned to the set version, evidence key and
// snapshot read before the call. Any failure (missing data, orbit, geometry, evidence that moved on, a concurrent
// publication) returns a sanitized outcome and leaves the previous set and runs as they were. A mover shared with
// another linked event is published here with a note on its cards; the single burn for both events is coordinated
// by that spacecraft's trajectoryPlans row (the scheduler's task), and no other event's set is touched.
export const publishFromOrbit = internalAction({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }): Promise<PublishOutcome> => {
    if (!orbitConfigured()) return { status: "skipped", reason: "ORBIT_NOT_CONFIGURED" };
    const nowMs = Date.now();
    try {
      const loaded = await ctx.runQuery(internal.advocates.publishInput, { eventId, nowMs });
      if ("skipped" in loaded) return { status: "skipped", reason: loaded.skipped };
      const { input } = loaded;
      const response = await getCandidates({
        snapshotId: input.snapshotId, evidenceVersion: input.evidenceVersion,
        objectA: input.facts.objectA.objectId, objectB: input.facts.objectB.objectId,
        tcaUtc: wholeSecondUtc(Date.parse(input.facts.tcaUtc)), allowedMovingObjectIds: input.allowedMovingObjectIds,
        notBeforeUtc: wholeSecondUtc(nowMs, Math.ceil),
      });
      if (!geometryMatches(response, input.facts)) {
        return { status: "failed", code: "GEOMETRY_MISMATCH", message: "The orbit service computed a different encounter than the stored event." };
      }
      const publish = async (current: PublishInput): Promise<PublishOutcome> => {
        const candidates = cardsFor(response, current, eventId, Date.now());
        const { version, changed } = await ctx.runMutation(internal.candidates.publish, {
          eventId, baseVersion: current.baseVersion, candidates,
          expectedEvidenceKey: input.evidenceKey, expectedSnapshotId: input.eventSnapshotId, expectedOmmSnapshotId: input.snapshotId,
          expectedDemoRunId: input.demoRunId,
        });
        if (changed) {
          // Candidate publication has committed. A failed follow-up dispatch must not report those committed
          // cards as missing or roll them back; the retryable internal hook records its own deduplication key.
          try { await ctx.runMutation(internal.advocates.publicationFollowups, { eventId, version, evidenceKey: input.evidenceKey }); }
          catch {
            try { await ctx.runMutation(internal.advocates.publicationFollowupFailed, { eventId, version, demoRunId: input.demoRunId }); }
            catch { console.warn("Candidate options committed; follow-up dispatch and its diagnostic write were unavailable."); }
          }
        }
        return { status: "published", version, changed, cards: candidates.length, sharedMoverEventIds: sharedMoverEventIds(candidates, current.sharedMovers) };
      };
      try {
        return await publish(input);
      } catch (error) {
        if (!isStale(error)) throw error;
        // One retry, only when a concurrent publication already wrote these same cards on the same evidence.
        const fresh = await ctx.runQuery(internal.advocates.publishInput, { eventId, nowMs: Date.now() });
        if ("skipped" in fresh || fresh.input.evidenceKey !== input.evidenceKey || fresh.input.eventSnapshotId !== input.eventSnapshotId ||
          fresh.input.snapshotId !== input.snapshotId || fresh.input.demoRunId !== input.demoRunId ||
          !sameCards(cardsFor(response, fresh.input, eventId, Date.now()), fresh.input.currentCards)) throw error;
        return await publish(fresh.input);
      }
    } catch (error) {
      return publishFailure(error);
    }
  },
});

export const list = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const { candidateSet: set } = await requireParty(ctx, eventId);
    const key = await currentEvidenceKey(ctx, set);
    const event = await ctx.db.get(eventId), scope = event && await responsibility(ctx, event, set, true);
    const [a, b] = await Promise.all([freshAssessment(ctx, set, "A", key ?? "", scope?.fingerprint ?? null), freshAssessment(ctx, set, "B", key ?? "", scope?.fingerprint ?? null)]);
    // Only the workflow's required sides decide: debris has one Advocate and no assessment for the debris side.
    const required = requiredSides(set).map(s => s === "A" ? a : b);
    const candidates = await loadCandidates(ctx, set);
    const companies = await Promise.all(requiredSides(set).map(s => ctx.db.get(companyOf(set, s)!)));
    const accepted = (value: string) => value === "feasible" || value === "preferred";
    const mutuallyAcceptable = candidates.filter(c => required.every(m => accepted(m?.entries.find(e => e.candidateId === c.candidateId)?.outcome ?? "")))
      .map(c => c.candidateId);
    const reviewCandidates = candidates.filter(c => required.every(m => m?.entries.some(e => e.candidateId === c.candidateId && e.outcome !== "infeasible"))).map(c => c.candidateId);
    const messages = await ctx.db.query("negotiationMessages").withIndex("by_event", q => q.eq("eventId", eventId)).order("desc").take(50);
    const runStates = await Promise.all((["A", "B"] as const).map(async s => {
      const companyId = companyOf(set, s);
      const run = companyId && await latestAdvocate(ctx, eventId, companyId);
      return run ? { status: run.status, stage: stageOf(run), memory: storedMemoryNote(run.checkedOutput), startedAt: new Date(run._creationTime).toISOString(),
        lastProgressAt: new Date(run.lastProgressAt).toISOString(), errorCode: run.errorCode ?? null, errorMessage: run.errorMessage ?? null } : null;
    }));
    return {
      eventId, version: set.version, state: set.state, reviewRequired: set.reviewRequired, evidenceCurrent: key === set.evidenceKey,
      simulated: companies.some(c => c?.simulated) || candidates.some(c => c.simulated),
      candidates, assessments: { A: a?.entries ?? [], B: b?.entries ?? [] }, mutuallyAcceptable, reviewCandidates,
      runs: { A: runStates[0], B: runStates[1] },
      situation: set.reviewRequired ? "scheduled_review_required" : key !== set.evidenceKey ? "stale_candidates" : candidates.length === 0 ? "no_candidates" : required.some(m => !m) ? "awaiting_advocates" : mutuallyAcceptable.length ? "needs_operator_decision" : reviewCandidates.length ? "needs_more_data" : "no_mutually_acceptable_option",
      ...await runFlags(ctx, eventId),
      messages: messages.reverse().map(m => ({ messageId: m._id, side: m.side, kind: m.kind, entries: m.entries, categories: m.categories,
        createdAt: new Date(m._creationTime).toISOString(), current: m._id === a?._id || m._id === b?._id })),
    };
  },
});

export const rerun = mutation({
  args: { eventId: v.id("events") }, returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const { user, candidateSet: set, side } = await requireParty(ctx, eventId);
    if (set.state !== "open" || await currentEvidenceKey(ctx, set) !== set.evidenceKey) throw new ConvexError({ code: "INVALID_STATE", message: "Current open candidate evidence is required." });
    const event = await ctx.db.get(eventId), scope = event && await responsibility(ctx, event, set);
    if (!scope) throw new ConvexError({ code: "INVALID_STATE", message: "Current responsibility and an active incident are required." });
    const run = await latestAdvocate(ctx, eventId, user.companyId);
    if (run && storedResponsibility(run) === scope.fingerprint && ((run.status === "running" && !run.stalled) || run.status === "succeeded")) throw new ConvexError({ code: "INVALID_STATE", message: "Retry only a failed, stale or stalled Advocate." });
    if (run && ["running", "succeeded"].includes(run.status)) await supersede(ctx, run._id);
    await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId, side });
    return null;
  },
});

// All provider I/O lives in agents/advocate. These transactions own namespace and write reservations.
// The frozen schema's scalar manifest carries only IDs/statuses, never memory text or private policy.
const assistantKey = (companyId: Id<"companies">) => `memory:assistant:${companyId}`;
const writeKey = (companyId: Id<"companies">, understoodId: Id<"understood">) => `memory:write:${companyId}:${understoodId}`;
const cleanupKey = (rowId: Id<"memoryAssistants">) => `memory:cleanup:${rowId}`;
const cleanupRef = ref<"action">("agents/advocate:cleanupMemoryAssistant");
function manifestRecord(run: Doc<"demoRuns">, key: string): Record<string, unknown> | null {
  try { const value = run.manifest?.[key]; return typeof value === "string" ? JSON.parse(value) : null; } catch { return null; }
}
async function memoryParty(ctx: QueryCtx, eventId: Id<"events">, companyId: Id<"companies">) {
  const event = await ctx.db.get(eventId);
  if (!event?.demoRunId) return null;
  const run = await ctx.db.get(event.demoRunId);
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  if (!run || run.state !== "open" || run.closedAt !== null || !set || ![set.companyAId, set.companyBId].includes(companyId)) return null;
  const object = await ctx.db.get(set.companyAId === companyId ? event.objectAId : event.objectBId);
  const owner = object && await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
  return owner?.companyId === companyId ? { event, run, set } : null;
}
async function activeAssistant(ctx: QueryCtx, demoRunId: Id<"demoRuns">, companyId: Id<"companies">) {
  return ctx.db.query("memoryAssistants").withIndex("by_run_company", q => q.eq("demoRunId", demoRunId).eq("companyId", companyId))
    .filter(q => q.eq(q.field("closedAt"), null)).first();
}

export const memoryScope = internalQuery({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, { runId }) => {
    const agent = await ctx.db.get(runId);
    if (!agent || agent.role !== "operator_advocate" || agent.status !== "running" || !agent.companyId) return null;
    const event = await ctx.db.get(agent.eventId);
    if (!event || !await openDemo(ctx, event)) return null;
    if (!event.demoRunId) return { eventId: event._id, companyId: agent.companyId, demoRunId: null };
    const scope = await memoryParty(ctx, event._id, agent.companyId);
    return scope ? { eventId: event._id, companyId: agent.companyId, demoRunId: scope.run._id } : null;
  },
});

export const reserveMemoryAssistant = internalMutation({
  args: { eventId: v.id("events"), companyId: v.id("companies"), token: v.string() },
  handler: async (ctx, { eventId, companyId, token }) => {
    const scope = await memoryParty(ctx, eventId, companyId);
    if (!scope) return { status: "unavailable" as const };
    const existing = await activeAssistant(ctx, scope.run._id, companyId);
    if (existing) return { status: "ready" as const, rowId: existing._id, assistantId: existing.assistantId, demoRunId: scope.run._id };
    // Never automatically repeat a create with an uncertain remote result. A concurrent caller proceeds without memory.
    if (manifestRecord(scope.run, assistantKey(companyId))) return { status: "unavailable" as const };
    await ctx.db.patch(scope.run._id, { manifest: { ...scope.run.manifest,
      [assistantKey(companyId)]: JSON.stringify({ state: "creating", token, at: Date.now() }) } });
    return { status: "create" as const, demoRunId: scope.run._id };
  },
});

export const registerMemoryAssistant = internalMutation({
  args: { demoRunId: v.id("demoRuns"), companyId: v.id("companies"), token: v.string(), assistantId: v.string() },
  handler: async (ctx, { demoRunId, companyId, token, assistantId }) => {
    const run = await ctx.db.get(demoRunId), existing = await activeAssistant(ctx, demoRunId, companyId);
    const collision = await ctx.db.query("memoryAssistants").filter(q => q.eq(q.field("assistantId"), assistantId)).first();
    if (collision && (collision.companyId !== companyId || collision.demoRunId !== demoRunId)) {
      // A provider ID already scoped elsewhere cannot be adopted or deleted by this company.
      return { usable: false, rowId: collision._id };
    }
    const reservation = run && manifestRecord(run, assistantKey(companyId));
    const usable = !!run && run.state === "open" && run.closedAt === null && reservation?.token === token && reservation.state === "creating" && !existing;
    // The ID is tracked even if reset won the race, so failed cleanup can be retried without losing the namespace.
    const same = (await ctx.db.query("memoryAssistants").withIndex("by_run_company", q => q.eq("demoRunId", demoRunId).eq("companyId", companyId)).collect())
      .find(row => row.assistantId === assistantId);
    if (same) return { usable: same.closedAt === null && run?.state === "open" && run.closedAt === null, rowId: same._id };
    const rowId = await ctx.db.insert("memoryAssistants", { demoRunId, companyId, assistantId, createdAt: Date.now(), closedAt: usable ? null : Date.now() });
    if (run) await ctx.db.patch(run._id, { manifest: { ...run.manifest,
      ...(usable ? { [assistantKey(companyId)]: JSON.stringify({ state: "ready", rowId }) }
        : { [cleanupKey(rowId)]: "pending", ...(run.state === "closed" ? { memoryCleanupState: "pending" } : {}) }) } });
    if (!usable) await ctx.scheduler.runAfter(0, cleanupRef, { rowId, attempt: 0 });
    return { usable, rowId };
  },
});

export const failMemoryAssistant = internalMutation({
  args: { demoRunId: v.id("demoRuns"), companyId: v.id("companies"), token: v.string() },
  handler: async (ctx, { demoRunId, companyId, token }) => {
    const run = await ctx.db.get(demoRunId);
    if (run && manifestRecord(run, assistantKey(companyId))?.token === token) await ctx.db.patch(demoRunId, {
      manifest: { ...run.manifest, [assistantKey(companyId)]: JSON.stringify({ state: "failed", at: Date.now() }) },
    });
  },
});

export const memoryCleanupScope = internalQuery({
  args: { rowId: v.id("memoryAssistants") },
  handler: async (ctx, { rowId }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return null;
    const run = await ctx.db.get(row.demoRunId);
    return row.closedAt !== null || !run || run.state === "closed" || run.closedAt !== null ? row : null;
  },
});
export const memoryCleanupResult = internalMutation({
  args: { rowId: v.id("memoryAssistants"), success: v.boolean(), attempt: v.number() },
  handler: async (ctx, { rowId, success, attempt }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return;
    const run = await ctx.db.get(row.demoRunId);
    if (run?.state === "open" && run.closedAt === null && row.closedAt === null) return;
    await ctx.db.patch(rowId, { closedAt: row.closedAt ?? Date.now() });
    success = success || run?.manifest?.[cleanupKey(rowId)] === "complete";
    if (run) await ctx.db.patch(run._id, { manifest: { ...run.manifest,
      [cleanupKey(rowId)]: success ? "complete" : "failed",
      ...(!success && run.state === "closed" ? { memoryCleanupState: "failed" } : {}),
    } });
    if (success && run?.state === "closed") await ctx.scheduler.runAfter(0, internal.demoReset.cleanup, { demoRunId: run._id });
    if (!success && attempt < 2) await ctx.scheduler.runAfter([1000, 10_000][attempt] ?? 10_000, cleanupRef, { rowId, attempt: attempt + 1 });
  },
});

async function outcomeAt(ctx: QueryCtx, event: Doc<"events">): Promise<{ key: string; at: number } | null> {
  if (event.status === "approved") {
    const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
    const approvals = await countingApprovals(ctx, event, selection);
    return allApproved(event, approvals) ? { key: [...approvals.values()].map(row => row._id).sort().join(), at: Math.max(...[...approvals.values()].map(row => row.at)) } : null;
  }
  if (!["scheduled", "monitoring", "awaiting_verification_data", "verified", "no_action_needed"].includes(event.status ?? "")) return null;
  const rows = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", event._id)).order("desc").take(100);
  const outcome = rows.find(row => row.demoRunId === event.demoRunId && row.after?.reviewRequired !== "true" &&
    (event.status === "no_action_needed" ? row.action === "no_action_needed" : event.status === "monitoring"
      ? row.action === "status_changed" && row.after?.status === "monitoring" : ["schedule_committed", "verified"].includes(row.action)));
  return outcome ? { key: outcome._id, at: outcome.at } : null;
}
type PreferenceSource = { id: string; kind: "message" | "voice_phrase"; companyId: string; userId: string;
  text: string; language: "en" | "ru" | "zh"; eventId: string | null; at: number };
async function humanSource(ctx: QueryCtx, row: Doc<"understood">, id: string): Promise<PreferenceSource | null> {
  const messageId = ctx.db.normalizeId("messages", id), message = messageId && await ctx.db.get(messageId);
  if (message) {
    if (message.roomId !== row.roomId || message.demoRunId !== row.demoRunId || message.author.kind !== "human" ||
      !["text", "voice"].includes(message.kind)) return null;
    return { id, kind: "message", companyId: message.author.companyId, userId: message.author.userId,
      text: message.originalText, language: message.originalLang, eventId: message.eventId, at: message.createdAt };
  }
  const phraseId = ctx.db.normalizeId("call_phrases", id), phrase = phraseId && await ctx.db.get(phraseId);
  if (!phrase || phrase.roomId !== row.roomId || phrase.rev < 2 || Object.values(phrase.translationStatus).includes("pending") ||
    !Number.isFinite(Date.parse(phrase.createdAt))) return null;
  return { id, kind: "voice_phrase", companyId: phrase.speaker.companyId, userId: phrase.speaker.userId,
    text: phrase.original, language: phrase.originalLang, eventId: phrase.eventId, at: Date.parse(phrase.createdAt) };
}
async function preferenceSource(ctx: QueryCtx, row: Doc<"understood">, event: Doc<"events">, companyId: Id<"companies">, outcomeTime: number, correctsId?: Id<"understood">) {
  const message = await ctx.db.get(row.sourceMessageId), room = await ctx.db.get(row.roomId);
  if (!message || !room || message.roomId !== row.roomId || room.demoRunId !== row.demoRunId || message.demoRunId !== row.demoRunId ||
    message.createdAt > outcomeTime || !row.text.trim()) return null;
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  if (!links.some(link => link.eventId === event._id)) return null;
  // Corrections require the checked Host's explicit predecessor, not a loose interpretation of human prose.
  if (correctsId && message.author.kind === "human") return null;
  let source = message.author.kind === "human" ? await humanSource(ctx, row, message._id) : null;
  if (!source && message.author.kind === "agent" && message.author.role === "coordination_host" && row.hostRunId) {
    const run = await ctx.db.get(row.hostRunId);
    if (!run || run.status !== "succeeded" || run.roomId !== row.roomId || run.demoRunId !== row.demoRunId ||
      message.originalText !== row.text || message.originalLang !== row.originalLang || message.eventId !== row.eventId) return null;
    const history = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", event._id)).order("desc").take(501);
    const audit = history.find(line => line.action === "summary_posted" && line.roomId === row.roomId && line.demoRunId === row.demoRunId &&
      line.at <= outcomeTime && line.after?.kind === "understood" && line.after.hostRunId === row.hostRunId &&
      line.after.messageId === row.sourceMessageId && line.after.understoodId === row._id && line.summary === row.text);
    try {
      const sources: unknown = JSON.parse(String(audit?.after?.sources)), ids: unknown = JSON.parse(String(audit?.after?.sourceMessageIds));
      if (!Array.isArray(sources) || sources.length !== 1 || !sources[0] || !Array.isArray(ids) || ids.length !== 1 || ids[0] !== sources[0].id || typeof ids[0] !== "string") return null;
      source = await humanSource(ctx, row, ids[0]);
      if (!source || ["id", "kind", "companyId", "userId", "text", "language", "eventId"].some(key =>
        (source as unknown as Record<string, unknown>)[key] !== sources[0][key])) return null;
      // R3 Host output adds understood without changing the frozen understood/messages table contract.
      const output = run.output as unknown as { understood?: { kind: string; hard: boolean; text: string; eventId: string | null; sourceMessageId: string; correctsId?: string | null }[] } | null;
      if (!Array.isArray(output?.understood) || !output.understood.some(item => item.kind === row.kind && item.hard === row.hard &&
        item.text === row.text && item.eventId === row.eventId && item.sourceMessageId === source!.id &&
        (!correctsId || item.correctsId === correctsId))) return null;
    } catch { return null; }
  }
  if (!source || source.companyId !== companyId || source.language !== row.originalLang || source.at > Math.min(outcomeTime, row.createdAt) ||
    source.eventId !== null && source.eventId !== event._id || !source.text.includes(row.text)) return null;
  const userId = ctx.db.normalizeId("users", source.userId), user = userId && await ctx.db.get(userId);
  if (!user || user.role !== "operator" || user.companyId !== companyId) return null;
  const object = await ctx.db.get(row.side === "A" ? event.objectAId : event.objectBId);
  if (!object) return null;
  const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
  const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
  return owner?.companyId === companyId && assignment?.active ? source : null;
}
async function softPreferenceSource(ctx: QueryCtx, row: Doc<"understood">, event: Doc<"events">, companyId: Id<"companies">,
  outcomeTime: number, corrected: Doc<"understood">[]) {
  let current = row, source: PreferenceSource | null = null;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current._id) || current.hard || current.roomId !== row.roomId || current.eventId !== row.eventId ||
      current.demoRunId !== row.demoRunId || current.side !== row.side || current.createdAt > outcomeTime) return null;
    seen.add(current._id);
    if (current.kind === "preference") {
      const original = await preferenceSource(ctx, current, event, companyId, outcomeTime);
      return original ? source ?? original : null;
    }
    if (current.kind !== "correction" || corrected.length > 100) return null;
    const predecessors = corrected.filter(old => old.correctedById === current._id);
    if (predecessors.length !== 1 || predecessors[0].createdAt > current.createdAt) return null;
    const correction = await preferenceSource(ctx, current, event, companyId, outcomeTime, predecessors[0]._id);
    if (!correction) return null;
    source ??= correction;
    current = predecessors[0];
  }
}
async function outcomeItems(ctx: QueryCtx, eventId: Id<"events">, companyId: Id<"companies">) {
  const scope = await memoryParty(ctx, eventId, companyId);
  if (!scope) return [];
  const outcome = await outcomeAt(ctx, scope.event);
  if (!outcome) return [];
  const rows = await ctx.db.query("understood").withIndex("by_event_status", q => q.eq("eventId", eventId).eq("status", "active")).order("desc").take(100);
  const corrected = rows.some(row => row.kind === "correction") ? await ctx.db.query("understood")
    .withIndex("by_event_status", q => q.eq("eventId", eventId).eq("status", "corrected")).take(101) : [];
  const result = [];
  for (const row of rows) {
    if (!["preference", "correction"].includes(row.kind) || row.hard || row.demoRunId !== scope.run._id || row.createdAt > outcome.at || !row.side || companyOf(scope.set, row.side) !== companyId) continue;
    const source = await softPreferenceSource(ctx, row, scope.event, companyId, outcome.at, corrected);
    if (!source) continue;
    try {
      const item = buildMemoryItem({ companyId, demoRunId: scope.run._id, preference: source.text, sourceEventId: eventId, sourceMessageIds: [source.id] });
      result.push({ understoodId: row._id, item, outcomeKey: outcome.key, at: outcome.at });
    } catch { /* Rejected approval language or private values never leave Convex. */ }
  }
  return result;
}

export const memoryBatch = internalQuery({
  args: { eventId: v.id("events"), companyId: v.id("companies"), previous: v.boolean() },
  handler: async (ctx, { eventId, companyId, previous }) => {
    const scope = await memoryParty(ctx, eventId, companyId);
    if (!scope) return null;
    const events = previous ? await ctx.db.query("events").withIndex("by_demo_run", q => q.eq("demoRunId", scope.run._id)).take(101) : [scope.event];
    if (events.length > 100) return null;
    const items = [];
    for (const event of events) if (!previous || event._id !== eventId) items.push(...await outcomeItems(ctx, event._id, companyId));
    return { demoRunId: scope.run._id, items: items.sort((a, b) => b.at - a.at).slice(0, 10),
      writeFailed: items.some(item => manifestRecord(scope.run, writeKey(companyId, item.understoodId))?.state === "failed") };
  },
});

export const reserveMemoryWrite = internalMutation({
  args: { eventId: v.id("events"), companyId: v.id("companies"), understoodId: v.id("understood"), token: v.string() },
  handler: async (ctx, { eventId, companyId, understoodId, token }) => {
    const scope = await memoryParty(ctx, eventId, companyId);
    const item = (await outcomeItems(ctx, eventId, companyId)).find(item => item.understoodId === understoodId);
    if (!scope || !item) return null;
    const assistant = await activeAssistant(ctx, scope.run._id, companyId);
    if (!assistant || manifestRecord(scope.run, writeKey(companyId, understoodId))) return null;
    await ctx.db.patch(scope.run._id, { manifest: { ...scope.run.manifest,
      [writeKey(companyId, understoodId)]: JSON.stringify({ state: "writing", token, outcomeKey: item.outcomeKey, at: Date.now() }) } });
    return { ...item, rowId: assistant._id, assistantId: assistant.assistantId, demoRunId: scope.run._id };
  },
});
export const finishMemoryWrite = internalMutation({
  args: { demoRunId: v.id("demoRuns"), companyId: v.id("companies"), understoodId: v.id("understood"), rowId: v.id("memoryAssistants"), token: v.string(), success: v.boolean() },
  handler: async (ctx, { demoRunId, companyId, understoodId, rowId, token, success }) => {
    const run = await ctx.db.get(demoRunId), row = await ctx.db.get(rowId);
    if (!row || row.demoRunId !== demoRunId || row.companyId !== companyId) return;
    if (run && manifestRecord(run, writeKey(companyId, understoodId))?.token === token) await ctx.db.patch(run._id, { manifest: { ...run.manifest,
      [writeKey(companyId, understoodId)]: JSON.stringify({ state: success ? "complete" : "failed", at: Date.now() }) } });
    if (!run || run.state !== "open" || run.closedAt !== null || row.closedAt !== null) {
      await ctx.db.patch(rowId, { closedAt: row.closedAt ?? Date.now() });
      const latest = await ctx.db.get(demoRunId);
      if (latest) await ctx.db.patch(demoRunId, { manifest: { ...latest.manifest, [cleanupKey(rowId)]: "pending", memoryCleanupState: "pending" } });
      await ctx.scheduler.runAfter(0, cleanupRef, { rowId, attempt: 0 });
    }
  },
});
export const noteMemory = internalMutation({
  args: { runId: v.id("agentRuns"), status: v.union(v.literal("used"), v.literal("none"), v.literal("unavailable")),
    sources: v.array(v.object({ sourceEventId: v.id("events"), fingerprint: v.string() })), writeFailed: v.boolean() },
  handler: async (ctx, { runId, status, sources, writeFailed }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.role !== "operator_advocate" || run.status !== "running" || !run.companyId) return false;
    const event = await ctx.db.get(run.eventId);
    if (!event || !await openDemo(ctx, event) || (event.demoRunId && !await memoryParty(ctx, event._id, run.companyId))) { await supersede(ctx, runId); return false; }
    if (sources.length > 3 || (status === "used") !== (sources.length > 0)) { await supersede(ctx, runId); return false; }
    const pins: MemorySourcePin[] = [];
    for (const source of sources) {
      const sourceEvent = await ctx.db.get(source.sourceEventId);
      const candidates = sourceEvent?.demoRunId === event.demoRunId ? await outcomeItems(ctx, source.sourceEventId, run.companyId) : [];
      let matched = false;
      for (const candidate of candidates) {
        if (await memorySourceFingerprint(candidate.item) !== source.fingerprint) continue;
        pins.push({ ...source, understoodId: candidate.understoodId, outcomeKey: candidate.outcomeKey });
        matched = true; break;
      }
      // Do not send a quote to Claude if it changed between recall and this atomic reservation.
      if (!matched) { await supersede(ctx, runId); return false; }
    }
    await ctx.db.patch(runId, { checkedOutput: JSON.stringify({ responsibility: storedResponsibility(run),
      memory: sharedMemoryNote(status, pins.map(pin => pin.sourceEventId), writeFailed), memorySources: pins }) });
    return true;
  },
});

type MemorySourcePin = { sourceEventId: Id<"events">; understoodId: Id<"understood">; fingerprint: string; outcomeKey: string };
async function memorySourcesCurrent(ctx: QueryCtx, run: Doc<"agentRuns">): Promise<boolean> {
  if (!run.checkedOutput) return true; // Legacy/direct completions did not recall memory.
  try {
    const stored = JSON.parse(run.checkedOutput);
    if (stored.memory?.status !== "used") return true;
    if (!run.companyId || !Array.isArray(stored.memorySources) || !stored.memorySources.length || stored.memorySources.length > 3) return false;
    const event = await ctx.db.get(run.eventId);
    for (const pin of stored.memorySources as MemorySourcePin[]) {
      const sourceEventId = ctx.db.normalizeId("events", pin.sourceEventId);
      const sourceEvent = sourceEventId && await ctx.db.get(sourceEventId);
      if (!sourceEvent || sourceEvent.demoRunId !== event?.demoRunId) return false;
      // outcomeItems rechecks the complete original source/correction chain and the speaker's current authority.
      const source = (await outcomeItems(ctx, sourceEvent._id, run.companyId)).find(item => item.understoodId === pin.understoodId);
      if (!source || source.outcomeKey !== pin.outcomeKey || await memorySourceFingerprint(source.item) !== pin.fingerprint) return false;
    }
    return true;
  } catch { return false; }
}
