// Convex-side client for the orbital service (services/orbit/; contract services/orbit/docs/contract.md v2.1–v2.3,
// spec Appendix A). Plain fetch, no "use node": it runs in the default Convex runtime and tests stub global fetch.
// One bounded request per call. Polling GET /jobs/{id} belongs to the scheduler in scans.ts and maneuvers.ts,
// never to a loop here or inside a mutation.
// Responses are checked field by field: every field Convex reads must be present with the right type, null stays
// null (never 0), echoed ids and versions must match the request, and a verdict that breaks its own rule is not
// trusted. Fields this client does not read (diagnostics, echoed proposalId/revision/runId) pass through.

export type ISODate = string;
export type ObjectId = string;
export type Direction = "prograde" | "retrograde";
export type Side = "A" | "B";

export type OrbitErrorCode =
  | "ORBIT_NOT_CONFIGURED" | "ORBIT_ACCESS_DENIED" | "RATE_LIMITED" | "NOT_FOUND" | "SNAPSHOT_MISMATCH"
  | "JOB_CONFLICT" | "NOT_READY" | "VALIDATION" | "INVALID_RESPONSE" | "UPSTREAM_UNAVAILABLE";

export class OrbitServiceError extends Error {
  constructor(
    readonly code: OrbitErrorCode, message: string,
    readonly status: number | null = null,
    readonly upstreamCode: string | null = null,   // the service's own error code, from a fixed allowlist
  ) {
    super(message);
    this.name = "OrbitServiceError";
  }
}

// ---------- Shapes (contract.md; spec §2.2, §2.5, §2.6) ----------

export interface ObjectInfo {
  objectId: ObjectId; name: string;
  kind: "payload" | "debris" | "rocket_body" | "unknown";
  maneuverability: "maneuverable" | "non_maneuverable" | "unknown";   // real objects are never "maneuverable"
  classificationBasis: string; operationalStatus: string | null; group: string; simulated: boolean;
}

export interface SourceSpread {
  gpMissKm: number | null; supgpMissKm: number | null; minKm: number | null; maxKm: number | null;
  gpEpochUtc: ISODate | null; supgpEpochUtc: ISODate | null;
}

export interface ScreenedEvent {
  objectA: ObjectId; objectB: ObjectId;         // canonical: catalog number order
  tcaUtc: ISODate; missKm: number; relSpeedKmS: number;
  spread: SourceSpread;
  primaries: ObjectId[];                        // which of the two were primaries
  attachedObjectIds: ObjectId[];                // bodies sharing objectB's element set (docked)
  simulated: boolean;
}

export interface Coverage {
  complete: boolean; timedOut: boolean; catalogScope: string;
  excludedObjects: number; reasons: { reason: string; count: number }[];
}

export interface ScreenCounts { primaryObjects: number; catalogObjects: number; primariesCompleted: number; pairsChecked: number; eventsFound: number }

export interface ScreenResult {
  scanId: string; snapshotId: string; evidenceVersion: string | null;
  fromUtc: ISODate; toUtc: ISODate; thresholdKm: number; cached: boolean; runtimeS: number;
  coverage: Coverage; counts: ScreenCounts;
  missingPrimaryIds: ObjectId[];                // primaries not in the snapshot: partial coverage, not an error
  unpropagatedObjectIds: ObjectId[];
  dockedBodies: Record<ObjectId, ObjectId[]>;
  events: ScreenedEvent[];                      // sorted by TCA
  coLocated: { objectA: ObjectId; objectB: ObjectId; minDistanceKm: number }[];
  objects: Record<ObjectId, ObjectInfo>;
  uncovered: Record<string, unknown>[];
  method: string; limitations: string[];
  runId?: string;
}

export interface NewConjunction {
  objectId: ObjectId; name: string; tcaUtc: ISODate; missKm: number;
  withoutManeuverKm: number | null; attachedObjectIds: ObjectId[];
}

export interface RescreenResult {
  passed: boolean;                              // originalMissAfterKm ≥ 1 km and nothing new under 1 km
  objectsChecked: number; objectsInCatalog: number; horizonH: number;
  originalMissAfterKm: number | null;
  newConjunctions: NewConjunction[];
  refusalReason: string | null;                 // set whenever passed is false
  snapshotId: string; evidenceVersion: string;
  simulated: boolean; method: string; limitations: string[];
  // Absent when the maneuver could not be propagated (nothing was screened).
  fromUtc?: ISODate; toUtc?: ISODate; screenedFromUtc?: ISODate; screenedToUtc?: ISODate;
  attachedObjectIds?: ObjectId[]; partnerAttachedObjectIds?: ObjectId[];
  proposalId?: string; revision?: number; runId?: string;
}

export type JobKind = "screen" | "rescreen";
export type JobStatus = "queued" | "running" | "completed" | "failed";
export type JobPhase = "queued" | "screening" | "publishing" | "done" | "failed";

export interface JobAccepted { jobId: string; status: JobStatus; created: boolean; statusUrl: string }

export interface OrbitJob<R> {
  jobId: string; kind: JobKind; status: JobStatus; phase: JobPhase;
  progress: number | null;                      // measured fraction; null when indeterminate
  counters: Record<string, number>;             // measured counters, passed through as reported
  coverage: Coverage | null;                    // null until the service knows it
  requestHash: string; createdAt: ISODate; startedAt: ISODate | null; finishedAt: ISODate | null;
  result: R | null;                             // only when completed
  resultRef: string | null;
  error: { code: JobErrorCode; message: string } | null;   // only when failed; the message is this client's, never the service's
}

export type JobErrorCode = "VALIDATION" | "ERROR" | "SERVICE_RESTARTED";

export interface ServiceCandidate {
  candidateId: string; kind: "maneuver" | "wait";
  movingSide: Side | null; movingObjectId: ObjectId | null;
  burnTimeUtc: ISODate | null; leadH: number | null;
  deltaVMs: number | null; direction: Direction | null; deltaAKm: number | null;
  missBeforeKm: number; missAfterKm: number | null;
  tcaAfterUtc: ISODate | null; relSpeedKmS: number | null;
  passesPairThreshold: boolean;                 // pair miss ≥ 1 km; not the whole-catalog re-screen
  estimatedFuelKg: null;                        // always null: mass and Isp are private (POL-2)
  indicative: true; simulated: boolean; rank: number | null;
}

// The service's real /candidates answer. It differs from the provisional OrbitCandidatesResponse in
// convex/lib/candidateCards.ts (no eventId, the full grid with ranks, classification of both objects); the round 2
// publish task maps between them.
export interface CandidatesResponse {
  snapshotId: string; evidenceVersion: string;
  objectA: ObjectId; objectB: ObjectId;
  objects: Record<ObjectId, ObjectInfo>;
  notMovable: { side: Side; objectId: ObjectId; reason: string }[];
  tcaUtc: ISODate; tcaInputUtc: ISODate;
  missBeforeKm: number; relSpeedKmS: number; simulated: boolean;
  candidates: ServiceCandidate[];               // the full grid, policy-free order (rank 1 first)
  wait: ServiceCandidate;
  failed: { candidateId: string; reason: string }[];
  assumptions: string[]; method: string;
  proposalId?: string; revision?: number; runId?: string;
}

