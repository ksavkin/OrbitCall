import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireParty } from "./lib/operatorAccess";
import { decisionTurn, isResolved } from "./lib/decision";
import { candidate } from "./lib/policyValidators";
import { getCandidates, orbitConfigured } from "./lib/orbitClient";
import {
  discussionCards, geometryMatches, parseDiscussionConstraints, publishFailure, wholeSecondUtc,
  type DiscussionConstraint, type PublishInput,
} from "./lib/publishCandidates";

// This module consumes checked Host requests. It never approves, selects, schedules a burn, or parses a model's
// free-form reason as a number. All filters come from the original currently authorized human statements.
const bad = (code: string, message: string): never => { throw new ConvexError({ code, message }); };
const STALE = "The discussion or its source authority changed. Request a fresh revision.";
const MAX_ROWS = 501;
type Source = { id: string; messageId: Id<"messages"> | null; text: string; language: "en" | "ru" | "zh";
  userId: Id<"users">; companyId: Id<"companies">; objectId: string; side: "A" | "B"; pin: string };
type Discussion = { roomId: Id<"rooms">; demoRunId: Id<"demoRuns"> | null; sources: Source[];
  constraints: DiscussionConstraint[]; targetCandidateId: string | null; inputVersion: string; ruleVersion: string; done: boolean };

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function humanSource(ctx: QueryCtx, event: Doc<"events">, room: Doc<"rooms">, id: string): Promise<Source> {
  const messageId = ctx.db.normalizeId("messages", id), message = messageId && await ctx.db.get(messageId);
  const phraseId = ctx.db.normalizeId("call_phrases", id), phrase = phraseId && await ctx.db.get(phraseId);
  let userId: Id<"users">, companyId: Id<"companies">, text: string, language: Source["language"], eventId: string | null;
  let sourcePin: unknown;
  if (message && message.author.kind === "human" && message.roomId === room._id && message.demoRunId === room.demoRunId) {
    ({ userId, companyId } = message.author); text = message.originalText; language = message.originalLang; eventId = message.eventId;
    sourcePin = [message._id, text, language, message.author, message.eventId, message.createdAt];
  } else if (phrase && phrase.roomId === room._id && phrase.rev >= 2 && !Object.values(phrase.translationStatus).includes("pending")) {
    const user = ctx.db.normalizeId("users", phrase.speaker.userId), company = ctx.db.normalizeId("companies", phrase.speaker.companyId);
    if (!user || !company || phrase.startedAtMs < room.createdAt || phrase.simulated !== room.simulated ||
      phrase.speaker.identity !== `user-${phrase.speaker.userId}`) return bad("STALE_REVISION", STALE);
    userId = user; companyId = company; text = phrase.original; language = phrase.originalLang; eventId = phrase.eventId;
    sourcePin = [phrase._id, text, language, phrase.speaker, phrase.eventId, phrase.startedAtMs];
  } else return bad("STALE_REVISION", STALE);
  if (eventId !== null && eventId !== event._id) return bad("STALE_REVISION", STALE);
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "operator" || user.companyId !== companyId) return bad("STALE_REVISION", STALE);
  for (const [side, objectRef] of [["A", event.objectAId], ["B", event.objectBId]] as const) {
    const object = await ctx.db.get(objectRef);
    if (!object) continue;
    const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
    const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", userId).eq("objectId", object.objectId)).unique();
    if (owner?.companyId === companyId && assignment?.active) return {
      id, messageId: message ? message._id : null, text, language, userId, companyId, objectId: object.objectId, side,
      pin: await digest([sourcePin, user.assignmentVersion ?? 0, assignment._id, assignment.active, owner._id, owner.companyId]),
    };
  }
  return bad("STALE_REVISION", STALE);
}

