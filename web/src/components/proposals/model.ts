import type { Revision } from "@/lib/backend/types";
import { fmtWhen } from "@/lib/ops/format";
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

/* ---------------------------------------------------------------- real mode: a backend revision in the card's words */

const fuel = (kg: number) => (kg < 1 ? `${(kg * 1000).toFixed(1)} g fuel` : `${kg.toFixed(2)} kg fuel`);
const dv = (ms: number) => (ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

/**
 * What one backend revision proposes (wiring map §1.2 `Revision`), worded like the simulator's cards. Every number
 * is the revision's own; only the lead time before closest approach is derived, as the simulator does.
 */
export function revisionText(r: Revision, tcaMs: number) {
  const missKm = r.kind === "wait" ? (r.missAfterKm ?? r.missBeforeKm) : r.missAfterKm;
  const base = { miss: missKm === null ? null : missKm * 1000, from: r.missBeforeKm * 1000 };
  if (r.kind === "wait") return { ...base, verb: "Wait", who: null, by: null, meta: "No burn. The next conjunction message decides." };
  const burn = r.burnTimeUtc ? Date.parse(r.burnTimeUtc) : NaN;
  const lead = Number.isFinite(burn) && tcaMs > burn ? Math.round((tcaMs - burn) / 3600_000) : null;
  const when = Number.isFinite(burn) ? `Burn ${fmtWhen(burn)}${lead !== null ? `, ${lead} h before closest approach` : ""}` : "Burn time not set";
  return {
    ...base,
    verb: r.direction === "prograde" ? "Raise" : r.direction === "retrograde" ? "Lower" : "Move",
    who: r.movingSide === "A" ? ("a" as const) : r.movingSide === "B" ? ("b" as const) : null,
    by: r.deltaVMs === null ? null : `by ${dv(r.deltaVMs)} m/s`,
    meta: r.estimatedFuelKg === null ? when : `${when} · ${fuel(r.estimatedFuelKg)}`,
  };
}
