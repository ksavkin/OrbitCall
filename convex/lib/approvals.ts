import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

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

export { advanceSelection, allApproved, countingApprovals, decisionInputs, invalidateEventApprovals } from "./approvalState";
export type { ResetReason } from "./approvalState";
