import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isoUtc } from "./events";
import { MAX_MESSAGES, type HostContext, type HostTrigger, type Language } from "./host";

type HostEvent = HostContext["events"][number];
const present = <T>(row: T | null): row is T => row !== null;

// The Coordination Host's allowlisted context, read field by field from shared room rows (roadmap §6). Policies,
// Backboard memory and advocate contexts are never read here.
export async function buildHostContext(ctx: QueryCtx, room: Doc<"rooms">, trigger: HostTrigger): Promise<HostContext> {
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const rows = (await Promise.all([...new Set(links.map(l => l.eventId))].map(id => ctx.db.get(id)))).filter(present);
  // Every linked event, most urgent first. A room above MAX_EVENTS fails validateHostContext visibly; none is dropped.
  rows.sort((a, b) => a.tcaMs - b.tcaMs || (a._id < b._id ? -1 : 1));
  const events = await Promise.all(rows.map(event => hostEvent(ctx, event)));
  const members = await roomMembers(ctx, room);
  const messages = await recentMessages(ctx, room._id);
  // Selections are not sent, but a new generation resets approvals and so is a new input for the host.
  const inputVersion = await versionOf({
    roomId: room._id, members, events: events.map(e => e.event), messages, selections: events.map(e => e.selectionGeneration),
  });
  return { roomId: room._id, inputVersion, trigger, members, events: events.map(e => e.event), messages };
}

async function versionOf(material: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(material)));
  return `host-v1:${[...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hostEvent(ctx: QueryCtx, event: Doc<"events">): Promise<{ event: HostEvent; selectionGeneration: number | null }> {
  const [a, b, set, selection] = await Promise.all([
    ctx.db.get(event.objectAId), ctx.db.get(event.objectBId),
    ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique(),
    ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique(),
  ]);
  if (!a || !b) throw new ConvexError({ code: "NOT_FOUND", message: "Event data is incomplete." });
  const revisions = set ? (await Promise.all(set.candidateRevisionIds.map(id => ctx.db.get(id)))).filter(present) : [];
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
      feasibility: set ? await sharedOutcomes(ctx, set, hostIds) : [],
      approvals: await recordedApprovals(ctx, event._id),
    },
    selectionGeneration: selection?.generation ?? null,
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
    for (const entry of latest.entries) {
      const candidateId = hostIds.get(`${entry.candidateId}#${entry.revision}`);
      if (candidateId) outcomes.push({ companyId, candidateId, revision: entry.revision, outcome: entry.outcome, categories: [...entry.categories] });
    }
  }
  return outcomes;
}

// Server-reported approval state: current approved rows only. Pending, vetoed and reset rows are not approvals.
async function recordedApprovals(ctx: QueryCtx, eventId: Id<"events">) {
  const rows = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", eventId).eq("current", true)).collect();
  const approvals: HostEvent["approvals"] = [];
  for (const row of rows.filter(r => r.status === "approved")) {
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", row.proposalId).eq("revision", row.revision)).unique();
    const candidate = revision && await ctx.db.get(revision.candidateRevisionId);
    if (candidate) approvals.push({ companyId: row.companyId, candidateId: candidate._id, revision: candidate.revision });
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
