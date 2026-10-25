import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commitSchedule, getScheduleHealth, getScheduleJob, prepareSchedule, retryScheduleJob, type PrepareSchedule, type CommitSchedule } from "../convex/lib/scheduleClient";
import { scheduleContent, scheduleDiff } from "../convex/maneuvers";
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); vi.stubEnv("SCHEDULE_SERVICE_URL", "https://scheduler.example"); vi.stubEnv("SCHEDULE_SERVICE_TOKEN", "private-token-of-at-least-32-characters"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, "0")).join("");
const input: PrepareSchedule = { intentKey: "event:e1:proposal:p1:revision:1:generation:1", filePath: "operators/company-a/schedule.json",
  ref: { eventId: "e1", proposalId: "p1", revision: 1, selectionGeneration: 1, approvalRuleVersion: 1 }, trajectory: null,
  entry: { eventId: "e1", proposalId: "p1", revision: 1, objectId: "SIM-1001", burnTimeUtc: "2030-01-01T00:00:00Z", deltaVMs: 0.01, direction: "prograde", simulated: true } };
const respond = (body: unknown, status = 200) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
async function job() { const after = scheduleContent([input.entry]); return { jobId: await hash(`prepare:${input.intentKey}`), intentKey: input.intentKey, kind: "prepare", status: "completed", attempt: 1, request: input,
  result: { filePath: input.filePath, before: null, after, diff: scheduleDiff(input.filePath, null, after), contentHash: await hash(after), expectedPreviousHash: null,
    expectedPreviousCommit: "a".repeat(40), factory: { sessionId: "sdk-session", modelId: "fixed-model", toolWrites: 1 }, commitSha: null }, error: null }; }
it("validates an exact maneuvers.ts artifact and makes one authenticated request", async () => {
  const expected = await job(); respond(expected); expect(await prepareSchedule(input)).toEqual(expected);
  expect(fetchMock).toHaveBeenCalledOnce(); const [url, init] = fetchMock.mock.calls[0]; expect(url).toBe("https://scheduler.example/prepare");
  expect(init.headers.Authorization).toBe(`Bearer ${process.env.SCHEDULE_SERVICE_TOKEN}`); expect(JSON.parse(init.body)).toEqual(input); expect(init.redirect).toBe("error");
});
it("binds commit and job polling to the immutable reservation", async () => {
  const p = await job(); const req: CommitSchedule = { intentKey: input.intentKey, preparedJobId: p.jobId, contentHash: p.result.contentHash,
    expectedPreviousHash: null, expectedPreviousCommit: p.result.expectedPreviousCommit, ref: input.ref, trajectory: null };
  const committed = { ...p, jobId: await hash(`commit:${input.intentKey}`), kind: "commit", request: req, result: { ...p.result, commitSha: "b".repeat(40) } };
  respond(committed); expect(await commitSchedule(req)).toEqual(committed);
  respond(committed); expect(await getScheduleJob(committed.jobId, { intentKey: input.intentKey, kind: "commit", ref: input.ref, trajectory: null })).toEqual(committed);
});
it("sends one explicit attempt-pinned retry and checks the returned job identity", async () => {
  const p = { ...await job(), attempt: 2 }; respond(p);
  const expected = { intentKey: input.intentKey, kind: "prepare" as const, ref: input.ref, trajectory: null };
  expect(await retryScheduleJob(p.jobId, 1, expected)).toEqual(p);
  expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe(`https://scheduler.example/jobs/${p.jobId}/retry`);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ expectedAttempt: 1 });
  await expect(retryScheduleJob(p.jobId, 4, expected)).rejects.toMatchObject({ code: "VALIDATION" });
  respond({ ...p, attempt: 4 }); await expect(retryScheduleJob(p.jobId, 1, expected)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it.each(["hash", "diff", "number", "ref", "path", "receipt", "jobId"])("rejects %s corruption", async field => {
  const p = await job();
  if (field === "hash") p.result.contentHash = "f".repeat(64);
  if (field === "diff") p.result.diff += "modified";
  if (field === "number") { p.result.after = scheduleContent([{ ...input.entry, deltaVMs: 500 }]); p.result.contentHash = await hash(p.result.after); p.result.diff = scheduleDiff(input.filePath, null, p.result.after); }
  if (field === "ref") p.request = { ...input, ref: { ...input.ref, selectionGeneration: 2 } };
  if (field === "path") p.result.filePath = "../secrets";
  if (field === "receipt") p.result.factory.toolWrites = 0;
  if (field === "jobId") p.jobId = "f".repeat(64);
  respond(p); await expect(prepareSchedule(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(fetchMock).toHaveBeenCalledOnce();
});
it("reports configuration readiness without claiming a verified provider call", async () => {
  respond({ ready: false, service: "orbitcall-scheduler", sdkVersion: "0.10.0", providerVerified: false }, 503);
  expect(await getScheduleHealth()).toMatchObject({ ready: false, providerVerified: false });
});
it.each([401, 409, 429, 503])("sanitizes HTTP %s and never retries", async status => {
  respond({ error: "SECRET_PROVIDER_BODY" }, status);
  const error = await prepareSchedule(input).catch(e => e); expect(error.message).not.toContain("SECRET"); expect(fetchMock).toHaveBeenCalledOnce();
});
it("rejects invalid inputs and unsafe URLs before making a request", async () => {
  await expect(prepareSchedule({ ...input, filePath: "operators/../schedule.json" })).rejects.toMatchObject({ code: "VALIDATION" });
  vi.stubEnv("SCHEDULE_SERVICE_URL", "https://name:secret@scheduler.example"); await expect(prepareSchedule(input)).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" }); expect(fetchMock).not.toHaveBeenCalled();
});
it("sanitizes transport failures and service job errors", async () => {
  fetchMock.mockRejectedValue(new Error("SECRET_SOCKET_DETAILS")); const error = await prepareSchedule(input).catch(e => e); expect(error.message).not.toContain("SECRET");
  const p = await job(); respond({ ...p, status: "failed", result: null, error: { code: "PROVIDER_ERROR", message: "SECRET_PROVIDER_BODY" } });
  expect(JSON.stringify(await prepareSchedule(input))).not.toContain("SECRET");
});