export interface SimulateResult {
  objectId: ObjectId;                           // reserved simulated ID, "SIM-0001"
  omm: Record<string, unknown>; tle: [string, string]; simulated: true;
  event: { objectA: ObjectId; objectB: ObjectId; tcaUtc: ISODate; missKm: number; relSpeedKmS: number; simulated: true };
  assumptions: string[];
}

export interface SourceRef { name?: string; url?: string | null; format?: string; epochUtc?: ISODate | null; fetchedAt?: ISODate | null; sha256?: string }

export interface Verification {
  kind: "live" | "replay";
  result: "awaiting_data" | "consistent" | "mismatch";
  label: string;
  expected: { deltaAKm: number; sign: 1 | -1 };
  observed: { deltaAKm: number; z: number; epochUtc: ISODate } | null;
  elementSetCount: number;
  series: { epochUtc: ISODate; smaKm: number }[];
  thresholds: { z: number; minDeltaAKm: number; sizeTolerance: number; minSets: number };
  method: string; limitations: string[]; missing: string[]; sources: SourceRef[]; simulated: boolean;
}

// ---------- Requests ----------

export interface ScreenRequest {
  scanId: string; snapshotId: string; primaryObjectIds: ObjectId[];   // 1–50, resolved by Convex from assignments
  fromUtc: ISODate; toUtc: ISODate;                                    // window ≤ 168 h
  jobId?: string;                                                      // default "screen-<scanId>": a resubmit is idempotent
  evidenceVersion?: string; runId?: string;
}
export interface CandidatesRequest {
  snapshotId: string; evidenceVersion: string;
  objectA: ObjectId; objectB: ObjectId; tcaUtc: ISODate;
  allowedMovingObjectIds: ObjectId[];                                  // [] = nobody moves (wait only)
  notBeforeUtc?: ISODate;                                              // burns before this are not offered
  proposalId?: string; revision?: number; runId?: string;
}
export interface ManeuverInput { burnTimeUtc: ISODate; deltaVMs: number; direction: Direction }
export interface RescreenRequest {
  jobId: string;                                                       // the caller's idempotency key
  snapshotId: string; evidenceVersion: string;
  objectId: ObjectId; maneuver: ManeuverInput;
  partnerObjectId: ObjectId; tcaUtc: ISODate;                          // without them the pair is not checked
  fromUtc: ISODate; toUtc: ISODate;                                    // fromUtc ≤ burn < toUtc
  proposalId?: string; revision?: number; runId?: string;
}
export interface SimulateRequest {
  targetObjectId: ObjectId; tcaUtc: ISODate; name?: string;
  objectId?: string; tiltDeg?: number; missKm?: number; deltaAKm?: number;
}
export interface VerifyRequest {
  objectId: ObjectId;
  expected: { burnTimeUtc: ISODate; deltaVMs?: number; direction?: Direction; deltaAKm?: number };
  series?: { epochUtc: ISODate; meanMotionRevPerDay?: number; smaKm?: number }[];
  replay?: string; kind?: "live" | "replay"; sources?: SourceRef[];
}

// ---------- Validation helpers ----------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;   // what the client sends: the service echoes whole seconds
const OBJECT_ID = /^(\d{1,9}|SIM-\d{4})$/;                 // catalog.py decodes Alpha-5 designators to decimal
const SIM_ID = /^SIM-\d{4}$/;
const JOB_ID = /^[A-Za-z0-9._:-]{1,128}$/;                 // jobs.py JOB_ID_RE
const REPLAY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;           // verify.py: a file stem, never a path
const MAX_PRIMARIES = 50;                                  // screen.py MAX_PRIMARIES
const MAX_WINDOW_MS = 168 * 3_600_000;
const MAX_EVENTS = 10_000;
const MAX_CANDIDATES = 100;                                // the grid is at most 48 maneuvers
const MAX_LIST = 1_000;
const MAX_OBJECTS = 25_000;                                // lists keyed by catalog objects (the snapshot has ~19.5k)
const TCA_SEARCH_MS = 600_000;                             // the service refines the given TCA within ±10 min
const PAIR_THRESHOLD_KM = 1;                               // §20 Q11
const JOB_ERROR_CODES = ["VALIDATION", "ERROR", "SERVICE_RESTARTED"] as const;
const JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  VALIDATION: "The orbit service rejected the job's request.",
  ERROR: "The orbit service could not finish the job. Resubmit it.",
  SERVICE_RESTARTED: "The orbit service restarted before the job finished. Resubmit it.",
};
const VERIFY_LABELS = { awaiting_data: "awaiting verification data", consistent: "evidence consistent with plan", mismatch: "mismatch" } as const;
const DIRECTIONS = ["prograde", "retrograde"] as const;
const SIDES = ["A", "B"] as const;
const JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
const JOB_PHASES = ["queued", "screening", "publishing", "done", "failed"] as const;
const KINDS = ["payload", "debris", "rocket_body", "unknown"] as const;
const MANEUVERABILITY = ["maneuverable", "non_maneuverable", "unknown"] as const;

type Rec = Record<string, unknown>;
type Check = (v: unknown) => boolean;
const fail = (what: string): never => { throw new OrbitServiceError("INVALID_RESPONSE", `Orbit service returned an unexpected ${what}.`); };
const badInput = (what: string): never => { throw new OrbitServiceError("VALIDATION", `Orbit request has an invalid ${what}.`); };

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNeg = (v: unknown): v is number => isNum(v) && v >= 0;
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));
const isIsoSecond = (v: unknown): v is string => isIso(v) && ISO_SECOND.test(v);
const isObjectId = (v: unknown): v is string => typeof v === "string" && OBJECT_ID.test(v);
const isSim = (v: unknown): v is string => typeof v === "string" && SIM_ID.test(v);
const orNull = <T>(check: (v: unknown) => v is T) => (v: unknown): v is T | null => v === null || check(v);
const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
const ms = (iso: string) => Date.parse(iso);

function rec(v: unknown, what: string): Rec {
  if (!isRecord(v)) fail(what);
  return v as Rec;
}
// Checks the named fields of r. Keys not named are left alone: the service adds echoes and diagnostics.
function fields(r: Rec, checks: Record<string, Check>, what: string): void {
  for (const [key, check] of Object.entries(checks)) if (!check(r[key])) fail(`${what} (${key})`);
}
function list(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(what);
  return v as unknown[];
}
function strList(v: unknown, what: string): string[] {
  const l = list(v, MAX_LIST, what);
  if (!l.every(isStr)) fail(what);
  return l as string[];
}
function idList(v: unknown, what: string, max = MAX_LIST): ObjectId[] {
  const l = list(v, max, what);
  if (!l.every(isObjectId)) fail(what);
  return l as ObjectId[];
}
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