async function understoodSource(ctx: QueryCtx, event: Doc<"events">, room: Doc<"rooms">, row: Doc<"understood">): Promise<Source> {
  const message = await ctx.db.get(row.sourceMessageId);
  if (!message || message.roomId !== room._id || message.demoRunId !== room.demoRunId) return bad("STALE_REVISION", STALE);
  if (message.author.kind === "human") {
    const source = await humanSource(ctx, event, room, message._id);
    if (!source.text.includes(row.text) || (row.side !== null && row.side !== source.side)) return bad("STALE_REVISION", STALE);
    return source;
  }
  if (message.author.kind !== "agent" || message.author.role !== "coordination_host" || !row.hostRunId) return bad("STALE_REVISION", STALE);
  const run = await ctx.db.get(row.hostRunId);
  const audit = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", row.eventId)).order("desc").take(MAX_ROWS);
  if (audit.length === MAX_ROWS) return bad("INPUT_LIMIT", "Too much source history to verify this constraint safely.");
  const records = audit.filter(l => l.action === "summary_posted" && l.roomId === room._id && l.demoRunId === room.demoRunId &&
    l.after?.hostRunId === row.hostRunId && l.after?.messageId === message._id && l.after?.understoodId === row._id && l.summary === row.text);
  if (run?.status !== "succeeded" || run.roomId !== room._id || run.demoRunId !== room.demoRunId || records.length !== 1 ||
    typeof records[0].after?.sources !== "string") return bad("STALE_REVISION", STALE);
  let provenance: { id: string; text: string; companyId: string; userId: string; language: string }[];
  try { provenance = JSON.parse(records[0].after.sources); } catch { return bad("STALE_REVISION", STALE); }
  if (!Array.isArray(provenance) || provenance.length !== 1 || typeof provenance[0]?.id !== "string") return bad("STALE_REVISION", STALE);
  const saved = provenance[0], source = await humanSource(ctx, event, room, saved.id);
  if (source.text !== saved.text || source.userId !== saved.userId || source.companyId !== saved.companyId || source.language !== saved.language ||
    message.originalText !== row.text || !source.text.includes(row.text) || (row.side !== null && row.side !== source.side) ||
    !run.output?.understood?.some(u => u.eventId === row.eventId && u.kind === row.kind && u.hard === row.hard && u.text === row.text && u.sourceMessageId === source.id)) {
    return bad("STALE_REVISION", STALE);
  }
  return { ...source, messageId: row.sourceMessageId };
}

