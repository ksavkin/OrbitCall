import { ConvexError, v, type Infer } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assignmentVersionOf, countingApprovals, decisionInputs, turnOf } from "./lib/approvalState";
import { inputKey } from "./lib/analyst";
import { isResolved, decisionTurn } from "./lib/decision";
import { loadFacts } from "./lib/events";
import { requireOperator, requireReader } from "./lib/operatorAccess";
import { validateCandidates, type Candidate, type Side } from "./lib/policies";
import { evidenceVersionOf, ommSnapshotId, wholeSecondUtc } from "./lib/publishCandidates";
import { getRescreenJob, orbitFailure, startRescreen, type RescreenRequest } from "./lib/orbitClient";
import { isOpenRoom } from "./rooms";
import { SHARED_BURN, sameBurn, sharedBurn } from "./revisions";
import { summaryForm } from "./schema/rooms";
import { rescreen } from "./schema/schedule";

// The form follows the event's current selection. An old summary message is never decision authority.
// Long rescreens use immutable, source-tagged log entries as a durable job ledger without a second schema writer.
const MARKER = "summary_edit_v1";
export const POLL_LIMIT = 24;
export const POLL_DELAY_MS = 5_000;
const HORIZON_H = 72;
const MAX_LOGS = 500;
const changes = v.object({
  movingSide: v.optional(v.union(v.literal("A"), v.literal("B"), v.null())),
  burnTimeUtc: v.optional(v.union(v.string(), v.null())), deltaVMs: v.optional(v.union(v.number(), v.null())),
  direction: v.optional(v.union(v.literal("prograde"), v.literal("retrograde"), v.null())), note: v.optional(v.string()),
});
const editArgs = { eventId: v.id("events"), proposalId: v.id("proposals"), baseRevision: v.number(),
  expectedGeneration: v.optional(v.number()), changes };
type Edit = Infer<typeof changes>;
type Args = { eventId: Id<"events">; proposalId: Id<"proposals">; baseRevision: number; expectedGeneration?: number; changes: Edit };
type Job = { args: Args; userId: Id<"users">; inputHash: string; baseVersion: number; generation: number;
  evidenceKey: string; eventSnapshotId: string; ommSnapshotId: string; demoRunId: Id<"demoRuns"> | null;
  candidate: Candidate; note: string };
// Landed with the parallel Advocate follow-ups task; a typed seam avoids a generated/import dependency.
const publicationFollowups = makeFunctionReference<"mutation", { eventId: Id<"events">; version: number; evidenceKey: string }>("advocates:publicationFollowups");
function fail(code: string, message: string): never { throw new ConvexError({ code, message }); }
const validVersion = (n: number) => Number.isSafeInteger(n) && n >= 1;
const scalar = (row: Doc<"log">, key: string) => row.after?.[key];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function history(ctx: QueryCtx, eventId: Id<"events">) {
  const rows = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).order("desc").take(MAX_LOGS + 1);
  if (rows.length > MAX_LOGS) fail("HISTORY_LIMIT", "This incident needs archived edit history before accepting another summary edit.");
  return rows.filter(row => scalar(row, "type") === MARKER);
}
const resultFor = (rows: Doc<"log">[], id: Id<"log">) => rows.find(row => scalar(row, "jobId") === id &&
  ["completed", "failed"].includes(String(scalar(row, "state"))));
function noteFor(rows: Doc<"log">[], proposalId: Id<"proposals">, revision: number) {
  const row = rows.find(row => row.proposalId === proposalId && row.revision === revision && scalar(row, "state") === "completed");
  return typeof row?.after?.note === "string" ? row.after.note : "";
}

async function authority(ctx: QueryCtx, userId: Id<"users">, event: Doc<"events">) {
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "operator") fail("FORBIDDEN", "An assigned operator is required.");
  const pair = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  const owned: Side[] = [];
  const assigned: Side[] = [];
  for (const [index, object] of pair.entries()) {
    if (!object) continue;
    const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
    if (owner?.companyId !== user.companyId) continue;
    const side = index === 0 ? "A" : "B";
    owned.push(side);
    const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
      q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
    if (assignment?.active) assigned.push(side);
  }
  if (!assigned.length) fail("FORBIDDEN", "Current ownership and fleet assignment are required for this incident.");
  return { user, side: owned.length === 1 ? owned[0] : null };
}
async function selected(ctx: QueryCtx, eventId: Id<"events">) {
  const event = await ctx.db.get(eventId);
  if (!event) fail("NOT_FOUND", "Incident not found.");
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  const input = await decisionInputs(ctx, event, selection);
  if (!selection || !input) return null;
  validateCandidates([input.card], await loadFacts(ctx, event));
  const rows = await history(ctx, eventId);
  const form = { proposalId: input.proposal._id, revision: input.card.revision, movingSide: input.card.movingSide,
    burnTimeUtc: input.card.burnTimeUtc, deltaVMs: input.card.deltaVMs, direction: input.card.direction,
    note: noteFor(rows, input.proposal._id, input.card.revision) };
  return { event, selection, input, rows, form };
}

