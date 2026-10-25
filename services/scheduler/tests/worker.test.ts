import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { parsePrepare, content, hash } from "../src/protocol.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(p => rm(p, { recursive: true, force: true }))); roots.length = 0; });
export const request = (n = 1) => ({ intentKey: `event:e${n}:proposal:p${n}:revision:1:generation:1`,
  ref: { eventId: `e${n}`, proposalId: `p${n}`, revision: 1, selectionGeneration: 1, approvalRuleVersion: 1 }, trajectory: null,
  filePath: "operators/company-a/schedule.json", entry: { eventId: `e${n}`, proposalId: `p${n}`, revision: 1,
    objectId: "SIM-1001", burnTimeUtc: "2030-01-01T00:00:00Z", deltaVMs: 0.01, direction: "prograde", simulated: true } });
async function setup(provider = vi.fn(async ({ file, expected }: { file: string; expected: string }) => {
  await writeFile(file, expected); return { sessionId: "factory-session", modelId: "test-model", toolWrites: 1 };
})) { const root = await mkdtemp(join(tmpdir(), "orbit-scheduler-")); roots.push(root); return { root, provider, engine: await Engine.open(root, provider) }; }
async function prepared(engine: Engine, n = 1) { const job = await engine.prepare(request(n)); await engine.idle(); return (await engine.get(job.jobId))!; }
const commitRequest = (job: Awaited<ReturnType<typeof prepared>>) => ({ intentKey: job.intentKey, preparedJobId: job.jobId,
  contentHash: job.result!.contentHash, expectedPreviousHash: job.result!.expectedPreviousHash,
  expectedPreviousCommit: job.result!.expectedPreviousCommit, ref: request(Number(job.request.ref.eventId.slice(1))).ref, trajectory: null });

it("requires exact paths, finite approved values, and intent-bound references", () => {
  for (const filePath of ["../schedule.json", "operators/../schedule.json", "/operators/a/schedule.json", "operators/a/b/schedule.json"]) expect(() => parsePrepare({ ...request(), filePath })).toThrow();
  expect(() => parsePrepare({ ...request(), entry: { ...request().entry, deltaVMs: Infinity } })).toThrow();
  expect(() => parsePrepare({ ...request(), ref: { ...request().ref, revision: 2 } })).toThrow();
  expect(() => parsePrepare({ ...request(), extra: true })).toThrow();
});
it("only publishes a real provider-written exact artifact and deduplicates prepare/commit", async () => {
  const { engine, provider, root } = await setup();
  const [a, b] = await Promise.all([engine.prepare(request()), engine.prepare(request())]); expect(a.jobId).toBe(b.jobId);
  await engine.idle(); const preview = (await engine.get(a.jobId))!;
  expect(preview.status).toBe("completed"); expect(preview.result!.after).toBe(content([request().entry])); expect(provider).toHaveBeenCalledTimes(1);
  const [c, d] = await Promise.all([engine.commit(commitRequest(preview)), engine.commit(commitRequest(preview))]); expect(c.jobId).toBe(d.jobId);
  await engine.idle(); const committed = (await engine.get(c.jobId))!;
  expect(committed.result!.commitSha).toMatch(/^[a-f0-9]{40}$/);
  expect(await readFile(join(root, "repo", request().filePath), "utf8")).toBe(preview.result!.after);
  const reopened = await Engine.open(root, provider); expect((await reopened.commit(commitRequest(preview))).jobId).toBe(c.jobId);
  expect(provider).toHaveBeenCalledTimes(1);
});
it("fails closed on provider failure, invented values and a claimed write with no artifact", async () => {
  for (const provider of [vi.fn(async () => { throw new Error("secret-provider-response"); }),
    vi.fn(async () => ({ sessionId: "session", modelId: "test", toolWrites: 1 })),
    vi.fn(async ({ file }: { file: string }) => { await writeFile(file, content([{ ...request().entry, deltaVMs: 500 }])); return { sessionId: "s", modelId: "test", toolWrites: 1 }; })]) {
    const { engine } = await setup(provider); const p = await prepared(engine);
    expect(p.status).toBe("failed"); expect(JSON.stringify(p)).not.toContain("secret-provider-response");
    await expect(engine.commit({ ...commitRequest({ ...p, result: { contentHash: hash("x"), expectedPreviousHash: null, expectedPreviousCommit: "a".repeat(40) } } as any) })).rejects.toThrow();
  }
});
it("refuses changed payloads for an existing key and changed hashes on commit", async () => {
  const { engine } = await setup(); const p = await prepared(engine);
  await expect(engine.prepare({ ...request(), entry: { ...request().entry, deltaVMs: 0.02 } })).rejects.toThrow();
  await expect(engine.commit({ ...commitRequest(p), contentHash: "f".repeat(64) })).rejects.toThrow();
});
it("serializes writes and rejects a second preview based on an old repository version", async () => {
  const { engine, root } = await setup(); const a = await prepared(engine), b = await prepared(engine, 2);
  const c = await engine.commit(commitRequest(a)); await engine.idle(); expect((await engine.get(c.jobId))!.status).toBe("completed");
  const d = await engine.commit(commitRequest(b)); await engine.idle(); expect((await engine.get(d.jobId))!).toMatchObject({ status: "failed", error: { code: "STALE_WORKSPACE" } });
  expect(JSON.parse(await readFile(join(root, "repo", request().filePath), "utf8")).maneuvers).toHaveLength(1);
});

