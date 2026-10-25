// Convex-side client for the Python orbit service (services/orbit/, roadmap §7, spec Appendix A).
// Plain fetch, no "use node": it runs in the default Convex runtime and tests stub global fetch.
// One bounded request per call. Polling GET /jobs/{id} belongs to the scheduler in scans.ts and
// maneuvers.ts, never to a loop here or inside a mutation.
// Responses are parsed strictly: exact keys, null stays null (never 0), echoed versions must match.

export type ISODate = string;
export type ObjectId = string;

export type OrbitErrorCode =
  | "ORBIT_NOT_CONFIGURED" | "ORBIT_ACCESS_DENIED" | "RATE_LIMITED" | "NOT_FOUND"
  | "REQUEST_REJECTED" | "INVALID_REQUEST" | "INVALID_RESPONSE" | "UPSTREAM_UNAVAILABLE";

export class OrbitServiceError extends Error {
  constructor(readonly code: OrbitErrorCode, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "OrbitServiceError";
  }
}

// ---------- Shapes (spec §2.2, §2.5, §2.6, Appendix A) ----------

export interface SourceSpread {
  gpMissKm: number | null;
  supgpMissKm: number | null;
  minKm: number | null;
  maxKm: number | null;
  gpEpochUtc: ISODate | null;
  supgpEpochUtc: ISODate | null;
}

export interface ScreenedEvent {
  objectA: ObjectId;
  objectB: ObjectId;
  tcaUtc: ISODate;
  missKm: number;
  relSpeedKmS: number;
  spread: SourceSpread;
}

export interface Coverage {
  complete: boolean;
  catalogScope: string;
  excludedObjects: number;
  reasons: { reason: string; count: number }[];
}

export interface ScreenResult {
  scanId: string;
  snapshotId: string;
  coverage: Coverage;
  events: ScreenedEvent[];
}

export interface Rescreen {
  passed: boolean;
  objectsChecked: number;
  horizonH: number;
  originalMissAfterKm: number;
  newConjunctions: { objectId: ObjectId; name: string; tcaUtc: ISODate; missKm: number }[];
  refusalReason: string | null;
}

export interface RescreenResult extends Rescreen {
  snapshotId: string;
  evidenceVersion: string;
}

export type JobKind = "screen" | "rescreen";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface OrbitJob<R> {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  progress: number | null;              // measured fraction; null when indeterminate
  counts: Record<string, number>;       // measured counters, passed through as reported
  coverage: Coverage | null;            // null until the service knows it
  result: R | null;                     // only when completed
  error: { code: string; message: string } | null;   // only when failed
}

// Mirrors Andrew's OrbitCandidatesResponse (andrew-r1-candidate-cards); field names must stay identical.
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

export interface SimulateResult {
  objectId: ObjectId;                   // reserved simulated ID, "SIM-0001"
  omm: Record<string, unknown>;
  event: ScreenedEvent;
}

export type SourceName =
  | "celestrak_gp" | "celestrak_supgp" | "socrates" | "cdm_public"
  | "gp_history" | "keeptrack" | "simulated" | "celestrak_satcat";

export interface SourceRef { name: SourceName; url: string | null; epochUtc: ISODate | null; fetchedAt: ISODate | null }

export interface Verification {
  kind: "live" | "replay";
  result: "awaiting_data" | "consistent" | "mismatch";
  label: string;
  expected: { deltaAKm: number; sign: 1 | -1 };
  observed: { deltaAKm: number; z: number; epochUtc: ISODate } | null;
  elementSetCount: number;
  series: { epochUtc: ISODate; smaKm: number }[];
  thresholds: { z: number; minDeltaAKm: number; sizeTolerance: number; minSets: number };
  method: string;
  limitations: string[];
  missing: string[];
  sources: SourceRef[];
}

// ---------- Requests ----------