async function loadDiscussion(ctx: QueryCtx, hostRunId: Id<"hostRuns">, eventId: Id<"events">): Promise<Discussion> {
  const run = await ctx.db.get(hostRunId), event = await ctx.db.get(eventId);
  const room = run && await ctx.db.get(run.roomId);
  if (!run || run.status !== "succeeded" || !run.output || !event || !room || room.state !== "open" || room.closedAt !== null ||
    room.demoRunId !== (event.demoRunId ?? null) || run.demoRunId !== room.demoRunId || isResolved(event) || event.tcaMs <= Date.now()) {
    return bad("INVALID_STATE", "Only a checked discussion for an active incident can revise its options.");
  }
  if (event.demoRunId) {
    const demo = await ctx.db.get(event.demoRunId);
    if (!demo || demo.state !== "open" || demo.closedAt !== null) return bad("INVALID_STATE", "This demonstration is closed.");
  }
  const links = await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect();
  if (!links.some(l => l.roomId === room._id)) return bad("FORBIDDEN", "The discussion is not linked to this incident.");
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  if (!set || set.state !== "open") return bad("INVALID_STATE", "The candidate set is not open for revision.");
  const history = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).order("desc").take(MAX_ROWS);
  if (history.length === MAX_ROWS) return bad("INPUT_LIMIT", "Too much revision history to verify this request safely.");
  const done = history.some(l => (l.action === "proposal_revised" || (l.action === "negotiation" && l.after?.kind === "revision_unchanged")) && l.after?.hostRunId === hostRunId);
  const requests = run.output.requestedRevisions.filter(r => r.eventId === eventId);
  const requestedIds = [...new Set(requests.map(r => r.candidateId))];
  if (requestedIds.length > 1) return bad("CLARIFICATION_REQUIRED", "Clarify which existing proposal should be revised first.");
  const current = await Promise.all(set.candidateRevisionIds.map(id => ctx.db.get(id)));
  // Host candidateId is the immutable candidateRevisions ID, not the stable card ID (hostContext.ts).
  if (!done && requestedIds.some(id => !current.some(c => c?._id === id))) return bad("STALE_REVISION", STALE);
  const targets = current.filter(c => c && requestedIds.includes(c._id)).map(c => c!.candidateId);
  const latest = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", room._id))
    .filter(q => q.eq(q.field("status"), "succeeded")).order("desc").first();
  if (!done && latest?._id !== run._id) return bad("STALE_REVISION", STALE);
  const rows = await ctx.db.query("understood").withIndex("by_room_status", q => q.eq("roomId", room._id).eq("status", "active")).take(101);
  if (rows.length === 101) return bad("INPUT_LIMIT", "Too many active interpretations to revise safely.");
  const hard = rows.filter(r => r.hard && (r.kind === "constraint" || r.kind === "correction") &&
    (r.eventId === eventId || r.eventId === null) && r.demoRunId === room.demoRunId);
  const releases = rows.filter(r => r.kind === "correction" && !r.hard && r.hostRunId === hostRunId &&
    (r.eventId === eventId || r.eventId === null) && r.demoRunId === room.demoRunId);
  if (!requests.length && !hard.length && !releases.length) return bad("NO_REVISION_REQUEST", "The discussion has no requested revision or active hard constraint for this incident.");
  const pair = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  const pairIds = pair.flatMap(o => o ? [o.objectId] : []);
  const sources = new Map<string, Source>();
  const pins: unknown[] = [];
  for (const row of hard) {
    // A room-wide statement made by another involved company does not constrain this pair's spacecraft.
    if (row.eventId === null && row.side === null) {
      const bridge = await ctx.db.get(row.sourceMessageId);
      if (bridge?.author.kind === "human" && bridge.author.companyId !== set.companyAId && bridge.author.companyId !== set.companyBId) continue;
    }
    const source = await understoodSource(ctx, event, room, row);
    // Parse the full original line so an excerpt cannot strip "not", an exception, or a second restriction.
    if (/\b(?:prefer|hypothetical|if)\b/i.test(source.text)) return bad("CLARIFICATION_REQUIRED", "Clarify whether this statement is a binding constraint or a preference.");
    sources.set(source.id, source); pins.push([row._id, row.kind, row.hard, row.text, row.sourceMessageId, row.correctedById, source.pin]);
  }
  for (const id of new Set(requests.flatMap(r => r.messageIds))) {
    if (!sources.has(id)) sources.set(id, await humanSource(ctx, event, room, id));
  }
  const constraints = [...sources.values()].flatMap(s => parseDiscussionConstraints(s.text, s.objectId, pairIds));
  for (const row of releases) {
    const output = run.output.understood?.find(u => u.kind === "correction" && !u.hard && u.text === row.text && u.eventId === row.eventId);
    const oldId = output?.correctsId && ctx.db.normalizeId("understood", output.correctsId), old = oldId && await ctx.db.get(oldId);
    if (!old || !old.hard || old.status !== "corrected" || old.correctedById !== row._id || old.roomId !== row.roomId || old.eventId !== row.eventId) continue;
    const source = await understoodSource(ctx, event, room, row);
    sources.set(source.id, source); pins.push([row._id, row.text, old._id, old.status, old.correctedById, source.pin]);
  }
  if (!sources.size) return bad("NO_REVISION_REQUEST", "There are no current human sources for this revision.");
  const sourceList = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  const inputVersion = await digest([eventId, room._id, room.demoRunId, targets, pins, sourceList.map(s => [s.id, s.pin]), constraints]);
  // New Host output repeating the same rules must not create a new revision/reset loop. Source provenance is
  // still pinned by inputVersion; the immutable card assumption changes only when the actual filter changes.
  const ruleVersion = await digest([...new Set(constraints.map(c => JSON.stringify(c)))].sort());
  return { roomId: room._id, demoRunId: room.demoRunId, sources: sourceList, constraints,
    targetCandidateId: targets[0] ?? null, inputVersion, ruleVersion, done };
}