it("appends a later revision without disclosing prior entries in its diff and refuses duplicate revision writes", async () => {
  const { engine, root } = await setup(); const first = await prepared(engine); await engine.commit(commitRequest(first)); await engine.idle();
  const second = await prepared(engine, 2); expect(second.status).toBe("completed");
  expect(second.result!.before).toBe(first.result!.after); expect(second.result!.diff).not.toContain('"eventId":"e1"');
  const commit = await engine.commit(commitRequest(second)); await engine.idle(); expect((await engine.get(commit.jobId))!.status).toBe("completed");
  expect(JSON.parse(await readFile(join(root, "repo", request().filePath), "utf8")).maneuvers).toEqual([request().entry, request(2).entry]);
  const repeat = request(); repeat.ref.selectionGeneration = 2; repeat.intentKey = repeat.intentKey.replace("generation:1", "generation:2");
  const duplicate = await engine.prepare(repeat); await engine.idle(); expect(await engine.get(duplicate.jobId)).toMatchObject({ status: "failed", error: { code: "DUPLICATE_MANEUVER" } });
});

it("pins the trajectory version and refuses changed versions under the same intent", async () => {
  const { engine } = await setup(); const input = { ...request(), intentKey: "trajectory:plan1:version:1", trajectory: { id: "plan1", version: 1 } };
  const job = await engine.prepare(input); await engine.idle(); expect((await engine.get(job.jobId))!.status).toBe("completed");
  await expect(engine.prepare({ ...input, trajectory: { id: "plan1", version: 2 } })).rejects.toThrow();
});

it.each(["before_write", "temporary_file", "partial_temporary_file", "after_write", "after_commit"])("recovers crash at %s without another Factory call or duplicate append", async point => {
  const { engine, provider, root } = await setup(); const p = await prepared(engine);
  const req = commitRequest(p), jobId = hash(`commit:${req.intentKey}`);
  if (point === "after_commit") { await engine.commit(req); await engine.idle(); }
  if (point === "temporary_file") await writeFile(join(root, "repo", `${request().filePath}.tmp`), p.result!.after);
  if (point === "partial_temporary_file") await writeFile(join(root, "repo", `${request().filePath}.tmp`), p.result!.after.slice(0, 20));
  if (point === "after_write") await writeFile(join(root, "repo", request().filePath), p.result!.after);
  // The durable intent exists before any external write. Simulate a killed process by restoring that journal state.
  await writeFile(join(root, "jobs", `${jobId}.json`), JSON.stringify({ jobId, intentKey: req.intentKey, kind: "commit", status: "running", request: req, result: p.result, error: null }));
  const recovered = await Engine.open(root, provider); const committed = (await recovered.get(jobId))!;
  expect(committed.status).toBe("completed"); expect(committed.result!.commitSha).toMatch(/^[a-f0-9]{40}$/);
  expect(JSON.parse(await readFile(join(root, "repo", request().filePath), "utf8")).maneuvers).toHaveLength(1);
  expect(provider).toHaveBeenCalledTimes(1); expect((await recovered.commit(req)).result!.commitSha).toBe(committed.result!.commitSha);
});

it("fails an interrupted preparation visibly and never automatically spends again", async () => {
  const { engine, provider, root } = await setup(); const p = await prepared(engine);
  await writeFile(join(root, "jobs", `${p.jobId}.json`), JSON.stringify({ ...p, status: "running", result: null }));
  const recovered = await Engine.open(root, provider);
  expect(await recovered.prepare(request())).toMatchObject({ status: "failed", error: { code: "PREPARE_INTERRUPTED" } });
  expect(provider).toHaveBeenCalledTimes(1);
  const retried = await recovered.retry(p.jobId, { expectedAttempt: 1 });
  expect(retried).toMatchObject({ jobId: p.jobId, status: "queued", attempt: 2, request: p.request });
  await recovered.idle(); expect(await recovered.get(p.jobId)).toMatchObject({ status: "completed", attempt: 2 });
  expect(provider).toHaveBeenCalledTimes(2);
});

