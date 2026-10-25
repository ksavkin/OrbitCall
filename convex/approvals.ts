import { ConvexError, v, type Infer } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireParty, requireReader } from "./lib/operatorAccess";
import { advanceSelection, allApproved, assignmentVersionOf, classifyIfUnset, countingApprovals, decisionInputs, turnOf } from "./lib/approvals";
import { isResolved } from "./lib/decision";
import { isoUtc } from "./lib/events";
import { side } from "./lib/policyValidators";
import { workflow } from "./lib/validators";
import { closeRoomIfResolved, notify, roomOfEvent } from "./rooms";
import { scheduleConfig } from "./lib/scheduleClient";
import { planFor, syncPlans } from "./trajectoryPlans";

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
const requestSchedule = makeFunctionReference<"mutation", { eventId: Id<"events"> }>("maneuvers:requestSchedule");

// A maneuver is approved on its prepared schedule diff (EXE-4, ROOM-9). Gated only while the Factory worker is configured
// (the schedule client's own URL and token check): without it the approval still records and the scheduler's
// WORKER_UNAVAILABLE stays visible instead.
async function requirePreview(ctx: MutationCtx, args: Args) {
  try { scheduleConfig(); } catch { return; }
  const stored = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
    q.eq("proposalId", args.proposalId).eq("revision", args.revision)).unique();
  const card = stored && await ctx.db.get(stored.candidateRevisionId);
  if (card?.kind === "maneuver" && stored!.schedulePreviewHash === null) {
    throw error("INVALID_STATE", "Factory is still preparing this plan's schedule diff; approve once it is shown.");
  }
}

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
  const inputs = await decisionInputs(ctx, event, selection);
  if (!inputs) throw stale();
  if (event.tcaMs <= Date.now() || (inputs.card.kind === "maneuver" && Date.parse(inputs.card.burnTimeUtc!) <= Date.now())) {
    throw error("INVALID_STATE", "The encounter or selected burn is no longer in the future.");
  }
  return { user, side, event, selection };
}

// Off-turn approve or veto is refused. The turn comes from the approvals that count, the same rule as consensus.
async function requireTurn(ctx: MutationCtx, d: Awaited<ReturnType<typeof checkDecision>>) {
  const turn = turnOf(d.event, await countingApprovals(ctx, d.event, d.selection));
  if (turn !== d.side) throw error("INVALID_STATE", turn ? `It is side ${turn}'s turn to decide.` : "Every required side has approved.");
}

type Side = "A" | "B";

/**
 * The operators who may act for `sides` of the event now: the same rule as requireParty (the side object's owner
 * company, an active fleet assignment, the operator role). A side without an owner (debris) has nobody. The actor is
 * left out: a notice tells the others what someone did.
 */
export async function sideOperators(ctx: MutationCtx, event: Doc<"events">, sides: Side[], actor: Id<"users">) {
  const users = new Map<Id<"users">, Doc<"users">>();
  for (const s of new Set(sides)) {
    const object = await ctx.db.get(s === "A" ? event.objectAId : event.objectBId);
    if (!object) continue;
    const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
    if (!owner) continue;
    for (const a of await ctx.db.query("fleetAssignments").withIndex("by_object", q => q.eq("objectId", object.objectId)).collect()) {
      if (!a.active || a.userId === actor || users.has(a.userId)) continue;
      const user = await ctx.db.get(a.userId);
      if (user?.role === "operator" && user.companyId === owner.companyId) users.set(user._id, user);
    }
  }
  return [...users.values()];
}

/**
 * Leaves one inbox notice (rooms.notify, the round 1.5 row) for the operators of `sides`. One string per person per
 * mutation, because a notice replaces the previous one. Notices name the card, its revision and sides only: never a
 * veto reason, a policy value or advocate text (ROOM-3, ROOM-15).
 */
export async function notifySides(ctx: MutationCtx, event: Doc<"events">, sides: Side[], actor: Id<"users">, summary: string) {
  for (const user of await sideOperators(ctx, event, sides, actor)) await notify(ctx, user._id, event, summary);
}

/**
 * Writes the same new summary onto the actor's existing inbox row and leaves it read. A person who has no row yet
 * does not gain one: the row is created only when someone else notifies them. One row per person per event.
 */
export async function noteActor(ctx: MutationCtx, event: Doc<"events">, actor: Id<"users">, summary: string) {
  const existing = await ctx.db.query("inbox").withIndex("by_user_event", q => q.eq("userId", actor).eq("eventId", event._id)).unique();
  if (!existing) return;
  await ctx.db.patch(existing._id, { lastUpdateSummary: summary, lastUpdateAt: Date.now(), unread: false });
}

