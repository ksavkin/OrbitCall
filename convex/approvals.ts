import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireParty, requireReader } from "./lib/operatorAccess";
import { advanceSelection, allApproved, classifyIfUnset, countingApprovals } from "./lib/approvals";
import { decisionTurn } from "./lib/decision";
import { isoUtc } from "./lib/events";
import { side } from "./lib/policyValidators";
import { workflow } from "./lib/validators";
import { closeRoomIfResolved } from "./rooms";

// Explicit human approval and veto of the selected proposal revision, per event (spec §3.4, §4.1; ROOM-7, ROOM-11,
// ROOM-14; user-flow "App navigation and the decision flow"). Nothing moves without a human: a row is written only
// here, by an assigned operator of a required side clicking Approve or Veto. Selection, speech, agent output and
// memory never write here. Parties decide in turns, side A then side B (lib/decision.ts); only the side in turn acts.

const MAX_REASON = 500;
type Args = { eventId: Id<"events">; proposalId: Id<"proposals">; revision: number; selectionGeneration: number; approvalRuleVersion: number };
const decisionArgs = {
  eventId: v.id("events"), proposalId: v.id("proposals"), revision: v.number(),
  selectionGeneration: v.number(), approvalRuleVersion: v.number(),
};
const error = (code: string, message: string) => new ConvexError({ code, message });

// spec §4.1 steps 1-4, shared by approve and veto.
async function checkDecision(ctx: MutationCtx, args: Args) {
  const { user, candidateSet: set, side } = await requireParty(ctx, args.eventId);
  const event = await classifyIfUnset(ctx, (await ctx.db.get(args.eventId))!);
  if ((event.workflow !== "bilateral" && event.workflow !== "unilateral_debris") || !event.requiredApprovalSides?.includes(side)) {
    throw error("FORBIDDEN", "This workflow needs no approval from your side.");
  }
  const status = event.status ?? "new";
  if (status === "approved" || status === "scheduled") throw error("ALREADY_DECIDED", "This plan is already decided; its approvals can no longer change.");
  if (!event.active || set.state !== "open" || (status !== "proposal" && status !== "communication")) {
    throw error("INVALID_STATE", "This incident is not waiting for a decision.");
  }
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  if (!selection?.proposalId || selection.proposalId !== args.proposalId) throw error("NOT_SELECTED", "Select this card before deciding on it.");
  const stale = () => error("STALE_REVISION", "The selected plan changed; review the current revision first.");
  if (args.revision !== selection.revision || args.selectionGeneration !== selection.generation || args.approvalRuleVersion !== event.approvalRuleVersion) throw stale();
  const proposal = await ctx.db.get(args.proposalId);
  const stored = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
    q.eq("proposalId", args.proposalId).eq("revision", args.revision)).unique();
  if (proposal?.latestRevision !== args.revision || !stored || !set.candidateRevisionIds.includes(stored.candidateRevisionId)) throw stale();
  return { user, side, event, selection };
}

// Off-turn approve or veto is refused; null means every required side looks approved under the turn rule.
async function requireTurn(ctx: MutationCtx, d: Awaited<ReturnType<typeof checkDecision>>) {
  const { turn } = await decisionTurn(ctx, d.event);
  if (turn !== null && turn !== d.side) throw error("INVALID_STATE", `It is side ${turn}'s turn to decide.`);
}

const approveResult = v.object({ allRequiredApproved: v.boolean(), requiredApprovalSides: v.array(side) });

export const approve = mutation({
  args: decisionArgs,
  returns: approveResult,
  handler: async (ctx, args) => {
    const d = await checkDecision(ctx, args);
    let counted = await countingApprovals(ctx, d.event, d.selection);
    // Approving the same tick again is idempotent, even after the turn has moved on.
    if (!counted.has(d.side)) {
      await requireTurn(ctx, d);
      await ctx.db.insert("approvals", {
        eventId: d.event._id, side: d.side, status: "approved", userId: d.user._id, companyId: d.user.companyId,
        proposalId: args.proposalId, revision: args.revision, selectionGeneration: args.selectionGeneration,
        approvalRuleVersion: args.approvalRuleVersion, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null,
        demoRunId: d.event.demoRunId ?? null, current: true, at: Date.now(),
      });
      counted = await countingApprovals(ctx, d.event, d.selection);
    }
    const all = allApproved(d.event, counted);
    if (all) {
      // spec §4.1 step 5; the room closes on consensus in the same mutation (rooms.closeRoomIfResolved).
      await ctx.db.patch(d.event._id, { status: "approved", situation: undefined });
      await closeRoomIfResolved(ctx, d.event._id);
    }
    return { allRequiredApproved: all, requiredApprovalSides: d.event.requiredApprovalSides! };
  },
});