export interface ScreenRequest { scanId: string; snapshotId: string; primaryObjectIds: ObjectId[]; fromUtc: ISODate; toUtc: ISODate }
export interface CandidatesRequest {
  eventId: string; snapshotId: string; evidenceVersion: string;
  objectA: ObjectId; objectB: ObjectId; tcaUtc: ISODate; allowedMovingObjectIds: ObjectId[];
}
export interface ManeuverInput { burnTimeUtc: ISODate; deltaVMs: number; direction: "prograde" | "retrograde" }
export interface RescreenRequest {
  snapshotId: string; evidenceVersion: string; objectId: ObjectId; maneuver: ManeuverInput; fromUtc: ISODate; toUtc: ISODate;
}
export interface SimulateRequest { targetObjectId: ObjectId; tcaUtc: ISODate; name: string }
export interface VerifyRequest { objectId: ObjectId; expected: { deltaAKm: number; sign: 1 | -1 } }

// ---------- Validation helpers ----------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const OBJECT_ID = /^(\d{1,9}|SIM-\d{4})$/;
const SIM_ID = /^SIM-\d{4}$/;
const MAX_EVENTS = 10_000;
const MAX_CANDIDATES = 100;
const MAX_PRIMARIES = 1_000;

type Rec = Record<string, unknown>;
const bad = (what: string): never => { throw new OrbitServiceError("INVALID_RESPONSE", `Orbit service returned an unexpected ${what}.`); };
const badInput = (what: string): never => { throw new OrbitServiceError("INVALID_REQUEST", `Orbit request has an invalid ${what}.`); };

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));
const isObjectId = (v: unknown): v is string => typeof v === "string" && OBJECT_ID.test(v);
const orNull = <T>(check: (v: unknown) => v is T) => (v: unknown): v is T | null => v === null || check(v);

function record(v: unknown, keys: string[], what: string): Rec {
  if (!isRecord(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) bad(what);
  return v as Rec;
}
function list(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) bad(what);
  return v as unknown[];
}

function parseSpread(v: unknown): SourceSpread {
  const s = record(v, ["gpMissKm", "supgpMissKm", "minKm", "maxKm", "gpEpochUtc", "supgpEpochUtc"], "source spread");
  if (![s.gpMissKm, s.supgpMissKm, s.minKm, s.maxKm].every(orNull(isNum)) ||
    !orNull(isIso)(s.gpEpochUtc) || !orNull(isIso)(s.supgpEpochUtc)) bad("source spread");
  return s as unknown as SourceSpread;
}

function parseEvent(v: unknown): ScreenedEvent {
  const e = record(v, ["objectA", "objectB", "tcaUtc", "missKm", "relSpeedKmS", "spread"], "event");
  if (!isObjectId(e.objectA) || !isObjectId(e.objectB) || e.objectA === e.objectB || !isIso(e.tcaUtc) ||
    !isNum(e.missKm) || e.missKm < 0 || !isNum(e.relSpeedKmS) || e.relSpeedKmS < 0) bad("event");
  parseSpread(e.spread);
  return e as unknown as ScreenedEvent;
}

function parseCoverage(v: unknown): Coverage {
  const c = record(v, ["complete", "catalogScope", "excludedObjects", "reasons"], "coverage");
  if (typeof c.complete !== "boolean" || !isStr(c.catalogScope) || !isCount(c.excludedObjects)) bad("coverage");
  for (const r of list(c.reasons, 100, "coverage")) {
    const reason = record(r, ["reason", "count"], "coverage reason");
    if (!isNonEmpty(reason.reason) || !isCount(reason.count)) bad("coverage reason");
  }
  return c as unknown as Coverage;
}

function parseScreenResult(v: unknown, expected: { scanId: string; snapshotId: string }): ScreenResult {
  const r = record(v, ["scanId", "snapshotId", "coverage", "events"], "screen result");
  if (r.scanId !== expected.scanId || r.snapshotId !== expected.snapshotId) bad("screen result for a different scan or snapshot");
  parseCoverage(r.coverage);
  list(r.events, MAX_EVENTS, "screen result").forEach(parseEvent);
  return r as unknown as ScreenResult;
}