it("pins explicit retries to the observed attempt and preserves their bound across restarts", async () => {
  const provider = vi.fn(async () => { throw new Error("temporary provider outage"); });
  const { engine, root } = await setup(provider), p = await prepared(engine);
  expect(await engine.prepare(request())).toMatchObject({ attempt: 1, status: "failed" });
  await expect(engine.retry(p.jobId, { expectedAttempt: 2 })).rejects.toMatchObject({ code: "ATTEMPT_CONFLICT" });
  await expect(engine.retry(p.jobId, { expectedAttempt: 1, entry: request().entry })).rejects.toMatchObject({ code: "VALIDATION" });
  const [a, b] = await Promise.all([engine.retry(p.jobId, { expectedAttempt: 1 }), engine.retry(p.jobId, { expectedAttempt: 1 })]);
  expect(a.attempt).toBe(2); expect(b.attempt).toBe(2); await engine.idle();
  // Replayed commands after a second failure must not trigger a third charge.
  expect(await engine.retry(p.jobId, { expectedAttempt: 1 })).toMatchObject({ attempt: 2, status: "failed" });
  expect(provider).toHaveBeenCalledTimes(2);
  const recovered = await Engine.open(root, provider);
  await recovered.retry(p.jobId, { expectedAttempt: 2 }); await recovered.idle();
  expect(provider).toHaveBeenCalledTimes(3);
  await expect(recovered.retry(p.jobId, { expectedAttempt: 3 })).rejects.toMatchObject({ code: "RETRY_LIMIT" });
  expect((await recovered.get(p.jobId))!.request).toEqual(p.request);
});

it("retries a failed commit before a write without changing its preview or calling Factory again", async () => {
  const { engine, provider, root } = await setup(), p = await prepared(engine), req = commitRequest(p), jobId = hash(`commit:${req.intentKey}`);
  await writeFile(join(root, "jobs", `${jobId}.json`), JSON.stringify({ jobId, intentKey: req.intentKey, kind: "commit", attempt: 1,
    status: "failed", request: req, result: p.result, error: { code: "WORKER_FAILED", message: "Transient read failure before write." } }));
  const retried = await engine.retry(jobId, { expectedAttempt: 1 }); expect(retried).toMatchObject({ attempt: 2, request: req, result: p.result });
  await engine.idle(); const completed = await engine.get(jobId); expect(completed).toMatchObject({ status: "completed", attempt: 2 });
  expect(await engine.retry(jobId, { expectedAttempt: 1 })).toEqual(completed);
  expect(await engine.commit(req)).toEqual(completed); expect(provider).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(root, "repo", request().filePath), "utf8")).maneuvers).toHaveLength(1);
});

it("refuses to retry stale previews or writes whose outcome needs recovery", async () => {
  const { engine, root } = await setup(), a = await prepared(engine), b = await prepared(engine, 2);
  await engine.commit(commitRequest(a)); await engine.idle();
  const stale = await engine.commit(commitRequest(b)); await engine.idle();
  await expect(engine.retry(stale.jobId, { expectedAttempt: 1 })).rejects.toMatchObject({ code: "RETRY_UNSAFE" });
  const job = (await engine.get(stale.jobId))!;
  await writeFile(join(root, "jobs", `${job.jobId}.json`), JSON.stringify({ ...job, status: "running", error: { code: "RECOVERY_REQUIRED", message: "Interrupted write." } }));
  await expect(engine.retry(stale.jobId, { expectedAttempt: 1 })).rejects.toMatchObject({ code: "RETRY_UNSAFE" });
});

it("rejects symlink destinations and never writes outside its isolated workspace", async () => {
  const { engine, provider, root } = await setup();
  const target = join(root, "outside"); await writeFile(target, "untouched");
  const first = await prepared(engine); // creates safe directories without changing the repository
  await symlink(target, join(root, "repo", request().filePath));
  const job = await engine.commit(commitRequest(first)); await engine.idle();
  expect((await engine.get(job.jobId))!.status).toBe("failed"); expect(await readFile(target, "utf8")).toBe("untouched"); expect(provider).toHaveBeenCalledTimes(1);
});