/** Vetoes the selected revision: approvals reset, the selection stays, and the event returns to the agents. */
export const veto = mutation({
  args: { ...decisionArgs, reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { reason, ...args }) => {
    const text = reason?.trim() || null;
    if (text && text.length > MAX_REASON) throw error("VALIDATION", `A veto reason is at most ${MAX_REASON} characters.`);
    const d = await checkDecision(ctx, args);
    await requireTurn(ctx, d);
    await advanceSelection(ctx, d.event, { proposalId: args.proposalId, revision: args.revision }, { kind: "human", userId: d.user._id }, "vetoed");
    // History only: a veto never counts as an approval state of the new generation.
    await ctx.db.insert("approvals", {
      eventId: d.event._id, side: d.side, status: "vetoed", userId: d.user._id, companyId: d.user.companyId,
      proposalId: args.proposalId, revision: args.revision, selectionGeneration: args.selectionGeneration,
      approvalRuleVersion: args.approvalRuleVersion, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: text,
      demoRunId: d.event.demoRunId ?? null, current: false, at: Date.now(),
    });
    await ctx.db.patch(d.event._id, { status: "agents", situation: undefined });
    return null;
  },
});

const nullable = <T extends Parameters<typeof v.union>[0]>(t: T) => v.union(t, v.null());
// spec §2.3 SideApproval.
const sideApproval = v.object({
  status: v.union(v.literal("pending"), v.literal("approved"), v.literal("vetoed")),
  byUserId: nullable(v.id("users")), byName: nullable(v.string()), at: nullable(v.string()),
  proposalId: nullable(v.id("proposals")), revision: nullable(v.number()), selectionGeneration: nullable(v.number()),
  approvalRuleVersion: v.number(),
});
export const approvalStatus = v.object({
  eventId: v.id("events"),
  // Stored classification; null while unclassified, which authorizes nothing.
  workflow: nullable(workflow), requiredApprovalSides: v.array(side), approvalRuleVersion: nullable(v.number()),
  selectionGeneration: v.number(),
  selected: nullable(v.object({ proposalId: v.id("proposals"), label: v.string(), revision: v.number(), generation: v.number() })),
  // Required sides only: never a debris or internal entry.
  approvals: v.object({ A: v.optional(sideApproval), B: v.optional(sideApproval) }),
  allRequiredApproved: v.boolean(),
  deciding: v.boolean(), turn: nullable(side),
  lastReset: nullable(v.object({ at: v.string(), reason: v.string() })),
  mySide: nullable(side), canAct: v.boolean(), myTurn: v.boolean(), simulated: v.boolean(),
});

/** "P2 · R2 · A approved · waiting for B" for one event. Parties and the observer read; the observer has no control. */
export const status = query({
  args: { eventId: v.id("events") },
  returns: approvalStatus,
  handler: async (ctx, { eventId }) => {
    const { user, event, owners } = await requireReader(ctx, eventId);
    const [selection, set] = await Promise.all([
      ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
      ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
    ]);
    const [counted, { deciding, turn }] = await Promise.all([countingApprovals(ctx, event, selection), decisionTurn(ctx, event)]);
    const required = event.requiredApprovalSides ?? [];
    const ruleVersion = event.approvalRuleVersion ?? null;
    const approvals: Partial<Record<"A" | "B", Infer<typeof sideApproval>>> = {};
    for (const s of required) {
      const row = counted.get(s);
      approvals[s] = row ? {
        status: "approved", byUserId: row.userId, byName: (await ctx.db.get(row.userId))?.name ?? null, at: isoUtc(row.at),
        proposalId: row.proposalId, revision: row.revision, selectionGeneration: row.selectionGeneration, approvalRuleVersion: row.approvalRuleVersion,
      } : { status: "pending", byUserId: null, byName: null, at: null, proposalId: null, revision: null, selectionGeneration: null,
        approvalRuleVersion: ruleVersion ?? 0 };
    }
    const proposal = selection?.proposalId ? await ctx.db.get(selection.proposalId) : null;
    const internal = event.workflow === "internal_review" || (!!owners[0] && owners[0].companyId === owners[1]?.companyId);
    const mySide = user.role === "demo_observer" || internal ? null
      : owners[0]?.companyId === user.companyId ? "A" as const : owners[1]?.companyId === user.companyId ? "B" as const : null;
    let canAct = false;
    const status = event.status ?? "new";
    if (user.role === "operator" && mySide && required.includes(mySide) && proposal && set?.state === "open" && event.active
      && (event.workflow === "bilateral" || event.workflow === "unilateral_debris") && (status === "proposal" || status === "communication")) {
      const object = await ctx.db.get(mySide === "A" ? event.objectAId : event.objectBId);
      const assignment = object && await ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
        q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
      canAct = assignment?.active === true;
    }
    return {
      eventId, workflow: event.workflow ?? null, requiredApprovalSides: required, approvalRuleVersion: ruleVersion,
      selectionGeneration: selection?.generation ?? 0,
      selected: proposal && selection?.revision != null
        ? { proposalId: proposal._id, label: proposal.label, revision: selection.revision, generation: selection.generation } : null,
      approvals, allRequiredApproved: allApproved(event, counted), deciding, turn,
      lastReset: selection?.lastReset ? { at: isoUtc(selection.lastReset.at), reason: selection.lastReset.reason } : null,
      mySide, canAct, myTurn: canAct && deciding && turn === mySide, simulated: event.simulated,
    };
  },
});