function parseRescreenResult(v: unknown, expected: { snapshotId: string; evidenceVersion: string }): RescreenResult {
  const r = record(v, ["snapshotId", "evidenceVersion", "passed", "objectsChecked", "horizonH",
    "originalMissAfterKm", "newConjunctions", "refusalReason"], "re-screen result");
  if (r.snapshotId !== expected.snapshotId || r.evidenceVersion !== expected.evidenceVersion) {
    bad("re-screen result for a different snapshot or evidence version");
  }
  if (typeof r.passed !== "boolean" || !isCount(r.objectsChecked) || !isNum(r.horizonH) || r.horizonH <= 0 ||
    !isNum(r.originalMissAfterKm) || r.originalMissAfterKm < 0 || !orNull(isStr)(r.refusalReason)) bad("re-screen result");
  const conjunctions = list(r.newConjunctions, MAX_EVENTS, "re-screen result").map(c => {
    const n = record(c, ["objectId", "name", "tcaUtc", "missKm"], "new conjunction");
    if (!isObjectId(n.objectId) || !isStr(n.name) || !isIso(n.tcaUtc) || !isNum(n.missKm) || n.missKm < 0) bad("new conjunction");
    return n as unknown as Rescreen["newConjunctions"][number];
  });
  // Spec §2.5: a pass needs original miss ≥ 1 km and no new conjunction under 1 km. A pass that breaks this is not trusted.
  if (r.passed && ((r.originalMissAfterKm as number) < 1 || conjunctions.some(c => c.missKm < 1) || r.refusalReason !== null)) {
    bad("re-screen pass that does not meet the pass rule");
  }
  if (!r.passed && !isNonEmpty(r.refusalReason)) bad("re-screen refusal without a reason");
  return r as unknown as RescreenResult;
}

function parseJob<R>(v: unknown, jobId: string, kind: JobKind, parseResult: (value: unknown) => R): OrbitJob<R> {
  const j = record(v, ["jobId", "kind", "status", "phase", "progress", "counts", "coverage", "result", "error"], "job");
  if (j.jobId !== jobId) bad("job for a different job ID");
  if (j.kind !== kind) bad("job kind");
  if (!["queued", "running", "completed", "failed"].includes(j.status as string) || !isNonEmpty(j.phase)) bad("job status");
  if (!(j.progress === null || (isNum(j.progress) && j.progress >= 0 && j.progress <= 1))) bad("job progress");
  if (!isRecord(j.counts) || !Object.values(j.counts).every(isCount)) bad("job counters");
  if (j.coverage !== null) parseCoverage(j.coverage);
  if (j.error !== null) {
    const e = record(j.error, ["code", "message"], "job error");
    if (!isNonEmpty(e.code) || !isStr(e.message)) bad("job error");
  }
  const status = j.status as JobStatus;
  if (status === "completed" && (j.result === null || j.error !== null)) bad("completed job without a result");
  if (status === "failed" && (j.error === null || j.result !== null)) bad("failed job without an error");
  if ((status === "queued" || status === "running") && (j.result !== null || j.error !== null)) bad("unfinished job with a result");
  const result = j.result === null ? null : parseResult(j.result);
  return { ...(j as unknown as OrbitJob<R>), result };
}

function parseJobAccepted(v: unknown): { jobId: string } {
  const r = record(v, ["jobId"], "job acceptance");
  if (!isNonEmpty(r.jobId) || r.jobId.length > 200) bad("job acceptance");
  return { jobId: r.jobId as string };
}

