// Server-only transport. Round 4 calls prepare for the selected revision, then commit only after
// maneuvers.reserveCommit; the worker's credential is not itself a human approval.
export type ScheduleRef = { eventId: string; proposalId: string; revision: number; selectionGeneration: number; approvalRuleVersion: number };
export type ScheduleTrajectory = { id: string; version: number } | null;
export type ScheduleEntry = { eventId: string; proposalId: string; revision: number; objectId: string; burnTimeUtc: string;
  deltaVMs: number; direction: "prograde" | "retrograde"; simulated: boolean };
export type PrepareSchedule = { intentKey: string; filePath: string; ref: ScheduleRef; trajectory: ScheduleTrajectory; entry: ScheduleEntry };
export type CommitSchedule = { intentKey: string; preparedJobId: string; contentHash: string; expectedPreviousHash: string | null;
  expectedPreviousCommit: string; ref: ScheduleRef; trajectory: ScheduleTrajectory };
export type ScheduleArtifact = { filePath: string; before: string | null; after: string; diff: string; contentHash: string;
  expectedPreviousHash: string | null; expectedPreviousCommit: string; factory: { sessionId: string; modelId: string; toolWrites: 1 }; commitSha: string | null };
export type ScheduleJob = { jobId: string; intentKey: string; kind: "prepare" | "commit"; status: "queued" | "running" | "completed" | "failed";
  attempt: number; request: PrepareSchedule | CommitSchedule; result: ScheduleArtifact | null; error: { code: string; message: string } | null };
