import { ConvexError } from "convex/values";
import { inputKey, type EventFacts } from "./analyst";
import { mapCandidates, type CardContext, type OrbitCandidatesResponse, type StoredCandidate } from "./candidateCards";
import { orbitFailure, OrbitServiceError, type CandidatesResponse, type ServiceCandidate } from "./orbitClient";
import type { Candidate, Side } from "./policies";
import type { Id } from "../_generated/dataModel";

// Pure glue between the orbit service's real /candidates answer and the advocate tables. The card mapper keeps its
// own guarantees (at most four cards, wait keeps its slot, debris side rule, revisions against stored history,
// invalid geometry dropped); this file only adapts the service shape to it and names the publish outcomes.

export type SkipReason =
  | "ORBIT_NOT_CONFIGURED" | "NOT_FOUND" | "EVENT_INACTIVE" | "SET_NOT_OPEN" | "WORKFLOW_UNSUPPORTED" | "OMM_SNAPSHOT_UNKNOWN" | "DEMO_RUN_CLOSED";
export type PublishOutcome =
  | { status: "published"; version: number; changed: boolean; cards: number; sharedMoverEventIds: string[] }
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; code: string; message: string };

/** A moving object that is also an object of other active events linked in the same open room. */
export interface SharedMover { objectId: string; eventIds: string[] }

// Everything the action needs, read in one query. Debris never moves: only operator-owned objects are allowed movers.
export interface PublishInput {
  facts: EventFacts;
  evidenceKey: string;                // inputKey(facts), pinned into candidates.publish
  eventSnapshotId: string;            // the event's stored snapshot, pinned into candidates.publish
  snapshotId: string;                 // the OMM snapshot the orbit service holds
  evidenceVersion: string;
  demoRunId: Id<"demoRuns"> | null;
  activeSide: Side;
  counterpartSide: Side | null;
  allowedMovingObjectIds: string[];
  baseVersion: number | null;
  previous: StoredCandidate[];
  currentCards: { candidateId: string; revision: number }[];
  sharedMovers: SharedMover[];
}

// The v1 cards require the event's baseline. Do not splice materially different SOCRATES/OMM results into one
// before/after comparison. These tolerances cover one output rounding unit in the landed screen/candidates
// service (three decimals for km and km/s; whole-second UTC), not an orbital accuracy or uncertainty estimate.
export const GEOMETRY_TOLERANCE_KM = 0.001;
const SPEED_TOLERANCE_KM_S = 0.001;
const TCA_TOLERANCE_MS = 1_000;
const ROUNDING_EPSILON = 1e-9;
const PAIR_THRESHOLD_KM = 1;

const WAIT_REVIEW = "Reassess when new orbital evidence or a new screening result arrives.";
export const FEWER_OPTIONS = "Some burns could not be computed or an object cannot move; fewer options are shown.";
// candidates.py counts the grid burns already before notBeforeUtc; the count moves with the clock, not the geometry.
const TIME_VARYING = [/^\d+ grid burns? fall before notBeforeUtc\b/];
const MAX_ASSUMPTIONS = 20;
const MAX_TEXT = 500;