type Values = Record<string, number | string | null>;

/**
 * One shared audit row for a human decision on a card revision (LOG-2, LOG-3): who, for which side, when, and the
 * numbers before and after. Selection, approval and veto write it in their own transaction, before any reset the
 * decision causes. Like a notice it names the card, its revision and side only: never a veto reason (LOG-1, POL-2).
 */
export async function logDecision(ctx: MutationCtx, event: Doc<"events">, user: Doc<"users">, side: Side,
  action: "selected" | "approved" | "vetoed", target: { proposalId: Id<"proposals">; revision: number }, summary: string,
  before: Values, after: Values) {
  await ctx.db.insert("log", { eventId: event._id,
    actor: { kind: "human", userId: user._id, companyId: user.companyId, name: user.name ?? "Operator", side },
    action, summary, texts: null, before, after, proposalId: target.proposalId, revision: target.revision,
    roomId: (await roomOfEvent(ctx, event))?._id ?? null, demoRunId: event.demoRunId ?? null, simulated: event.simulated, at: Date.now() });
}

const planName = async (ctx: MutationCtx, proposalId: Id<"proposals">, revision: number) =>
  `${(await ctx.db.get(proposalId))?.label ?? "The plan"} revision ${revision}`;

const approveResult = v.object({ allRequiredApproved: v.boolean(), requiredApprovalSides: v.array(side) });