type Expected = Pick<ScheduleJob, "intentKey" | "kind"> & { ref: ScheduleRef; trajectory: ScheduleTrajectory };
export class ScheduleServiceError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const fail = (code: string, message: string): never => { throw new ScheduleServiceError(code, message); };
const invalid = (): never => fail("INVALID_RESPONSE", "The schedule service returned an invalid or mismatched job.");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max = 600): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const version = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const path = (v: unknown): v is string => typeof v === "string" && /^operators\/[A-Za-z0-9_-]{1,128}\/schedule\.json$/.test(v);
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : object(v) ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, "0")).join(""); }
function validRef(v: unknown): v is ScheduleRef { return fields(v, ["eventId", "proposalId", "revision", "selectionGeneration", "approvalRuleVersion"]) && id(v.eventId) && id(v.proposalId) && version(v.revision) && version(v.selectionGeneration) && version(v.approvalRuleVersion); }
function validTrajectory(v: unknown): v is ScheduleTrajectory { return v === null || fields(v, ["id", "version"]) && id(v.id) && version(v.version); }
function validEntry(v: unknown): v is ScheduleEntry { return fields(v, ["eventId", "proposalId", "revision", "objectId", "burnTimeUtc", "deltaVMs", "direction", "simulated"]) && id(v.eventId) && id(v.proposalId) && version(v.revision) && typeof v.objectId === "string" && /^(?:\d{1,9}|SIM-\d+)$/.test(v.objectId) && typeof v.burnTimeUtc === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v.burnTimeUtc) && Number.isFinite(Date.parse(v.burnTimeUtc)) && typeof v.deltaVMs === "number" && Number.isFinite(v.deltaVMs) && v.deltaVMs > 0 && ["prograde", "retrograde"].includes(v.direction as string) && typeof v.simulated === "boolean" && (!v.objectId.startsWith("SIM-") || v.simulated); }
function validRequest(v: unknown, kind: ScheduleJob["kind"]): v is PrepareSchedule | CommitSchedule {
  const keys = kind === "prepare" ? ["intentKey", "filePath", "ref", "trajectory", "entry"] : ["intentKey", "preparedJobId", "contentHash", "expectedPreviousHash", "expectedPreviousCommit", "ref", "trajectory"];
  if (!fields(v, keys) || !text(v.intentKey) || !/^[A-Za-z0-9:_-]+$/.test(v.intentKey) || !validRef(v.ref) || !validTrajectory(v.trajectory)) return false;
  if (kind === "commit") return digest(v.preparedJobId) && digest(v.contentHash) && (v.expectedPreviousHash === null || digest(v.expectedPreviousHash)) && commit(v.expectedPreviousCommit);
  const key = v.trajectory ? `trajectory:${v.trajectory.id}:version:${v.trajectory.version}` : `event:${v.ref.eventId}:proposal:${v.ref.proposalId}:revision:${v.ref.revision}:generation:${v.ref.selectionGeneration}`;
  return v.intentKey === key && path(v.filePath) && validEntry(v.entry) && v.entry.eventId === v.ref.eventId && v.entry.proposalId === v.ref.proposalId && v.entry.revision === v.ref.revision;
}
export function scheduleConfig() {
  let url: URL; try { url = new URL(process.env.SCHEDULE_SERVICE_URL ?? ""); } catch { return fail("WORKER_UNAVAILABLE", "The Factory schedule worker is not configured."); }
  const token = process.env.SCHEDULE_SERVICE_TOKEN;
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !token || token.length < 32 || /[\r\n]/.test(token)) return fail("WORKER_UNAVAILABLE", "The Factory schedule worker configuration is invalid.");
  return { url: url.toString().replace(/\/$/, ""), token };
}
async function request(endpoint: string, body?: unknown, health = false) {
  const config = scheduleConfig(); let response: Response;
  try { response = await fetch(config.url + endpoint, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store" }); }
  catch { return fail("WORKER_UNAVAILABLE", "The Factory schedule worker could not be reached."); }
  if (!response.ok && !(health && response.status === 503)) return fail(response.status === 409 ? "SCHEDULE_CONFLICT" : "WORKER_UNAVAILABLE", response.status === 409 ? "The immutable schedule intent conflicts with the worker state." : "The Factory schedule worker refused the request.");
  if (!response.headers.get("content-type")?.includes("application/json") || !response.body) return invalid();
  const reader = response.body.getReader(); let bytes = 0, raw = ""; const decoder = new TextDecoder();
  try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2_000_000) { await reader.cancel(); return invalid(); } raw += decoder.decode(value, { stream: true }); } raw += decoder.decode(); return JSON.parse(raw) as unknown; }
  catch (e) { if (e instanceof ScheduleServiceError) throw e; return invalid(); }
}
const render = (entries: unknown[]) => `{"maneuvers":[\n${entries.map((entry, i) => `${i ? "," : ""}${canonical(entry)}\n`).join("")}]}\n`;
async function checkedJob(raw: unknown, expected: Expected, expectedRequest?: PrepareSchedule | CommitSchedule, expectedJobId?: string): Promise<ScheduleJob> {
  if (!fields(raw, ["jobId", "intentKey", "kind", "status", "attempt", "request", "result", "error"]) || !version(raw.attempt) || raw.attempt > 3 || raw.intentKey !== expected.intentKey || raw.kind !== expected.kind || !validRequest(raw.request, expected.kind) ||
    !same(raw.request.ref, expected.ref) || !same(raw.request.trajectory, expected.trajectory) || raw.request.intentKey !== expected.intentKey ||
    (expectedRequest && !same(raw.request, expectedRequest)) || !["queued", "running", "completed", "failed"].includes(raw.status as string) || raw.jobId !== await hash(`${expected.kind}:${expected.intentKey}`) || (expectedJobId && raw.jobId !== expectedJobId)) return invalid();
  if (raw.error !== null && (!fields(raw.error, ["code", "message"]) || !text(raw.error.code, 80) || !text(raw.error.message, 500))) return invalid();
  if ((raw.status === "failed") !== (raw.error !== null) && !(raw.status === "running" && raw.error !== null)) return invalid();
  if (raw.result !== null) {
    const a = raw.result;
    if (!fields(a, ["filePath", "before", "after", "diff", "contentHash", "expectedPreviousHash", "expectedPreviousCommit", "factory", "commitSha"]) || !path(a.filePath) || (a.before !== null && !text(a.before, 256_000)) || !text(a.after, 256_000) || !text(a.diff, 512_000) || !digest(a.contentHash) || !commit(a.expectedPreviousCommit) ||
      (a.expectedPreviousHash !== null && !digest(a.expectedPreviousHash)) || !fields(a.factory, ["sessionId", "modelId", "toolWrites"]) || !text(a.factory.sessionId, 200) || !text(a.factory.modelId, 200) || a.factory.toolWrites !== 1 ||
      (a.commitSha !== null && !commit(a.commitSha)) || a.contentHash !== await hash(a.after) || a.expectedPreviousHash !== (a.before === null ? null : await hash(a.before))) return invalid();
    let before: unknown, after: unknown; try { before = a.before === null ? { maneuvers: [] } : JSON.parse(a.before); after = JSON.parse(a.after); } catch { return invalid(); }
    if (!fields(before, ["maneuvers"]) || !fields(after, ["maneuvers"]) || !Array.isArray(before.maneuvers) || !Array.isArray(after.maneuvers) || before.maneuvers.length > 500 || after.maneuvers.length !== before.maneuvers.length + 1 ||
      !after.maneuvers.every(validEntry) || !same(after.maneuvers.slice(0, -1), before.maneuvers) || a.after !== render(after.maneuvers) || (a.before !== null && a.before !== render(before.maneuvers))) return invalid();
    const count = before.maneuvers.length, header = `--- ${a.before === null ? "/dev/null" : `a/${a.filePath}`}\n+++ b/${a.filePath}\n`;
    const wantedDiff = a.before === null ? `${header}@@ -0,0 +1,${after.maneuvers.length + 2} @@\n${a.after.trimEnd().split("\n").map(line => `+${line}\n`).join("")}` : `${header}@@ -${count + 1},0 +${count + 2} @@\n+${count ? "," : ""}${canonical(after.maneuvers[count])}\n`;
    if (a.diff !== wantedDiff) return invalid();
    if (raw.kind === "prepare" && (!same(after.maneuvers.at(-1), (raw.request as PrepareSchedule).entry) || a.filePath !== (raw.request as PrepareSchedule).filePath || a.commitSha !== null)) return invalid();
    if (raw.kind === "commit") { const r = raw.request as CommitSchedule; if (a.contentHash !== r.contentHash || a.expectedPreviousHash !== r.expectedPreviousHash || a.expectedPreviousCommit !== r.expectedPreviousCommit || (raw.status === "completed" && !commit(a.commitSha))) return invalid(); }
  }
  if (raw.status === "completed" && raw.result === null) return invalid();
  // Worker errors are never propagated verbatim; only our stable message crosses into Convex logs/UI.
  return { ...raw, error: raw.error ? { code: "SCHEDULE_JOB_FAILED", message: "The Factory schedule job failed; inspect the authorized worker job status." } : null } as ScheduleJob;
}
export async function getScheduleHealth() {
  const raw = await request("/health", undefined, true);
  if (!fields(raw, ["ready", "service", "sdkVersion", "providerVerified"]) || typeof raw.ready !== "boolean" || raw.service !== "orbitcall-scheduler" || raw.sdkVersion !== "0.10.0" || raw.providerVerified !== false) return invalid();
  return { ready: raw.ready, service: raw.service, sdkVersion: raw.sdkVersion, providerVerified: false as const };
}
export async function prepareSchedule(input: PrepareSchedule) { if (!validRequest(input, "prepare")) fail("VALIDATION", "Invalid immutable schedule request."); return checkedJob(await request("/prepare", input), { ...input, kind: "prepare" }, input); }
export async function commitSchedule(input: CommitSchedule) { if (!validRequest(input, "commit")) fail("VALIDATION", "Invalid reserved schedule request."); return checkedJob(await request("/commit", input), { ...input, kind: "commit" }, input); }
export async function getScheduleJob(jobId: string, expected: Expected) { if (!digest(jobId) || !validRef(expected.ref) || !validTrajectory(expected.trajectory)) fail("VALIDATION", "Invalid schedule job reference."); return checkedJob(await request(`/jobs/${jobId}`), expected, undefined, jobId); }
export async function retryScheduleJob(jobId: string, expectedAttempt: number, expected: Expected) {
  if (!digest(jobId) || !version(expectedAttempt) || expectedAttempt > 3 || !validRef(expected.ref) || !validTrajectory(expected.trajectory)) fail("VALIDATION", "Invalid schedule retry reference.");
  return checkedJob(await request(`/jobs/${jobId}/retry`, { expectedAttempt }), expected, undefined, jobId);
}