function parseCandidates(v: unknown, req: CandidatesRequest): OrbitCandidatesResponse {
  const r = record(v, ["eventId", "evidenceVersion", "snapshotId", "simulated", "candidates"], "candidates response");
  if (r.eventId !== req.eventId || r.evidenceVersion !== req.evidenceVersion || r.snapshotId !== req.snapshotId) {
    bad("candidates response for a different event or evidence version");
  }
  if (typeof r.simulated !== "boolean") bad("candidates response");
  const allowed = new Set(req.allowedMovingObjectIds);
  for (const item of list(r.candidates, MAX_CANDIDATES, "candidates response")) {
    const c = record(item, ["kind", "movingObjectId", "burnTimeUtc", "direction", "deltaVMs",
      "estimatedFuelKg", "missAfterKm", "reviewCondition", "assumptions"], "candidate");
    if (!orNull(isNum)(c.estimatedFuelKg) || !orNull(isNum)(c.missAfterKm) || !orNull(isStr)(c.reviewCondition) ||
      !Array.isArray(c.assumptions) || !c.assumptions.every(isStr)) bad("candidate");
    if (c.kind === "maneuver") {
      if (!isStr(c.movingObjectId) || !isIso(c.burnTimeUtc) || (c.direction !== "prograde" && c.direction !== "retrograde") ||
        !isNum(c.deltaVMs) || c.deltaVMs <= 0) bad("maneuver candidate");
      // Debris and anything else the caller did not allow can never be the moving object.
      if (!allowed.has(c.movingObjectId as string)) bad("maneuver candidate for an object that is not allowed to move");
    } else if (c.kind === "wait") {
      if (c.movingObjectId !== null || c.burnTimeUtc !== null || c.direction !== null || c.deltaVMs !== null) bad("wait candidate");
    } else bad("candidate kind");
  }
  return r as unknown as OrbitCandidatesResponse;
}

function parseSimulate(v: unknown, req: SimulateRequest): SimulateResult {
  const r = record(v, ["objectId", "omm", "event"], "simulated object");
  if (!isStr(r.objectId) || !SIM_ID.test(r.objectId)) bad("simulated object ID");
  if (!isRecord(r.omm) || Object.keys(r.omm).length === 0) bad("simulated OMM");
  const event = parseEvent(r.event);
  const pair = [event.objectA, event.objectB];
  if (!pair.includes(r.objectId as string) || !pair.includes(req.targetObjectId)) bad("simulated event for a different pair");
  return r as unknown as SimulateResult;
}

const SOURCE_NAMES = new Set(["celestrak_gp", "celestrak_supgp", "socrates", "cdm_public", "gp_history", "keeptrack", "simulated", "celestrak_satcat"]);

function parseVerification(v: unknown, req: VerifyRequest): Verification {
  const r = record(v, ["kind", "result", "label", "expected", "observed", "elementSetCount", "series",
    "thresholds", "method", "limitations", "missing", "sources"], "verification");
  if ((r.kind !== "live" && r.kind !== "replay") || !["awaiting_data", "consistent", "mismatch"].includes(r.result as string) ||
    !isNonEmpty(r.label) || !isCount(r.elementSetCount) || !isStr(r.method)) bad("verification");
  const expected = record(r.expected, ["deltaAKm", "sign"], "verification expectation");
  if (expected.deltaAKm !== req.expected.deltaAKm || expected.sign !== req.expected.sign) bad("verification for a different expectation");
  if (r.observed !== null) {
    const o = record(r.observed, ["deltaAKm", "z", "epochUtc"], "verification observation");
    if (!isNum(o.deltaAKm) || !isNum(o.z) || !isIso(o.epochUtc)) bad("verification observation");
  }
  // A consistent or mismatch verdict needs an observation; awaiting data must not carry one.
  if ((r.result === "awaiting_data") !== (r.observed === null)) bad("verification verdict without matching evidence");
  for (const p of list(r.series, MAX_EVENTS, "verification series")) {
    const point = record(p, ["epochUtc", "smaKm"], "verification series point");
    if (!isIso(point.epochUtc) || !isNum(point.smaKm)) bad("verification series point");
  }
  const t = record(r.thresholds, ["z", "minDeltaAKm", "sizeTolerance", "minSets"], "verification thresholds");
  if (![t.z, t.minDeltaAKm, t.sizeTolerance, t.minSets].every(isNum)) bad("verification thresholds");
  for (const field of ["limitations", "missing"] as const) {
    if (!list(r[field], 100, "verification").every(isStr)) bad("verification");
  }
  for (const s of list(r.sources, 100, "verification sources")) {
    const src = record(s, ["name", "url", "epochUtc", "fetchedAt"], "verification source");
    if (!SOURCE_NAMES.has(src.name as string) || !orNull(isStr)(src.url) || !orNull(isIso)(src.epochUtc) ||
      !orNull(isIso)(src.fetchedAt)) bad("verification source");
  }
  return r as unknown as Verification;
}

