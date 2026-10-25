import type { Candidate } from "./policies";
import type { EventFacts } from "./analyst";
import type { CandidatesResponse, ServiceCandidate } from "./orbit";

// Turns the orbital service's policy-free grid (up to 48 maneuvers + wait) into the at most four candidates
// candidates.publish accepts: the cheapest maneuver per side that keeps the pair apart, plus wait.
// The service orders its grid: passing the pair threshold first, then least Δv, largest miss, latest burn.

export const WAIT_REVIEW_CONDITION =
  "Review again when new element sets arrive or the miss distance changes; waiting is not a maneuver decision.";

type Unrevised = Omit<Candidate, "revision">;

function candidateId(c: ServiceCandidate): string {
  // The service's ids ("A:T-6h:+0.05") use characters publish refuses; this keeps them readable and stable.
  if (c.kind === "wait") return "wait";
  const mms = Math.round((c.deltaVMs ?? 0) * 1000);
  return `${c.movingSide}-T${c.leadH}h-${c.direction === "prograde" ? "pro" : "retro"}-${mms}mms`;
}

function label(c: ServiceCandidate, facts: EventFacts): string {
  if (c.kind === "wait") return "Wait";
  const object = c.movingSide === "A" ? facts.objectA : facts.objectB;
  return `${object.name.slice(0, 40)}: ${c.deltaVMs} m/s ${c.direction}, T−${c.leadH} h`.slice(0, 80);
}

export function selectCandidates(response: CandidatesResponse, facts: EventFacts): Unrevised[] {
  const tca = Date.parse(facts.tcaUtc);
  const usable = (c: ServiceCandidate) => c.kind === "maneuver" && c.passesPairThreshold && c.missAfterKm !== null &&
    c.burnTimeUtc !== null && Date.parse(c.burnTimeUtc) < tca && c.deltaVMs !== null && c.deltaVMs > 0 && c.direction !== null &&
    c.movingObjectId === (c.movingSide === "A" ? facts.objectA.objectId : facts.objectB.objectId);
  const picks: ServiceCandidate[] = [];
  for (const side of ["A", "B"] as const) {
    const best = response.candidates.find(c => c.movingSide === side && usable(c));
    if (best) picks.push(best);
  }
  const simulated = facts.simulated || response.simulated;
  const shared = [
    `Orbital service (${response.method}), snapshot ${response.snapshotId}: indicative SGP4 geometry on public mean elements, not flight-safety screening.`,
    `Service closest approach ${response.tcaUtc}, miss ${response.missBeforeKm} km before any maneuver; the event's figure is kept as the reference.`,
    ...response.assumptions,
  ].map(s => s.slice(0, 500));
  const maneuvers = picks.map((c): Unrevised => ({
    candidateId: candidateId(c), label: label(c, facts), kind: "maneuver",
    movingSide: c.movingSide, movingObjectId: c.movingObjectId, burnTimeUtc: c.burnTimeUtc,
    deltaVMs: c.deltaVMs, direction: c.direction,
    estimatedFuelKg: null,   // masses are private: each side's Advocate assesses fuel [POL-2]
    missBeforeKm: facts.missKm, missAfterKm: c.missAfterKm, indicative: true, reviewCondition: null,
    assumptions: [...shared, "Pair miss only: a whole-catalog re-screen runs before scheduling."].slice(0, 20),
    simulated: simulated || c.simulated,
  }));
  const wait: Unrevised = {
    candidateId: "wait", label: "Wait", kind: "wait",
    movingSide: null, movingObjectId: null, burnTimeUtc: null, deltaVMs: null, direction: null,
    estimatedFuelKg: null, missBeforeKm: facts.missKm, missAfterKm: null, indicative: true,
    reviewCondition: WAIT_REVIEW_CONDITION, assumptions: shared.slice(0, 20), simulated,
  };
  return [...maneuvers, wait];
}

// Candidate revisions are immutable: an unchanged candidate keeps its revision, a changed one gets the next.
export function assignRevisions(candidates: Unrevised[], latest: Record<string, Candidate | null>): Candidate[] {
  return candidates.map(c => {
    const previous = latest[c.candidateId];
    if (!previous) return { ...c, revision: 1 };
    const { revision, ...stored } = previous;
    const same = (Object.keys(c) as (keyof Unrevised)[]).every(key => JSON.stringify(c[key]) === JSON.stringify(stored[key]));
    return { ...c, revision: same ? revision : revision + 1 };
  });
}