export const get = query({
  args: { eventId: v.id("events") },
  returns: v.object({ form: v.union(summaryForm, v.null()), selectionGeneration: v.number(), canEdit: v.boolean(),
    edit: v.union(v.object({ jobId: v.id("log"), state: v.string(), errorCode: v.union(v.string(), v.null()) }), v.null()) }),
  handler: async (ctx, { eventId }) => {
    const { user, event } = await requireReader(ctx, eventId);
    if (user.role === "operator") await authority(ctx, user._id, event);
    const current = await selected(ctx, eventId);
    const rows = current?.rows ?? await history(ctx, eventId);
    const requested = rows.find(row => scalar(row, "state") === "requested");
    const outcome = requested && resultFor(rows, requested._id);
    let canEdit = false;
    if (current && user.role === "operator") {
      try {
        await editContext(ctx, user._id, { eventId, proposalId: current.form.proposalId, baseRevision: current.form.revision, changes: {} });
        await singleTrajectory(ctx, event, current.input.card, current.input.card); canEdit = true;
      }
      catch { /* The current selected facts stay readable when an artifact or another input blocks editing. */ }
    }
    const selection = current?.selection ?? await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return { form: current?.form ?? null, selectionGeneration: selection?.generation ?? 0, canEdit,
      edit: requested ? { jobId: requested._id, state: outcome ? String(scalar(outcome, "state")) : "pending",
        errorCode: typeof outcome?.after?.errorCode === "string" ? outcome.after.errorCode : null } : null };
  },
});

export const request = mutation({
  args: { roomId: v.id("rooms") }, returns: v.null(),
  handler: async (ctx, { roomId }) => {
    const user = await requireOperator(ctx);
    const room = await ctx.db.get(roomId);
    if (!room || !await isOpenRoom(ctx, room)) fail("INVALID_STATE", "An open coordination channel is required for a Host summary.");
    const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", roomId)).collect();
    let involved = false;
    let offTurn = false;
    for (const link of links) {
      const event = await ctx.db.get(link.eventId);
      if (!event || (event.demoRunId ?? null) !== room.demoRunId) continue;
      let side: Side | null = null;
      try { side = (await authority(ctx, user._id, event)).side; involved = true; }
      catch { continue; /* A summary request does not act on another company's pair decision. */ }
      const decision = await decisionTurn(ctx, event);
      if (decision.deciding && decision.turn !== side) offTurn = true;
    }
    if (!involved) fail("FORBIDDEN", "Current responsibility for a linked incident is required.");
    if (offTurn) fail("INVALID_STATE", "Wait for your turn before requesting a room-wide summary.");
    await ctx.runMutation(internal.hostTriggers.request, { roomId, trigger: "summary_requested" });
    return null;
  },
});

/** An edit may change the text of a card whose burn is shared with other incidents (revisions.ts sharedBurn), never
 * that burn: it changes only together in every affected incident. The same card twice checks only that it resolves. */
async function singleTrajectory(ctx: QueryCtx, event: Doc<"events">, before: Candidate, after: Candidate) {
  const code = "SHARED_TRAJECTORY_REQUIRED";
  if ((await sharedBurn(ctx, event, before, code) || await sharedBurn(ctx, event, after, code)) && !sameBurn(before, after)) fail(code, SHARED_BURN);
}

