import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { roomOfEvent } from "../rooms";
import { inputKey } from "./analyst";
import { loadFacts } from "./events";

// Approval rules shared by proposals.ts, approvals.ts and candidates.publish (spec §4.1, ROOM-7, ROOM-11, ROOM-14).
// Main's write-time model: a reset marks approval rows not current and advances the selection generation; old rows
// stay as history and never come back. Decision turns (A, then B) are lib/decision.ts.

type Side = "A" | "B";
/** The first approval rule version an event gets; a classification change would advance it (schema/data.ts). */
export const APPROVAL_RULE_VERSION = 1;

/**
 * Stores the event's workflow, required sides and rule version when they are unset, from satellite ownership:
 * one company owning both objects is an internal review, anything else bilateral. Never infers debris (a missing
 * operator is not debris, spec §4.1) and never overwrites a stored value. Returns the event as stored.
 */
export async function classifyIfUnset(ctx: MutationCtx, event: Doc<"events">): Promise<Doc<"events">> {
  if (event.workflow !== undefined && event.requiredApprovalSides !== undefined && event.approvalRuleVersion !== undefined) return event;
  const objects = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  const owners = await Promise.all(objects.map(o => o && ctx.db.query("satelliteOwners")
    .withIndex("by_object", q => q.eq("objectId", o.objectId)).unique()));
  const internal = !!owners[0] && owners[0].companyId === owners[1]?.companyId;
  const workflow = event.workflow ?? (internal ? "internal_review" as const : "bilateral" as const);
  const requiredApprovalSides: Side[] = event.requiredApprovalSides ?? (workflow === "internal_review" ? []
    : workflow === "bilateral" ? ["A", "B"] : owners[0] ? ["A"] : ["B"]);
  const patch = { workflow, requiredApprovalSides, approvalRuleVersion: event.approvalRuleVersion ?? APPROVAL_RULE_VERSION };
  await ctx.db.patch(event._id, patch);
  return { ...event, ...patch };
}

export type ResetReason = "selection_changed" | "revision_changed" | "proposal_withdrawn" | "vetoed" | "policy_changed" | "assignment_revoked";
type Next = { proposalId: Id<"proposals">; revision: number } | null;
type By = Doc<"selections">["by"];

/**
 * Moves the event's selection to `next` and advances its generation; every current approval row stops counting.
 * When rows were reset, `lastReset` records it and the open room gets the workflow's reset line (spec §4.1 Resets).
 */
export async function advanceSelection(ctx: MutationCtx, event: Doc<"events">, next: Next, by: By, reason: ResetReason) {
  const now = Date.now();
  const row = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  const current = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  for (const approval of current) await ctx.db.patch(approval._id, { current: false });
  // A veto is a reset even when nobody had approved yet.
  const reset = current.length > 0 || reason === "vetoed";
  const value = {
    eventId: event._id, proposalId: next?.proposalId ?? null, revision: next?.revision ?? null,
    generation: (row?.generation ?? 0) + 1, by, at: now,
    lastReset: reset ? { at: now, reason } : row?.lastReset ?? null,
  };
  if (row) await ctx.db.replace(row._id, value);
  else await ctx.db.insert("selections", value);
  if (reset) {
    const room = await roomOfEvent(ctx, event);
    if (room) await ctx.db.insert("messages", {
      roomId: room._id, eventId: event._id, author: { kind: "system" }, kind: "system",
      originalText: event.workflow === "unilateral_debris" ? "Approval reset." : "Both approvals reset.", originalLang: "en",
      translations: {}, translationStatus: {}, values: [], refs: {}, form: null,
      demoRunId: room.demoRunId, simulated: room.simulated, createdAt: now,
    });
  }
  return value.generation;
}

/**
 * The approved rows that count for the current selection, by side: current, exactly the selected proposal, revision
 * and generation, the event's rule version and demo run, a required side, signed by an operator of that side's owner
 * who is still assigned to its object (ACC-2). The same rules hostContext.recordedApprovals applies.
 */
export async function countingApprovals(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections"> | null) {
  const counted = new Map<Side, Doc<"approvals">>();
  if (!selection?.proposalId || selection.revision === null || !event.requiredApprovalSides?.length) return counted;
  if (event.workflow !== "bilateral" && event.workflow !== "unilateral_debris") return counted;
  const objects = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  const rows = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  for (const row of rows) {
    if (counted.has(row.side) || row.status !== "approved" || row.proposalId !== selection.proposalId || row.revision !== selection.revision
      || row.selectionGeneration !== selection.generation || row.approvalRuleVersion !== event.approvalRuleVersion
      || !event.requiredApprovalSides.includes(row.side) || row.demoRunId !== (event.demoRunId ?? null)) continue;
    const object = objects[row.side === "A" ? 0 : 1];
    if (!object) continue;
    const [owner, user, assignment] = await Promise.all([
      ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique(),
      ctx.db.get(row.userId),
      ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", row.userId).eq("objectId", object.objectId)).unique(),
    ]);
    if (owner?.companyId !== row.companyId || user?.role !== "operator" || user.companyId !== row.companyId || !assignment?.active) continue;
    counted.set(row.side, row);
  }
  return counted;
}

export const allApproved = (event: Doc<"events">, counted: Map<Side, unknown>) =>
  !!event.requiredApprovalSides?.length && event.requiredApprovalSides.every(s => counted.has(s));

/** The decision turn from the approvals that count: the first required side, A before B, without one. */
export const turnOf = (event: Doc<"events">, counted: Map<Side, unknown>): Side | null =>
  [...(event.requiredApprovalSides ?? [])].sort().find(s => !counted.has(s)) ?? null;

/** A material change (policy, authorization) resets the event's approvals and keeps its selected card (spec §4.1). */
export async function resetApprovals(ctx: MutationCtx, event: Doc<"events">, reason: ResetReason) {
  const row = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  // Approvals need a selection, so an event without one has nothing to reset.
  if (!row) return;
  const next = row.proposalId && row.revision !== null ? { proposalId: row.proposalId, revision: row.revision } : null;
  await advanceSelection(ctx, event, next, row.by, reason);
}

/**
 * Called after provisioning changes a user's role or assignments: every current approval the user signed for an
 * object they no longer hold as an operator is reset at once, so restoring the assignment never revives it (ACC-2).
 */
export async function revalidateApprover(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  // No index by user: approvals are few per deployment, and a missed row would keep a revoked approval alive.
  const rows: Doc<"approvals">[] = [];
  for await (const row of ctx.db.query("approvals")) if (row.userId === userId && row.current) rows.push(row);
  for (const eventId of new Set(rows.map(r => r.eventId))) {
    const event = await ctx.db.get(eventId);
    if (!event) continue;
    const stale = await Promise.all(rows.filter(r => r.eventId === eventId).map(async r => {
      const object = await ctx.db.get(r.side === "A" ? event.objectAId : event.objectBId);
      const assignment = object && await ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
        q.eq("userId", userId).eq("objectId", object.objectId)).unique();
      return user?.role !== "operator" || user.companyId !== r.companyId || !assignment?.active;
    }));
    if (stale.some(Boolean)) await resetApprovals(ctx, event, "assignment_revoked");
  }
}

/** Whether the candidate set was computed on the event's current evidence. */
export async function currentEvidence(ctx: QueryCtx, event: Doc<"events">, set: Doc<"candidateSets">) {
  return set.evidenceKey === inputKey(await loadFacts(ctx, event));
}
