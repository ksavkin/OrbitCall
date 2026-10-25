import { ConvexError } from "convex/values";
import { inputKey, type EventFacts } from "./analyst";
import { mapCandidates, type CardContext, type OrbitCandidatesResponse, type StoredCandidate } from "./candidateCards";
import { orbitFailure, OrbitServiceError, type CandidatesResponse, type ServiceCandidate } from "./orbitClient";
import type { Candidate, Side } from "./policies";

// Pure glue between the orbit service's real /candidates answer and the advocate tables. The card mapper keeps its
// own guarantees (at most four cards, wait keeps its slot, debris side rule, revisions against stored history,
// invalid geometry dropped); this file only adapts the service shape to it and names the publish outcomes.

export type SkipReason =
  | "ORBIT_NOT_CONFIGURED" | "NOT_FOUND" | "EVENT_INACTIVE" | "SET_NOT_OPEN" | "WORKFLOW_UNSUPPORTED" | "OMM_SNAPSHOT_UNKNOWN";
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
  activeSide: Side;
  counterpartSide: Side | null;
  allowedMovingObjectIds: string[];
  baseVersion: number | null;
  previous: StoredCandidate[];
  currentCards: { candidateId: string; revision: number }[];
  sharedMovers: SharedMover[];
}

// The service propagates public mean elements: its miss distance carries kilometre-level uncertainty, so only a
// larger disagreement means it computed a different encounter than the stored event. To confirm with Kostya.
export const GEOMETRY_TOLERANCE_KM = 1;
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

// Same encounter: miss distances within the tolerance and on the same side of the 1 km pair threshold.
export const geometryMatches = (response: CandidatesResponse, facts: EventFacts) =>
  Math.abs(response.missBeforeKm - facts.missKm) <= GEOMETRY_TOLERANCE_KM &&
  response.wait.passesPairThreshold === (facts.missKm >= PAIR_THRESHOLD_KM);

// Policy-free choice from the ranked grid: maneuvers that clear the pair threshold and widen the miss, the cheapest
// one per moving side first, then the rest in service rank order. The mapper keeps the first valid ones, so this
// order decides which three maneuvers accompany the wait card. A grid with no such maneuver yields wait only.
function chooseOrder(response: CandidatesResponse): ServiceCandidate[] {
  const useful = response.candidates.filter(c => c.kind === "maneuver" && c.passesPairThreshold &&
    c.missAfterKm !== null && c.missAfterKm > response.missBeforeKm);
  const firstPerSide = useful.filter((c, i) => useful.findIndex(p => p.movingSide === c.movingSide) === i);
  return [...firstPerSide, ...useful.filter(c => !firstPerSide.includes(c))];
}

const sharedLine = (eventIds: string[]) =>
  `This spacecraft is also in linked incident(s) ${eventIds.join(", ")}; one burn must be authorized through a single trajectory plan.`;

/** Adapts the service's /candidates answer to the card mapper's input. The service echoes the pair, snapshot and
 *  evidence version (checked by the orbit client) but not the event, so the caller's event ID is the echo. Card
 *  assumptions are stable across calls, so an unchanged geometry keeps its revision. */
export function toCardResponse(response: CandidatesResponse, eventId: string, sharedMovers: SharedMover[] = []): OrbitCandidatesResponse {
  const base = response.assumptions.filter(text => !TIME_VARYING.some(pattern => pattern.test(text)));
  const fewer = response.failed.length > 0 || response.notMovable.length > 0 ? [FEWER_OPTIONS] : [];
  const assumptionsFor = (c: ServiceCandidate) => {
    const shared = sharedMovers.find(m => m.objectId === c.movingObjectId);
    const extras = [`Method: ${response.method}`, ...fewer, ...(shared ? [sharedLine(shared.eventIds)] : [])];
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
    candidates: [...chooseOrder(response), response.wait].map(card),
  };
}

export function cardsFor(response: CandidatesResponse, input: PublishInput, eventId: string, nowMs: number): Candidate[] {
  const context: CardContext = {
    facts: input.facts, activeSide: input.activeSide, counterpartSide: input.counterpartSide, previous: input.previous, nowMs,
    eventId, evidenceVersion: input.evidenceVersion, snapshotId: input.snapshotId,
  };
  return mapCandidates(toCardResponse(response, eventId, input.sharedMovers), context);
}

/** The linked events whose mover appears on a published card, sorted. */
export function sharedMoverEventIds(cards: Candidate[], sharedMovers: SharedMover[]): string[] {
  const moving = new Set(cards.map(c => c.movingObjectId));
  return [...new Set(sharedMovers.filter(m => moving.has(m.objectId)).flatMap(m => m.eventIds))].sort();
}

/** True when the current set already holds exactly these card revisions (a concurrent identical publication). */
export const sameCards = (cards: Candidate[], current: PublishInput["currentCards"]) =>
  cards.length === current.length && cards.every((c, i) => c.candidateId === current[i].candidateId && c.revision === current[i].revision);

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
