"use client";

import { AnimatePresence, motion } from "motion/react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Chip } from "@/components/ui/Chip";
import { Tooltip } from "@/components/ui/Tooltip";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { AdvocatesView, CardRationale as RationaleRow, Evaluation, ProposalCard, ProposalId, Side } from "@/lib/backend/types";

// What the agents say about each plan card in real mode. Only a checked explanation reaches a card (AGT-5); feasibility
// and the recommendation are each side's Advocate's, shared as an outcome and policy areas only (AGT-3). Everything here
// renders spans, so it can sit inside the plan card's row button. Nothing renders in dev mode or while loading.

const EASE = [0.22, 1, 0.36, 1] as const;

/** The card's candidate and current revision: from proposals.list, else from lib.rationale.list (wiring map §5.3). */
function cardRef(cards: ProposalCard[] | undefined, rows: RationaleRow[] | undefined, proposalId: ProposalId) {
  const card = cards?.find((c) => c.proposalId === proposalId);
  if (card) return { candidateId: card.latest.candidateId, revision: card.latest.revision };
  const row = rows?.find((r) => r.proposalId === proposalId);
  return row ? { candidateId: row.candidateId, revision: row.revision } : null;
}

/**
 * The checked explanation for this proposal and revision. Once lib.rationale.list has loaded it decides alone: it
 * withholds an explanation whose evidence or responsibility changed, which the card's own copy does not.
 */
function checkedRationale(rows: RationaleRow[] | undefined, cards: ProposalCard[] | undefined, proposalId: ProposalId, revision: number) {
  if (rows) {
    const r = rows.find((x) => x.proposalId === proposalId && x.revision === revision)?.rationale;
    return r?.numbersChecked ? r : null;
  }
  const card = cards?.find((c) => c.proposalId === proposalId);
  return card?.latest.revision === revision ? card.latest.rationale : null;
}

