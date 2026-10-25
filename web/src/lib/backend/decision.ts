import type { ApprovalStatus, ConfigFlags, DecisionArgs, EventId, LogEntry, Maneuver, ProposalCard, RoomProjection } from "./types";

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

export type Gate = { ok: boolean; why: string | null };

const deciding = (s: ApprovalStatus) => (s.turn ? `Side ${s.turn} is deciding` : "The other side is deciding");

/**
 * Who may pick a card now (wiring map §1.3 point 3). Before the first selection `approvals.status.canAct` is always
 * false, so the pick gates on the room's linked event instead; with no room yet the mutation answers.
 */
export function selectGate(status: ApprovalStatus | undefined, room: RoomProjection | undefined, eventId: EventId): Gate {
  if (!status) return { ok: false, why: null };
  if (status.workflow === "internal_review") return { ok: false, why: "Internal review: scheduling is disabled" };
  if (status.deciding && !status.myTurn) return { ok: false, why: deciding(status) };
  const linked = room?.linkedEvents.find((e) => e.eventId === eventId);
  if (linked && !linked.canAct) return { ok: false, why: "Your side does not act on this incident" };
  return { ok: true, why: null };
}

export type DiffState = "not_needed" | "preparing" | "ready" | "stale" | "slow" | "failed";

/** How long a selection may wait for its diff before the screen says it is taking too long (wiring map §1.4 point 4). */
export const DIFF_SLOW_MS = 90_000;

/**
 * The schedule diff of the selected card (wiring map §1.4). `waitingSince` is when this screen first saw the current
 * selection without a diff, or null. Wait cards and deployments without the Factory worker never wait for one.
 */
export function diffState(a: {
  flags: ConfigFlags | undefined;
  status: ApprovalStatus | undefined;
  cards: ProposalCard[] | undefined;
  maneuver: Maneuver | null | undefined;
  log: LogEntry[] | undefined;
  now: number;
  waitingSince: number | null;
}): DiffState {
  const card = selectedCard(a.status, a.cards);
  if (!card || card.latest.kind === "wait") return "not_needed";
  const m = diffForSelection(a.maneuver, a.status);
  if (m?.diff) return m.status === "preview" && m.reviewRequired ? "stale" : "ready";
  if (card.latest.schedulePreviewDiff) return "ready";
  if (a.flags && !a.flags.droid) return "not_needed";
  const failed = a.log?.some(
    (l) => l.action === "schedule_failed" && l.proposalId === card.proposalId && (l.revision === null || l.revision === card.latest.revision),
  );
  if (failed) return "failed";
  if (a.waitingSince !== null && a.now - a.waitingSince > DIFF_SLOW_MS) return "slow";
  return "preparing";
}

/** The diff text to render for the selection: the matching maneuver row's, else the revision's own. */
export function selectionDiff(status: ApprovalStatus | undefined, cards: ProposalCard[] | undefined, m: Maneuver | null | undefined): string | null {
  return diffForSelection(m, status)?.diff ?? selectedCard(status, cards)?.latest.schedulePreviewDiff ?? null;
}

/**
 * Approve and veto (wiring map §1.3 point 4, §1.4). Approve waits for the diff only when `config.flags` says the worker
 * is configured; while the flags are unknown it stays clickable but secondary. Veto never waits for the diff.
 */
export function decideGate(status: ApprovalStatus | undefined, diff: DiffState, flags: ConfigFlags | undefined): { approve: Gate & { secondary: boolean }; veto: Gate } {
  const no = (why: string | null) => ({ approve: { ok: false, why, secondary: false }, veto: { ok: false, why } });
  if (!status?.selected) return no("Select a plan first");
  if (status.approvalRuleVersion === null) return no("Classifying the incident");
  if (status.requiredApprovalSides.length === 0) return no("Internal review: scheduling is disabled");
  if (status.allRequiredApproved) return no(null);
  if (!status.myTurn) return no(status.deciding ? deciding(status) : null);
  const veto = { ok: true, why: null };
  if (diff === "failed") return { approve: { ok: false, why: "The schedule diff failed. Select the plan again to retry.", secondary: false }, veto };
  if (diff === "preparing" || diff === "slow" || diff === "stale") {
    const why = diff === "stale" ? "Inputs changed; the diff will be prepared again" : "Preparing the schedule diff…";
    return { approve: flags?.droid ? { ok: false, why, secondary: false } : { ok: true, why, secondary: true }, veto };
  }
  return { approve: { ok: true, why: null, secondary: false }, veto };
}

/** "Your turn to decide" / "Side B is deciding"; null before a selection, when nobody is deciding, or once agreed. */
export function turnText(status: ApprovalStatus | undefined): string | null {
  if (!status?.selected || status.allRequiredApproved) return null;
  if (status.myTurn) return "Your turn to decide";
  return status.deciding ? deciding(status) : null;
}

/** "P2 · R2 · A approved · waiting for B" (spec §3.4). One required side never reads "Both approved". */
export function statusLine(status: ApprovalStatus | undefined): string | null {
  const sel = status?.selected;
  if (!status || !sel) return null;
  const parts = [sel.label, `R${sel.revision}`];
  if (status.allRequiredApproved) parts.push(status.requiredApprovalSides.length > 1 ? "Both approved" : "Approved");
  else {
    for (const side of status.requiredApprovalSides) if (status.approvals[side]?.status === "approved") parts.push(`${side} approved`);
    if (status.turn) parts.push(`waiting for ${status.turn}`);
  }
  return parts.join(" · ");
}

/** Debris and internal review notes (wiring map §1.3 points 7-8, user-flow §5). */
export function workflowNote(status: ApprovalStatus | undefined): string | null {
  if (status?.workflow === "unilateral_debris") return "Single-operator avoidance: debris has no operator";
  if (status?.workflow === "internal_review") return "Internal review: scheduling is disabled";
  return null;
}