// ---------- Response parsers ----------

function parseObjectInfo(v: unknown, what: string): ObjectInfo {
  const o = rec(v, what);
  fields(o, {
    objectId: isObjectId, name: isStr, kind: oneOf(KINDS), maneuverability: oneOf(MANEUVERABILITY),
    classificationBasis: isStr, operationalStatus: orNull(isStr), group: isStr, simulated: isBool,
  }, what);
  // Only the demo satellite is simulated, and only it may be called maneuverable: public data has no propulsion field.
  if (isSim(o.objectId) !== o.simulated) fail(`${what} (simulated flag)`);
  if (o.maneuverability === "maneuverable" && o.simulated !== true) fail(`${what} (a real object marked maneuverable)`);
  return o as unknown as ObjectInfo;
}

function parseObjects(v: unknown, what: string): Record<ObjectId, ObjectInfo> {
  const r = rec(v, what);
  const keys = Object.keys(r);
  if (keys.length > MAX_OBJECTS) fail(what);
  for (const key of keys) if (parseObjectInfo(r[key], what).objectId !== key) fail(`${what} (key)`);
  return r as unknown as Record<ObjectId, ObjectInfo>;
}

// The service compares the unrounded miss with the 1 km threshold and reports the miss rounded to 3 decimals, so
// a flag may disagree with the rounded figure only when that figure is exactly 1.0.
const passFlagAgrees = (passes: boolean, missKm: number) => passes ? missKm >= PAIR_THRESHOLD_KM : missKm <= PAIR_THRESHOLD_KM;

function parseSpread(v: unknown): SourceSpread {
  const what = "source spread";
  const s = rec(v, what);
  fields(s, {
    gpMissKm: orNull(isNonNeg), supgpMissKm: orNull(isNonNeg), minKm: orNull(isNonNeg), maxKm: orNull(isNonNeg),
    gpEpochUtc: orNull(isIso), supgpEpochUtc: orNull(isIso),
  }, what);
  return s as unknown as SourceSpread;
}

function parsePair(v: unknown, what: string): Rec {
  const e = rec(v, what);
  fields(e, { objectA: isObjectId, objectB: isObjectId, tcaUtc: isIso, missKm: isNonNeg, relSpeedKmS: isNonNeg, simulated: isBool }, what);
  if (e.objectA === e.objectB) fail(`${what} (self-pair)`);
  // Simulated data is always labeled (DATA-5), and only it: the flag follows the SIM ids exactly.
  if (e.simulated !== (isSim(e.objectA) || isSim(e.objectB))) fail(`${what} (simulated flag)`);
  return e;
}

function parseEvent(v: unknown): ScreenedEvent {
  const what = "event";
  const e = parsePair(v, what);
  parseSpread(e.spread);
  const primaries = idList(e.primaries, `${what} (primaries)`);
  // Every event comes from screening a primary, so at least one side is one.
  if (primaries.length === 0 || !primaries.every(p => p === e.objectA || p === e.objectB)) fail(`${what} (primaries)`);
  idList(e.attachedObjectIds, `${what} (attachedObjectIds)`);
  return e as unknown as ScreenedEvent;
}

function parseCoverage(v: unknown): Coverage {
  const what = "coverage";
  const c = rec(v, what);
  fields(c, { complete: isBool, timedOut: isBool, catalogScope: isNonEmpty, excludedObjects: isCount }, what);
  if (c.complete === true && c.timedOut === true) fail(`${what} (complete but timed out)`);
  for (const r of list(c.reasons, MAX_LIST, what)) fields(rec(r, "coverage reason"), { reason: isNonEmpty, count: isCount }, "coverage reason");
  return c as unknown as Coverage;
}

function parseCounts(v: unknown): ScreenCounts {
  const what = "screen counts";
  const c = rec(v, what);
  fields(c, { primaryObjects: isCount, catalogObjects: isCount, primariesCompleted: isCount, pairsChecked: isCount, eventsFound: isCount }, what);
  if ((c.primariesCompleted as number) > (c.primaryObjects as number)) fail(`${what} (primariesCompleted)`);
  return c as unknown as ScreenCounts;
}

export interface ScreenExpectation { scanId: string; snapshotId: string; evidenceVersion?: string }

function parseScreenResult(v: unknown, expected: ScreenExpectation): ScreenResult {
  const what = "screen result";
  const r = rec(v, what);
  if (r.scanId !== expected.scanId || r.snapshotId !== expected.snapshotId) fail(`${what} for a different scan or snapshot`);
  if (expected.evidenceVersion !== undefined && r.evidenceVersion !== expected.evidenceVersion) fail(`${what} for a different evidence version`);
  fields(r, {
    evidenceVersion: orNull(isStr), fromUtc: isIso, toUtc: isIso, thresholdKm: isPos, cached: isBool, runtimeS: isNonNeg, method: isStr,
  }, what);
  if (ms(r.toUtc as string) <= ms(r.fromUtc as string)) fail(`${what} (window)`);
  const coverage = parseCoverage(r.coverage);
  const counts = parseCounts(r.counts);
  const missing = idList(r.missingPrimaryIds, `${what} (missingPrimaryIds)`);
  const unpropagated = idList(r.unpropagatedObjectIds, `${what} (unpropagatedObjectIds)`, MAX_OBJECTS);
  const docked = rec(r.dockedBodies, `${what} (dockedBodies)`);
  if (Object.keys(docked).length > MAX_PRIMARIES) fail(`${what} (dockedBodies)`);
  for (const key of Object.keys(docked)) {
    if (!isObjectId(key)) fail(`${what} (dockedBodies)`);
    idList(docked[key], `${what} (dockedBodies)`);
  }
  const events = list(r.events, MAX_EVENTS, `${what} (events)`).map(parseEvent);
  if (counts.eventsFound !== events.length) fail(`${what} (eventsFound)`);
  // Events are under the screening threshold and sorted by TCA (screen.py). The threshold is compared with the
  // unrounded miss and the miss is reported rounded to 3 decimals, so a reported miss may equal the threshold.
  if (events.some(e => e.missKm > (r.thresholdKm as number))) fail(`${what} (event beyond the threshold)`);
  if (events.some((e, i) => i > 0 && ms(e.tcaUtc) < ms(events[i - 1].tcaUtc))) fail(`${what} (events out of TCA order)`);
  const named = new Set<string>();
  for (const e of events) named.add(e.objectA).add(e.objectB);
  for (const c of list(r.coLocated, MAX_EVENTS, `${what} (coLocated)`)) {
    const p = rec(c, "co-located pair");
    fields(p, { objectA: isObjectId, objectB: isObjectId, minDistanceKm: isNonNeg }, "co-located pair");
    named.add(p.objectA as string).add(p.objectB as string);
  }
  // Every object named in an event or a co-located pair comes with its classification (debris, rocket body, …).
  const objects = parseObjects(r.objects, `${what} (objects)`);
  for (const id of named) if (!(id in objects)) fail(`${what} (object ${id} without classification)`);
  const uncovered = list(r.uncovered, MAX_EVENTS, `${what} (uncovered)`);
  uncovered.forEach(u => rec(u, `${what} (uncovered)`));
  strList(r.limitations, `${what} (limitations)`);
  // A missing primary, an unrefined encounter or an unpropagated object is partial coverage; it is never reported
  // as complete (SCAN-1).
  if (coverage.complete && (missing.length > 0 || uncovered.length > 0 || unpropagated.length > 0 ||
    counts.primariesCompleted !== counts.primaryObjects)) {
    fail(`${what} (complete coverage with gaps)`);
  }
  return r as unknown as ScreenResult;
}