// cyrb53: a short, stable digest; the evidence version only needs to change when the evidence does.
function digest(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The evidence generation sent to the service and echoed back: a digest of the evidence key candidate sets store. */
export const evidenceVersionOf = (facts: EventFacts) => `ev-${digest(inputKey(facts))}`;

// Events loaded from SOCRATES keep the SOCRATES snapshot ID; the orbit service holds the pinned GP OMM snapshot whose
// catalog the web app serves at ommUrl ("/snapshots/gp-20261024T2134Z/catalog.json"). Fixtures keep their own ID.
const OMM_SEGMENT = /(?:^|\/)(gp-\d{8}T\d{4}(?:\d{2})?Z)\/[^/]+$/;
export function ommSnapshotId(snapshot: { snapshotId: string; ommUrl?: string }): string | null {
  if (snapshot.snapshotId.startsWith("fixture:")) return snapshot.snapshotId;
  return snapshot.ommUrl?.match(OMM_SEGMENT)?.[1] ?? null;
}

/** Whole seconds, as the orbit client requires. */
export const wholeSecondUtc = (ms: number, round: (x: number) => number = Math.round) =>
  new Date(round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

// Every grid point must use the same computed baseline, including those not selected for a card.
export const geometryMatches = (response: CandidatesResponse, facts: EventFacts) =>
  Math.abs(response.missBeforeKm - facts.missKm) <= GEOMETRY_TOLERANCE_KM + ROUNDING_EPSILON &&
  Math.abs(response.relSpeedKmS - facts.relSpeedKmS) <= SPEED_TOLERANCE_KM_S + ROUNDING_EPSILON &&
  Math.abs(Date.parse(response.tcaUtc) - Date.parse(facts.tcaUtc)) <= TCA_TOLERANCE_MS &&
  response.candidates.every(c => c.missBeforeKm === response.missBeforeKm) &&
  response.wait.passesPairThreshold === (facts.missKm >= PAIR_THRESHOLD_KM);

// Policy-free choice from the ranked grid: maneuvers that clear the pair threshold and widen the miss, the cheapest
// one per moving side first, then the rest in service rank order. The mapper keeps the first valid ones, so this
// order decides which three maneuvers accompany the wait card. A grid with no such maneuver yields wait only.
function chooseOrder(response: CandidatesResponse, nowMs: number): ServiceCandidate[] {
  const useful = response.candidates.filter(c => c.kind === "maneuver" && c.passesPairThreshold &&
    c.missAfterKm !== null && c.missAfterKm > response.missBeforeKm && Date.parse(c.burnTimeUtc!) > nowMs);
  const firstPerSide = useful.filter((c, i) => useful.findIndex(p => p.movingSide === c.movingSide) === i);
  return [...firstPerSide, ...useful.filter(c => !firstPerSide.includes(c))];
}

const sharedLine = (eventIds: string[]) =>
  `This spacecraft is also in linked incident(s) ${eventIds.join(", ")}; one burn must be authorized through a single trajectory plan.`;

/** Adapts the service's /candidates answer to the card mapper's input. The service echoes the pair, snapshot and
 *  evidence version (checked by the orbit client) but not the event, so the caller's event ID is the echo. Card
 *  assumptions are stable across calls, so an unchanged geometry keeps its revision. */
export function toCardResponse(response: CandidatesResponse, eventId: string, nowMs: number, sharedMovers: SharedMover[] = []): OrbitCandidatesResponse {
  const base = response.assumptions.filter(text => !TIME_VARYING.some(pattern => pattern.test(text)));
  const fewer = response.failed.length > 0 || response.notMovable.length > 0 ? [FEWER_OPTIONS] : [];
  const assumptionsFor = (c: ServiceCandidate) => {
    const shared = sharedMovers.find(m => m.objectId === c.movingObjectId);
    const extras = [
      `Orbit calculation: snapshot ${response.snapshotId}; baseline miss ${response.missBeforeKm} km at ${response.tcaUtc}; relative speed ${response.relSpeedKmS} km/s.`,
      ...(c.kind === "maneuver" ? [`Computed maneuver closest approach: ${c.tcaAfterUtc}; relative speed ${c.relSpeedKmS} km/s. The miss distances are indicative and do not establish a collision probability reduction.`] : []),
      `Method: ${response.method}`, ...fewer, ...(shared ? [sharedLine(shared.eventIds)] : []),
    ];
    return [...base.slice(0, MAX_ASSUMPTIONS - extras.length), ...extras].map(text => text.slice(0, MAX_TEXT));
  };
  const card = (c: ServiceCandidate): OrbitCandidatesResponse["candidates"][number] => ({
    kind: c.kind, movingObjectId: c.movingObjectId, burnTimeUtc: c.burnTimeUtc, direction: c.direction, deltaVMs: c.deltaVMs,
    // Always null from the service: mass and Isp are private, so each Advocate settles fuel itself.
    estimatedFuelKg: null, missAfterKm: c.missAfterKm,
    reviewCondition: c.kind === "wait" ? WAIT_REVIEW : null, assumptions: assumptionsFor(c),
  });
  return {
    eventId, evidenceVersion: response.evidenceVersion, snapshotId: response.snapshotId, simulated: response.simulated,
    candidates: [...chooseOrder(response, nowMs), response.wait].map(card),
  };
}

export function cardsFor(response: CandidatesResponse, input: PublishInput, eventId: string, nowMs: number): Candidate[] {
  const context: CardContext = {
    facts: input.facts, activeSide: input.activeSide, counterpartSide: input.counterpartSide, previous: input.previous, nowMs,
    eventId, evidenceVersion: input.evidenceVersion, snapshotId: input.snapshotId,
  };
  // Both baselines may differ by one rounding unit. A card must widen the stored baseline too, otherwise its
  // own displayed before/after values can suggest an improvement that the rounded numbers do not establish.
  const comparable = { ...response, candidates: response.candidates.filter(c => c.missAfterKm !== null && c.missAfterKm > input.facts.missKm) };
  return mapCandidates(toCardResponse(comparable, eventId, nowMs, input.sharedMovers), context);
}

/** The linked events whose mover appears on a published card, sorted. */
export function sharedMoverEventIds(cards: Candidate[], sharedMovers: SharedMover[]): string[] {
  const moving = new Set(cards.map(c => c.movingObjectId));
  return [...new Set(sharedMovers.filter(m => moving.has(m.objectId)).flatMap(m => m.eventIds))].sort();
}

/** True when the current set already holds exactly these card revisions (a concurrent identical publication). */
export const sameCards = (cards: Candidate[], current: PublishInput["currentCards"]) =>
  cards.length === current.length && cards.every((c, i) => c.candidateId === current[i].candidateId && c.revision === current[i].revision);

/** Exact, deterministic constraints extracted from original human lines, never from translated/model prose.
 * Unsupported language stays a clarification; it is not permission to discard a hard constraint. */
export type DiscussionConstraint =
  | { objectId: string; kind: "only_mover" | "cannot_move" }
  | { objectId: string; kind: "after" | "before"; timeMs: number }
  | { objectId: string; kind: "blocked_window"; startMs: number; endMs: number }
  | { objectId: string; kind: "min_delta_v" | "max_delta_v"; deltaVMs: number }
  | { objectId: string; kind: "direction"; direction: "prograde" | "retrograde" };

const UTC = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)";
const DECIMAL = "(\\d+(?:\\.\\d+)?)";
const clarify = (): never => { throw new ConvexError({ code: "CLARIFICATION_REQUIRED",
  message: "Clarify the requested mover, UTC burn window, delta-v in m/s or prograde/retrograde direction. The existing options have not changed." }); };
function utcMs(text: string): number {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || wholeSecondUtc(ms) !== text) return clarify();
  return ms;
}

