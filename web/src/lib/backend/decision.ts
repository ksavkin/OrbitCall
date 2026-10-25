import type { ApprovalStatus, DecisionArgs, Maneuver, ProposalCard } from "./types";

// Pure reads of the Decision Center state (wiring map §1.3, §1.4). No React, no store: every view shares them.

/** Readable text for `approvals.status.lastReset.reason` (wiring map §1.3 point 9). */
export function resetText(reason: string): string {
  switch (reason) {
    case "selection_changed":
      return "A new plan was selected";
    case "vetoed":
      return "Vetoed";
    case "revision_changed":
      return "A new revision was published";
    case "proposal_withdrawn":
      return "The plan was withdrawn";
    case "policy_changed":
    case "evidence_changed":
    case "candidate_set_changed":
      return "Inputs changed";
    case "assignment_revoked":
    case "assignment_changed":
    case "authorization_changed":
      return "Responsibility changed";
    case "event_expired":
      return "The encounter passed";
    default:
      return "Approvals were reset";
  }
}

/** The card the server holds as selected, joined to the card list (`selected` has no kind). */
export function selectedCard(status: ApprovalStatus | undefined, cards: ProposalCard[] | undefined): ProposalCard | null {
  const sel = status?.selected;
  if (!sel || !cards) return null;
  return cards.find((c) => c.proposalId === sel.proposalId) ?? null;
}

/** Approve and veto arguments: always the selection the server holds, never built from the card list. */
export function decisionArgs(status: ApprovalStatus | undefined): DecisionArgs | null {
  if (!status?.selected || status.approvalRuleVersion === null) return null;
  return {
    eventId: status.eventId,
    proposalId: status.selected.proposalId,
    revision: status.selected.revision,
    selectionGeneration: status.selectionGeneration,
    approvalRuleVersion: status.approvalRuleVersion,
  };
}

/**
 * The maneuver row for the current selection, or null. The newest row can belong to an older card, so match on
 * proposal and revision, not generation (a veto keeps the byte-identical diff).
 */
export function diffForSelection(m: Maneuver | null | undefined, status: ApprovalStatus | undefined): Maneuver | null {
  const sel = status?.selected;
  if (!m || !sel) return null;
  return m.refs.some((r) => r.proposalId === sel.proposalId && r.revision === sel.revision) ? m : null;
}
