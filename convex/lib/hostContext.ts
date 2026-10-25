import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildFacts, isoUtc } from "./events";
import { inputKey } from "./analyst";
import { currentAssessment } from "./coordination";
import { countingApprovals } from "./approvalState";
import { MAX_MESSAGES, type HostContext, type HostTrigger, type Language } from "./host";

type HostEvent = HostContext["events"][number];
const present = <T>(row: T | null): row is T => row !== null;

// The Coordination Host's allowlisted context, read field by field from shared room rows (roadmap §6). Private policy values,
// Backboard memory and advocate contexts never enter the Host context.
export async function buildHostContext(ctx: QueryCtx, room: Doc<"rooms">, trigger: HostTrigger): Promise<HostContext> {
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const linked = await Promise.all([...new Set(links.map(l => l.eventId))].map(id => ctx.db.get(id)));
  if (linked.some(row => !row)) throw new ConvexError({ code: "NOT_FOUND", message: "Linked event data is incomplete." });
  const rows = linked.filter(present);
  // Every linked event, most urgent first. A room above MAX_EVENTS fails validateHostContext visibly; none is dropped.
  rows.sort((a, b) => a.tcaMs - b.tcaMs || (a._id < b._id ? -1 : 1));
  const events = await Promise.all(rows.map(event => hostEvent(ctx, event)));
  const members = await roomMembers(ctx, room);
  const messages = await recentMessages(ctx, room, rows);
  const understood = await activeUnderstanding(ctx, room, rows);
  // Authority and evidence pins are hashed only, never sent as extra model context. Membership changes matter
  // even when the company/language list stays the same, as do new evidence and selections with unchanged geometry.
  const memberships = await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const authority = await Promise.all(memberships.map(async member => {
    const user = await ctx.db.get(member.userId);
    const assignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", member.userId)).collect();
    const objectIds = new Set(events.flatMap(e => [e.event.objectAId, e.event.objectBId]));
    return { memberId: member._id, userId: member.userId, companyId: member.companyId,
      userCompanyId: user?.companyId ?? null, role: user?.role ?? null, assignmentVersion: user?.assignmentVersion ?? null,
      assignments: assignments.filter(a => objectIds.has(a.objectId)).map(a => ({ id: a._id, objectId: a.objectId, active: a.active })) };
  }));
  const inputVersion = await versionOf({
    roomId: room._id, demoRunId: room.demoRunId, members, authority,
    events: events.map(e => e.event), messages, pins: events.map(e => e.pins),
    ...(understood.length ? { understood } : {}),
  });
  // Optional until Host publication lands; existing callers without understood entries keep their contract.
  const context = { roomId: room._id, inputVersion, trigger, members, events: events.map(e => e.event), messages,
    ...(understood.length ? { understood } : {}) };
  return context;
}

