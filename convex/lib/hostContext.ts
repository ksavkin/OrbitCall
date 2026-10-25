import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildFacts, isoUtc } from "./events";
import { inputKey } from "./analyst";
import { currentAssessment } from "./coordination";
import { LEGACY_ASSIGNMENT_VERSION } from "./accounts";
import { MAX_MESSAGES, type HostContext, type HostTrigger, type Language } from "./host";

type HostEvent = HostContext["events"][number];
const present = <T>(row: T | null): row is T => row !== null;

// The Coordination Host's allowlisted context, read field by field from shared room rows (roadmap §6). Policies,
// Backboard memory and advocate contexts are never read here.
export async function buildHostContext(ctx: QueryCtx, room: Doc<"rooms">, trigger: HostTrigger): Promise<HostContext> {
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const linked = await Promise.all([...new Set(links.map(l => l.eventId))].map(id => ctx.db.get(id)));
  if (linked.some(row => !row)) throw new ConvexError({ code: "NOT_FOUND", message: "Linked event data is incomplete." });
  const rows = linked.filter(present);
  // Every linked event, most urgent first. A room above MAX_EVENTS fails validateHostContext visibly; none is dropped.
  rows.sort((a, b) => a.tcaMs - b.tcaMs || (a._id < b._id ? -1 : 1));
  const events = await Promise.all(rows.map(event => hostEvent(ctx, event)));
  const members = await roomMembers(ctx, room);
  const messages = await recentMessages(ctx, room._id);
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
  });
  return { roomId: room._id, inputVersion, trigger, members, events: events.map(e => e.event), messages };
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
      approvals: currentSet && !currentSet.reviewRequired ? await recordedApprovals(ctx, event, selection, currentSet, [a, b], owners) : [],
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
async function recordedApprovals(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections"> | null,
  set: Doc<"candidateSets">, objects: Doc<"spaceObjects">[], owners: (Doc<"satelliteOwners"> | null)[]) {
  const approvals: HostEvent["approvals"] = [];
  if (!selection?.proposalId || selection.revision === null || !["bilateral", "unilateral_debris"].includes(event.workflow ?? "")) return approvals;
  const rows = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).order("desc").collect();
  const sides = new Set<string>();
  for (const row of rows) {
    if (sides.has(row.side)) continue;
    sides.add(row.side);
    const index = row.side === "A" ? 0 : 1;
    const companyId = row.side === "A" ? set.companyAId : set.companyBId;
    if (row.status !== "approved" || row.proposalId !== selection.proposalId || row.revision !== selection.revision ||
      row.selectionGeneration !== selection.generation || row.approvalRuleVersion !== event.approvalRuleVersion ||
      !event.requiredApprovalSides?.includes(row.side) || row.companyId !== companyId || row.companyId !== owners[index]?.companyId ||
      row.demoRunId !== (event.demoRunId ?? null)) continue;
    const user = await ctx.db.get(row.userId);
    const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
      q.eq("userId", row.userId).eq("objectId", objects[index].objectId)).unique();
    // The approvals module's rule: a changed assignment set since the approval means it no longer counts.
    if (!user || user.role !== "operator" || user.companyId !== row.companyId || !assignment?.active
      || row.assignmentVersion !== (user.assignmentVersion ?? LEGACY_ASSIGNMENT_VERSION)) continue;
    const proposal = await ctx.db.get(row.proposalId);
    if (!proposal || proposal.eventId !== event._id || proposal.latestRevision !== row.revision) continue;
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", row.proposalId).eq("revision", row.revision)).unique();
    const candidate = revision && await ctx.db.get(revision.candidateRevisionId);
    if (!candidate || revision?.eventId !== event._id || candidate.eventId !== event._id || !set.candidateRevisionIds.includes(candidate._id)) continue;
    if (row.trajectoryPlanId) {
      const plan = await ctx.db.get(row.trajectoryPlanId);
      if (!plan || plan.planVersion !== row.trajectoryPlanVersion || ["superseded", "review_required"].includes(plan.state) ||
        !plan.affectedEventIds.includes(event._id) || !plan.eventRefs.some(ref => ref.eventId === event._id && ref.proposalId === row.proposalId &&
          ref.revision === row.revision && ref.selectionGeneration === row.selectionGeneration)) continue;
    } else if (row.trajectoryPlanVersion !== null) continue;
    approvals.push({ companyId: row.companyId, candidateId: candidate._id, revision: candidate.revision });
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
async function recentMessages(ctx: QueryCtx, roomId: Id<"rooms">) {
  const messages: HostContext["messages"] = [];
  for await (const m of ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", roomId)).order("desc")) {
    const companyId = m.author.kind === "human" ? m.author.companyId
      : m.author.kind === "agent" && m.author.role !== "coordination_host" ? m.author.companyId : null;
    if (!companyId) continue;
    messages.push({ messageId: m._id, companyId, language: m.originalLang, text: m.originalText, createdAt: isoUtc(m.createdAt) });
    if (messages.length === MAX_MESSAGES) break;
  }
  return messages.reverse();
}