// ---------- Request checks ----------

function checkWindow(fromUtc: unknown, toUtc: unknown) {
  if (!isIso(fromUtc) || !isIso(toUtc) || Date.parse(toUtc) <= Date.parse(fromUtc)) badInput("time window");
}
function checkVersions(snapshotId: unknown, evidenceVersion?: unknown) {
  if (!isNonEmpty(snapshotId)) badInput("snapshot ID");
  if (evidenceVersion !== undefined && !isNonEmpty(evidenceVersion)) badInput("evidence version");
}

// ---------- Transport ----------

export function orbitConfig() {
  const url = process.env.ORBIT_SERVICE_URL;
  const token = process.env.ORBIT_SERVICE_TOKEN;
  if (!url || !token) throw new OrbitServiceError("ORBIT_NOT_CONFIGURED", "Set ORBIT_SERVICE_URL and ORBIT_SERVICE_TOKEN in this Convex deployment.");
  return { url: url.replace(/\/+$/, ""), token };
}

export const ORBIT_TIMEOUT_MS = 20_000;

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const { url, token } = orbitConfig();
  // AbortController + setTimeout instead of AbortSignal.timeout: both exist in the Convex default runtime.
  // The timer covers reading the body too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORBIT_TIMEOUT_MS);
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
      throw new OrbitServiceError("UPSTREAM_UNAVAILABLE", "The orbit service did not respond. Retry later.");
    }
    if (!response.ok) {
      const s = response.status;
      // The upstream body is never read into an error: it may contain diagnostics we do not persist.
      if (s === 401 || s === 403) throw new OrbitServiceError("ORBIT_ACCESS_DENIED", "The orbit service rejected the service credential.", s);
      if (s === 404) throw new OrbitServiceError("NOT_FOUND", "The orbit service does not know this resource.", s);
      if (s === 429) throw new OrbitServiceError("RATE_LIMITED", "The orbit service is rate limiting requests. Retry later.", s);
      if (s === 400 || s === 409 || s === 422) throw new OrbitServiceError("REQUEST_REJECTED", "The orbit service rejected the request.", s);
      throw new OrbitServiceError("UPSTREAM_UNAVAILABLE", "The orbit service is unavailable. Retry later.", s);
    }
    try {
      return await response.json();
    } catch {
      throw new OrbitServiceError("INVALID_RESPONSE", "Orbit service returned a response that is not JSON.", response.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Endpoints ----------

/** POST /screen: reserves a full-fleet screening job and returns only its ID. */
export async function startScreen(req: ScreenRequest): Promise<{ jobId: string }> {
  if (!isNonEmpty(req.scanId)) badInput("scan ID");
  checkVersions(req.snapshotId);
  if (!Array.isArray(req.primaryObjectIds) || req.primaryObjectIds.length === 0 || req.primaryObjectIds.length > MAX_PRIMARIES ||
    !req.primaryObjectIds.every(isObjectId) || new Set(req.primaryObjectIds).size !== req.primaryObjectIds.length) badInput("primary object list");
  checkWindow(req.fromUtc, req.toUtc);
  const { scanId, snapshotId, primaryObjectIds, fromUtc, toUtc } = req;
  return parseJobAccepted(await request("POST", "/screen", { scanId, snapshotId, primaryObjectIds, fromUtc, toUtc }));
}

/** POST /rescreen: reserves a full-catalog re-screen of the exact proposed trajectory. */
export async function startRescreen(req: RescreenRequest): Promise<{ jobId: string }> {
  checkVersions(req.snapshotId, req.evidenceVersion);
  if (!isObjectId(req.objectId)) badInput("object ID");
  const m = req.maneuver;
  if (!isRecord(m) || !isIso(m.burnTimeUtc) || !isNum(m.deltaVMs) || m.deltaVMs <= 0 ||
    (m.direction !== "prograde" && m.direction !== "retrograde")) badInput("maneuver");
  checkWindow(req.fromUtc, req.toUtc);
  const { snapshotId, evidenceVersion, objectId, fromUtc, toUtc } = req;
  const maneuver = { burnTimeUtc: m.burnTimeUtc, deltaVMs: m.deltaVMs, direction: m.direction };
  return parseJobAccepted(await request("POST", "/rescreen", { snapshotId, evidenceVersion, objectId, maneuver, fromUtc, toUtc }));
}

function jobPath(jobId: string) {
  if (!isNonEmpty(jobId) || jobId.length > 200) badInput("job ID");
  return `/jobs/${encodeURIComponent(jobId)}`;
}

/** GET /jobs/{id} for a screening job. One bounded request; the caller schedules the next poll. */
export async function getScreenJob(jobId: string, expected: { scanId: string; snapshotId: string }): Promise<OrbitJob<ScreenResult>> {
  return parseJob(await request("GET", jobPath(jobId)), jobId, "screen", v => parseScreenResult(v, expected));
}

/** GET /jobs/{id} for a re-screen job. One bounded request; the caller schedules the next poll. */
export async function getRescreenJob(jobId: string, expected: { snapshotId: string; evidenceVersion: string }): Promise<OrbitJob<RescreenResult>> {
  return parseJob(await request("GET", jobPath(jobId)), jobId, "rescreen", v => parseRescreenResult(v, expected));
}

/** POST /candidates: bounded grid of options for one event version. No policy is applied here. */
export async function getCandidates(req: CandidatesRequest): Promise<OrbitCandidatesResponse> {
  if (!isNonEmpty(req.eventId)) badInput("event ID");
  checkVersions(req.snapshotId, req.evidenceVersion);
  if (!isObjectId(req.objectA) || !isObjectId(req.objectB) || req.objectA === req.objectB) badInput("object pair");
  if (!isIso(req.tcaUtc)) badInput("TCA");
  if (!Array.isArray(req.allowedMovingObjectIds) ||
    !req.allowedMovingObjectIds.every(id => id === req.objectA || id === req.objectB)) badInput("allowed moving objects");
  const { eventId, snapshotId, evidenceVersion, objectA, objectB, tcaUtc, allowedMovingObjectIds } = req;
  return parseCandidates(await request("POST", "/candidates",
    { eventId, snapshotId, evidenceVersion, objectA, objectB, tcaUtc, allowedMovingObjectIds }), req);
}

/** POST /simulate: deterministic, flagged demo orbit. The returned ID is always a reserved SIM- ID. */
export async function simulate(req: SimulateRequest): Promise<SimulateResult> {
  if (!isObjectId(req.targetObjectId) || SIM_ID.test(req.targetObjectId)) badInput("target object ID");
  if (!isIso(req.tcaUtc)) badInput("TCA");
  if (!isNonEmpty(req.name) || req.name.length > 80) badInput("name");
  const { targetObjectId, tcaUtc, name } = req;
  return parseSimulate(await request("POST", "/simulate", { targetObjectId, tcaUtc, name }), req);
}

/** POST /verify: numerical comparison against supplied observations. Stored apart from the schedule file. */
export async function verify(req: VerifyRequest): Promise<Verification> {
  if (!isObjectId(req.objectId)) badInput("object ID");
  if (!isRecord(req.expected) || !isNum(req.expected.deltaAKm) || (req.expected.sign !== 1 && req.expected.sign !== -1)) badInput("expectation");
  const { objectId, expected } = req;
  return parseVerification(await request("POST", "/verify",
    { objectId, expected: { deltaAKm: expected.deltaAKm, sign: expected.sign } }), req);
}

// ---------- Failure mapping ----------

/** Maps any error to a code and message safe to persist or show. Raw upstream text never passes through. */
export function orbitFailure(error: unknown): { code: OrbitErrorCode; message: string } {
  if (error instanceof OrbitServiceError) return { code: error.code, message: error.message };
  return { code: "UPSTREAM_UNAVAILABLE", message: "The orbit service request did not complete. Retry later." };
}