async function versionOf(material: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(material)));
  return `host-v1:${[...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hostEvent(ctx: QueryCtx, event: Doc<"events">): Promise<{ event: HostEvent; pins: unknown }> {
  const [a, b, snapshot, set, selection] = await Promise.all([
    ctx.db.get(event.objectAId), ctx.db.get(event.objectBId), ctx.db.get(event.snapshotId),
    ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique(),
    ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique(),
  ]);
  if (!a || !b || !snapshot) throw new ConvexError({ code: "NOT_FOUND", message: "Event data is incomplete." });
  const evidenceKey = inputKey(buildFacts(event, a, b, snapshot.sources));
  const currentSet = set && set.evidenceKey === evidenceKey && set.state !== "closed" ? set : null;
  const revisions = currentSet ? await Promise.all(currentSet.candidateRevisionIds.map(async id => {
    const revision = await ctx.db.get(id);
    if (!revision || revision.eventId !== event._id) throw new ConvexError({ code: "NOT_FOUND", message: "Candidate evidence is incomplete." });
    return revision;
  })) : [];
  const owners = await Promise.all([a, b].map(object => ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique()));
  // Candidate IDs repeat across events (P1, or the one wait card ID), so the host names each candidate by its
  // immutable revision row, which is unique in the room and leads back to the event and candidate.
  const hostIds = new Map(revisions.map(r => [`${r.candidateId}#${r.revision}`, r._id]));
  // People name cards by their proposal label ("P2"); a candidate without a proposal keeps its computed label.
  const labels = await Promise.all(revisions.map(async r => (await ctx.db.query("proposals").withIndex("by_event_candidate", q =>
    q.eq("eventId", event._id).eq("candidateId", r.candidateId)).first())?.label ?? r.label));
  return {
    event: {
      eventId: event._id, objectAId: a.objectId, objectBId: b.objectId, debris: event.workflow === "unilateral_debris",
      tcaUtc: isoUtc(event.tcaMs), missKm: event.missKm, simulated: event.simulated,
      candidates: revisions.map((r, i) => ({
        candidateId: r._id, revision: r.revision, label: labels[i], kind: r.kind, movingObjectId: r.movingObjectId,
        burnTimeUtc: r.burnTimeUtc, deltaVMs: r.deltaVMs, missAfterKm: r.missAfterKm,
      })),
      feasibility: currentSet ? await sharedOutcomes(ctx, currentSet, hostIds) : [],
      approvals: currentSet && !currentSet.reviewRequired ? await recordedApprovals(ctx, event, selection) : [],
    },
    pins: { evidenceKey, snapshotId: snapshot._id, snapshotVersion: snapshot.snapshotId, ommUrl: snapshot.ommUrl ?? null,
      workflow: event.workflow ?? null, requiredApprovalSides: event.requiredApprovalSides ?? [], approvalRuleVersion: event.approvalRuleVersion ?? null,
      active: event.active, status: event.status ?? null, demoRunId: event.demoRunId ?? null,
      owners: owners.map(o => o?.companyId ?? null),
      set: set ? { id: set._id, version: set.version, evidenceKey: set.evidenceKey, state: set.state, reviewRequired: set.reviewRequired } : null,
      selection: selection ? { proposalId: selection.proposalId, revision: selection.revision, generation: selection.generation } : null },
  };
}

// Only the deterministic outcomes and categories advocates share, for the candidates currently on the table.
async function sharedOutcomes(ctx: QueryCtx, set: Doc<"candidateSets">, hostIds: Map<string, Id<"candidateRevisions">>) {
  const notes = await ctx.db.query("negotiationMessages").withIndex("by_event", q => q.eq("eventId", set.eventId)).order("desc").collect();
  const outcomes: HostEvent["feasibility"] = [];
  for (const side of ["A", "B"] as const) {
    const latest = notes.find(n => n.side === side);
    const companyId = side === "A" ? set.companyAId : set.companyBId;
    // A policy change after the last assessment voids it until that side's advocate runs again.
    if (latest?.kind !== "assessment" || !companyId) continue;
    const assessment = await currentAssessment(ctx, set, side, set.evidenceKey);
    if (!assessment || assessment._id !== latest._id) continue;
    for (const entry of assessment.entries) {
      const candidateId = hostIds.get(`${entry.candidateId}#${entry.revision}`);
      if (candidateId) outcomes.push({ companyId, candidateId, revision: entry.revision, outcome: entry.outcome, categories: [...entry.categories] });
    }
  }
  return outcomes;
}

// Server-reported approval state: current approved rows only. Pending, vetoed and reset rows are not approvals.
async function recordedApprovals(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections"> | null) {
  const approvals: HostEvent["approvals"] = [];
  for (const row of (await countingApprovals(ctx, event, selection)).values()) {
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", row.proposalId).eq("revision", row.revision)).unique();
    if (revision) approvals.push({ companyId: row.companyId, candidateId: revision.candidateRevisionId, revision: row.revision });
  }
  return approvals;
}

// One entry per company, in the company's shared language, else the first member's own language.
async function roomMembers(ctx: QueryCtx, room: Doc<"rooms">) {
  const rows = await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const companyIds = [...new Set([...room.companyIds, ...rows.map(m => m.companyId)])].sort();
  return Promise.all(companyIds.map(async companyId => {
    let language: Language | null = (await ctx.db.get(companyId))?.language ?? null;
    for (const member of rows) {
      if (language) break;
      if (member.companyId === companyId) language = (await ctx.db.get(member.userId))?.language ?? null;
    }
    return { companyId, language: language ?? "en" as const };
  }));
}