/** A deliberately small whole-clause grammar. Partial regex matches would lose negations and exceptions.
 * Multiple independent clauses use semicolons. Dates must include the date, seconds and UTC Z; relative or
 * local times, translations, hypotheticals, mixed prose and unsupported constraints require clarification. */
export function parseDiscussionConstraints(text: string, objectId: string, pair: string[]): DiscussionConstraint[] {
  if (text.length > 2000 || !pair.includes(objectId)) return clarify();
  const clauses = text.trim().replace(/[.!]$/, "").split(/\s*;\s*/);
  if (!clauses.length || clauses.length > 8 || clauses.some(c => !c)) return clarify();
  return clauses.map(original => {
    const clause = original.trim().replace(/^(?:please |we |i |our spacecraft )/i, "");
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^move ([A-Za-z0-9-]+) only$/i)) || (m = clause.match(/^only ([A-Za-z0-9-]+) (?:may|can) (?:move|maneuver)$/i))) {
      // A company states its own restrictions. It cannot impose an exclusive maneuver on someone else's object.
      if (m[1] !== objectId) return clarify();
      return { objectId, kind: "only_mover" };
    }
    if (/^(?:cannot|can't) (?:move|maneuver)$/i.test(clause)) return { objectId, kind: "cannot_move" };
    if ((m = clause.match(new RegExp(`^(?:burn after|maneuver after|cannot maneuver before|can't maneuver before) ${UTC}$`, "i")))) {
      return { objectId, kind: "after", timeMs: utcMs(m[1]) + (/^(?:burn|maneuver) after/i.test(clause) ? 1 : 0) };
    }
    if ((m = clause.match(new RegExp(`^(?:burn before|maneuver before|cannot maneuver after|can't maneuver after) ${UTC}$`, "i")))) {
      return { objectId, kind: "before", timeMs: utcMs(m[1]) - (/^(?:burn|maneuver) before/i.test(clause) ? 1 : 0) };
    }
    if ((m = clause.match(new RegExp(`^(?:cannot|can't) maneuver between ${UTC} and ${UTC}$`, "i")))) {
      const startMs = utcMs(m[1]), endMs = utcMs(m[2]);
      if (endMs <= startMs) return clarify();
      return { objectId, kind: "blocked_window", startMs, endMs };
    }
    if ((m = clause.match(new RegExp(`^delta-v (at most|at least) ${DECIMAL} m/s$`, "i")))) {
      const deltaVMs = Number(m[2]);
      if (!Number.isFinite(deltaVMs) || deltaVMs <= 0) return clarify();
      return { objectId, kind: m[1].toLowerCase() === "at most" ? "max_delta_v" : "min_delta_v", deltaVMs };
    }
    if ((m = clause.match(/^(?:use|prefer) (prograde|retrograde)(?: direction)?$/i))) {
      return { objectId, kind: "direction", direction: m[1].toLowerCase() as "prograde" | "retrograde" };
    }
    return clarify();
  });
}

