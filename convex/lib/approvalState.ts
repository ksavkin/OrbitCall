import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { inputKey } from "./analyst";
import { loadFacts } from "./events";

type Side = "A" | "B";
export type ResetReason = "selection_changed" | "revision_changed" | "proposal_withdrawn" | "vetoed" |
  "policy_changed" | "evidence_changed" | "assignment_changed" | "authorization_changed" | "candidate_set_changed";
type Next = { proposalId: Id<"proposals">; revision: number } | null;

/** Current, complete evidence for an approval. Every reader and decision writer uses this same gate. */
export async function decisionInputs(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections"> | null) {
  if (!selection?.proposalId || selection.revision === null || !event.active ||
    !event.requiredApprovalSides?.length || !["bilateral", "unilateral_debris"].includes(event.workflow ?? "")) return null;
  if (event.demoRunId) {
    const run = await ctx.db.get(event.demoRunId);
    if (!run || run.state !== "open" || run.closedAt !== null) return null;
  }
  const [set, proposal, revision, a, b] = await Promise.all([
    ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique(),
    ctx.db.get(selection.proposalId),
    ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", selection.proposalId!).eq("revision", selection.revision!)).unique(),
    ctx.db.get(event.objectAId), ctx.db.get(event.objectBId),
  ]);
  if (!set || set.state === "closed" || set.reviewRequired || !a || !b || !proposal || !revision ||
    proposal.eventId !== event._id || revision.eventId !== event._id || proposal.latestRevision !== selection.revision ||
    proposal.demoRunId !== (event.demoRunId ?? null) || !set.candidateRevisionIds.includes(revision.candidateRevisionId)) return null;
  const card = await ctx.db.get(revision.candidateRevisionId);
  if (!card || card.eventId !== event._id || card.candidateId !== proposal.candidateId || card.revision !== selection.revision) return null;
  try { if (set.evidenceKey !== inputKey(await loadFacts(ctx, event))) return null; } catch { return null; }
  const owners = await Promise.all([a, b].map(o => ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", o.objectId)).unique()));
  const companies = { A: owners[0]?.companyId ?? null, B: owners[1]?.companyId ?? null };
  if (set.companyAId !== companies.A || set.companyBId !== companies.B) return null;
  const required = [...new Set(event.requiredApprovalSides)].sort();
  if (event.workflow === "bilateral") {
    if (required.join() !== "A,B" || !companies.A || !companies.B || companies.A === companies.B) return null;
  } else if (required.length !== 1 || !companies[required[0]] || companies[required[0] === "A" ? "B" : "A"]) return null;
  if (card.kind === "maneuver" && (!card.movingSide || !required.includes(card.movingSide) ||
    card.movingObjectId !== (card.movingSide === "A" ? a : b).objectId)) return null;
  let materialAt = Math.max(selection.at, revision.createdAt);
  for (const companyId of new Set(owners.flatMap(o => o ? [o.companyId] : []))) {
    const policy = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
    materialAt = Math.max(materialAt, policy?.updatedAt ?? 0);
  }
  return { set, proposal, revision, card, objects: { A: a, B: b }, companies, materialAt };
}

/** Latest rows only; old or revoked approvals never supply either consensus or a decision turn. */
export async function countingApprovals(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections"> | null) {
  const counted = new Map<Side, Doc<"approvals">>();
  const input = await decisionInputs(ctx, event, selection);
  if (!input || !selection) return counted;
  const rows = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  const seen = new Set<Side>();
  for (const row of rows.sort((a, b) => b.at - a.at || b._creationTime - a._creationTime)) {
    if (seen.has(row.side)) continue;
    seen.add(row.side);
    if (row.status !== "approved" || row.proposalId !== selection.proposalId || row.revision !== selection.revision ||
      row.selectionGeneration !== selection.generation || row.approvalRuleVersion !== event.approvalRuleVersion ||
      !event.requiredApprovalSides!.includes(row.side) || row.demoRunId !== (event.demoRunId ?? null) ||
      row.companyId !== input.companies[row.side] || row.at < input.materialAt) continue;
    const [user, assignment] = await Promise.all([
      ctx.db.get(row.userId), ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
        q.eq("userId", row.userId).eq("objectId", input.objects[row.side].objectId)).unique(),
    ]);
    if (!user || user.role !== "operator" || user.companyId !== row.companyId || !assignment?.active) continue;
    if (row.trajectoryPlanId) {
      const plan = await ctx.db.get(row.trajectoryPlanId);
      if (!plan || plan.demoRunId !== (event.demoRunId ?? null) || plan.planVersion !== row.trajectoryPlanVersion ||
        ["superseded", "review_required"].includes(plan.state) || !plan.affectedEventIds.includes(event._id) ||
        !plan.eventRefs.some(r => r.eventId === event._id && r.proposalId === row.proposalId && r.revision === row.revision && r.selectionGeneration === row.selectionGeneration)) continue;
    } else if (row.trajectoryPlanVersion !== null) continue;
    counted.set(row.side, row);
  }
  return counted;
}

export const allApproved = (event: Doc<"events">, counted: Map<Side, unknown>) =>
  !!event.requiredApprovalSides?.length && event.requiredApprovalSides.every(s => counted.has(s));

/** Retires rows permanently. The frozen schema binds input changes by advancing the selection generation. */
export async function advanceSelection(ctx: MutationCtx, event: Doc<"events">, next: Next, by: Doc<"selections">["by"], reason: ResetReason) {
  const now = Date.now();
  const row = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  const current = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  for (const approval of current) await ctx.db.patch(approval._id, { current: false });
  const reset = current.length > 0 || reason === "vetoed" || !["selection_changed", "revision_changed", "proposal_withdrawn"].includes(reason);
  const value = { eventId: event._id, proposalId: next?.proposalId ?? null, revision: next?.revision ?? null,
    generation: (row?.generation ?? 0) + 1, by, at: now, lastReset: reset ? { at: now, reason } : row?.lastReset ?? null };
  if (row) await ctx.db.replace(row._id, value); else await ctx.db.insert("selections", value);
  if (reset) {
    const summary = event.workflow === "unilateral_debris" ? "Approval reset." : "Both approvals reset.";
    for (const link of await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", event._id)).collect()) {
      const room = await ctx.db.get(link.roomId);
      if (!room || room.state !== "open" || room.closedAt !== null) continue;
      if (room.demoRunId) { const run = await ctx.db.get(room.demoRunId); if (!run || run.state !== "open" || run.closedAt !== null) continue; }
      await ctx.db.insert("messages", { roomId: room._id, eventId: event._id, author: { kind: "system" }, kind: "system",
        originalText: summary, originalLang: "en", translations: {}, translationStatus: {}, values: [], refs: {}, form: null,
        demoRunId: room.demoRunId, simulated: room.simulated, createdAt: now });
      break;
    }
    await ctx.db.insert("log", { eventId: event._id, actor: { kind: "system" }, action: "approvals_reset", summary: `${summary} ${reason}`,
      texts: null, before: { generation: row?.generation ?? 0 }, after: { generation: value.generation, reason },
      proposalId: row?.proposalId ?? null, revision: row?.revision ?? null, roomId: null,
      demoRunId: event.demoRunId ?? null, simulated: event.simulated, at: now });
  }
  return value.generation;
}

/** Real writers call this in their transaction. Artifact history is retained and any reserved write is flagged. */
export async function invalidateEventApprovals(ctx: MutationCtx, supplied: Doc<"events">, reason: ResetReason) {
  const event = await ctx.db.get(supplied._id);
  if (!event) return;
  if (event.demoRunId) {
    const run = await ctx.db.get(event.demoRunId);
    if (!run || run.state !== "open" || run.closedAt !== null) return;
  }
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  const current = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  let reserved = false;
  for (const link of await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", event._id)).collect()) {
    const maneuver = await ctx.db.get(link.maneuverId);
    if (!maneuver || maneuver.demoRunId !== (event.demoRunId ?? null)) continue;
    reserved ||= ["rescreening", "committing", "committed"].includes(maneuver.status);
    if (!maneuver.reviewRequired) await ctx.db.patch(maneuver._id, { reviewRequired: true, updatedAt: Date.now() });
  }
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  const scheduled = reserved || set?.state === "scheduled" || ["scheduled", "awaiting_verification_data", "verified"].includes(event.status ?? "");
  if ((scheduled || reason === "evidence_changed") && set && !set.reviewRequired) await ctx.db.patch(set._id, { reviewRequired: true });
  if (!selection?.proposalId && !current.length) return;
  await advanceSelection(ctx, event, selection?.proposalId && selection.revision !== null ?
    { proposalId: selection.proposalId, revision: selection.revision } : null, { kind: "agents" }, reason);
  if (!scheduled && event.active && event.status !== "no_action_needed") {
    await ctx.db.patch(event._id, { status: reason === "evidence_changed" ? "agents" : "proposal", situation: undefined });
  }
}

/** Indexed object-scoped invalidation, shared by assignment and catalog writers. */
export async function invalidateObjectApprovals(ctx: MutationCtx, objectIds: string[], reason: ResetReason) {
  const events = new Map<Id<"events">, Doc<"events">>();
  for (const objectId of new Set(objectIds)) {
    const object = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
    if (!object) continue;
    const [a, b] = await Promise.all([
      ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", object._id)).collect(),
      ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", object._id)).collect(),
    ]);
    for (const event of [...a, ...b]) events.set(event._id, event);
  }
  for (const event of events.values()) await invalidateEventApprovals(ctx, event, reason);
}