export const load = internalQuery({
  args: { hostRunId: v.id("hostRuns"), eventId: v.id("events") },
  handler: (ctx, { hostRunId, eventId }) => loadDiscussion(ctx, hostRunId, eventId),
});

/** The Decision Center can request a retry without entering the communication room. Source authority is checked
 * again when the queued work runs, including after the numerical service returns. */
export const request = mutation({
  args: { eventId: v.id("events"), hostRunId: v.id("hostRuns") },
  handler: async (ctx, args) => {
    const { side, user } = await requireParty(ctx, args.eventId);
    const event = (await ctx.db.get(args.eventId))!;
    const turn = await decisionTurn(ctx, event);
    if (turn.deciding && turn.turn !== side) return bad("INVALID_STATE", "Only the deciding operator may request this revision.");
    const discussion = await loadDiscussion(ctx, args.hostRunId, args.eventId);
    if (!discussion.done) {
      const logs = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", args.eventId)).order("desc").take(MAX_ROWS);
      const attempts = logs.filter(l => l.action === "agents_rerun" && l.after?.role === "candidate_revision" &&
        l.after.hostRunId === args.hostRunId && l.after.inputVersion === discussion.inputVersion);
      for (const attempt of attempts) {
        const id = typeof attempt.after?.scheduledId === "string" && ctx.db.system.normalizeId("_scheduled_functions", attempt.after.scheduledId);
        const job = id && await ctx.db.system.get(id);
        if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return { accepted: true, alreadyApplied: false };
      }
      if (attempts.length >= 3) return bad("RETRY_LIMIT", "Revision retry limit reached. Correct the discussion or review the numerical service failure first.");
      const scheduledId = await ctx.scheduler.runAfter(0, internal.revisions.fromHost, args);
      await ctx.db.insert("log", { eventId: args.eventId, actor: { kind: "human", userId: user._id, companyId: user.companyId, name: user.name ?? "Operator", side },
        action: "agents_rerun", summary: "Operator requested recalculation from the checked discussion.", texts: null, before: null,
        after: { role: "candidate_revision", hostRunId: args.hostRunId, inputVersion: discussion.inputVersion, scheduledId, attempt: attempts.length + 1 },
        proposalId: null, revision: null, roomId: discussion.roomId, demoRunId: discussion.demoRunId, simulated: event.simulated, at: Date.now() });
    }
    return { accepted: true, alreadyApplied: discussion.done };
  },
});

const pinsValidator = v.object({ evidenceKey: v.string(), eventSnapshotId: v.string(), snapshotId: v.string(),
  demoRunId: v.union(v.id("demoRuns"), v.null()), baseVersion: v.union(v.number(), v.null()) });

