import { invalid } from "./policies";

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
