// Typed client for the orbital service (services/orbit, contract: services/orbit/docs/contract.md).
// Only Convex actions call it; the browser never does. Every failure the caller cannot fix becomes
// UPSTREAM_UNAVAILABLE (spec §6): the service is down, slow, misconfigured or answered with nonsense.
// Request errors the caller can fix keep the service's code (VALIDATION, NOT_FOUND, SNAPSHOT_MISMATCH, JOB_CONFLICT).

export type ObjectId = string;
export type Direction = "prograde" | "retrograde";
export type Side = "A" | "B";

export class OrbitError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "OrbitError";
  }
}

const PASS_THROUGH = new Set(["VALIDATION", "NOT_FOUND", "SNAPSHOT_MISMATCH", "JOB_CONFLICT", "NOT_READY"]);

// Suggested timeouts from the contract, in milliseconds.
export const ORBIT_TIMEOUTS = {
  health: 5_000, snapshot: 5_000, candidates: 15_000, rescreenSubmit: 5_000, job: 5_000,
  screenSubmit: 5_000, verify: 30_000, simulate: 10_000, validation: 5_000, objects: 5_000,
} as const;

export interface OrbitConfig { url: string; token: string }

export function orbitConfig(env: Record<string, string | undefined> = process.env): OrbitConfig {
  const url = env.ORBIT_SERVICE_URL?.trim();
  const token = env.ORBIT_SERVICE_TOKEN?.trim();
  if (!url || !token) throw new OrbitError("UPSTREAM_UNAVAILABLE", "The orbital service is not configured.");
  if (!/^https?:\/\//.test(url)) throw new OrbitError("UPSTREAM_UNAVAILABLE", "The orbital service URL is invalid.");
  return { url: url.replace(/\/+$/, ""), token };
}

export const orbitConfigured = (env: Record<string, string | undefined> = process.env) =>
  Boolean(env.ORBIT_SERVICE_URL?.trim() && env.ORBIT_SERVICE_TOKEN?.trim());

interface RequestOptions { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; auth?: boolean; accept?: number[] }

export async function orbitRequest<T>(config: OrbitConfig, path: string, options: RequestOptions): Promise<{ status: number; body: T }> {
  const { method = "GET", body, timeoutMs, auth = true, accept = [200] } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method, signal: controller.signal,
      headers: {
        ...(auth ? { "X-Service-Token": config.token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Never echo the request (it carries the token) or the raw error into stored state.
    const timedOut = controller.signal.aborted;
    throw new OrbitError("UPSTREAM_UNAVAILABLE", timedOut ? "The orbital service timed out." : "The orbital service is unreachable.");
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (accept.includes(response.status)) {
    if (parsed === null || typeof parsed !== "object") {
      throw new OrbitError("UPSTREAM_UNAVAILABLE", "The orbital service returned an unreadable answer.", response.status);
    }
    return { status: response.status, body: parsed as T };
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message.slice(0, 300) : `HTTP ${response.status}`;
  if (response.status === 401) throw new OrbitError("UPSTREAM_UNAVAILABLE", "The orbital service rejected the service token.", 401);
  if (code && PASS_THROUGH.has(code) && response.status < 500 || code === "NOT_READY") throw new OrbitError(code, message, response.status);
  throw new OrbitError("UPSTREAM_UNAVAILABLE", `The orbital service failed: ${message}`, response.status);
}

// ---- Shapes (contract v2.1–v2.3). Only the fields Convex reads are typed strictly. ----

export interface SourceRef { url?: string; format?: string; fetchedAt?: string; sha256?: string; epochUtc?: string }
export interface ObjectInfo {
  objectId: ObjectId; name: string; kind: "payload" | "debris" | "rocket_body" | "unknown";
  maneuverability: "maneuverable" | "non_maneuverable" | "unknown";
  classificationBasis: string; operationalStatus: string | null; group: string; simulated: boolean;
}

export interface CandidatesRequest {
  objectA: ObjectId; objectB: ObjectId; tcaUtc: string;
  notBeforeUtc?: string; snapshotId?: string; evidenceVersion?: string; allowedMovingObjectIds?: ObjectId[];
}
export interface ServiceCandidate {
  candidateId: string; kind: "maneuver" | "wait";
  movingSide: Side | null; movingObjectId: ObjectId | null;
  burnTimeUtc: string | null; leadH: number | null;
  deltaVMs: number | null; direction: Direction | null; deltaAKm: number | null;
  missBeforeKm: number; missAfterKm: number | null;
  tcaAfterUtc: string | null; relSpeedKmS: number | null;
  passesPairThreshold: boolean; estimatedFuelKg: null;
  indicative: true; simulated: boolean; rank: number | null;
}
export interface CandidatesResponse {
  snapshotId: string; evidenceVersion: string | null;
  objectA: ObjectId; objectB: ObjectId;
  objects: Record<ObjectId, ObjectInfo>;
  notMovable: { side: Side; objectId: ObjectId; reason: string }[];
  tcaUtc: string; tcaInputUtc: string;
  missBeforeKm: number; relSpeedKmS: number; simulated: boolean;
  candidates: ServiceCandidate[]; wait: ServiceCandidate;
  failed: { candidateId: string; reason: string }[];
  assumptions: string[]; method: string;
}

export interface Maneuver { burnTimeUtc: string; deltaVMs: number; direction: Direction }
export interface RescreenRequest {
  jobId: string; objectId: ObjectId; maneuver: Maneuver;
  partnerObjectId?: ObjectId; tcaUtc?: string; horizonH?: number;
  snapshotId?: string; evidenceVersion?: string; fromUtc?: string; toUtc?: string;
  proposalId?: string; revision?: number; runId?: string;
}
export interface RescreenResult {
  passed: boolean; objectsChecked: number; objectsInCatalog: number; horizonH: number;
  originalMissAfterKm: number | null;
  newConjunctions: { objectId: ObjectId; name: string; tcaUtc: string; missKm: number; withoutManeuverKm: number | null; attachedObjectIds: ObjectId[] }[];
  refusalReason: string | null; snapshotId: string; evidenceVersion: string | null;
  screenedFromUtc: string; screenedToUtc: string;
  attachedObjectIds: ObjectId[]; partnerAttachedObjectIds: ObjectId[];
  simulated: boolean; method: string; limitations: string[];
}

export interface ScreenRequest {
  scanId?: string; jobId?: string; primaryObjectIds: ObjectId[];   // 1–50, resolved by Convex from assignments
  fromUtc: string; toUtc?: string;                                 // default fromUtc + 72 h, window ≤ 168 h
  snapshotId?: string; evidenceVersion?: string; runId?: string;
}

export interface JobAccepted { jobId: string; status: JobStatus; created: boolean; statusUrl: string }
export type JobStatus = "queued" | "running" | "completed" | "failed";
export interface Job<R = unknown> {
  jobId: string; kind: "screen" | "rescreen"; status: JobStatus;
  phase: "queued" | "screening" | "publishing" | "done" | "failed";
  progress: number | null;
  counters: { primaryObjects?: number; catalogObjects?: number; primariesCompleted?: number; pairsChecked?: number; eventsFound?: number };
  coverage?: Record<string, unknown>;
  requestHash: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
  result: R | null; resultRef: string | null;
  error: { code: string; message: string } | null;
}

export interface VerifyRequest {
  objectId: ObjectId;
  expected: { burnTimeUtc: string; deltaVMs?: number; direction?: Direction; deltaAKm?: number };
  series?: { epochUtc: string; meanMotionRevPerDay?: number; smaKm?: number }[];
  replay?: string; kind?: "live" | "replay"; sources?: SourceRef[]; simulated?: boolean;
}
export interface VerifyResponse {
  kind: "live" | "replay"; result: "awaiting_data" | "consistent" | "mismatch";
  label: string; expected: { deltaAKm: number; sign: 1 | -1 };
  observed: { deltaAKm: number; z: number; epochUtc: string } | null;
  elementSetCount: number; series: { epochUtc: string; smaKm: number }[];
  thresholds: { z: number; minDeltaAKm: number; sizeTolerance: number; minSets: number };
  method: string; limitations: string[]; missing: string[]; sources: SourceRef[]; simulated: boolean;
}

export interface SimulateRequest {
  targetObjectId: ObjectId; tcaUtc: string; name?: string; objectId?: string;
  tiltDeg?: number; missKm?: number; deltaAKm?: number;
}
export interface SimulateResponse {
  objectId: string; omm: Record<string, unknown>; tle: [string, string]; simulated: true;
  event: { objectA: ObjectId; objectB: string; tcaUtc: string; missKm: number; relSpeedKmS: number; simulated: true };
  assumptions: string[];
}

export interface SnapshotResponse {
  snapshotId: string; takenAt: string; format: "omm" | "tle"; mode: string;
  sources: SourceRef[]; objectCount: number; skipped: number; simulated: ObjectId[];
  manifest: Record<string, unknown> | null;
  ommFile: { path: string; sha256: string; bytes: number; records: number; snapshotId: string } | null;
}

// ---- Calls ----

export const orbit = {
  health: (c: OrbitConfig) =>
    orbitRequest<{ ok: boolean; snapshotId: string; objects: number }>(c, "/health", { timeoutMs: ORBIT_TIMEOUTS.health, auth: false }).then(r => r.body),
  snapshot: (c: OrbitConfig) =>
    orbitRequest<SnapshotResponse>(c, "/snapshot", { timeoutMs: ORBIT_TIMEOUTS.snapshot }).then(r => r.body),
  candidates: (c: OrbitConfig, body: CandidatesRequest) =>
    orbitRequest<CandidatesResponse>(c, "/candidates", { method: "POST", body, timeoutMs: ORBIT_TIMEOUTS.candidates }).then(r => r.body),
  // Jobs: the service answers 202 once the job is persisted; a resubmit with the same jobId and body is idempotent.
  submitRescreen: (c: OrbitConfig, body: RescreenRequest) =>
    orbitRequest<JobAccepted>(c, "/rescreen", { method: "POST", body, timeoutMs: ORBIT_TIMEOUTS.rescreenSubmit, accept: [200, 202] }).then(r => r.body),
  submitScreen: (c: OrbitConfig, body: ScreenRequest) =>
    orbitRequest<JobAccepted>(c, "/screen", { method: "POST", body, timeoutMs: ORBIT_TIMEOUTS.screenSubmit, accept: [200, 202] }).then(r => r.body),
  job: <R>(c: OrbitConfig, jobId: string) =>
    orbitRequest<Job<R>>(c, `/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: ORBIT_TIMEOUTS.job }).then(r => r.body),
  verify: (c: OrbitConfig, body: VerifyRequest) =>
    orbitRequest<VerifyResponse>(c, "/verify", { method: "POST", body, timeoutMs: ORBIT_TIMEOUTS.verify }).then(r => r.body),
  simulate: (c: OrbitConfig, body: SimulateRequest) =>
    orbitRequest<SimulateResponse>(c, "/simulate", { method: "POST", body, timeoutMs: ORBIT_TIMEOUTS.simulate }).then(r => r.body),
  validation: (c: OrbitConfig) =>
    orbitRequest<Record<string, unknown>>(c, "/validation", { timeoutMs: ORBIT_TIMEOUTS.validation }).then(r => r.body),
  object: (c: OrbitConfig, objectId: ObjectId) =>
    orbitRequest<ObjectInfo>(c, `/objects/${encodeURIComponent(objectId)}`, { timeoutMs: ORBIT_TIMEOUTS.objects }).then(r => r.body),
  objects: (c: OrbitConfig, objectIds: ObjectId[]) =>
    orbitRequest<{ snapshotId: string; rule: string; objects: Record<ObjectId, ObjectInfo>; missing: ObjectId[] }>(c, "/objects", { method: "POST", body: { objectIds }, timeoutMs: ORBIT_TIMEOUTS.objects }).then(r => r.body),
};

// Polls a job until it completes, with bounded requests (contract: every 1 s, up to 240 s for a re-screen).
// A failed or unfinished job is UPSTREAM_UNAVAILABLE: the caller retries the same jobId, which the service reuses.
export async function waitForJob<R>(c: OrbitConfig, jobId: string, options: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<Job<R> & { result: R }> {
  const { intervalMs = 1_000, timeoutMs = 240_000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const job = await orbit.job<R>(c, jobId);
    if (job.status === "completed" && job.result !== null) return job as Job<R> & { result: R };
    if (job.status === "failed") {
      throw new OrbitError("UPSTREAM_UNAVAILABLE", `The orbital job failed: ${job.error?.code ?? "ERROR"}.`);
    }
    if (now() + intervalMs > deadline) throw new OrbitError("UPSTREAM_UNAVAILABLE", "The orbital job did not finish in time.");
    await sleep(intervalMs);
  }
}
