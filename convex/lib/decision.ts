import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { countingApprovals, turnOf, RESOLVED_STATUSES } from "./approvalState";

// Decision turns (user-flow "App navigation and the decision flow", October 25): the required sides decide in
// order, A then B. While an incident's decision is open, only the side whose turn it is acts on it; everyone may
// discuss before it opens. Read-only rules shared by rooms, messages and the approvals module.

type Side = "A" | "B";

/** Statuses after human agreement or with nothing left to decide (functionality §3). */
export { RESOLVED_STATUSES } from "./approvalState";

export const isResolved = (event: Doc<"events">) => !event.active || RESOLVED_STATUSES.has(event.status ?? "new");

/**
 * The event's decision state. A decision is open while the event is active and unresolved, classified with required
 * sides, and a card is selected. The turn is the first required side (A before B) without an approval that counts
 * (lib/approvals.ts countingApprovals, the rule consensus uses). Null when no decision is open.
 */
export async function decisionTurn(ctx: QueryCtx, event: Doc<"events">): Promise<{ deciding: boolean; turn: Side | null }> {
  if (isResolved(event) || !event.requiredApprovalSides?.length || !event.workflow || event.workflow === "internal_review") return { deciding: false, turn: null };
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  if (!selection?.proposalId || selection.revision === null) return { deciding: false, turn: null };
  const turn = turnOf(event, await countingApprovals(ctx, event, selection));
  return { deciding: turn !== null, turn };
}