export interface RescreenExpectation { snapshotId: string; evidenceVersion: string; objectId?: ObjectId; partnerObjectId?: ObjectId }

function parseRescreenResult(v: unknown, expected: RescreenExpectation): RescreenResult {
  const what = "re-screen result";
  const r = rec(v, what);
  if (r.snapshotId !== expected.snapshotId || r.evidenceVersion !== expected.evidenceVersion) {
    fail(`${what} for a different snapshot or evidence version`);
  }
  fields(r, {
    passed: isBool, objectsChecked: isCount, objectsInCatalog: isCount, horizonH: isPos,
    originalMissAfterKm: orNull(isNonNeg), refusalReason: orNull(isStr), simulated: isBool, method: isStr,
  }, what);
  if ((r.horizonH as number) > 168) fail(`${what} (horizonH)`);
  // The label follows the moved object and its partner (rescreen.py), when the caller says which they are.
  if (expected.objectId !== undefined && expected.partnerObjectId !== undefined &&
    r.simulated !== (isSim(expected.objectId) || isSim(expected.partnerObjectId))) fail(`${what} (simulated flag)`);
  strList(r.limitations, `${what} (limitations)`);
  const conjunctions = list(r.newConjunctions, MAX_EVENTS, `${what} (newConjunctions)`).map(c => {
    const n = rec(c, "new conjunction");
    fields(n, { objectId: isObjectId, name: isStr, tcaUtc: isIso, missKm: isNonNeg, withoutManeuverKm: orNull(isNonNeg) }, "new conjunction");
    idList(n.attachedObjectIds, "new conjunction (attachedObjectIds)");
    return n as unknown as NewConjunction;
  });
  // New conjunctions come closest first (rescreen.py).
  if (conjunctions.some((c, i) => i > 0 && c.missKm < conjunctions[i - 1].missKm)) fail(`${what} (new conjunctions out of order)`);
  // Present after a screen; absent when the maneuver could not be propagated.
  for (const key of ["fromUtc", "toUtc", "screenedFromUtc", "screenedToUtc"]) if (r[key] !== undefined && !isIso(r[key])) fail(`${what} (${key})`);
  for (const key of ["attachedObjectIds", "partnerAttachedObjectIds"]) if (r[key] !== undefined) idList(r[key], `${what} (${key})`);
  // §20 Q11 pass rule: the original pair was checked and is ≥ 1 km apart, nothing new under 1 km, no refusal.
  // A pass that breaks it is not trusted; a refusal always carries its reason.
  const original = r.originalMissAfterKm as number | null;
  if (r.passed === true && (original === null || original < PAIR_THRESHOLD_KM ||
    conjunctions.some(c => c.missKm < PAIR_THRESHOLD_KM) || r.refusalReason !== null)) {
    fail(`${what} (pass that does not meet the pass rule)`);
  }
  if (r.passed === false && !isNonEmpty(r.refusalReason)) fail(`${what} (refusal without a reason)`);
  return r as unknown as RescreenResult;
}

function parseJob<R>(v: unknown, jobId: string, kind: JobKind, parseResult: (value: unknown) => R): OrbitJob<R> {
  const what = "job";
  const j = rec(v, what);
  if (j.jobId !== jobId) fail(`${what} for a different job ID`);
  if (j.kind !== kind) fail(`${what} (kind)`);
  fields(j, {
    status: oneOf(JOB_STATUSES), phase: oneOf(JOB_PHASES), requestHash: isNonEmpty,
    createdAt: isIso, startedAt: orNull(isIso), finishedAt: orNull(isIso), resultRef: orNull(isStr),
  }, what);
  if (!(j.progress === null || (isNum(j.progress) && j.progress >= 0 && j.progress <= 1))) fail(`${what} (progress)`);
  const counters = rec(j.counters, `${what} (counters)`);
  if (!Object.values(counters).every(isCount)) fail(`${what} (counters)`);
  const coverage = j.coverage === undefined || j.coverage === null ? null : parseCoverage(j.coverage);
  const status = j.status as JobStatus;
  const hasResult = j.result !== null && j.result !== undefined;
  if (status === "completed" && (!hasResult || j.error !== null || j.phase !== "done")) fail("completed job without a result");
  if (status === "failed" && (j.error === null || hasResult || j.phase !== "failed")) fail("failed job without an error");
  if ((status === "queued" || status === "running") && (hasResult || j.error !== null)) fail("unfinished job with a result");
  // jobs.py stamps startedAt when the job starts running and finishedAt when it ends. A job that failed before it
  // started (the service restarted while it was queued) has no start time.
  if ((status === "running" || status === "completed") && j.startedAt === null) fail(`${what} (startedAt)`);
  if (status === "queued" && j.startedAt !== null) fail(`${what} (startedAt)`);
  if ((status === "completed" || status === "failed") === (j.finishedAt === null)) fail(`${what} (finishedAt)`);
  const phases: Record<JobStatus, readonly JobPhase[]> = { queued: ["queued"], running: ["screening", "publishing"], completed: ["done"], failed: ["failed"] };
  if (!phases[status].includes(j.phase as JobPhase)) fail(`${what} (phase)`);
  if (coverage !== null && status !== "completed") fail(`${what} (coverage before completion)`);
  // The job's error carries raw exception text (jobs.py: str(exc)[:500]). Only its code is kept, from a fixed list;
  // the message stored and shown is this client's.
  let error: OrbitJob<R>["error"] = null;
  if (j.error !== null) {
    const e = rec(j.error, "job error");
    fields(e, { code: isNonEmpty, message: isStr }, "job error");
    const code = oneOf(JOB_ERROR_CODES)(e.code) ? e.code : "ERROR";
    error = { code, message: JOB_ERROR_MESSAGES[code] };
  }
  const result = hasResult ? parseResult(j.result) : null;
  // The job's coverage is the result's (jobs.py done()).
  if (coverage !== null && isRecord(j.result) && JSON.stringify(j.result.coverage) !== JSON.stringify(coverage)) fail(`${what} (coverage differs from the result's)`);
  return {
    jobId, kind, status, phase: j.phase as JobPhase, progress: j.progress as number | null,
    counters: counters as Record<string, number>, coverage,
    requestHash: j.requestHash as string, createdAt: j.createdAt as string,
    startedAt: j.startedAt as string | null, finishedAt: j.finishedAt as string | null,
    result, resultRef: j.resultRef as string | null, error,
  };
}