/** The checked rationale on one card, and the independent check when it disagrees (wiring map §5.2, AGT-6). */
export function CardRationale({ proposalId, revision }: { proposalId: ProposalId; revision: number }) {
  const real = useRealMode();
  const rows = useLive((s) => s.rationale);
  const cards = useLive((s) => s.proposals);
  const r = real ? checkedRationale(rows, cards, proposalId, revision) : null;
  const disagrees = r?.secondModel?.agrees === false ? r.secondModel.note : null;
  return (
    <AnimatePresence initial={false}>
      {r && (
        <motion.span
          key="rationale"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="block overflow-hidden"
        >
          <span className="mt-1 block text-[12.5px] leading-[1.5] text-neutral-500">{r.text}</span>
          {disagrees !== null && (
            <span className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-[1.45] text-orange">
              <TriangleAlert size={11} className="mt-[3px] shrink-0" />
              <span>Independent check disagrees: {disagrees}</span>
            </span>
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

const OUTCOME: Record<Evaluation["outcome"], { label: string; color: string; says: string }> = {
  preferred: { label: "Preferred", color: "var(--green)", says: "finds this plan feasible and prefers it" },
  feasible: { label: "Feasible", color: "var(--green)", says: "finds this plan feasible" },
  infeasible: { label: "Not feasible", color: "var(--red)", says: "rules this plan out" },
  // pending is unresolved evidence (every maneuver's risk check in Phase 1), never a rejection or an approval
  pending: { label: "Pending", color: "var(--muted)", says: "has open checks on this plan" },
};

const AREA: Record<string, string> = { fuel: "fuel", mission_window: "mission window", risk: "risk", priority: "mission priority", other: "other" };

/** Each side's assessment of this card's current revision; one made for an older revision is not shown. */
function assessed(view: AdvocatesView, ref: { candidateId: string; revision: number }) {
  return (["A", "B"] as const).flatMap((side) => {
    const e = view.assessments[side].find((x) => x.candidateId === ref.candidateId && x.revision === ref.revision);
    return e && OUTCOME[e.outcome] ? [{ side, e }] : [];
  });
}

/** Per-side feasibility and "Recommended by A/B" on one card (wiring map §5.3). Hidden for a head of ops (FORBIDDEN). */
export function AdvocateChips({ proposalId, className = "" }: { proposalId: ProposalId; className?: string }) {
  const real = useRealMode();
  const view = useLive((s) => s.advocates);
  const cards = useLive((s) => s.proposals);
  const rows = useLive((s) => s.rationale);
  const mySide = useLive((s) => s.approvals?.mySide ?? null);
  const ref = cardRef(cards, rows, proposalId);
  const sides = real && view && ref ? assessed(view, ref) : [];
  const recommendedBy = sides.filter((s) => s.e.recommended).map((s) => s.side);
  return (
    <AnimatePresence initial={false}>
      {sides.length > 0 && (
        <motion.span
          key="advocates"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}
        >
          {sides.map(({ side, e }) => (
            <SideChip key={side} side={side} e={e} mine={side === mySide} />
          ))}
          {recommendedBy.length > 0 && (
            <span className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]">
              Recommended by {recommendedBy.join(" and ")}
            </span>
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function SideChip({ side, e, mine }: { side: Side; e: Evaluation; mine: boolean }) {
  const o = OUTCOME[e.outcome];
  const areas = e.categories.map((c) => AREA[c] ?? String(c).replace(/_/g, " ")).join(", ");
  return (
    <Tooltip
      side="top"
      label={
        <span>
          {mine ? "Your Advocate" : `Side ${side}'s Advocate`} {o.says}
          {areas && <span className="text-muted"> · {areas}</span>}
        </span>
      }
    >
      <Chip color={o.color} size="sm">
        <span className="mono font-semibold">{side}</span>
        {o.label}
      </Chip>
    </Tooltip>
  );
}

const SITUATION: Record<AdvocatesView["situation"], string> = {
  scheduled_review_required: "Something changed after a plan was decided. A person needs to review it.",
  stale_candidates: "The evidence changed since these plans were computed.",
  no_candidates: "No plans have been computed yet.",
  awaiting_advocates: "Waiting for the Advocates to check the plans.",
  needs_operator_decision: "At least one plan is acceptable to every side.",
  needs_more_data: "No plan is confirmed by every side yet. Some checks are still open.",
  no_mutually_acceptable_option: "No plan is acceptable to every side.",
};

function situationText(v: AdvocatesView): string {
  // waiting on a side whose last run failed is not progress: name it instead of "waiting"
  const failed = v.situation === "awaiting_advocates" ? (["A", "B"] as const).filter((s) => v.runs[s]?.status === "failed") : [];
  if (failed.length === 2) return "Neither Advocate could finish its check.";
  if (failed.length === 1) return `Side ${failed[0]}'s Advocate could not finish its check.`;
  return SITUATION[v.situation] ?? String(v.situation).replace(/_/g, " ");
}

/** advocates.situation as the panel subtitle (AGT-3), with the agents' working or stalled state. */
export function AdvocatesSituation({ className = "" }: { className?: string }) {
  const real = useRealMode();
  const view = useLive((s) => s.advocates);
  if (!real || !view) return null;
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-neutral-500 ${className}`}>
      <motion.span key={view.situation} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE }}>
        {situationText(view)}
      </motion.span>
      {view.agentsStalled ? (
        <Tooltip side="top" label="An agent has made no progress for over 60 s">
          <Chip color="var(--orange)" size="sm" icon={<TriangleAlert size={9} />}>
            Agents stalled
          </Chip>
        </Tooltip>
      ) : (
        view.agentsWorking && (
          <Chip color="var(--blue)" size="sm" icon={<Loader2 size={9} className="animate-spin" />}>
            Agents working
          </Chip>
        )
      )}
    </span>
  );
}