export const commit = internalMutation({
  args: { eventId: v.id("events"), hostRunId: v.id("hostRuns"), inputVersion: v.string(),
    pins: pinsValidator, candidates: v.array(candidate) },
  handler: async (ctx, args): Promise<{ version: number; changed: boolean }> => {
    const discussion = await loadDiscussion(ctx, args.hostRunId, args.eventId);
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", args.eventId)).unique();
    if (discussion.done) return { version: set!.version, changed: false };
    if (discussion.inputVersion !== args.inputVersion) return bad("STALE_REVISION", STALE);
    await requireUnshared(ctx, args.eventId, args.candidates.flatMap(c => c.movingObjectId ? [c.movingObjectId] : []));
    const existingRevisions = new Set<string>();
    for (const card of args.candidates) {
      const proposal = await ctx.db.query("proposals").withIndex("by_event_candidate", q => q.eq("eventId", args.eventId).eq("candidateId", card.candidateId)).unique();
      const existing = proposal && await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", proposal._id).eq("revision", card.revision)).unique();
      if (existing) existingRevisions.add(existing._id);
    }
    const result = await ctx.runMutation(internal.candidates.publish, { eventId: args.eventId, baseVersion: args.pins.baseVersion,
      candidates: args.candidates, expectedEvidenceKey: args.pins.evidenceKey, expectedSnapshotId: args.pins.eventSnapshotId,
      expectedOmmSnapshotId: args.pins.snapshotId, expectedDemoRunId: args.pins.demoRunId });
    const event = (await ctx.db.get(args.eventId))!;
    if (!result.changed) {
      await ctx.db.insert("log", { eventId: args.eventId, actor: { kind: "agent", role: "coordination_host", companyId: null, side: null },
        action: "negotiation", summary: "The checked discussion leaves the calculated options unchanged.", texts: null, before: null,
        after: { hostRunId: args.hostRunId, inputVersion: args.inputVersion, kind: "revision_unchanged" }, proposalId: null, revision: null,
        roomId: discussion.roomId, demoRunId: discussion.demoRunId, simulated: event.simulated, at: Date.now() });
      return result;
    }
    const sourceMessageIds: Id<"messages">[] = [];
    for (const source of discussion.sources) {
      // The frozen proposal schema accepts message IDs. Voice retains its real ID in the immutable log and gets
      // a clearly agent-authored source bridge, never a forged human line or a call_phrases ID cast as messages.
      sourceMessageIds.push(source.messageId ?? await ctx.db.insert("messages", {
        roomId: discussion.roomId, eventId: args.eventId, author: { kind: "agent", role: "coordination_host", companyId: null }, kind: "text",
        originalText: source.text, originalLang: source.language, translations: {}, translationStatus: {}, values: [],
        refs: { eventId: args.eventId }, form: null, demoRunId: discussion.demoRunId, simulated: event.simulated, createdAt: Date.now(),
      }));
    }
    const kinds = [...new Set(discussion.constraints.map(c => c.kind))];
    const summary = kinds.length
      ? `Recomputed the full candidate grid using the discussion's ${kinds.join(", ").replaceAll("_", " ")} constraints. Human approval is still required.`
      : "Recomputed the full candidate grid after the operator corrected a hard constraint. Human approval is still required.";
    let added = 0;
    for (const card of args.candidates) {
      const proposal = await ctx.db.query("proposals").withIndex("by_event_candidate", q => q.eq("eventId", args.eventId).eq("candidateId", card.candidateId)).unique();
      const revision = proposal && await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", proposal._id).eq("revision", card.revision)).unique();
      if (!proposal || !revision) return bad("INVALID_STATE", "The published revision projection is unavailable.");
      if (existingRevisions.has(revision._id)) continue;
      await ctx.db.patch(revision._id, { changeSummary: summary, sourceMessageIds: [...new Set(sourceMessageIds)] });
      await ctx.db.insert("log", { eventId: args.eventId, actor: { kind: "agent", role: "coordination_host", companyId: null, side: null },
        action: "proposal_revised", summary, texts: null, before: { candidateVersion: args.pins.baseVersion },
        after: { hostRunId: args.hostRunId, inputVersion: args.inputVersion, candidateVersion: result.version,
          sourceMessageIds: JSON.stringify(sourceMessageIds), originalSourceIds: JSON.stringify(discussion.sources.map(s => s.id)) },
        proposalId: proposal._id, revision: card.revision, roomId: discussion.roomId, demoRunId: discussion.demoRunId,
        simulated: event.simulated, at: Date.now() });
      added++;
    }
    if (!added) await ctx.db.insert("log", { eventId: args.eventId, actor: { kind: "agent", role: "coordination_host", companyId: null, side: null },
      action: "proposal_revised", summary, texts: null, before: { candidateVersion: args.pins.baseVersion },
      after: { hostRunId: args.hostRunId, inputVersion: args.inputVersion, candidateVersion: result.version,
        sourceMessageIds: JSON.stringify(sourceMessageIds), originalSourceIds: JSON.stringify(discussion.sources.map(s => s.id)) },
      proposalId: null, revision: null, roomId: discussion.roomId, demoRunId: discussion.demoRunId, simulated: event.simulated, at: Date.now() });
    await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { eventId: Id<"events">; version: number; evidenceKey: string }, unknown>("advocates:publicationFollowups"), {
      eventId: args.eventId, version: result.version, evidenceKey: args.pins.evidenceKey,
    });
    return result;
  },
});

