import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { httpServer } from "../src/http.js";
import type { AddressInfo } from "node:net";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const token = "test-service-token-32-characters-minimum";
it("authenticates every route and health reports unverified provider readiness without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-http-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = vi.fn(async ({ file, expected }) => { await writeFile(file, expected); return { sessionId: "s", modelId: "m", toolWrites: 1 }; });
  const engine = await Engine.open(root, provider), server = httpServer(engine, token, async () => false);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const path of ["/health", "/prepare", "/commit", `/jobs/${"a".repeat(64)}`, `/jobs/${"a".repeat(64)}/retry`]) expect((await fetch(base + path)).status).toBe(401);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const health = await fetch(base + "/health", { headers }); expect(health.status).toBe(503); expect(await health.json()).toMatchObject({ ready: false, providerVerified: false });
  expect((await fetch(base + "/prepare", { method: "POST", headers, body: "{bad" })).status).toBe(400);
  expect((await fetch(base + "/prepare", { method: "POST", headers, body: JSON.stringify({ payload: "x".repeat(20_000) }) })).status).toBe(413);
  expect(provider).not.toHaveBeenCalled();
});

it("accepts authenticated prepare/commit and returns the durable job on polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-http-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const engine = await Engine.open(root, async ({ file, expected }) => { if (++calls === 1) throw new Error("Transient provider failure"); await writeFile(file, expected); return { sessionId: "s", modelId: "m", toolWrites: 1 }; });
  const server = httpServer(engine, token, async () => true); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const input = { intentKey: "event:e:proposal:p:revision:1:generation:1", filePath: "operators/company/schedule.json", trajectory: null,
    ref: { eventId: "e", proposalId: "p", revision: 1, selectionGeneration: 1, approvalRuleVersion: 1 },
    entry: { eventId: "e", proposalId: "p", revision: 1, objectId: "1001", burnTimeUtc: "2030-01-01T00:00:00Z", deltaVMs: 0.01, direction: "retrograde", simulated: false } };
  const accepted = await fetch(base + "/prepare", { method: "POST", headers, body: JSON.stringify(input) }); expect(accepted.status).toBe(202);
  const initial = await accepted.json() as { jobId: string }; await engine.idle();
  expect(await (await fetch(`${base}/jobs/${initial.jobId}`, { headers })).json()).toMatchObject({ status: "failed", attempt: 1 });
  expect((await fetch(`${base}/jobs/${initial.jobId}/retry`, { method: "POST", headers, body: JSON.stringify({ expectedAttempt: 1 }) })).status).toBe(202);
  await engine.idle();
  const p = await (await fetch(`${base}/jobs/${initial.jobId}`, { headers })).json() as any; expect(p.status).toBe("completed");
  const commit = await fetch(base + "/commit", { method: "POST", headers, body: JSON.stringify({ intentKey: input.intentKey, preparedJobId: p.jobId,
    contentHash: p.result.contentHash, expectedPreviousHash: p.result.expectedPreviousHash, expectedPreviousCommit: p.result.expectedPreviousCommit, ref: input.ref, trajectory: null }) });
  expect(commit.status).toBe(202); const committed = await commit.json() as any; await engine.idle();
  expect(await (await fetch(`${base}/jobs/${committed.jobId}`, { headers })).json()).toMatchObject({ status: "completed", result: { commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) } });
  expect(calls).toBe(2);
});