async function editContext(ctx: QueryCtx, userId: Id<"users">, args: Args) {
  const event = await ctx.db.get(args.eventId);
  if (!event) fail("NOT_FOUND", "Incident not found.");
  const actor = await authority(ctx, userId, event);
  if (!actor.side || isResolved(event) || event.tcaMs <= Date.now()) fail("INVALID_STATE", "Only an undecided active incident can be edited.");
  const current = await selected(ctx, args.eventId);
  if (!current || current.input.set.state !== "open" || current.form.proposalId !== args.proposalId || current.form.revision !== args.baseRevision ||
    (args.expectedGeneration !== undefined && args.expectedGeneration !== current.selection.generation)) {
    fail("STALE_REVISION", "The current selected proposal revision and generation are required.");
  }
  const turn = turnOf(event, await countingApprovals(ctx, event, current.selection));
  if (turn !== actor.side) fail("INVALID_STATE", "Only the operator whose turn it is may edit this selected proposal.");
  for (const link of await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", event._id)).collect()) {
    const maneuver = await ctx.db.get(link.maneuverId);
    if (maneuver && maneuver.demoRunId === (event.demoRunId ?? null) &&
      (["rescreening", "committing", "committed"].includes(maneuver.status) || maneuver.commitSha || maneuver.rescreen?.passed)) {
      fail("INVALID_STATE", "A reserved or recorded schedule artifact needs review; summary edits cannot replace it.");
    }
  }
  const facts = await loadFacts(ctx, event);
  const snapshot = await ctx.db.get(event.snapshotId);
  const ommId = snapshot && ommSnapshotId(snapshot);
  if (!snapshot || !ommId) fail("INVALID_STATE", "The incident's pinned orbital snapshot is unavailable.");
  const policies = await Promise.all([current.input.companies.A, current.input.companies.B].map(async companyId => {
    const policy = companyId && await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
    return { companyId, revision: policy ? policy.revision : 0 };
  }));
  const inputHash = await hash({ eventId: event._id, proposalId: args.proposalId, baseRevision: args.baseRevision,
    generation: current.selection.generation, setVersion: current.input.set.version, cards: current.input.set.candidateRevisionIds,
    evidence: inputKey(facts), snapshot: snapshot.snapshotId, ommId, demoRunId: event.demoRunId ?? null,
    rule: event.approvalRuleVersion, required: event.requiredApprovalSides, workflow: event.workflow,
    companies: current.input.companies, policies, userId, companyId: actor.user.companyId, side: actor.side,
    assignmentVersion: assignmentVersionOf(actor.user), turn });
  return { ...current, actor, facts, snapshot, ommId, inputHash };
}

function editedCandidate(card: Doc<"candidateRevisions">, input: Edit, note: string, facts: Awaited<ReturnType<typeof loadFacts>>): Candidate {
  const { _id: _id, _creationTime: _created, eventId: _event, ...base } = card;
  const { note: _note, ...fields } = input;
  const next: Candidate = { ...base, ...fields, revision: base.revision + 1 };
  next.kind = next.movingSide === null ? "wait" : "maneuver";
  next.movingObjectId = next.movingSide === "A" ? facts.objectA.objectId : next.movingSide === "B" ? facts.objectB.objectId : null;
  next.estimatedFuelKg = null; // Fuel needs the Advocate's current private policy; never reuse the old estimate.
  next.missAfterKm = null; // A maneuver gets its new distance only from the completed rescreen.
  next.reviewCondition = next.kind === "wait" ? base.reviewCondition ?? "Reassess when new orbital evidence arrives." : null;
  if (next.kind === "maneuver") {
    if (next.deltaVMs !== null && next.deltaVMs > 1) fail("VALIDATION", "The numerical service supports a delta-v of at most 1 m/s.");
    const time = next.burnTimeUtc && Date.parse(next.burnTimeUtc);
    if (!time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(next.burnTimeUtc!) || time % 1000 !== 0 || time <= Date.now() || new Date(time).toISOString().slice(0, 19) !== next.burnTimeUtc!.slice(0, 19)) {
      fail("VALIDATION", "A burn needs a valid future UTC time at whole-second precision.");
    }
    next.burnTimeUtc = wholeSecondUtc(time);
  }
  if (note.length > 500) fail("VALIDATION", "The summary note must be at most 500 characters.");
  validateCandidates([next], facts);
  // Orbit labels describe the original burn. Reusing one after a field edit would contradict the checked card.
  const description = next.kind === "wait" ? "Wait for update"
    : `Move ${next.movingObjectId} ${next.direction} ${next.deltaVMs} m/s at ${next.burnTimeUtc}`;
  next.label = description.length <= 80 ? description : "Edited maneuver";
  if (next.kind === "wait") next.assumptions = ["Waiting is not a maneuver or a claim of safety."];
  return next;
}