function parseJobAccepted(v: unknown, expectedJobId: string): JobAccepted {
  const what = "job acceptance";
  const r = rec(v, what);
  fields(r, { jobId: (x: unknown) => isStr(x) && JOB_ID.test(x), status: oneOf(JOB_STATUSES), created: isBool, statusUrl: isNonEmpty }, what);
  if (r.jobId !== expectedJobId) fail(`${what} for a different job ID`);
  return { jobId: r.jobId as string, status: r.status as JobStatus, created: r.created as boolean, statusUrl: r.statusUrl as string };
}

interface CandidateContext { objectA: ObjectId; objectB: ObjectId; tcaUtc: ISODate; allowed: Set<ObjectId>; objects: Record<ObjectId, ObjectInfo>; simulated: boolean }

function parseCandidate(v: unknown, ctx: CandidateContext, what: string): ServiceCandidate {
  const c = rec(v, what);
  fields(c, {
    candidateId: isNonEmpty, kind: oneOf(["maneuver", "wait"] as const), missBeforeKm: isNonNeg, missAfterKm: orNull(isNonNeg),
    tcaAfterUtc: orNull(isIso), relSpeedKmS: orNull(isNonNeg), passesPairThreshold: isBool, deltaAKm: orNull(isNum),
    leadH: orNull(isPos), simulated: isBool,
  }, what);
  if (c.estimatedFuelKg !== null) fail(`${what} (fuel from the service: masses are private)`);
  if (c.indicative !== true) fail(`${what} (indicative)`);
  if (c.simulated !== ctx.simulated) fail(`${what} (simulated flag)`);
  if (c.kind === "wait") {
    if (c.movingSide !== null || c.movingObjectId !== null || c.burnTimeUtc !== null || c.leadH !== null || c.deltaVMs !== null ||
      c.direction !== null || c.deltaAKm !== null || c.missAfterKm !== null || c.tcaAfterUtc !== null || c.relSpeedKmS !== null || c.rank !== null) {
      fail(`${what} (wait with maneuver fields)`);
    }
    if (!passFlagAgrees(c.passesPairThreshold as boolean, c.missBeforeKm as number)) fail(`${what} (passesPairThreshold)`);
    return c as unknown as ServiceCandidate;
  }
  // A maneuver that reached the grid has its geometry after the burn (candidates.py); one that could not be
  // modeled is in `failed`, not here.
  fields(c, {
    movingSide: oneOf(SIDES), movingObjectId: isObjectId, burnTimeUtc: isIso, deltaVMs: isPos, direction: oneOf(DIRECTIONS),
    rank: isPosInt, missAfterKm: isNonNeg, tcaAfterUtc: isIso, relSpeedKmS: isNonNeg, deltaAKm: isNum, leadH: isPos,
  }, what);
  if (!passFlagAgrees(c.passesPairThreshold as boolean, c.missAfterKm as number)) fail(`${what} (passesPairThreshold)`);
  const mover = c.movingSide === "A" ? ctx.objectA : ctx.objectB;
  if (c.movingObjectId !== mover) fail(`${what} (moving object is not its side's object)`);
  // Debris, rocket bodies, nonoperational payloads and anything the caller did not allow never move (ROOM-14).
  if (ctx.objects[mover]?.maneuverability === "non_maneuverable") fail(`${what} (non-maneuverable moving object)`);
  if (!ctx.allowed.has(mover)) fail(`${what} (moving object outside the allowed list)`);
  if (ms(c.burnTimeUtc as string) >= ms(ctx.tcaUtc)) fail(`${what} (burn after closest approach)`);
  return c as unknown as ServiceCandidate;
}

function parseCandidates(v: unknown, req: CandidatesRequest): CandidatesResponse {
  const what = "candidates response";
  const r = rec(v, what);
  if (r.snapshotId !== req.snapshotId || r.evidenceVersion !== req.evidenceVersion) fail(`${what} for a different snapshot or evidence version`);
  if (r.objectA !== req.objectA || r.objectB !== req.objectB) fail(`${what} for a different pair`);
  fields(r, { tcaUtc: isIso, tcaInputUtc: isIso, missBeforeKm: isNonNeg, relSpeedKmS: isNonNeg, simulated: isBool, method: isStr }, what);
  if (ms(r.tcaInputUtc as string) !== ms(req.tcaUtc)) fail(`${what} (tcaInputUtc)`);
  if (Math.abs(ms(r.tcaUtc as string) - ms(req.tcaUtc)) > TCA_SEARCH_MS) fail(`${what} (TCA refined beyond the search window)`);
  const objects = parseObjects(r.objects, `${what} (objects)`);
  if (!(req.objectA in objects) || !(req.objectB in objects)) fail(`${what} (objects of the pair)`);
  const simulated = r.simulated as boolean;
  if (simulated !== (isSim(req.objectA) || isSim(req.objectB))) fail(`${what} (simulated flag)`);
  const frozen = new Set<string>();
  for (const n of list(r.notMovable, 2, `${what} (notMovable)`)) {
    const m = rec(n, "not-movable side");
    fields(m, { side: oneOf(SIDES), objectId: isObjectId, reason: isNonEmpty }, "not-movable side");
    if (m.objectId !== (m.side === "A" ? req.objectA : req.objectB)) fail("not-movable side (objectId)");
    frozen.add(m.objectId as string);
  }
  const ctx: CandidateContext = { objectA: req.objectA, objectB: req.objectB, tcaUtc: r.tcaUtc as string,
    allowed: new Set(req.allowedMovingObjectIds), objects, simulated };
  const candidates = list(r.candidates, MAX_CANDIDATES, `${what} (candidates)`).map(c => parseCandidate(c, ctx, "candidate"));
  if (candidates.some(c => c.kind === "maneuver" && frozen.has(c.movingObjectId as string))) fail("candidate (moving object listed as not movable)");
  // The grid comes in the service's policy-free order, ranked 1..n (candidates.py).
  if (candidates.some((c, i) => c.rank !== i + 1)) fail("candidate (rank order)");
  const wait = parseCandidate(r.wait, ctx, "wait candidate");
  if (wait.kind !== "wait" || wait.missBeforeKm !== r.missBeforeKm) fail("wait candidate (kind or miss before)");
  for (const f of list(r.failed, MAX_CANDIDATES, `${what} (failed)`)) fields(rec(f, "failed grid point"), { candidateId: isNonEmpty, reason: isStr }, "failed grid point");
  strList(r.assumptions, `${what} (assumptions)`);
  return r as unknown as CandidatesResponse;
}