// The latest shared lines, oldest first, as originally written. Lines by the host itself or the system never enter,
// so the host's own output cannot change its input or trigger another run.
async function recentMessages(ctx: QueryCtx, room: Doc<"rooms">, events: Doc<"events">[]) {
  const messages: HostContext["messages"] = [];
  for await (const m of ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", room._id)).order("desc")) {
    if (m.kind === "voice") continue; // call_phrases is the canonical spoken source, never a mirrored text row.
    const companyId = m.author.kind === "human" ? m.author.companyId
      : m.author.kind === "agent" && m.author.role !== "coordination_host" ? m.author.companyId : null;
    if (!companyId) continue;
    messages.push({ messageId: m._id, companyId, language: m.originalLang, text: m.originalText, createdAt: isoUtc(m.createdAt) });
    if (messages.length === MAX_MESSAGES) break;
  }
  const eventIds = new Set<string>(events.map(e => e._id));
  const objects = (await Promise.all([...new Set(events.flatMap(e => [e.objectAId, e.objectBId]))].map(id => ctx.db.get(id)))).filter(present);
  const owners = await Promise.all(objects.map(object => ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique()));
  const speakers = new Map<string, Promise<string | null>>();
  const companyOf = (speakerId: string) => {
    if (!speakers.has(speakerId)) speakers.set(speakerId, (async () => {
      const id = ctx.db.normalizeId("users", speakerId);
      const user = id ? await ctx.db.get(id) : null;
      if (!user || user.role !== "operator" || !room.companyIds.includes(user.companyId)) return null;
      for (let i = 0; i < objects.length; i++) {
        if (owners[i]?.companyId !== user.companyId) continue;
        const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", objects[i].objectId)).unique();
        if (assignment?.active) return user.companyId;
      }
      return null;
    })());
    return speakers.get(speakerId)!;
  };
  let voiceCount = 0;
  for await (const phrase of ctx.db.query("call_phrases").withIndex("by_room_created", q => q.eq("roomId", room._id)).order("desc")) {
    // Worker contract: rev 1 is pending; rev 2 is final; later revisions can report TTS failure.
    // Translation failure still supplies the original. No partial or pending text reaches the Host.
    if (phrase.rev < 2 || Object.values(phrase.translationStatus).includes("pending") || !phrase.original.trim() ||
      phrase.simulated !== room.simulated || phrase.startedAtMs < room.createdAt ||
      (phrase.eventId !== null && !eventIds.has(phrase.eventId)) ||
      phrase.speaker.identity !== `user-${phrase.speaker.userId}`) continue;
    const companyId = await companyOf(phrase.speaker.userId);
    if (!companyId || companyId !== phrase.speaker.companyId) continue;
    const createdAt = Date.parse(phrase.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    messages.push({ messageId: phrase._id, companyId, language: phrase.originalLang, text: phrase.original, createdAt: isoUtc(createdAt) });
    if (++voiceCount === MAX_MESSAGES) break;
  }
  // One chronological window across both sources, with deterministic ties for stable input-version hashing.
  return messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.messageId.localeCompare(b.messageId)).slice(-MAX_MESSAGES);
}

async function activeUnderstanding(ctx: QueryCtx, room: Doc<"rooms">, events: Doc<"events">[]) {
  const rows = await ctx.db.query("understood").withIndex("by_room_status", q => q.eq("roomId", room._id).eq("status", "active")).take(65);
  if (rows.length > 64) throw new ConvexError({ code: "INVALID_INPUT", message: "The room has too many active understood entries for one Host context." });
  const eventIds = new Set(events.map(e => e._id));
  return rows.filter(row => row.demoRunId === room.demoRunId && (row.eventId === null || eventIds.has(row.eventId)))
    .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))
    .map(row => ({ understoodId: row._id, eventId: row.eventId, kind: row.kind, hard: row.hard, text: row.text,
      sourceMessageId: row.sourceMessageId, side: row.side }));
}