/** There is no landed trajectory publication API yet. Check actual current room/event links and existing plans
 * both before and at commit. A missing plan must never downgrade a shared maneuver into independent approvals. */
async function requireUnshared(ctx: QueryCtx, eventId: Id<"events">, movingObjectIds: string[]) {
  const event = await ctx.db.get(eventId);
  const movers = new Set(movingObjectIds);
  const current = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  for (const id of current?.candidateRevisionIds ?? []) {
    const card = await ctx.db.get(id);
    if (card?.movingObjectId) movers.add(card.movingObjectId);
  }
  const links = await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect();
  for (const link of links) {
    const room = await ctx.db.get(link.roomId);
    if (!room || room.state !== "open") continue;
    const linked = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
    for (const other of linked) {
      if (other.eventId === eventId) continue;
      const row = await ctx.db.get(other.eventId);
      if (!row?.active || row.tcaMs <= Date.now()) continue;
      for (const object of await Promise.all([ctx.db.get(row.objectAId), ctx.db.get(row.objectBId)])) {
        if (object && movers.has(object.objectId)) return bad("TRAJECTORY_PLAN_REQUIRED", "This mover affects linked incidents. Revision requires the shared trajectory-plan publisher before any options can change.");
      }
    }
  }
  for (const objectId of movers) {
    const plans = await ctx.db.query("trajectoryPlans").withIndex("by_object_version", q => q.eq("objectId", objectId)).collect();
    if (plans.some(p => p.demoRunId === (event?.demoRunId ?? null) && p.state !== "superseded")) {
      return bad("TRAJECTORY_PLAN_REQUIRED", "This maneuver already belongs to a trajectory plan; its version must be revised through that plan.");
    }
  }
}

export const checkMovers = internalQuery({
  args: { eventId: v.id("events"), objectIds: v.array(v.string()) },
  handler: async (ctx, { eventId, objectIds }) => { await requireUnshared(ctx, eventId, objectIds); return null; },
});

export const eventsForHost = internalQuery({
  args: { hostRunId: v.id("hostRuns") },
  handler: async (ctx, { hostRunId }) => {
    const run = await ctx.db.get(hostRunId);
    if (!run || run.status !== "succeeded" || !run.output) return [];
    const ids = new Set(run.output.requestedRevisions.map(r => r.eventId));
    for (const row of run.output.understood ?? []) if ((row.hard && row.kind === "constraint") || row.kind === "correction") {
      if (row.eventId) ids.add(row.eventId);
      else for (const link of await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", run.roomId)).collect()) ids.add(link.eventId);
    }
    return [...ids].flatMap(id => { const eventId = ctx.db.normalizeId("events", id); return eventId ? [eventId] : []; });
  },
});

/** A visible refusal/clarification is deduplicated by checked run and event. Failures leave cards and approvals
 * untouched; users can correct the original discussion and obtain a fresh checked Host run. */
export const recordFailure = internalMutation({
  args: { hostRunId: v.id("hostRuns"), eventId: v.id("events"), code: v.string(), message: v.string() },
  handler: async (ctx, { hostRunId, eventId, code, message }) => {
    const run = await ctx.db.get(hostRunId), event = await ctx.db.get(eventId);
    const room = run && await ctx.db.get(run.roomId);
    if (!run || !event || !room || run.status !== "succeeded" || room.state !== "open" || room.closedAt !== null ||
      room.demoRunId !== (event.demoRunId ?? null)) return null;
    if (room.demoRunId && (await ctx.db.get(room.demoRunId))?.state !== "open") return null;
    const logs = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).order("desc").take(MAX_ROWS);
    if (logs.length === MAX_ROWS || logs.some(l => l.action === "summary_posted" && l.after?.revisionHostRunId === hostRunId && l.after?.revisionError === code)) return null;
    const text = `Candidate revision needs attention: ${message}`;
    const messageId = await ctx.db.insert("messages", { roomId: room._id, eventId, author: { kind: "system" }, kind: "system",
      originalText: text, originalLang: "en", translations: {}, translationStatus: {}, values: [], refs: { eventId }, form: null,
      demoRunId: room.demoRunId, simulated: event.simulated, createdAt: Date.now() });
    await ctx.db.insert("log", { eventId, actor: { kind: "system" }, action: "summary_posted", summary: text, texts: null,
      before: null, after: { revisionHostRunId: hostRunId, revisionError: code, messageId }, proposalId: null, revision: null,
      roomId: room._id, demoRunId: room.demoRunId, simulated: event.simulated, at: Date.now() });
    return null;
  },
});

