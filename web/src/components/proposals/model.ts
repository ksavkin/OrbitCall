import type { ConjunctionEvent, DecisionOption } from "@/lib/ops/types";

// Proposal cards as the room shows them (spec §2.3 ProposalCard, §4.1): a label per card, the shared
// selection with its revision and generation, and the approvals that count for that selection only.

export interface Card {
  option: DecisionOption;
  label: string;
  selected: boolean;
}

export function cardsOf(e: ConjunctionEvent): Card[] {
  const sel = e.selection?.optionId;
  return (e.options ?? []).slice(0, 4).map((o, i) => ({ option: o, label: `P${i + 1}`, selected: o.id === sel }));
}

/** The selected card's revision: how many published versions of that same move exist up to now. */
export function revisionOf(e: ConjunctionEvent, o: DecisionOption | undefined) {
  if (!o) return 1;
  return Math.max(1, (e.proposals ?? []).filter((p) => p.mover === o.mover && p.action === o.action).length);
}

/** Sides whose approval the workflow requires: both for two operators, only A when B is debris. */
export function requiredSides(e: ConjunctionEvent): ("a" | "b")[] {
  return e.b.kind === "debris" ? ["a"] : ["a", "b"];
}