/** Filter the full numerical grid BEFORE chooseOrder/mapCandidates truncate to four cards. Wait retains its
 * slot and never counts as approval; constraints concern maneuvers and do not manufacture a safe wait outcome. */
export function filterDiscussionGrid(response: CandidatesResponse, constraints: DiscussionConstraint[]): CandidatesResponse {
  return { ...response, candidates: response.candidates.filter(c => constraints.every(rule => {
    if (rule.kind === "only_mover") return c.movingObjectId === rule.objectId;
    if (c.movingObjectId !== rule.objectId) return true;
    switch (rule.kind) {
      case "cannot_move": return false;
      case "after": return Date.parse(c.burnTimeUtc!) >= rule.timeMs;
      case "before": return Date.parse(c.burnTimeUtc!) <= rule.timeMs;
      case "blocked_window": return Date.parse(c.burnTimeUtc!) < rule.startMs || Date.parse(c.burnTimeUtc!) > rule.endMs;
      case "max_delta_v": return c.deltaVMs! <= rule.deltaVMs;
      case "min_delta_v": return c.deltaVMs! >= rule.deltaVMs;
      case "direction": return c.direction === rule.direction;
    }
  })) };
}

/** Changed discussion is part of the immutable revision's assumptions. A requested card retains its identity
 * when replaced by a newly calculated burn; earlier published revisions and their decisions stay historical. */
export function discussionCards(response: CandidatesResponse, input: PublishInput, eventId: string, nowMs: number,
  constraints: DiscussionConstraint[], targetCandidateId: string | null, discussionKey: string): Candidate[] {
  const cards = cardsFor(filterDiscussionGrid(response, constraints), input, eventId, nowMs);
  // Preserve identities assigned by an earlier discussion revision even when a subsequent Host request merely
  // repeats the same restriction without naming a card. Otherwise each follow-up would create another plan.
  for (const card of cards) {
    const current = input.previous.find(p => input.currentCards.some(c => c.candidateId === p.candidateId && c.revision === p.revision) &&
      p.kind === card.kind && p.movingObjectId === card.movingObjectId && p.burnTimeUtc === card.burnTimeUtc &&
      p.deltaVMs === card.deltaVMs && p.direction === card.direction);
    if (current) card.candidateId = current.candidateId;
  }
  const target = targetCandidateId && input.previous.filter(c => c.candidateId === targetCandidateId).sort((a, b) => b.revision - a.revision)[0];
  if (target && !cards.some(c => c.candidateId === target.candidateId)) {
    const replacement = cards.find(c => c.kind === target.kind);
    if (replacement) replacement.candidateId = target.candidateId;
  }
  return cards.map(card => {
    const revised = { ...card, assumptions: [...card.assumptions.slice(0, MAX_ASSUMPTIONS - 1), `Discussion input: ${discussionKey}.`] };
    const previous = input.previous.filter(c => c.candidateId === revised.candidateId).sort((a, b) => b.revision - a.revision)[0];
    const equal = previous && (Object.keys(revised) as (keyof Candidate)[]).every(k => k === "revision" || JSON.stringify(revised[k]) === JSON.stringify(previous[k]));
    revised.revision = previous ? previous.revision + (equal ? 0 : 1) : 1;
    return revised;
  });
}

/** A code and message safe to return: orbit errors carry the client's own text; Convex errors carry ours. */
export function publishFailure(error: unknown): { status: "failed"; code: string; message: string } {
  if (error instanceof OrbitServiceError) return { status: "failed", ...orbitFailure(error) };
  if (error instanceof ConvexError && typeof error.data?.code === "string" && typeof error.data?.message === "string") {
    return { status: "failed", code: error.data.code, message: error.data.message };
  }
  // Not an orbit response (those are OrbitServiceError above), so no upstream text reaches the log.
  console.error("Candidate publication failed unexpectedly:", error instanceof Error ? `${error.name}: ${error.message}` : typeof error);
  return { status: "failed", code: "PUBLISH_FAILED", message: "Candidate publication did not complete. Retry later." };
}
