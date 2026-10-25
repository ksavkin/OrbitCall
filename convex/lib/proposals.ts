import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { advanceSelection, classifyIfUnset, resetApprovals } from "./approvals";

// Plan cards (spec §2.3 ProposalCard/Revision) mirrored from the candidate set: one proposals row per event and
// candidateId ("P1".."P4"), one proposalRevisions row per immutable candidate revision. The numbers stay in
// candidateRevisions. candidates.publish calls syncProposals in its own transaction, so a card exists exactly when
// its candidate is published.

/** Statuses before people decide: publishing options moves these to "proposal" (functionality §3). */
const BEFORE_PROPOSAL = new Set(["new", "agents"]);

export async function syncProposals(ctx: MutationCtx, event: Doc<"events">, candidateRevisionIds: Id<"candidateRevisions">[],
  options: { candidateSetChanged?: boolean; preserveDecision?: boolean; evidenceChanged?: boolean } = {}) {
  const now = Date.now();
  const offered = new Set<Id<"proposals">>();
  for (const id of candidateRevisionIds) {
    const card = (await ctx.db.get(id))!;
    const existing = await ctx.db.query("proposals").withIndex("by_event_candidate", q =>
      q.eq("eventId", event._id).eq("candidateId", card.candidateId)).first();
    const proposalId = existing?._id ?? await ctx.db.insert("proposals", {
      eventId: event._id, candidateId: card.candidateId, label: card.label, latestRevision: card.revision,
      demoRunId: event.demoRunId ?? null, createdAt: now,
    });
    if (existing && card.revision > existing.latestRevision) await ctx.db.patch(existing._id, { latestRevision: card.revision, label: card.label });
    const stored = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
      q.eq("proposalId", proposalId).eq("revision", card.revision)).unique();
    if (!stored) await ctx.db.insert("proposalRevisions", {
      proposalId, eventId: event._id, revision: card.revision, candidateRevisionId: id,
      changeSummary: null, sourceMessageIds: [], rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null,
      // A repair preserves the immutable candidate's time; repair time is not a new human decision input.
      simulated: card.simulated, createdAt: options.preserveDecision ? Math.floor(card._creationTime) : now,
    });
    offered.add(proposalId);
  }
  if (options.preserveDecision) return;
  const classified = await classifyIfUnset(ctx, event);
  if (BEFORE_PROPOSAL.has(classified.status ?? "new")) await ctx.db.patch(event._id, { status: "proposal" });
  // A new revision of the selected card, or its withdrawal, is a reset (spec §4.1); the selection follows the card.
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
  if (!selection?.proposalId) return;
  const selected = await ctx.db.get(selection.proposalId);
  if (!selected || !offered.has(selected._id)) await advanceSelection(ctx, classified, null, { kind: "agents" }, "proposal_withdrawn");
  else if (selected.latestRevision !== selection.revision) {
    await advanceSelection(ctx, classified, { proposalId: selected._id, revision: selected.latestRevision }, { kind: "agents" }, "revision_changed");
  } else if (options.candidateSetChanged !== false) {
    // The agreed comparison includes every offered option and its source evidence.
    await advanceSelection(ctx, classified, { proposalId: selected._id, revision: selected.latestRevision }, { kind: "agents" },
      options.evidenceChanged ? "evidence_changed" : "candidate_set_changed");
  }
}
