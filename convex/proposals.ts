import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireParty, requireReader } from "./lib/operatorAccess";
import { advanceSelection, classifyIfUnset, countingApprovals, currentEvidence, turnOf } from "./lib/approvals";
import { isResolved } from "./lib/decision";
import { isoUtc } from "./lib/events";
import { side } from "./lib/policyValidators";
import { logDecision, noteActor, notifySides } from "./approvals";

// The Decision Center's plan cards and the shared selection (user-flow "App navigation and the decision flow",
// spec §3.4 proposals.list and rooms.select, ROOM-5, ROOM-11). The spec names the mutation rooms.select; as with
// fleetQuery.ts (issue #6) this file hosts it, so the client calls api.proposals.select. The decision belongs to the
// event, not to the room. Selecting is not approving: it only advances the generation approvals bind to, and a
// changed selection resets every current approval.

const revisionView = v.object({
  proposalId: v.id("proposals"), label: v.string(), revision: v.number(), createdAt: v.string(),
  kind: v.union(v.literal("maneuver"), v.literal("wait")),
  movingSide: v.union(side, v.null()), movingObjectId: v.union(v.string(), v.null()),
  burnTimeUtc: v.union(v.string(), v.null()), deltaVMs: v.union(v.number(), v.null()),
  direction: v.union(v.literal("prograde"), v.literal("retrograde"), v.null()),
  estimatedFuelKg: v.union(v.number(), v.null()), missBeforeKm: v.number(), missAfterKm: v.union(v.number(), v.null()),
  indicative: v.literal(true), assumptions: v.array(v.string()), simulated: v.boolean(),
  candidateId: v.string(), changeSummary: v.union(v.string(), v.null()), sourceMessageIds: v.array(v.id("messages")),
  // Only a checked explanation reaches a card (AGT-5); the schedule diff is the one prepared for this revision (ROOM-9).
  rationale: v.union(v.object({ text: v.string(), numbersChecked: v.literal(true),
    secondModel: v.union(v.object({ agrees: v.boolean(), note: v.string() }), v.null()) }), v.null()),
  schedulePreviewDiff: v.union(v.string(), v.null()),
});
export const proposalCard = v.object({
  proposalId: v.id("proposals"), label: v.string(), latest: revisionView, revisionCount: v.number(), isSelected: v.boolean(),
});

/** Up to four cards of the current candidate set, in its order. Feasibility and rationale come from their own queries. */
export const list = query({
  args: { eventId: v.id("events") },
  returns: v.array(proposalCard),
  handler: async (ctx, { eventId }) => {
    await requireReader(ctx, eventId);
    const [set, selection] = await Promise.all([
      ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
      ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique(),
    ]);
    if (!set) return [];
    return Promise.all(set.candidateRevisionIds.map(async id => {
      const card = await ctx.db.get(id);
      const proposal = card && await ctx.db.query("proposals").withIndex("by_event_candidate", q =>
        q.eq("eventId", eventId).eq("candidateId", card.candidateId)).first();
      const revisions = proposal ? await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", proposal._id)).collect() : [];
      const revision = revisions.find(r => r.candidateRevisionId === id);
      if (!card || !proposal || !revision) throw new ConvexError({ code: "NOT_FOUND", message: "Candidate evidence is incomplete." });
      return {
        proposalId: proposal._id, label: proposal.label, revisionCount: revisions.length,
        isSelected: selection?.proposalId === proposal._id && selection.revision === card.revision,
        latest: {
          proposalId: proposal._id, label: proposal.label, revision: card.revision, createdAt: isoUtc(revision.createdAt),
          kind: card.kind, movingSide: card.movingSide, movingObjectId: card.movingObjectId, burnTimeUtc: card.burnTimeUtc,
          deltaVMs: card.deltaVMs, direction: card.direction, estimatedFuelKg: card.estimatedFuelKg, missBeforeKm: card.missBeforeKm,
          missAfterKm: card.missAfterKm, indicative: card.indicative, assumptions: card.assumptions, simulated: card.simulated,
          candidateId: card.candidateId, changeSummary: revision.changeSummary, sourceMessageIds: revision.sourceMessageIds,
          rationale: revision.rationale?.numbersChecked ? { text: revision.rationale.text, numbersChecked: true as const, secondModel: revision.rationale.secondModel } : null,
          schedulePreviewDiff: revision.schedulePreviewDiff,
        },
      };
    }));
  },
});

const invalid = () => new ConvexError({ code: "VALIDATION", message: "Revision or generation is invalid." });

/** spec rooms.select: selects an existing card for shared review; re-selecting the current card changes nothing. */
export const select = mutation({
  args: { eventId: v.id("events"), proposalId: v.id("proposals"), revision: v.number(), expectedGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, { eventId, proposalId, revision, expectedGeneration }) => {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw invalid();
    const { user, candidateSet: set, side } = await requireParty(ctx, eventId);
    const event = await classifyIfUnset(ctx, (await ctx.db.get(eventId))!);
    if (set.state !== "open" || isResolved(event)) throw new ConvexError({ code: "INVALID_STATE", message: "This plan is decided; its selection can no longer change." });
    // While a decision is open only the side in turn acts, selection included (voice selects, user-flow points 6-7).
    const row = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const counted = row?.proposalId ? await countingApprovals(ctx, event, row) : new Map();
    const turn = row?.proposalId ? turnOf(event, counted) : null;
    if (turn !== null && turn !== side) throw new ConvexError({ code: "INVALID_STATE", message: `It is side ${turn}'s turn to decide.` });
    if (!await currentEvidence(ctx, event, set)) throw new ConvexError({ code: "STALE_REVISION", message: "The incident's evidence changed; wait for recomputed candidates." });
    if ((row?.generation ?? 0) !== expectedGeneration) throw new ConvexError({ code: "STALE_REVISION", message: "Selection changed; reload it before selecting." });
    const proposal = await ctx.db.get(proposalId);
    if (!proposal || proposal.eventId !== eventId) throw new ConvexError({ code: "NOT_FOUND", message: "Proposal not found." });
    const stored = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", proposalId).eq("revision", revision)).unique();
    if (revision !== proposal.latestRevision || !stored || !set.candidateRevisionIds.includes(stored.candidateRevisionId)) {
      throw new ConvexError({ code: "STALE_REVISION", message: "This card has a newer revision or is no longer offered; reload it." });
    }
    // Re-clicking the current card must not advance the generation, or it would reset approvals for no change.
    if (row?.proposalId === proposalId && row.revision === revision) return null;
    // The expectedGeneration check above makes the next generation known before the selection advances.
    await logDecision(ctx, event, user, side, "selected", { proposalId, revision }, `Side ${side} selected ${proposal.label} revision ${revision}.`,
      { generation: expectedGeneration }, { generation: expectedGeneration + 1 });
    await advanceSelection(ctx, event, { proposalId, revision }, { kind: "human", userId: user._id }, "selection_changed");
    // Every operator of a required side hears of a changed selection, including the selector's colleagues: it opens
    // (or restarts) the decision, side A first. The selector's existing row gets the same summary and stays read;
    // a missing row is not created. Internal reviews have no required side and leave no notice. One sentence,
    // because a notice replaces the previous one.
    const first = turnOf(event, new Map());
    if (first) {
      const reset = counted.size > 0 ? " Earlier approvals were reset." : "";
      const summary = `Side ${side} selected ${proposal.label} revision ${revision} for decision.${reset} Side ${first} decides first.`;
      await notifySides(ctx, event, event.requiredApprovalSides ?? [], user._id, summary);
      await noteActor(ctx, event, user._id, summary);
    }
    return null;
  },
});
