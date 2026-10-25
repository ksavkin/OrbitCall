import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Decision turns (user-flow "App navigation and the decision flow", October 25): the required sides decide in
// order, A then B. While an incident's decision is open, only the side whose turn it is acts on it; everyone may
// discuss before it opens. Read-only rules shared by rooms, messages and the approvals module.

type Side = "A" | "B";

/** Statuses after human agreement or with nothing left to decide (functionality §3). */
export const RESOLVED_STATUSES = new Set(["approved", "scheduled", "monitoring", "awaiting_verification_data", "verified", "no_action_needed"]);

export const isResolved = (event: Doc<"events">) => !event.active || RESOLVED_STATUSES.has(event.status ?? "new");

/**
 * The event's decision state. A decision is open while the event is active and unresolved, classified with required
 * sides, and a card is selected. The turn is the first required side (A before B) without a current approval of
 * exactly that selection (proposal, revision, generation, approval rule version). Null when no decision is open.
 */
export async function decisionTurn(ctx: QueryCtx, event: Doc<"events">): Promise<{ deciding: boolean; turn: Side | null }> {
  const required = [...(event.requiredApprovalSides ?? [])].sort();
  if (isResolved(event) || !required.length || !event.workflow || event.workflow === "internal_review") return { deciding: false, turn: null };
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  if (!selection?.proposalId || selection.revision === null) return { deciding: false, turn: null };
  const rows = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect();
  const approved = new Set(rows.filter(r => r.status === "approved" && r.proposalId === selection.proposalId &&
    r.revision === selection.revision && r.selectionGeneration === selection.generation &&
    r.approvalRuleVersion === event.approvalRuleVersion).map(r => r.side));
  const turn = required.find(s => !approved.has(s)) ?? null;
  return { deciding: turn !== null, turn };
}
