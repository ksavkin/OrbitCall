import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCandidates, getRescreenJob, getScreenJob, ORBIT_TIMEOUTS, orbitConfigured, orbitFailure, OrbitServiceError, simulate,
  startRescreen, startScreen, verify, type CandidatesResponse, type ScreenRequest,
} from "../convex/lib/orbitClient";

// Fixtures follow services/orbit/docs/contract.md and the service's own test_jobs.py / test_app.py answers.

const TOKEN = "test-only-service-token";
beforeEach(() => {
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test/");
  vi.stubEnv("ORBIT_SERVICE_TOKEN", TOKEN);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const upstreamError = (status: number, code: string) => json({ error: { code, message: "secret diagnostic" } }, status);
function mockFetch(...responses: (Response | Error)[]) {
  const fetch = vi.fn();
  for (const r of responses) r instanceof Error ? fetch.mockRejectedValueOnce(r) : fetch.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const call = (fetch: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = fetch.mock.calls[i];
  return { url: String(url), method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
};
const errorOf = async (p: Promise<unknown>) => {
  const error = await p.catch(e => e);
  expect(error).toBeInstanceOf(OrbitServiceError);
  return error as OrbitServiceError;
};
const codeOf = async (p: Promise<unknown>) => (await errorOf(p)).code;
const without = <T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> => { const { [key]: _, ...rest } = obj; return rest; };

const SNAP = "gp-20261024T2134Z";
const EV = "ev-7";
const ISS = "25544", SAT = "48211", DEB = "31021", DOCKED = "48274";
const info = (objectId: string, over: Record<string, unknown> = {}) => ({
  objectId, name: `SAT ${objectId}`, kind: "payload", maneuverability: "unknown",
  classificationBasis: "CelesTrak group active, SOCRATES status [+]", operationalStatus: "+", group: "active", simulated: false, ...over,
});
const debris = info(DEB, { name: "FENGYUN 1C DEB", kind: "debris", maneuverability: "non_maneuverable", classificationBasis: "name (DEB)", operationalStatus: null, group: "fengyun-1c-debris" });
const sim = info("SIM-0001", { name: "Demo Sat", maneuverability: "maneuverable", classificationBasis: "simulated demo satellite", operationalStatus: null, group: "sim", simulated: true });
const spread = { gpMissKm: 0.42, supgpMissKm: null, minKm: null, maxKm: null, gpEpochUtc: "2026-10-24T21:00:00Z", supgpEpochUtc: null };
const event = { objectA: ISS, objectB: SAT, tcaUtc: "2026-10-26T04:12:00Z", missKm: 0.42, relSpeedKmS: 11.8, spread, primaries: [ISS], attachedObjectIds: [], simulated: false };
const fullCoverage = {
  complete: true, timedOut: false, excludedObjects: 3,
  catalogScope: `pinned CelesTrak GP snapshot ${SNAP}: 19468 objects (groups: active, stations); 3 records skipped at load. Not every object in space.`,
  reasons: [{ reason: "records skipped at load (parse or SGP4 error at epoch)", count: 3 }],
};
const counts = { primaryObjects: 2, catalogObjects: 19468, primariesCompleted: 2, pairsChecked: 3012, eventsFound: 1 };
const screenReq: ScreenRequest = { scanId: "scan-1", snapshotId: SNAP, evidenceVersion: EV, primaryObjectIds: [ISS, SAT],
  fromUtc: "2026-10-25T00:00:00Z", toUtc: "2026-10-28T00:00:00Z", runId: "run-7" };
const screenResult = {
  scanId: "scan-1", snapshotId: SNAP, evidenceVersion: EV, fromUtc: screenReq.fromUtc, toUtc: screenReq.toUtc, thresholdKm: 5,
  cached: false, runtimeS: 18.2, coverage: fullCoverage, counts, missingPrimaryIds: [], unpropagatedObjectIds: [],
  dockedBodies: { [ISS]: [DOCKED] }, events: [event], coLocated: [], objects: { [ISS]: info(ISS, { name: "ISS (ZARYA)", group: "stations" }), [SAT]: info(SAT) },
  uncovered: [], method: "SGP4 (python-sgp4, WGS-72) on public mean elements", limitations: ["Public mean elements: kilometre-level uncertainty."], runId: "run-7",
};
const accepted = { jobId: "screen-scan-1", status: "queued", created: true, statusUrl: "/jobs/screen-scan-1" };
const job = (over: Record<string, unknown>) => ({
  jobId: "screen-scan-1", kind: "screen", status: "running", phase: "screening", progress: 0.5,
  counters: { primaryObjects: 2, catalogObjects: 19468, primariesCompleted: 1, pairsChecked: 1500, eventsFound: 0 },
  requestHash: "9f".repeat(32), createdAt: "2026-10-25T00:00:01Z", startedAt: "2026-10-25T00:00:02Z", finishedAt: null,
  result: null, resultRef: null, error: null, ...over,
});
const doneJob = (result: unknown, over: Record<string, unknown> = {}) => job({
  status: "completed", phase: "done", progress: 1, finishedAt: "2026-10-25T00:00:20Z", resultRef: "jobs/screen-scan-1.json#result",
  counters: counts, coverage: fullCoverage, result, ...over,
});
const expectScreen = { scanId: "scan-1", snapshotId: SNAP };

describe("configuration and transport", () => {
  it("refuses to call anything without a URL and token", async () => {
    vi.stubEnv("ORBIT_SERVICE_TOKEN", "");
    const fetch = mockFetch();
    expect(orbitConfigured()).toBe(false);
    expect(await codeOf(startScreen(screenReq))).toBe("ORBIT_NOT_CONFIGURED");
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("ORBIT_SERVICE_TOKEN", TOKEN);
    expect(orbitConfigured()).toBe(true);
  });

  it.each([
    [401, "UNAUTHORIZED", "ORBIT_ACCESS_DENIED"], [403, "ERROR", "ORBIT_ACCESS_DENIED"], [404, "NOT_FOUND", "NOT_FOUND"],
    [429, "ERROR", "RATE_LIMITED"], [400, "VALIDATION", "VALIDATION"], [409, "SNAPSHOT_MISMATCH", "SNAPSHOT_MISMATCH"],
    [409, "JOB_CONFLICT", "JOB_CONFLICT"], [503, "NOT_READY", "NOT_READY"], [500, "ERROR", "UPSTREAM_UNAVAILABLE"],
    [503, "ERROR", "UPSTREAM_UNAVAILABLE"],
  ])("makes one attempt on HTTP %s %s and never leaks the upstream message", async (status, upstream, code) => {
    const fetch = mockFetch(upstreamError(status, upstream));
    const error = await errorOf(startScreen(screenReq));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.upstreamCode).toBe(upstream);
    expect(orbitFailure(error).message).not.toContain("secret diagnostic");
  });

  it("ignores codes outside the service's own list and non-JSON error bodies", async () => {
    mockFetch(json({ error: { code: "DROP TABLE", message: "x" } }, 409));
    const unknown = await errorOf(startScreen(screenReq));
    expect(unknown.code).toBe("VALIDATION");
    expect(unknown.upstreamCode).toBeNull();
    mockFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await codeOf(startScreen(screenReq))).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("maps a network failure without exposing the URL or token", async () => {
    mockFetch(new TypeError(`fetch failed https://orbit.test/screen ${TOKEN}`));
    const failure = orbitFailure(await startScreen(screenReq).catch(e => e));
    expect(failure.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).not.toContain("orbit.test");
  });

  it("aborts a request that outlives the endpoint's time limit", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const pending = startScreen(screenReq).catch(e => e);
    await vi.advanceTimersByTimeAsync(ORBIT_TIMEOUTS.submit);
    const error = await pending;
    expect(orbitFailure(error).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.message).toContain("time limit");
  });

  it("rejects a non-JSON success body", async () => {
    mockFetch(new Response("<html>gateway</html>", { status: 200 }));
    expect(await codeOf(startScreen(screenReq))).toBe("INVALID_RESPONSE");
  });

  it("hides unknown errors behind a generic failure", () => {
    expect(orbitFailure(new Error("secret diagnostic"))).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: expect.not.stringContaining("secret") });
  });
});

describe("POST /screen", () => {
  it("sends the pinned scope with the service token and expects the job named after the scan", async () => {
    const fetch = mockFetch(json(accepted, 202));
    expect(await startScreen({ ...screenReq, extra: "dropped" } as ScreenRequest)).toEqual(accepted);
    const c = call(fetch);
    expect(c.url).toBe("https://orbit.test/screen");
    expect(c.method).toBe("POST");
    expect(c.headers["X-Service-Token"]).toBe(TOKEN);
    expect(c.body).toEqual(screenReq);
  });

  it("reports a resubmitted scan as the same job, not a new one", async () => {
    mockFetch(json({ ...accepted, status: "running", created: false }, 200));
    expect(await startScreen(screenReq)).toMatchObject({ jobId: "screen-scan-1", created: false });
  });

  it("sends an explicit job ID and expects it back", async () => {
    const fetch = mockFetch(json({ ...accepted, jobId: "scan-1.retry-2", statusUrl: "/jobs/scan-1.retry-2" }, 202));
    expect((await startScreen({ ...screenReq, jobId: "scan-1.retry-2" })).jobId).toBe("scan-1.retry-2");
    expect(call(fetch).body.jobId).toBe("scan-1.retry-2");
  });

  it.each([
    ["an acceptance for another job", { ...accepted, jobId: "screen-scan-2" }],
    ["an acceptance without the created flag", without(accepted, "created")],
    ["an acceptance with an unknown status", { ...accepted, status: "done" }],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body, 202));
    expect(await codeOf(startScreen(screenReq))).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["no primaries", { primaryObjectIds: [] }],
    ["more than 50 primaries", { primaryObjectIds: Array.from({ length: 51 }, (_, i) => String(10000 + i)) }],
    ["duplicate primaries", { primaryObjectIds: [ISS, ISS] }],
    ["a bad object ID", { primaryObjectIds: ["ISS"] }],
    ["a reversed window", { fromUtc: "2026-10-28T00:00:00Z", toUtc: "2026-10-25T00:00:00Z" }],
    ["a window over 168 h", { toUtc: "2026-11-02T00:00:01Z" }],
    ["a non-UTC time", { fromUtc: "2026-10-25T00:00:00+03:00" }],
    ["a missing snapshot", { snapshotId: "" }],
    ["an empty evidence version", { evidenceVersion: "" }],
    ["a scan ID that cannot name a job", { scanId: "scan 1" }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(startScreen({ ...screenReq, ...over }))).toBe("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GET /jobs/{id} for a screen", () => {
  it("reads one job by an encoded ID and rejects an answer about another job", async () => {
    const fetch = mockFetch(json(job({})));
    const result = await getScreenJob("job:1.a", expectScreen).catch(e => e);
    expect(call(fetch).url).toBe("https://orbit.test/jobs/job%3A1.a");
    expect(call(fetch).method).toBe("GET");
    expect(call(fetch).body).toBeUndefined();
    expect(orbitFailure(result).code).toBe("INVALID_RESPONSE");
  });

  it("returns a running job with its measured counters and no coverage yet", async () => {
    mockFetch(json(job({ progress: null })));
    const running = await getScreenJob("screen-scan-1", expectScreen);
    expect(running).toMatchObject({ status: "running", phase: "screening", progress: null, coverage: null, result: null, error: null });
    expect(running.counters).toEqual({ primaryObjects: 2, catalogObjects: 19468, primariesCompleted: 1, pairsChecked: 1500, eventsFound: 0 });
    expect(running.requestHash).toBe("9f".repeat(32));
  });

  it("returns a completed result and keeps unavailable spread values null", async () => {
    mockFetch(json(doneJob(screenResult)));
    const done = await getScreenJob("screen-scan-1", expectScreen);
    expect(done.status).toBe("completed");
    expect(done.coverage).toEqual(fullCoverage);
    expect(done.result).toEqual(screenResult);
    expect(done.result?.events[0].spread.supgpMissKm).toBeNull();
    expect(done.result?.runId).toBe("run-7");
  });

  it("passes partial coverage through so an empty result is never read as all clear", async () => {
    const partial = { ...fullCoverage, complete: false, excludedObjects: 4, reasons: [...fullCoverage.reasons, { reason: "primary not in the snapshot", count: 1 }] };
    const result = { ...screenResult, coverage: partial, counts: { ...counts, primariesCompleted: 1, eventsFound: 0 }, missingPrimaryIds: [SAT], events: [] };
    mockFetch(json(doneJob(result, { coverage: partial })));
    const done = await getScreenJob("screen-scan-1", expectScreen);
    expect(done.result?.coverage.complete).toBe(false);
    expect(done.result?.missingPrimaryIds).toEqual([SAT]);
    expect(done.result?.events).toEqual([]);
  });

  it("accepts a result that timed out and says so", async () => {
    const timedOut = { ...fullCoverage, complete: false, timedOut: true };
    mockFetch(json(doneJob({ ...screenResult, coverage: timedOut }, { coverage: timedOut })));
    expect((await getScreenJob("screen-scan-1", expectScreen)).result?.coverage.timedOut).toBe(true);
  });

  it("passes a failed job's error through", async () => {
    mockFetch(json(job({ status: "failed", phase: "failed", finishedAt: "2026-10-25T00:00:05Z",
      error: { code: "SERVICE_RESTARTED", message: "the service restarted before the job finished; resubmit" } })));
    const failed = await getScreenJob("screen-scan-1", expectScreen);
    expect(failed.error).toEqual({ code: "SERVICE_RESTARTED", message: "the service restarted before the job finished; resubmit" });
    expect(failed.result).toBeNull();
  });

  it.each([
    ["a result for another scan", doneJob({ ...screenResult, scanId: "scan-2" })],
    ["a result for another snapshot", doneJob({ ...screenResult, snapshotId: "gp-old" })],
    ["completed without a result", job({ status: "completed", phase: "done" })],
    ["failed without an error", job({ status: "failed", phase: "failed" })],
    ["running with a result", job({ result: screenResult })],
    ["a re-screen job", job({ kind: "rescreen" })],
    ["a made-up percentage", job({ progress: 37 })],
    ["an unknown status", job({ status: "done" })],
    ["an unknown phase", job({ phase: "thinking" })],
    ["a counter that is not a count", job({ counters: { primariesCompleted: "1 of 2" } })],
    ["no request hash", job({ requestHash: "" })],
    ["complete coverage with a missing primary", doneJob({ ...screenResult, missingPrimaryIds: [SAT] })],
    ["complete coverage with an unfinished primary", doneJob({ ...screenResult, counts: { ...counts, primariesCompleted: 1 } })],
    ["coverage both complete and timed out", doneJob({ ...screenResult, coverage: { ...fullCoverage, timedOut: true } })],
    ["an event count that disagrees with the events", doneJob({ ...screenResult, counts: { ...counts, eventsFound: 2 } })],
    ["a spread value that is not a number", doneJob({ ...screenResult, events: [{ ...event, spread: { ...spread, supgpMissKm: "n/a" } }] })],
    ["a self-pair", doneJob({ ...screenResult, events: [{ ...event, objectB: event.objectA }] })],
    ["a primary that is not in the pair", doneJob({ ...screenResult, events: [{ ...event, primaries: [DEB] }] })],
    ["a simulated pair reported as real", doneJob({ ...screenResult, events: [{ ...event, objectB: "SIM-0001" }], objects: { ...screenResult.objects, "SIM-0001": sim } })],
    ["a real object classified maneuverable", doneJob({ ...screenResult, objects: { ...screenResult.objects, [SAT]: info(SAT, { maneuverability: "maneuverable" }) } })],
    ["an object keyed under another ID", doneJob({ ...screenResult, objects: { ...screenResult.objects, [SAT]: info(DEB) } })],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    expect(await codeOf(getScreenJob("screen-scan-1", expectScreen))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /rescreen and its job", () => {
  const req = { jobId: "rescreen-p1-r2", snapshotId: SNAP, evidenceVersion: EV, objectId: SAT, partnerObjectId: ISS,
    maneuver: { burnTimeUtc: "2026-10-25T22:00:00Z", deltaVMs: 0.12, direction: "prograde" as const },
    tcaUtc: "2026-10-26T04:12:00Z", fromUtc: "2026-10-25T00:00:00Z", toUtc: "2026-10-28T22:00:00Z", proposalId: "p1", revision: 2 };
  const expectRescreen = { snapshotId: SNAP, evidenceVersion: EV };
  const pass = {
    passed: true, objectsChecked: 2140, objectsInCatalog: 19467, horizonH: 72.9, originalMissAfterKm: 3.4,
    newConjunctions: [], refusalReason: null, snapshotId: SNAP, evidenceVersion: EV, simulated: false,
    fromUtc: req.fromUtc, toUtc: req.toUtc, screenedFromUtc: req.maneuver.burnTimeUtc, screenedToUtc: req.toUtc,
    attachedObjectIds: [], partnerAttachedObjectIds: [DOCKED], proposalId: "p1", revision: 2,
    method: "SGP4, differential along-track burn", limitations: ["Public mean elements (SGP4/TLE): kilometre-level uncertainty."],
  };
  const conjunction = { objectId: DEB, name: "FENGYUN 1C DEB", tcaUtc: "2026-10-27T01:00:00Z", missKm: 0.3, withoutManeuverKm: 14.2, attachedObjectIds: [] };
  const refusal = { ...pass, passed: false, newConjunctions: [conjunction], refusalReason: `new conjunction with FENGYUN 1C DEB (${DEB}) at 0.3 km, 2026-10-27T01:00:00Z` };
  // rescreen.py _refused(): the maneuver could not be propagated, nothing was screened, no window fields.
  const notRun = { passed: false, objectsChecked: 0, objectsInCatalog: 19467, horizonH: 72, originalMissAfterKm: null, newConjunctions: [],
    refusalReason: "cannot model the maneuver: SGP4 error 6", snapshotId: SNAP, evidenceVersion: EV, simulated: false, method: "not run",
    limitations: ["The maneuver could not be propagated with SGP4; nothing was screened."] };
  const rjob = (result: unknown) => job({ jobId: req.jobId, kind: "rescreen", status: "completed", phase: "done", progress: 1,
    finishedAt: "2026-10-25T00:00:09Z", counters: {}, resultRef: `jobs/${req.jobId}.json#result`, result });

  it("sends the exact trajectory, the partner, the window and the echoes under the caller's job ID", async () => {
    const fetch = mockFetch(json({ jobId: req.jobId, status: "queued", created: true, statusUrl: `/jobs/${req.jobId}` }, 202));
    expect(await startRescreen(req)).toMatchObject({ jobId: req.jobId, created: true });
    expect(call(fetch).url).toBe("https://orbit.test/rescreen");
    expect(call(fetch).body).toEqual(req);
  });

  it.each([
    ["no job ID", { jobId: undefined }],
    ["a non-positive burn", { maneuver: { ...req.maneuver, deltaVMs: 0 } }],
    ["a burn above 1 m/s", { maneuver: { ...req.maneuver, deltaVMs: 1.5 } }],
    ["a burn before the window", { fromUtc: "2026-10-25T23:00:00Z" }],
    ["a closest approach before the burn", { tcaUtc: "2026-10-25T21:00:00Z" }],
    ["the partner as the moved object", { partnerObjectId: SAT }],
    ["no partner", { partnerObjectId: undefined }],
    ["a revision that is not a positive integer", { revision: 0 }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(startRescreen({ ...req, ...over } as typeof req))).toBe("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a pass with its echoes", async () => {
    mockFetch(json(rjob(pass)));
    const done = await getRescreenJob(req.jobId, expectRescreen);
    expect(done.result?.passed).toBe(true);
    expect(done.result?.proposalId).toBe("p1");
    expect(done.result?.partnerAttachedObjectIds).toEqual([DOCKED]);
  });

  it("accepts a refusal with its reason and the unmoved-orbit comparison", async () => {
    mockFetch(json(rjob(refusal)));
    const done = await getRescreenJob(req.jobId, expectRescreen);
    expect(done.result?.passed).toBe(false);
    expect(done.result?.newConjunctions[0].withoutManeuverKm).toBe(14.2);
    expect(done.result?.refusalReason).toContain("FENGYUN 1C DEB");
  });

  it("accepts a refusal for a maneuver that could not be propagated, with nothing screened", async () => {
    mockFetch(json(rjob(notRun)));
    const done = await getRescreenJob(req.jobId, expectRescreen);
    expect(done.result).toMatchObject({ passed: false, objectsChecked: 0, originalMissAfterKm: null });
    expect(done.result?.screenedFromUtc).toBeUndefined();
  });

  it.each([
    ["a pass with a new conjunction under 1 km", { ...pass, newConjunctions: [conjunction] }],
    ["a pass with the original pair under 1 km", { ...pass, originalMissAfterKm: 0.8 }],
    ["a pass without a checked partner", { ...pass, originalMissAfterKm: null }],
    ["a pass with a refusal reason", { ...pass, refusalReason: "partner not given: original pair not checked" }],
    ["a refusal without a reason", { ...refusal, refusalReason: null }],
    ["another evidence version", { ...pass, evidenceVersion: "ev-6" }],
    ["a missing echo", without(pass, "evidenceVersion")],
    ["a horizon beyond a week", { ...pass, horizonH: 200 }],
    ["a conjunction without the unmoved comparison field", { ...refusal, newConjunctions: [without(conjunction, "withoutManeuverKm")] }],
  ])("rejects %s", async (_, result) => {
    mockFetch(json(rjob(result)));
    expect(await codeOf(getRescreenJob(req.jobId, expectRescreen))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /candidates", () => {
  const req = { snapshotId: SNAP, evidenceVersion: EV, objectA: ISS, objectB: SAT, tcaUtc: "2026-10-26T04:12:00Z",
    allowedMovingObjectIds: [SAT], notBeforeUtc: "2026-10-25T12:00:00Z", runId: "run-9" };
  const maneuver = {
    candidateId: "B:T-6h:+0.05", kind: "maneuver", movingSide: "B", movingObjectId: SAT, burnTimeUtc: "2026-10-25T22:12:00Z", leadH: 6,
    deltaVMs: 0.05, direction: "prograde", deltaAKm: 0.09, missBeforeKm: 0.42, missAfterKm: 2.4, tcaAfterUtc: "2026-10-26T04:12:02Z",
    relSpeedKmS: 11.8, passesPairThreshold: true, estimatedFuelKg: null, indicative: true, simulated: false, rank: 1,
  };
  const weak = { ...maneuver, candidateId: "B:T-3h:+0.02", leadH: 3, burnTimeUtc: "2026-10-26T01:12:00Z", deltaVMs: 0.02, missAfterKm: 0.7, passesPairThreshold: false, rank: 2 };
  const wait = { candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null, leadH: null, deltaVMs: null,
    direction: null, deltaAKm: null, missBeforeKm: 0.42, missAfterKm: null, tcaAfterUtc: null, relSpeedKmS: null, passesPairThreshold: false,
    estimatedFuelKg: null, indicative: true, simulated: false, rank: null };
  const response = {
    snapshotId: SNAP, evidenceVersion: EV, objectA: ISS, objectB: SAT,
    objects: { [ISS]: info(ISS, { name: "ISS (ZARYA)", group: "stations" }), [SAT]: info(SAT) },
    notMovable: [{ side: "A", objectId: ISS, reason: "not in allowedMovingObjectIds" }],
    tcaUtc: "2026-10-26T04:12:03Z", tcaInputUtc: req.tcaUtc, missBeforeKm: 0.42, relSpeedKmS: 11.8, simulated: false,
    candidates: [maneuver, weak], wait, failed: [{ candidateId: "B:T-12h:-0.2", reason: "the orbit decays" }],
    assumptions: ["Indicative geometry: SGP4 on public mean elements, impulsive along-track burn, no covariance.", `Side A (${ISS}) does not move: not in allowedMovingObjectIds.`],
    method: "SGP4 (python-sgp4, WGS-72) with a differential impulsive along-track burn", runId: "run-9",
  };

  it("sends the pinned event version and the allowed movers, and returns the service's grid", async () => {
    const fetch = mockFetch(json(response));
    const result: CandidatesResponse = await getCandidates(req);
    expect(call(fetch).url).toBe("https://orbit.test/candidates");
    expect(call(fetch).body).toEqual(req);
    expect(result).toEqual(response);
    expect(result.candidates[0].estimatedFuelKg).toBeNull();
    expect(result.wait.kind).toBe("wait");
    expect(result.notMovable[0].objectId).toBe(ISS);
  });

  it("accepts a grid where nobody may move and only waiting is left", async () => {
    const frozen = { ...response, candidates: [], notMovable: [{ side: "A", objectId: ISS, reason: "not in allowedMovingObjectIds" }, { side: "B", objectId: SAT, reason: "not in allowedMovingObjectIds" }] };
    mockFetch(json(frozen));
    expect((await getCandidates({ ...req, allowedMovingObjectIds: [] })).candidates).toEqual([]);
  });

  it.each([
    ["an allowed mover outside the pair", { allowedMovingObjectIds: [DEB] }],
    ["a self-pair", { objectB: ISS }],
    ["a bad not-before time", { notBeforeUtc: "yesterday" }],
    ["an empty evidence version", { evidenceVersion: "" }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(getCandidates({ ...req, ...over }))).toBe("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a mover the caller did not allow", { ...response, notMovable: [], candidates: [{ ...maneuver, candidateId: "A:T-6h:+0.05", movingSide: "A", movingObjectId: ISS }] }],
    ["a mover listed as not movable", { ...response, candidates: [{ ...maneuver, candidateId: "A:T-6h:+0.05", movingSide: "A", movingObjectId: ISS }] }],
    ["debris as the moving object", { ...response, objects: { ...response.objects, [SAT]: { ...debris, objectId: SAT } } }],
    ["a mover that is not its side's object", { ...response, candidates: [{ ...maneuver, movingObjectId: ISS }] }],
    ["another pair", { ...response, objectB: DEB }],
    ["another evidence version", { ...response, evidenceVersion: "ev-6" }],
    ["another input TCA", { ...response, tcaInputUtc: "2026-10-26T04:13:00Z" }],
    ["a refined TCA far from the input", { ...response, tcaUtc: "2026-10-26T05:00:00Z" }],
    ["a wait card with a burn", { ...response, wait: { ...wait, deltaVMs: 0.1 } }],
    ["a maneuver without a burn time", { ...response, candidates: [{ ...maneuver, burnTimeUtc: null }] }],
    ["a burn after closest approach", { ...response, candidates: [{ ...maneuver, burnTimeUtc: "2026-10-26T05:00:00Z" }] }],
    ["fuel estimated by the service", { ...response, candidates: [{ ...maneuver, estimatedFuelKg: 1.2 }] }],
    ["a pass flag that disagrees with the miss", { ...response, candidates: [{ ...weak, passesPairThreshold: true }] }],
    ["a candidate not marked indicative", { ...response, candidates: [{ ...maneuver, indicative: false }] }],
    ["a rank that is not a positive integer", { ...response, candidates: [{ ...maneuver, rank: 0 }] }],
    ["a pair with a SIM object reported as real", { ...response, objectB: "SIM-0001", objects: { ...response.objects, "SIM-0001": sim } }],
    ["objects that omit one of the pair", { ...response, objects: { [ISS]: response.objects[ISS] } }],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    const r = body as { objectB: string };
    expect(await codeOf(getCandidates({ ...req, objectB: r.objectB === "SIM-0001" ? "SIM-0001" : req.objectB, allowedMovingObjectIds: r.objectB === "SIM-0001" ? [] : req.allowedMovingObjectIds }))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /simulate", () => {
  const req = { targetObjectId: ISS, tcaUtc: "2026-10-26T04:12:00Z", name: "Demo Sat", deltaAKm: 20 };
  const body = {
    objectId: "SIM-0001", omm: { OBJECT_NAME: "Demo Sat", OBJECT_ID: "SIM-0001", NORAD_CAT_ID: "SIM-0001", SIMULATED: true },
    tle: ["1 00000U 00000A   26298.17500000  .00000000  00000-0  00000-0 0  9999", "2 00000  51.6400 100.0000 0001000  90.0000 270.0000 15.50000000    05"],
    simulated: true,
    event: { objectA: ISS, objectB: "SIM-0001", tcaUtc: "2026-10-26T04:12:00Z", missKm: 0.2, relSpeedKmS: 0.41, simulated: true },
    assumptions: ["Plane tilted 3.0° about the meeting point, 0.2 km radial offset, semi-major axis +20 km from the target's (SCR-10)."],
  };

  it("returns a reserved simulated ID paired with the target, flagged simulated", async () => {
    const fetch = mockFetch(json(body));
    expect(await simulate(req)).toEqual(body);
    expect(call(fetch).url).toBe("https://orbit.test/simulate");
    expect(call(fetch).body).toEqual(req);
  });

  it("expects a requested SIM ID back", async () => {
    mockFetch(json({ ...body, objectId: "SIM-0007", event: { ...body.event, objectB: "SIM-0007" } }));
    expect((await simulate({ ...req, objectId: "SIM-0007" })).objectId).toBe("SIM-0007");
    mockFetch(json(body));
    expect(await codeOf(simulate({ ...req, objectId: "SIM-0007" }))).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["a real catalog number", { ...body, objectId: "48299", event: { ...body.event, objectB: "48299" } }],
    ["an event for another target", { ...body, event: { ...body.event, objectA: SAT } }],
    ["an event with another simulated object", { ...body, event: { ...body.event, objectB: "SIM-0002" } }],
    ["an event not flagged simulated", { ...body, event: { ...body.event, simulated: false } }],
    ["an object not flagged simulated", { ...body, simulated: false }],
    ["an empty OMM", { ...body, omm: {} }],
    ["a TLE with one line", { ...body, tle: [body.tle[0]] }],
  ])("rejects %s", async (_, response) => {
    mockFetch(json(response));
    expect(await codeOf(simulate(req))).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["another simulated object as the target", { targetObjectId: "SIM-0002" }],
    ["a tilt outside (0, 10]", { tiltDeg: 12 }],
    ["a miss outside [0.05, 5]", { missKm: 0.01 }],
    ["an ID that is not a SIM ID", { objectId: "48299" }],
    ["a name over 80 characters", { name: "x".repeat(81) }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(simulate({ ...req, ...over }))).toBe("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("POST /verify", () => {
  const req = { objectId: SAT, expected: { burnTimeUtc: "2026-10-25T22:12:00Z", deltaVMs: 0.05, direction: "prograde" as const },
    series: [{ epochUtc: "2026-10-24T06:00:00Z", meanMotionRevPerDay: 15.49 }, { epochUtc: "2026-10-26T06:00:00Z", smaKm: 6921.4 }] };
  const base = {
    kind: "live", label: "evidence consistent with plan", expected: { deltaAKm: 0.0905, sign: 1 }, elementSetCount: 2,
    series: [{ epochUtc: "2026-10-24T06:00:00Z", smaKm: 6921.31 }, { epochUtc: "2026-10-26T06:00:00Z", smaKm: 6921.4 }],
    thresholds: { z: 5, minDeltaAKm: 0.05, sizeTolerance: 0.5, minSets: 8 }, method: "SMA from mean motion; Theil–Sen trend on pre-burn sets",
    limitations: ["Mean elements from public element sets; not proof of the exact Δv or execution time."], missing: [],
    sources: [{ name: "gp_history", url: null, epochUtc: "2026-10-26T06:00:00Z", fetchedAt: null }], simulated: false,
  };
  const consistent = { ...base, result: "consistent", observed: { deltaAKm: 0.09, z: 7.1, epochUtc: "2026-10-26T06:00:00Z" } };
  const awaiting = { ...base, result: "awaiting_data", label: "awaiting verification data", observed: null,
    missing: ["8 element sets (have 2)", "4 element sets before the burn (have 1)", "4 element sets after the burn (have 1)"] };

  it("returns a verdict with its observation and sends the burn time the service needs", async () => {
    const fetch = mockFetch(json(consistent));
    expect(await verify(req)).toEqual(consistent);
    expect(call(fetch).url).toBe("https://orbit.test/verify");
    expect(call(fetch).body).toEqual(req);
  });

  it("never lets the caller label the object simulated", async () => {
    const fetch = mockFetch(json(consistent));
    await verify({ ...req, simulated: true } as typeof req);
    expect(call(fetch).body).not.toHaveProperty("simulated");
  });

  it("keeps missing evidence explicit while awaiting data, with or without an observation below the noise", async () => {
    mockFetch(json(awaiting));
    const result = await verify(req);
    expect(result.observed).toBeNull();
    expect(result.missing).toHaveLength(3);
    const quiet = { ...base, result: "awaiting_data", label: "awaiting verification data", observed: { deltaAKm: 0.004, z: 0.3, epochUtc: "2026-10-26T06:00:00Z" },
      missing: ["a semi-major-axis change above the noise (|z| ≥ 5 and |Δa| ≥ 50 m)"] };
    mockFetch(json(quiet));
    expect((await verify(req)).result).toBe("awaiting_data");
  });

  it("asks for a labeled replay and accepts its simulated verdict", async () => {
    const replay = { objectId: ISS, replay: "iss-simulated-reboost", expected: { burnTimeUtc: "2026-10-22T18:00:00Z", deltaVMs: 0.5 } };
    const fetch = mockFetch(json({ ...consistent, kind: "replay", simulated: true, expected: { deltaAKm: 0.9, sign: 1 } }));
    const result = await verify(replay);
    expect(call(fetch).body).toEqual(replay);
    expect(result.kind).toBe("replay");
    expect(result.simulated).toBe(true);
  });

  it.each([
    ["a verdict without an observation", { ...consistent, observed: null }],
    ["a verdict with missing evidence", { ...consistent, missing: ["8 element sets (have 2)"] }],
    ["awaiting data without saying what is missing", { ...awaiting, missing: [] }],
    ["an expectation whose sign contradicts the burn direction", { ...consistent, expected: { deltaAKm: -0.09, sign: -1 } }],
    ["an expectation of no change", { ...consistent, expected: { deltaAKm: 0, sign: 1 } }],
    ["an element set count that disagrees with the series", { ...consistent, elementSetCount: 9 }],
    ["a series point without a semi-major axis", { ...consistent, series: [{ epochUtc: "2026-10-24T06:00:00Z" }, base.series[1]] }],
    ["an unlabeled verdict", { ...consistent, simulated: "no" }],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    expect(await codeOf(verify(req))).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["both a series and a replay", { replay: "iss-simulated-reboost" }],
    ["neither a burn size nor a semi-major axis change", { expected: { burnTimeUtc: req.expected.burnTimeUtc } }],
    ["a replay name that is a path", { series: undefined, replay: "../secrets" }],
    ["an element set with both mean motion and semi-major axis", { series: [{ epochUtc: "2026-10-24T06:00:00Z", meanMotionRevPerDay: 15.49, smaKm: 6921 }] }],
    ["an expectation of zero", { expected: { burnTimeUtc: req.expected.burnTimeUtc, deltaAKm: 0 } }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(verify({ ...req, ...over } as typeof req))).toBe("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });
});