export const approve = mutation({
  args: decisionArgs,
  returns: approveResult,
  handler: async (ctx, args) => {
    const d = await checkDecision(ctx, args);
    // Selection writes keep shared plans current; this catches a change that bypassed them (a room link). If it had
    // to reset this event, the click is not recorded: the reset and its message stand, and throwing would undo them.
    if (await syncPlans(ctx, d.event)) return { allRequiredApproved: false, requiredApprovalSides: d.event.requiredApprovalSides! };
    // A shared mover's approval also signs the plan version every affected event must approve (spec §4.1).
    const plan = await planFor(ctx, d.event, d.selection);
    let counted = await countingApprovals(ctx, d.event, d.selection);
    // Approving the same tick again is idempotent, even after the turn has moved on; it leaves no notice either.
    const inserted = !counted.has(d.side);
    if (inserted) await requirePreview(ctx, args);
    if (inserted) {
      await requireTurn(ctx, d);
      await ctx.db.insert("approvals", {
        eventId: d.event._id, side: d.side, status: "approved", userId: d.user._id, companyId: d.user.companyId,
        proposalId: args.proposalId, revision: args.revision, selectionGeneration: args.selectionGeneration,
        approvalRuleVersion: args.approvalRuleVersion, trajectoryPlanId: plan?._id ?? null, trajectoryPlanVersion: plan?.planVersion ?? null,
        reason: null, demoRunId: d.event.demoRunId ?? null, current: true, at: Date.now(), assignmentVersion: assignmentVersionOf(d.user),
      });
      if (plan?.state === "draft") await ctx.db.patch(plan._id, { state: "authorizing", updatedAt: Date.now() });
      counted = await countingApprovals(ctx, d.event, d.selection);
    }
    const all = allApproved(d.event, counted);
    // Logged before consensus closes the room, so the row still names it.
    if (inserted) {
      const status = d.event.status ?? "new";
      await logDecision(ctx, d.event, d.user, d.side, "approved", args,
        `Side ${d.side} approved ${await planName(ctx, args.proposalId, args.revision)}.${all ? " The plan is agreed." : ""}`,
        { status }, { status: all ? "approved" : status, selectionGeneration: args.selectionGeneration,
          approvalRuleVersion: args.approvalRuleVersion, trajectoryPlanVersion: plan?.planVersion ?? null });
    }
    if (all) {
      // spec §4.1 step 5; the room closes on consensus in the same mutation (rooms.closeRoomIfResolved).
      await ctx.db.patch(d.event._id, { status: "approved", situation: undefined });
      await closeRoomIfResolved(ctx, d.event._id);
      // The Maneuver Scheduler runs in the background (spec §4.1); it logs its own failures and never undoes this.
      await ctx.scheduler.runAfter(0, requestSchedule, { eventId: d.event._id });
    }
    if (inserted) {
      const plan = await planName(ctx, args.proposalId, args.revision);
      const required = d.event.requiredApprovalSides!;
      const next = turnOf(d.event, counted);
      // Consensus: every required side hears that the plan is agreed. Otherwise the approver's side hears that it
      // is waiting, and the side now in turn hears that the decision is theirs. The actor's existing row gets the
      // same summary as their side and stays read; a missing row is not created.
      if (all) {
        const summary = required.length > 1
          ? `Both sides approved ${plan}. The plan is agreed.` : `Side ${d.side} approved ${plan}. The plan is agreed.`;
        await notifySides(ctx, d.event, required, d.user._id, summary);
        await noteActor(ctx, d.event, d.user._id, summary);
      } else if (next) {
        const waiting = `Side ${d.side} approved ${plan}. Waiting for side ${next}.`;
        await notifySides(ctx, d.event, [d.side], d.user._id, waiting);
        await noteActor(ctx, d.event, d.user._id, waiting);
        await notifySides(ctx, d.event, [next], d.user._id, `Side ${d.side} approved ${plan}. It is your turn to decide.`);
      }
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
    // The version this veto rejects; the selection advance below supersedes it and resets the other affected events.
    const vetoed = await planFor(ctx, d.event, d.selection);
    // The reason stays in the approval row: it is free text and may echo private policy.
    const plan = await planName(ctx, args.proposalId, args.revision);
    await logDecision(ctx, d.event, d.user, d.side, "vetoed", args, `Side ${d.side} vetoed ${plan}.`,
      { status: d.event.status ?? "new", generation: args.selectionGeneration }, { status: "agents", generation: args.selectionGeneration + 1 });
    await advanceSelection(ctx, d.event, { proposalId: args.proposalId, revision: args.revision }, { kind: "human", userId: d.user._id }, "vetoed");
    // History only: a veto never counts as an approval state of the new generation.
    await ctx.db.insert("approvals", {
      eventId: d.event._id, side: d.side, status: "vetoed", userId: d.user._id, companyId: d.user.companyId,
      proposalId: args.proposalId, revision: args.revision, selectionGeneration: args.selectionGeneration,
      approvalRuleVersion: args.approvalRuleVersion, trajectoryPlanId: vetoed?._id ?? null, trajectoryPlanVersion: vetoed?.planVersion ?? null, reason: text,
      demoRunId: d.event.demoRunId ?? null, current: false, at: Date.now(),
    });
    await ctx.db.patch(d.event._id, { status: "agents", situation: undefined });
    const summary = `Side ${d.side} vetoed ${plan}. Approvals were reset and the incident is back with the agents.`;
    await notifySides(ctx, d.event, d.event.requiredApprovalSides!, d.user._id, summary);
    await noteActor(ctx, d.event, d.user._id, summary);
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
  allRequiredApproved: v.boolean(), reviewRequired: v.boolean(),
  deciding: v.boolean(), turn: nullable(side),
  lastReset: nullable(v.object({ at: v.string(), reason: v.string() })),
  mySide: nullable(side), canAct: v.boolean(), myTurn: v.boolean(), simulated: v.boolean(),
});

/** "P2 · R2 · A approved · waiting for B" for one event. Assigned operators and heads of operations read. */
export const status = query({
  args: { eventId: v.id("events") },
  returns: approvalStatus,
  handler: async (ctx, { eventId }) => {
    const { user, event, owners } = await requireReader(ctx, eventId);
    const [selection, set] = await Promise.all([
      ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
      ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
    ]);
    const counted = await countingApprovals(ctx, event, selection);
    const decidable = !isResolved(event) && !!selection?.proposalId && (event.workflow === "bilateral" || event.workflow === "unilateral_debris");
    const turn = decidable ? turnOf(event, counted) : null;
    const deciding = turn !== null;
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
    const inputs = await decisionInputs(ctx, event, selection);
    const internal = event.workflow === "internal_review" || (!!owners[0] && owners[0].companyId === owners[1]?.companyId);
    const mySide = user.role === "demo_observer" || internal ? null
      : owners[0]?.companyId === user.companyId ? "A" as const : owners[1]?.companyId === user.companyId ? "B" as const : null;
    let canAct = false;
    const status = event.status ?? "new";
    if (inputs && event.tcaMs > Date.now() && user.role === "operator" && mySide && required.includes(mySide) && proposal && set?.state === "open" && event.active
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
      approvals, allRequiredApproved: allApproved(event, counted), reviewRequired: set?.reviewRequired ?? false, deciding, turn,
      lastReset: selection?.lastReset ? { at: isoUtc(selection.lastReset.at), reason: selection.lastReset.reason } : null,
      mySide, canAct, myTurn: canAct && deciding && turn === mySide, simulated: event.simulated,
    };
  },
});