function parseSimulate(v: unknown, req: SimulateRequest): SimulateResult {
  const what = "simulated object";
  const r = rec(v, what);
  if (!isSim(r.objectId)) fail(`${what} (ID)`);
  if (req.objectId !== undefined && r.objectId !== req.objectId) fail(`${what} for a different ID`);
  if (!isRecord(r.omm) || Object.keys(r.omm).length === 0) fail(`${what} (OMM)`);
  const tle = list(r.tle, 2, `${what} (TLE)`);
  if (tle.length !== 2 || !tle.every(isNonEmpty)) fail(`${what} (TLE)`);
  if (r.simulated !== true) fail(`${what} (simulated flag)`);
  const event = parsePair(r.event, "simulated event");
  if (event.objectA !== req.targetObjectId || event.objectB !== r.objectId || event.simulated !== true) fail("simulated event for a different pair");
  strList(r.assumptions, `${what} (assumptions)`);
  return r as unknown as SimulateResult;
}

function parseSources(v: unknown, what: string): void {
  for (const s of list(v, MAX_LIST, what)) {
    const src = rec(s, what);
    if ((src.name !== undefined && !isStr(src.name)) || (src.url !== undefined && !orNull(isStr)(src.url)) ||
      (src.epochUtc !== undefined && !orNull(isIso)(src.epochUtc)) || (src.fetchedAt !== undefined && !orNull(isIso)(src.fetchedAt))) fail(what);
  }
}

function parseVerification(v: unknown, req: VerifyRequest): Verification {
  const what = "verification";
  const r = rec(v, what);
  fields(r, {
    kind: oneOf(["live", "replay"] as const), result: oneOf(["awaiting_data", "consistent", "mismatch"] as const),
    label: isNonEmpty, elementSetCount: isCount, method: isStr, simulated: isBool,
  }, what);
  if (r.label !== VERIFY_LABELS[r.result as keyof typeof VERIFY_LABELS]) fail(`${what} (label does not match the result)`);
  // app.py derives the kind from the evidence given: a replay request is a replay verdict, anything else is live.
  if (r.kind !== (req.replay !== undefined ? "replay" : "live")) fail(`${what} (kind does not match the evidence given)`);
  const expected = rec(r.expected, "verification expectation");
  // The service rounds the expected Δa to 4 decimals, so a tiny expectation may read 0 while keeping its sign.
  if (!isNum(expected.deltaAKm) || (expected.sign !== 1 && expected.sign !== -1) ||
    (expected.deltaAKm !== 0 && Math.sign(expected.deltaAKm) !== expected.sign)) fail("verification expectation");
  // The expectation must be the one we asked about: same sign as the given Δa or the burn direction.
  const askedSign = req.expected.deltaAKm !== undefined ? Math.sign(req.expected.deltaAKm)
    : req.expected.direction === "retrograde" ? -1 : 1;
  if (expected.sign !== askedSign) fail("verification for a different expectation");
  if (r.observed !== null) fields(rec(r.observed, "verification observation"), { deltaAKm: isNum, z: isNum, epochUtc: isIso }, "verification observation");
  const series = list(r.series, MAX_EVENTS, "verification series");
  for (const p of series) fields(rec(p, "verification series point"), { epochUtc: isIso, smaKm: isPos }, "verification series point");
  if (r.elementSetCount !== series.length) fail(`${what} (elementSetCount)`);
  const thresholds = rec(r.thresholds, "verification thresholds");
  fields(thresholds, { z: isPos, minDeltaAKm: isPos, sizeTolerance: isPos, minSets: isPosInt }, "verification thresholds");
  // verify.py never reaches a verdict below its own minimum number of element sets.
  if (r.result !== "awaiting_data" && series.length < (thresholds.minSets as number)) fail(`${what} (verdict below the minimum element sets)`);
  // Live evidence is labeled from the catalog: simulated only for a SIM object. A replay carries its own label.
  if (req.replay === undefined && r.simulated !== isSim(req.objectId)) fail(`${what} (simulated flag)`);
  strList(r.limitations, `${what} (limitations)`);
  const missing = strList(r.missing, `${what} (missing)`);
  parseSources(r.sources, "verification source");
  // A verdict needs an observation and nothing missing; awaiting data names what is missing (it may still carry
  // an observation below the noise: absence of a jump is not a mismatch, VER-4).
  if (r.result === "awaiting_data" ? missing.length === 0 : r.observed === null || missing.length > 0) {
    fail(`${what} (verdict without matching evidence)`);
  }
  return r as unknown as Verification;
}

// ---------- Request checks ----------

// Times the client sends are whole seconds (contract: "times ISO 8601 UTC, whole seconds"); the service echoes
// them as such, and the echo checks compare exactly.
function checkTime(v: unknown, what: string) {
  if (!isIsoSecond(v)) badInput(what);
}
function checkWindow(fromUtc: unknown, toUtc: unknown, maxMs: number | null = MAX_WINDOW_MS) {
  checkTime(fromUtc, "time window");
  checkTime(toUtc, "time window");
  const span = ms(toUtc as string) - ms(fromUtc as string);
  if (span <= 0 || (maxMs !== null && span > maxMs)) badInput("time window");
}
function checkVersions(snapshotId: unknown, evidenceVersion: unknown, evidenceRequired: boolean) {
  if (!isNonEmpty(snapshotId)) badInput("snapshot ID");
  if ((evidenceRequired || evidenceVersion !== undefined) && !isNonEmpty(evidenceVersion)) badInput("evidence version");
}
function checkEcho(req: { proposalId?: unknown; revision?: unknown; runId?: unknown }) {
  if (req.proposalId !== undefined && !isNonEmpty(req.proposalId)) badInput("proposal ID");
  if (req.revision !== undefined && !isPosInt(req.revision)) badInput("revision");
  if (req.runId !== undefined && !isNonEmpty(req.runId)) badInput("run ID");
}
function checkPair(objectA: unknown, objectB: unknown) {
  if (!isObjectId(objectA) || !isObjectId(objectB) || objectA === objectB) badInput("object pair");
}

// ---------- Transport ----------

export interface OrbitConfig { url: string; token: string }

