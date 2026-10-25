import { invalid, validateCandidates, type Candidate, type Side } from "./policies";
import type { EventFacts } from "./analyst";

// Mirrors the orbit service /candidates response; must match orbitClient.ts.
export interface OrbitCandidatesResponse {
  eventId: string;
  evidenceVersion: string;
  snapshotId: string;
  simulated: boolean;
  candidates: {
    kind: "maneuver" | "wait";
    movingObjectId: string | null;
    burnTimeUtc: string | null;
    direction: "prograde" | "retrograde" | null;
    deltaVMs: number | null;
    estimatedFuelKg: number | null;
    missAfterKm: number | null;
    reviewCondition: string | null;
    assumptions: string[];
  }[];
}

const RESPONSE_KEYS = ["eventId", "evidenceVersion", "snapshotId", "simulated", "candidates"];
const CANDIDATE_KEYS = ["kind", "movingObjectId", "burnTimeUtc", "direction", "deltaVMs",
  "estimatedFuelKg", "missAfterKm", "reviewCondition", "assumptions"];
const MAX_SERVICE_CANDIDATES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stringOrNull = (value: unknown) => value === null || typeof value === "string";
const numberOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

export function parseCandidatesResponse(value: unknown): OrbitCandidatesResponse {
  if (!isRecord(value) || !exactKeys(value, RESPONSE_KEYS) ||
    typeof value.eventId !== "string" || typeof value.evidenceVersion !== "string" ||
    typeof value.snapshotId !== "string" || typeof value.simulated !== "boolean" ||
    !Array.isArray(value.candidates) || value.candidates.length > MAX_SERVICE_CANDIDATES) {
    invalid("Candidate service response has an unexpected shape.");
  }
  for (const c of value.candidates as unknown[]) {
    if (!isRecord(c) || !exactKeys(c, CANDIDATE_KEYS) ||
      (c.kind !== "maneuver" && c.kind !== "wait") ||
      !stringOrNull(c.movingObjectId) || !stringOrNull(c.burnTimeUtc) || !stringOrNull(c.reviewCondition) ||
      (c.direction !== null && c.direction !== "prograde" && c.direction !== "retrograde") ||
      !numberOrNull(c.deltaVMs) || !numberOrNull(c.estimatedFuelKg) || !numberOrNull(c.missAfterKm) ||
      !Array.isArray(c.assumptions) || !c.assumptions.every(a => typeof a === "string")) {
      invalid("Candidate service response has an unexpected candidate shape.");
    }
  }
  return value as unknown as OrbitCandidatesResponse;
}

export interface CardContext {
  facts: EventFacts;                  // from convex/lib/analyst.ts
  activeSide: Side;                   // the side whose operator acts
  counterpartSide: Side | null;       // null for debris
  previous: Candidate[];              // last published revisions, for revision bumping
  nowMs: number;
  eventId: string;                    // the service must echo these three
  evidenceVersion: string;
  snapshotId: string;
}

// cyrb53-style 64-bit string hash; IDs only need to be stable, not secret.
function hash64(text: string): string {
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

export function stableCandidateId(c: { kind: "maneuver" | "wait"; movingObjectId: string | null;
  burnTimeUtc: string | null; direction: string | null; deltaVMs: number | null }): string {
  const burnMs = c.burnTimeUtc === null ? NaN : Date.parse(c.burnTimeUtc);
  const burn = Number.isFinite(burnMs) ? new Date(burnMs).toISOString() : c.burnTimeUtc;
  return `${c.kind}-${hash64(JSON.stringify([c.kind, c.movingObjectId, burn, c.direction, c.deltaVMs]))}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const sameContent = (a: Candidate, b: Candidate) => {
  const { revision: _a, ...left } = a;
  const { revision: _b, ...right } = b;
  return canonical(left) === canonical(right);
};

function label(c: OrbitCandidatesResponse["candidates"][number], tcaUtc: string): string {
  if (c.kind === "wait") return "Wait for update";
  const hours = Math.round((Date.parse(tcaUtc) - Date.parse(c.burnTimeUtc!)) / 360_000) / 10;
  const move = `Move ${c.movingObjectId} ${c.direction} ${c.deltaVMs} m/s`;
  const full = `${move}, ${hours} h before closest approach`;
  return (full.length <= 80 ? full : move).slice(0, 80);
}

// Selection when the service returns more than four: drop past burns, keep the first occurrence of each
// candidate ID, then keep the first four in service order. Nothing is invented or reordered.
// Every returned maneuver is still checked for its moving object, including ones that are not kept.
export function mapCandidates(response: OrbitCandidatesResponse, context: CardContext): Candidate[] {
  const result = parseCandidatesResponse(response);
  const { facts, activeSide, counterpartSide, previous, nowMs } = context;
  if (counterpartSide === activeSide) invalid("The counterpart side must differ from the active side.");
  if (result.eventId !== context.eventId || result.evidenceVersion !== context.evidenceVersion ||
    result.snapshotId !== context.snapshotId) invalid("Candidate results do not match the requested event evidence.");
  const simulated = facts.simulated || result.simulated;
  const cards: Candidate[] = [];
  for (const c of result.candidates) {
    let movingSide: Side | null = null;
    if (c.kind === "maneuver") {
      movingSide = c.movingObjectId === facts.objectA.objectId ? "A" : c.movingObjectId === facts.objectB.objectId ? "B" : null;
      if (!movingSide) invalid("A candidate maneuver moves an object outside this event.");
      if (counterpartSide === null && movingSide !== activeSide) invalid("A debris event can only move the active side's object.");
      if (c.burnTimeUtc !== null && Date.parse(c.burnTimeUtc) <= nowMs) continue;
    }
    const candidateId = stableCandidateId(c);
    if (cards.length === 4 || cards.some(card => card.candidateId === candidateId)) continue;
    const card: Candidate = {
      candidateId, revision: 1, label: label(c, facts.tcaUtc), kind: c.kind, movingSide,
      movingObjectId: c.movingObjectId, burnTimeUtc: c.burnTimeUtc, deltaVMs: c.deltaVMs, direction: c.direction,
      estimatedFuelKg: c.estimatedFuelKg, missBeforeKm: facts.missKm, missAfterKm: c.missAfterKm, indicative: true,
      reviewCondition: c.reviewCondition, assumptions: [...c.assumptions], simulated,
    };
    const prior = previous.find(p => p.candidateId === candidateId);
    if (prior) card.revision = sameContent(card, prior) ? prior.revision : prior.revision + 1;
    cards.push(card);
  }
  validateCandidates(cards, facts);
  return cards;
}