type RevisionResult = { eventId: Id<"events">; status: "published"; changed: boolean; version: number } |
  { eventId: Id<"events">; status: "failed"; code: string; message: string };

export const fromHost = internalAction({
  args: { hostRunId: v.id("hostRuns"), eventId: v.optional(v.id("events")) },
  handler: async (ctx, { hostRunId, eventId }): Promise<RevisionResult[]> => {
    const events = await ctx.runQuery(internal.revisions.eventsForHost, { hostRunId });
    const results: RevisionResult[] = [];
    for (const id of events.filter(id => !eventId || id === eventId)) {
      try {
        const discussion = await ctx.runQuery(internal.revisions.load, { hostRunId, eventId: id });
        const loaded = await ctx.runQuery(internal.advocates.publishInput, { eventId: id, nowMs: Date.now() });
        if ("skipped" in loaded) bad(loaded.skipped, "The incident is not available for candidate revision.");
        const input: PublishInput = (loaded as { input: PublishInput }).input;
        if (discussion.done) { results.push({ eventId: id, status: "published", changed: false, version: input.baseVersion! }); continue; }
        if (!orbitConfigured()) bad("ORBIT_NOT_CONFIGURED", "The numerical service is not configured.");
        const response = await getCandidates({ snapshotId: input.snapshotId, evidenceVersion: input.evidenceVersion,
          objectA: input.facts.objectA.objectId, objectB: input.facts.objectB.objectId, tcaUtc: wholeSecondUtc(Date.parse(input.facts.tcaUtc)),
          allowedMovingObjectIds: input.allowedMovingObjectIds, notBeforeUtc: wholeSecondUtc(Date.now(), Math.ceil) });
        if (!geometryMatches(response, input.facts)) bad("GEOMETRY_MISMATCH", "The numerical result no longer matches this incident's evidence.");
        const candidates = discussionCards(response, input, id, Date.now(), discussion.constraints, discussion.targetCandidateId, discussion.ruleVersion);
        await ctx.runQuery(internal.revisions.checkMovers, { eventId: id, objectIds: candidates.flatMap(c => c.movingObjectId ? [c.movingObjectId] : []) });
        const result = await ctx.runMutation(internal.revisions.commit, { eventId: id, hostRunId, inputVersion: discussion.inputVersion,
          pins: { evidenceKey: input.evidenceKey, eventSnapshotId: input.eventSnapshotId, snapshotId: input.snapshotId, demoRunId: input.demoRunId, baseVersion: input.baseVersion }, candidates });
        results.push({ eventId: id, status: "published", ...result });
      } catch (error) {
        const failure = publishFailure(error);
        await ctx.runMutation(internal.revisions.recordFailure, { hostRunId, eventId: id, code: failure.code, message: failure.message });
        results.push({ eventId: id, ...failure });
      }
    }
    return results;
  },
});