export function orbitConfig(env: Record<string, string | undefined> = process.env): OrbitConfig {
  const url = env.ORBIT_SERVICE_URL?.trim();
  const token = env.ORBIT_SERVICE_TOKEN?.trim();
  if (!url || !token) throw new OrbitServiceError("ORBIT_NOT_CONFIGURED", "Set ORBIT_SERVICE_URL and ORBIT_SERVICE_TOKEN in this Convex deployment.");
  if (!/^https?:\/\//.test(url)) throw new OrbitServiceError("ORBIT_NOT_CONFIGURED", "ORBIT_SERVICE_URL must be an http(s) URL.");
  return { url: url.replace(/\/+$/, ""), token };
}

export const orbitConfigured = (env: Record<string, string | undefined> = process.env) =>
  Boolean(env.ORBIT_SERVICE_URL?.trim() && env.ORBIT_SERVICE_TOKEN?.trim());

// Per-endpoint limits from the contract. A job submission and a job read are short; the work runs in the service.
export const ORBIT_TIMEOUTS = { submit: 5_000, job: 5_000, candidates: 15_000, simulate: 10_000, verify: 30_000 } as const;

// The service's own error codes (contract.md "Errors"). Anything else in a body is ignored.
const UPSTREAM_CODES = new Set(["UNAUTHORIZED", "VALIDATION", "NOT_FOUND", "SNAPSHOT_MISMATCH", "JOB_CONFLICT", "NOT_READY", "ERROR"]);

function mapFailure(status: number, body: unknown): OrbitServiceError {
  // Only the code is read from the error body. Its message may carry diagnostics that are never persisted.
  const raw = isRecord(body) && isRecord(body.error) && isStr(body.error.code) && UPSTREAM_CODES.has(body.error.code) ? body.error.code : null;
  const error = (code: OrbitErrorCode, message: string) => new OrbitServiceError(code, message, status, raw);
  if (status === 401 || status === 403 || raw === "UNAUTHORIZED") return error("ORBIT_ACCESS_DENIED", "The orbit service rejected the service credential.");
  if (status === 404 || raw === "NOT_FOUND") return error("NOT_FOUND", "The orbit service does not know this object, job or replay.");
  if (status === 429) return error("RATE_LIMITED", "The orbit service is rate limiting requests. Retry later.");
  if (raw === "SNAPSHOT_MISMATCH") return error("SNAPSHOT_MISMATCH", "The orbit service holds a different snapshot than the request pinned.");
  if (raw === "JOB_CONFLICT") return error("JOB_CONFLICT", "A job with this ID exists for a different request.");
  if (raw === "NOT_READY") return error("NOT_READY", "The orbit service is still computing this result. Retry later.");
  if (status === 400 || status === 409 || status === 422) return error("VALIDATION", "The orbit service rejected the request.");
  return error("UPSTREAM_UNAVAILABLE", "The orbit service is unavailable. Retry later.");
}

const TIMED_OUT = "The orbit service did not answer within the time limit. Retry later.";

async function request(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, accept: readonly number[] = [200]): Promise<unknown> {
  const { url, token } = orbitConfig();
  // AbortController + setTimeout instead of AbortSignal.timeout: both exist in the Convex default runtime.
  // The timer covers reading the body too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        method,
        headers: { "X-Service-Token": token, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Timeouts and network failures. Never echo the URL, headers or token.
      throw new OrbitServiceError("UPSTREAM_UNAVAILABLE", controller.signal.aborted ? TIMED_OUT : "The orbit service is unreachable. Retry later.");
    }
    let parsed: unknown = null;
    let json = true;
    try { parsed = await response.json(); } catch { json = false; }
    // A body that stalls past the limit is a timeout, not a malformed answer.
    if (controller.signal.aborted) throw new OrbitServiceError("UPSTREAM_UNAVAILABLE", TIMED_OUT, response.status);
    if (!accept.includes(response.status)) throw mapFailure(response.status, json ? parsed : null);
    if (!json) throw new OrbitServiceError("INVALID_RESPONSE", "Orbit service returned a response that is not JSON.", response.status);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Endpoints ----------

/** Deployment check: a reachable service must have loaded the expected pinned catalog. */
export async function getHealth(snapshotId: string): Promise<{ ok: true; snapshotId: string; objects: number }> {
  if (!isNonEmpty(snapshotId)) badInput("snapshot ID");
  const body = await request("GET", "/health", undefined, ORBIT_TIMEOUTS.job);
  if (!isRecord(body) || body.ok !== true || !isNonEmpty(body.snapshotId) ||
    typeof body.objects !== "number" || !Number.isSafeInteger(body.objects) || body.objects <= 0) {
    return fail("health response");
  }
  if (body.snapshotId !== snapshotId) throw new OrbitServiceError("SNAPSHOT_MISMATCH", "The orbit service loaded a different snapshot than expected.");
  return { ok: true, snapshotId: body.snapshotId, objects: body.objects };
}

/** POST /screen: reserves a fleet screening job. The job ID defaults to "screen-<scanId>", so the same scan never
 *  creates a second job: a resubmit returns the same job with `created: false`. */
export async function startScreen(req: ScreenRequest): Promise<JobAccepted> {
  if (!isNonEmpty(req.scanId)) badInput("scan ID");
  const jobId = req.jobId ?? `screen-${req.scanId}`;
  if (!JOB_ID.test(jobId)) badInput("job ID");
  checkVersions(req.snapshotId, req.evidenceVersion, false);
  const ids = req.primaryObjectIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PRIMARIES || !ids.every(isObjectId) || new Set(ids).size !== ids.length) {
    badInput("primary object list");
  }
  checkWindow(req.fromUtc, req.toUtc);
  checkEcho(req);
  const body = pick(req, ["scanId", "jobId", "snapshotId", "evidenceVersion", "primaryObjectIds", "fromUtc", "toUtc", "runId"]);
  return parseJobAccepted(await request("POST", "/screen", body, ORBIT_TIMEOUTS.submit, [200, 202]), jobId);
}

/** POST /rescreen: reserves a full-catalog re-screen of the exact proposed trajectory under the caller's job ID. */
export async function startRescreen(req: RescreenRequest): Promise<JobAccepted> {
  if (!isStr(req.jobId) || !JOB_ID.test(req.jobId)) badInput("job ID");
  checkVersions(req.snapshotId, req.evidenceVersion, true);
  checkPair(req.objectId, req.partnerObjectId);
  const m = req.maneuver;
  if (!isRecord(m) || !isIsoSecond(m.burnTimeUtc) || !isNum(m.deltaVMs) || m.deltaVMs <= 0 || m.deltaVMs > 1 || !oneOf(DIRECTIONS)(m.direction)) badInput("maneuver");
  checkTime(req.tcaUtc, "TCA");
  // rescreen.py: fromUtc ≤ burn, and the screened horizon (toUtc − burn) is at most 168 h; fromUtc itself may be earlier.
  checkWindow(req.fromUtc, req.toUtc, null);
  const burn = ms(m.burnTimeUtc);
  if (ms(req.fromUtc) > burn || ms(req.toUtc) <= burn || ms(req.toUtc) - burn > MAX_WINDOW_MS) badInput("time window around the burn");
  if (ms(req.tcaUtc) <= burn) badInput("TCA (the maneuver acts on the encounter that follows it)");
  checkEcho(req);
  const body = {
    ...pick(req, ["jobId", "snapshotId", "evidenceVersion", "objectId", "partnerObjectId", "tcaUtc", "fromUtc", "toUtc", "proposalId", "revision", "runId"]),
    maneuver: { burnTimeUtc: m.burnTimeUtc, deltaVMs: m.deltaVMs, direction: m.direction },
  };
  return parseJobAccepted(await request("POST", "/rescreen", body, ORBIT_TIMEOUTS.submit, [200, 202]), req.jobId);
}

function jobPath(jobId: string) {
  if (!isStr(jobId) || !JOB_ID.test(jobId)) badInput("job ID");
  return `/jobs/${encodeURIComponent(jobId)}`;
}

/** GET /jobs/{id} for a screening job. One bounded request; the caller schedules the next poll. */
export async function getScreenJob(jobId: string, expected: ScreenExpectation): Promise<OrbitJob<ScreenResult>> {
  return parseJob(await request("GET", jobPath(jobId), undefined, ORBIT_TIMEOUTS.job), jobId, "screen", v => parseScreenResult(v, expected));
}

/** GET /jobs/{id} for a re-screen job. One bounded request; the caller schedules the next poll. */
export async function getRescreenJob(jobId: string, expected: RescreenExpectation): Promise<OrbitJob<RescreenResult>> {
  return parseJob(await request("GET", jobPath(jobId), undefined, ORBIT_TIMEOUTS.job), jobId, "rescreen", v => parseRescreenResult(v, expected));
}

/** POST /candidates: the policy-free grid of options for one event version. No policy is applied here. */
export async function getCandidates(req: CandidatesRequest): Promise<CandidatesResponse> {
  checkVersions(req.snapshotId, req.evidenceVersion, true);
  checkPair(req.objectA, req.objectB);
  checkTime(req.tcaUtc, "TCA");
  if (req.notBeforeUtc !== undefined) checkTime(req.notBeforeUtc, "not-before time");
  const allowed = req.allowedMovingObjectIds;
  if (!Array.isArray(allowed) || allowed.length > 2 || new Set(allowed).size !== allowed.length ||
    !allowed.every(id => id === req.objectA || id === req.objectB)) badInput("allowed moving objects");
  checkEcho(req);
  const body = pick(req, ["snapshotId", "evidenceVersion", "objectA", "objectB", "tcaUtc", "allowedMovingObjectIds", "notBeforeUtc", "proposalId", "revision", "runId"]);
  return parseCandidates(await request("POST", "/candidates", body, ORBIT_TIMEOUTS.candidates), req);
}

/** POST /simulate: deterministic, flagged demo orbit. The returned ID is always a reserved SIM- ID. The target is a
 *  real catalog object (SCR-10: the demo satellite meets a real one); the service itself would accept a SIM target. */
export async function simulate(req: SimulateRequest): Promise<SimulateResult> {
  if (!isObjectId(req.targetObjectId) || isSim(req.targetObjectId)) badInput("target object ID");
  checkTime(req.tcaUtc, "TCA");
  if (req.name !== undefined && (!isNonEmpty(req.name) || req.name.length > 80)) badInput("name");
  if (req.objectId !== undefined && !isSim(req.objectId)) badInput("simulated object ID");
  if (req.tiltDeg !== undefined && !(isNum(req.tiltDeg) && req.tiltDeg > 0 && req.tiltDeg <= 10)) badInput("tilt");
  if (req.missKm !== undefined && !(isNum(req.missKm) && req.missKm >= 0.05 && req.missKm <= 5)) badInput("miss distance");
  if (req.deltaAKm !== undefined && !(isNum(req.deltaAKm) && Math.abs(req.deltaAKm) <= 50)) badInput("semi-major axis offset");
  const body = pick(req, ["targetObjectId", "tcaUtc", "name", "objectId", "tiltDeg", "missKm", "deltaAKm"]);
  return parseSimulate(await request("POST", "/simulate", body, ORBIT_TIMEOUTS.simulate), req);
}

/** POST /verify: numerical comparison against element-set evidence. Stored apart from the schedule file. The
 *  simulated label comes from the service's catalog, never from the caller. */
export async function verify(req: VerifyRequest): Promise<Verification> {
  if (!isObjectId(req.objectId)) badInput("object ID");
  const e = req.expected;
  if (!isRecord(e) || !isIsoSecond(e.burnTimeUtc)) badInput("expectation");
  if (e.deltaVMs !== undefined && !isPos(e.deltaVMs)) badInput("expectation (deltaVMs)");
  if (e.direction !== undefined && !oneOf(DIRECTIONS)(e.direction)) badInput("expectation (direction)");
  if (e.deltaAKm !== undefined && (!isNum(e.deltaAKm) || e.deltaAKm === 0)) badInput("expectation (deltaAKm)");
  if (e.deltaVMs === undefined && e.deltaAKm === undefined) badInput("expectation (give deltaVMs or deltaAKm)");
  if (req.series !== undefined) {
    if (!Array.isArray(req.series) || req.series.length > MAX_EVENTS) badInput("element set series");
    for (const p of req.series) {
      // verify.py reads smaKm when present, else the mean motion; a set with neither is dropped there, refused here.
      if (!isRecord(p) || !isIso(p.epochUtc) || (p.meanMotionRevPerDay === undefined && p.smaKm === undefined) ||
        (p.meanMotionRevPerDay !== undefined && !isPos(p.meanMotionRevPerDay)) || (p.smaKm !== undefined && !isPos(p.smaKm))) badInput("element set");
    }
  }
  if (req.replay !== undefined && (!isStr(req.replay) || !REPLAY_NAME.test(req.replay))) badInput("replay name");
  if (req.series !== undefined && req.replay !== undefined) badInput("evidence (give series or replay, not both)");
  if (req.kind !== undefined && !oneOf(["live", "replay"] as const)(req.kind)) badInput("kind");
  // verify.py: a kind that contradicts the evidence given is a 400.
  if (req.kind !== undefined && req.kind !== (req.replay !== undefined ? "replay" : "live")) badInput("kind (contradicts the evidence given)");
  if (req.sources !== undefined && !Array.isArray(req.sources)) badInput("sources");
  const body = { ...pick(req, ["objectId", "series", "replay", "kind", "sources"]), expected: pick(e, ["burnTimeUtc", "deltaVMs", "direction", "deltaAKm"]) };
  return parseVerification(await request("POST", "/verify", body, ORBIT_TIMEOUTS.verify), req);
}

// ---------- Failure mapping ----------

/** Maps any error to a code and message safe to persist or show. Raw upstream text never passes through. */
export function orbitFailure(error: unknown): { code: OrbitErrorCode; message: string } {
  if (error instanceof OrbitServiceError) return { code: error.code, message: error.message };
  return { code: "UPSTREAM_UNAVAILABLE", message: "The orbit service request did not complete. Retry later." };
}
