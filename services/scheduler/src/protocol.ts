import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_BYTES = 256_000;
export const MAX_ATTEMPTS = 3;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const refSchema = z.object({ eventId: id, proposalId: id, revision: version, selectionGeneration: version, approvalRuleVersion: version }).strict();
export const trajectorySchema = z.object({ id, version }).strict().nullable();
export const entrySchema = z.object({ eventId: id, proposalId: id, revision: version,
  objectId: z.string().regex(/^(?:\d{1,9}|SIM-\d+)$/), burnTimeUtc: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/).refine(s => Number.isFinite(Date.parse(s))),
  deltaVMs: z.number().finite().positive(), direction: z.enum(["prograde", "retrograde"]), simulated: z.boolean() }).strict();
const intentKey = z.string().min(1).max(600).regex(/^[A-Za-z0-9:_-]+$/);
const filePath = z.string().regex(/^operators\/[A-Za-z0-9_-]{1,128}\/schedule\.json$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const prepareSchema = z.object({ intentKey, filePath, ref: refSchema, trajectory: trajectorySchema, entry: entrySchema }).strict();
export const commitSchema = z.object({ intentKey, preparedJobId: digest, contentHash: digest,
  expectedPreviousHash: digest.nullable(), expectedPreviousCommit: sha, ref: refSchema, trajectory: trajectorySchema }).strict();
export const retrySchema = z.object({ expectedAttempt: z.number().int().min(1).max(MAX_ATTEMPTS) }).strict();
export type Prepare = z.infer<typeof prepareSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type Receipt = { sessionId: string; modelId: string; toolWrites: number };
export type Artifact = { filePath: string; before: string | null; after: string; diff: string; contentHash: string;
  expectedPreviousHash: string | null; expectedPreviousCommit: string; factory: Receipt; commitSha: string | null };
export type Job = { jobId: string; intentKey: string; kind: "prepare" | "commit"; status: "queued" | "running" | "completed" | "failed";
  attempt: number; request: Prepare | Commit; result: Artifact | null; error: { code: string; message: string } | null };
export class WorkerError extends Error { constructor(readonly code: string, message: string, readonly status = 409) { super(message); } }
export const fail = (code: string, message: string, status = 409): never => { throw new WorkerError(code, message, status); };
export const safeError = (e: unknown) => e instanceof WorkerError ? { code: e.code, message: e.message } : { code: "WORKER_FAILED", message: "The schedule operation failed. No provider details are exposed." };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
export function parsePrepare(raw: unknown): Prepare {
  const p = prepareSchema.safeParse(raw); if (!p.success) return fail("VALIDATION", "Invalid immutable schedule request.", 400);
  const r = p.data, ref = r.ref;
  const key = r.trajectory ? `trajectory:${r.trajectory.id}:version:${r.trajectory.version}` : `event:${ref.eventId}:proposal:${ref.proposalId}:revision:${ref.revision}:generation:${ref.selectionGeneration}`;
  if (r.intentKey !== key || r.entry.eventId !== ref.eventId || r.entry.proposalId !== ref.proposalId || r.entry.revision !== ref.revision ||
    (r.entry.objectId.startsWith("SIM-") && !r.entry.simulated)) return fail("VALIDATION", "The artifact does not match the reserved revision.", 400);
  return r;
}
export function parseCommit(raw: unknown): Commit { const p = commitSchema.safeParse(raw); if (!p.success) return fail("VALIDATION", "Invalid commit reservation.", 400); return p.data; }
export const content = (entries: unknown[]) => `{"maneuvers":[\n${entries.map((entry, i) => `${i ? "," : ""}${canonical(entry)}\n`).join("") }]}\n`;
export function diff(file: string, before: string | null, after: string) {
  const entries = JSON.parse(after).maneuvers;
  const header = `--- ${before === null ? "/dev/null" : `a/${file}`}\n+++ b/${file}\n`;
  if (before === null) return `${header}@@ -0,0 +1,${entries.length + 2} @@\n${after.trimEnd().split("\n").map(line => `+${line}\n`).join("")}`;
  const count = JSON.parse(before).maneuvers.length;
  return `${header}@@ -${count + 1},0 +${count + 2} @@\n+${count ? "," : ""}${canonical(entries[count])}\n`;
}
export function append(before: string | null, request: Prepare) {
  let entries: z.infer<typeof entrySchema>[];
  try { entries = before === null ? [] : z.object({ maneuvers: z.array(entrySchema).max(500) }).strict().parse(JSON.parse(before)).maneuvers; }
  catch { return fail("INVALID_ARTIFACT", "Existing schedule is not a supported immutable artifact."); }
  if (before !== null && before !== content(entries)) return fail("INVALID_ARTIFACT", "Existing schedule bytes are not canonical.");
  if (entries.some(e => e.eventId === request.entry.eventId && e.proposalId === request.entry.proposalId && e.revision === request.entry.revision)) return fail("DUPLICATE_MANEUVER", "This revision is already scheduled.");
  const after = content([...entries, request.entry]);
  if (Buffer.byteLength(after) > MAX_BYTES) return fail("LIMIT_EXCEEDED", "Schedule exceeds its artifact size limit.");
  return after;
}