async function append(ctx: MutationCtx, request: Doc<"log">, state: "failed" | "completed", summary: string,
  after: Record<string, string | number | null>, revision = request.revision) {
  return ctx.db.insert("log", { eventId: request.eventId, actor: request.actor, action: state === "completed" ? "proposal_revised" : "refused",
    summary, texts: null, before: { revision: request.revision }, after: { type: MARKER, jobId: request._id, state, ...after },
    proposalId: request.proposalId, revision, roomId: null, demoRunId: request.demoRunId, simulated: request.simulated, at: Date.now() });
}

export const edit = mutation({
  args: editArgs, returns: v.object({ accepted: v.literal(true) }),
  handler: async (ctx, args) => {
    if (!validVersion(args.baseRevision) || (args.expectedGeneration !== undefined && !validVersion(args.expectedGeneration))) fail("VALIDATION", "Invalid proposal revision or selection generation.");
    if (!Object.keys(args.changes).length) fail("VALIDATION", "Specify a summary edit.");
    const user = await requireOperator(ctx);
    const event = await ctx.db.get(args.eventId);
    if (!event) fail("FORBIDDEN", "Current responsibility for this incident is required.");
    await authority(ctx, user._id, event);
    const normalized: Args = { ...args, changes: {
      ...(args.changes.movingSide === undefined ? {} : { movingSide: args.changes.movingSide }),
      ...(args.changes.burnTimeUtc === undefined ? {} : { burnTimeUtc: args.changes.burnTimeUtc }),
      ...(args.changes.deltaVMs === undefined ? {} : { deltaVMs: args.changes.deltaVMs }),
      ...(args.changes.direction === undefined ? {} : { direction: args.changes.direction }),
      ...(args.changes.note === undefined ? {} : { note: args.changes.note.trim() }),
    } };
    const requestKey = await hash({ ...normalized, userId: user._id });
    const rows = await history(ctx, args.eventId);
    const prior = rows.find(row => scalar(row, "state") === "requested" && scalar(row, "requestKey") === requestKey);
    if (prior) {
      const result = resultFor(rows, prior._id);
      if (scalar(result ?? prior, "state") === "completed") return { accepted: true as const };
      if (!result) { await loadJob(ctx, prior._id); return { accepted: true as const }; }
      if (rows.filter(row => scalar(row, "state") === "requested" && scalar(row, "requestKey") === requestKey).length >= 3) {
        fail("INVALID_STATE", "This edit reached its attempt limit; review the failure before changing it.");
      }
    }
    const current = await editContext(ctx, user._id, args);
    if (rows.some(row => scalar(row, "state") === "requested" && !resultFor(rows, row._id))) {
      fail("INVALID_STATE", "A summary edit is already being checked for this incident.");
    }
    const note = normalized.changes.note ?? current.form.note;
    const candidate = editedCandidate(current.input.card, normalized.changes, note, current.facts);
    if (Object.entries(normalized.changes).every(([key, value]) => current.form[key as keyof typeof current.form] === value)) fail("VALIDATION", "The summary fields are unchanged.");
    if (candidate.movingSide && !event.requiredApprovalSides?.includes(candidate.movingSide)) fail("INVALID_STATE", "Only an active operator's spacecraft can maneuver.");
    await singleTrajectory(ctx, event, current.input.card, candidate);
    const job: Job = { args: normalized, userId: user._id, inputHash: current.inputHash, baseVersion: current.input.set.version,
      generation: current.selection.generation, evidenceKey: inputKey(current.facts), eventSnapshotId: current.snapshot.snapshotId,
      ommSnapshotId: current.ommId, demoRunId: event.demoRunId ?? null, candidate, note };
    const jobId = await ctx.db.insert("log", { eventId: event._id,
      actor: { kind: "human", userId: user._id, companyId: user.companyId, name: user.name ?? "Operator", side: current.actor.side },
      action: "countered", summary: "Requested a checked edit of the selected summary. No approval was recorded.", texts: null,
      before: { revision: args.baseRevision, generation: current.selection.generation },
      after: { type: MARKER, state: "requested", requestKey, request: JSON.stringify(job) },
      proposalId: args.proposalId, revision: args.baseRevision, roomId: null, demoRunId: job.demoRunId, simulated: event.simulated, at: Date.now() });
    await ctx.scheduler.runAfter(0, internal.summary.submit, { jobId });
    await ctx.scheduler.runAfter(10 * 60_000, internal.summary.failJob, { jobId, code: "EDIT_TIMEOUT" });
    return { accepted: true as const };
  },
});

