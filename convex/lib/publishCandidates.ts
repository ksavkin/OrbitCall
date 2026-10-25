import { ConvexError } from "convex/values";
import { inputKey, type EventFacts } from "./analyst";
import { mapCandidates, type CardContext, type OrbitCandidatesResponse, type StoredCandidate } from "./candidateCards";
import { orbitFailure, OrbitServiceError, type CandidatesResponse, type ServiceCandidate } from "./orbitClient";
import type { Candidate, Side } from "./policies";

// Pure glue between the orbit service's real /candidates answer and the advocate tables. The card mapper keeps its
// own guarantees (at most four cards, wait keeps its slot, debris side rule, revisions against stored history,
// invalid geometry dropped); this file only adapts the service shape to it and names the publish outcomes.

export type SkipReason = "ORBIT_NOT_CONFIGURED" | "NOT_FOUND" | "EVENT_INACTIVE" | "SET_NOT_OPEN" | "WORKFLOW_UNSUPPORTED";
export type PublishOutcome =
  | { status: "published"; version: number; changed: boolean; cards: number }
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; code: string; message: string };

// Everything the action needs, read in one query. Debris never moves: only operator-owned objects are allowed movers.
export interface PublishInput {
  facts: EventFacts;
  snapshotId: string;
  evidenceVersion: string;
  activeSide: Side;
  counterpartSide: Side | null;
  allowedMovingObjectIds: string[];
  baseVersion: number | null;
  previous: StoredCandidate[];
}

// The service propagates public mean elements: its miss distance carries kilometre-level uncertainty, so only a
// larger disagreement means it computed a different encounter than the stored event.
export const GEOMETRY_TOLERANCE_KM = 1;

const WAIT_REVIEW = "Reassess when new orbital evidence or a new screening result arrives.";
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

/** The evidence generation sent to the service and echoed back: the same key candidate sets store. */
export const evidenceVersionOf = (facts: EventFacts) => `ev-${digest(inputKey(facts))}`;

/** Whole seconds, as the orbit client requires. */
export const wholeSecondUtc = (ms: number, round: (x: number) => number = Math.round) =>
  new Date(round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

export const geometryMatches = (response: CandidatesResponse, facts: EventFacts) =>
  Math.abs(response.missBeforeKm - facts.missKm) <= GEOMETRY_TOLERANCE_KM;

// Policy-free choice from the ranked grid: maneuvers that clear the pair threshold, the cheapest one per moving side
// first, then the rest in service rank order. The mapper keeps the first valid ones, so this order decides which
// three maneuvers accompany the wait card. Nothing is invented: a grid with no passing maneuver yields wait only.
function chooseOrder(grid: ServiceCandidate[]): ServiceCandidate[] {
  const passing = grid.filter(c => c.kind === "maneuver" && c.passesPairThreshold);
  const firstPerSide = passing.filter((c, i) => passing.findIndex(p => p.movingSide === c.movingSide) === i);
  return [...firstPerSide, ...passing.filter(c => !firstPerSide.includes(c))];
}

/** Adapts the service's /candidates answer to the card mapper's input. The service echoes the pair, snapshot and
 *  evidence version (checked by the orbit client) but not the event, so the caller's event ID is the echo. */
export function toCardResponse(response: CandidatesResponse, eventId: string): OrbitCandidatesResponse {
  const assumptions = [...response.assumptions.slice(0, MAX_ASSUMPTIONS - 1), `Method: ${response.method}`]
    .map(text => text.slice(0, MAX_TEXT));
  const card = (c: ServiceCandidate): OrbitCandidatesResponse["candidates"][number] => ({
    kind: c.kind, movingObjectId: c.movingObjectId, burnTimeUtc: c.burnTimeUtc, direction: c.direction, deltaVMs: c.deltaVMs,
    // Always null from the service: mass and Isp are private, so each Advocate settles fuel itself.
    estimatedFuelKg: null, missAfterKm: c.missAfterKm,
    reviewCondition: c.kind === "wait" ? WAIT_REVIEW : null, assumptions: [...assumptions],
  });
  return {
    eventId, evidenceVersion: response.evidenceVersion, snapshotId: response.snapshotId, simulated: response.simulated,
    candidates: [...chooseOrder(response.candidates), response.wait].map(card),
  };
}

export function cardsFor(response: CandidatesResponse, input: PublishInput, eventId: string, nowMs: number): Candidate[] {
  const context: CardContext = {
    facts: input.facts, activeSide: input.activeSide, counterpartSide: input.counterpartSide, previous: input.previous, nowMs,
    eventId, evidenceVersion: input.evidenceVersion, snapshotId: input.snapshotId,
  };
  return mapCandidates(toCardResponse(response, eventId), context);
}

/** A code and message safe to return: orbit errors carry the client's own text; Convex errors carry ours. */
export function publishFailure(error: unknown): { status: "failed"; code: string; message: string } {
  if (error instanceof OrbitServiceError) return { status: "failed", ...orbitFailure(error) };
  if (error instanceof ConvexError && typeof error.data?.code === "string" && typeof error.data?.message === "string") {
    return { status: "failed", code: error.data.code, message: error.data.message };
  }
  return { status: "failed", code: "PUBLISH_FAILED", message: "Candidate publication did not complete. Retry later." };
}