async function loadJob(ctx: QueryCtx, jobId: Id<"log">) {
  const row = await ctx.db.get(jobId);
  if (!row?.eventId || scalar(row, "type") !== MARKER || scalar(row, "state") !== "requested") return null;
  if (resultFor(await history(ctx, row.eventId), jobId)) return null;
  const job = JSON.parse(String(scalar(row, "request"))) as Job;
  const current = await editContext(ctx, job.userId, job.args);
  if (current.inputHash !== job.inputHash) fail("STALE_REVISION", "The selected proposal, evidence or responsibility changed during the edit.");
  if (job.candidate.kind === "maneuver" && Date.parse(job.candidate.burnTimeUtc!) <= Date.now()) {
    fail("BURN_TIME_EXPIRED", "The edited burn time passed while its numerical result was being checked.");
  }
  await singleTrajectory(ctx, current.event, current.input.card, job.candidate);
  const card = job.candidate;
  const request: RescreenRequest | null = card.kind === "wait" ? null : {
    jobId: `summary-${jobId}`, snapshotId: job.ommSnapshotId, evidenceVersion: evidenceVersionOf(current.facts),
    objectId: card.movingObjectId!, partnerObjectId: card.movingSide === "A" ? current.facts.objectB.objectId : current.facts.objectA.objectId,
    maneuver: { burnTimeUtc: card.burnTimeUtc!, deltaVMs: card.deltaVMs!, direction: card.direction! },
    tcaUtc: wholeSecondUtc(current.event.tcaMs), fromUtc: card.burnTimeUtc!,
    toUtc: wholeSecondUtc(Date.parse(card.burnTimeUtc!) + HORIZON_H * 3_600_000),
    proposalId: String(job.args.proposalId), revision: card.revision, ...(job.demoRunId ? { runId: String(job.demoRunId) } : {}),
  };
  return { row, job, current, request };
}
export const jobInput = internalQuery({
  args: { jobId: v.id("log") },
  handler: async (ctx, { jobId }) => {
    const loaded = await loadJob(ctx, jobId);
    return loaded ? { request: loaded.request, eventId: loaded.current.event._id } : null;
  },
});
export const failJob = internalMutation({
  args: { jobId: v.id("log"), code: v.string() }, returns: v.null(),
  handler: async (ctx, { jobId, code }) => {
    const row = await ctx.db.get(jobId);
    if (!row?.eventId || scalar(row, "type") !== MARKER || scalar(row, "state") !== "requested" || resultFor(await history(ctx, row.eventId), jobId)) return null;
    await append(ctx, row, "failed", "The summary edit could not be published. Existing candidate history and decisions were retained.",
      { errorCode: /^[A-Z_]{1,80}$/.test(code) ? code : "EDIT_FAILED" });
    return null;
  },
});
function errorCode(error: unknown) {
  return error instanceof ConvexError && typeof error.data?.code === "string" ? error.data.code : orbitFailure(error).code;
}
export const submit = internalAction({
  args: { jobId: v.id("log") }, returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    try {
      const input = await ctx.runQuery(internal.summary.jobInput, { jobId });
      if (!input) return null;
      if (input.request === null) await ctx.runMutation(internal.summary.finish, { jobId, result: null });
      else {
        await startRescreen(input.request);
        await ctx.scheduler.runAfter(0, internal.summary.poll, { jobId, attempt: 0 });
      }
    } catch (error) { await ctx.runMutation(internal.summary.failJob, { jobId, code: errorCode(error) }); }
    return null;
  },
});
export const poll = internalAction({
  args: { jobId: v.id("log"), attempt: v.number() }, returns: v.null(),
  handler: async (ctx, { jobId, attempt }): Promise<null> => {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= POLL_LIMIT) fail("VALIDATION", "Invalid poll attempt.");
    try {
      const input = await ctx.runQuery(internal.summary.jobInput, { jobId });
      if (!input?.request) return null;
      const request = input.request;
      const response = await getRescreenJob(request.jobId, request);
      if (response.status === "failed") await ctx.runMutation(internal.summary.failJob, { jobId, code: response.error!.code });
      else if (response.status === "completed") {
        const result = response.result!;
        if (result.horizonH !== HORIZON_H || result.screenedFromUtc !== request.fromUtc || result.screenedToUtc !== request.toUtc ||
          result.proposalId !== request.proposalId || result.revision !== request.revision || result.runId !== request.runId) fail("INVALID_RESPONSE", "The rescreen did not echo this exact edited proposal and time window.");
        await ctx.runMutation(internal.summary.finish, { jobId, result: {
          snapshotId: result.snapshotId, evidenceKeys: [{ eventId: input.eventId, evidenceKey: request.evidenceVersion }],
          passed: result.passed, objectsChecked: result.objectsChecked, horizonH: result.horizonH,
          originalMissAfterKm: result.originalMissAfterKm,
          newConjunctions: result.newConjunctions.map(({ objectId, name, tcaUtc, missKm }) => ({ objectId, name, tcaUtc, missKm })),
          refusalReason: result.refusalReason,
        }, method: result.method, limitations: result.limitations });
      } else if (attempt + 1 >= POLL_LIMIT) await ctx.runMutation(internal.summary.failJob, { jobId, code: "RESCREEN_TIMEOUT" });
      else await ctx.scheduler.runAfter(POLL_DELAY_MS, internal.summary.poll, { jobId, attempt: attempt + 1 });
    } catch (error) { await ctx.runMutation(internal.summary.failJob, { jobId, code: errorCode(error) }); }
    return null;
  },
});
export const finish = internalMutation({
  args: { jobId: v.id("log"), result: v.union(rescreen, v.null()), method: v.optional(v.string()), limitations: v.optional(v.array(v.string())) }, returns: v.null(),
  handler: async (ctx, { jobId, result, method, limitations }): Promise<null> => {
    const loaded = await loadJob(ctx, jobId);
    if (!loaded) return null;
    const { row, job, current } = loaded;
    const candidate = { ...job.candidate };
    if (candidate.kind === "maneuver") {
      if (!result || result.snapshotId !== job.ommSnapshotId || result.evidenceKeys.length !== 1 ||
        result.evidenceKeys[0].eventId !== current.event._id || result.evidenceKeys[0].evidenceKey !== evidenceVersionOf(current.facts) ||
        result.horizonH !== HORIZON_H || !Number.isInteger(result.objectsChecked) || result.objectsChecked < 1) fail("INVALID_RESPONSE", "The rescreen is not bound to this edit.");
      if (!result.passed || result.originalMissAfterKm === null || result.originalMissAfterKm < 1 || result.originalMissAfterKm <= current.facts.missKm ||
        result.newConjunctions.some(c => !Number.isFinite(c.missKm) || c.missKm < 1) || result.refusalReason !== null) {
        await append(ctx, row, "failed", "The edited maneuver did not pass the catalog rescreen. No new proposal or approval was published.", { errorCode: "RESCREEN_REFUSED" });
        return null;
      }
      candidate.missAfterKm = result.originalMissAfterKm;
      candidate.assumptions = ["Edited maneuver recalculated by catalog rescreen over a 72-hour horizon.",
        "Miss distance is indicative; this result does not establish a collision-probability reduction.",
        ...(method ? [`Method: ${method}`] : []), ...(limitations ?? [])].slice(0, 20).map(text => text.slice(0, 500));
    } else if (result !== null) fail("INVALID_RESPONSE", "A wait proposal has no maneuver rescreen.");
    const cards: Candidate[] = [];
    for (const id of current.input.set.candidateRevisionIds) {
      const stored = (await ctx.db.get(id))!;
      const { _id, _creationTime, eventId: _event, ...card } = stored;
      cards.push(stored.candidateId === candidate.candidateId ? candidate : card);
    }
    const published = await ctx.runMutation(internal.candidates.publish, { eventId: current.event._id, baseVersion: job.baseVersion, candidates: cards,
      expectedEvidenceKey: job.evidenceKey, expectedSnapshotId: job.eventSnapshotId, expectedOmmSnapshotId: job.ommSnapshotId,
      expectedDemoRunId: job.demoRunId });
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", job.args.proposalId).eq("revision", candidate.revision)).unique();
    if (!revision) fail("INVALID_STATE", "The checked proposal revision was not created.");
    await ctx.db.patch(revision._id, { changeSummary: `Operator-edited summary recomputed from revision ${job.args.baseRevision}.${job.note ? ` ${job.note}` : ""}` });
    await append(ctx, row, "completed", "Published the checked summary edit as a new proposal revision. Required approvals reset.",
      { note: job.note, generation: job.generation + 1, errorCode: null }, candidate.revision);
    await ctx.scheduler.runAfter(0, publicationFollowups, { eventId: current.event._id, version: published.version, evidenceKey: job.evidenceKey });
    return null;
  },
});
