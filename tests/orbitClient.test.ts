import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCandidates, getRescreenJob, getScreenJob, ORBIT_TIMEOUT_MS, orbitFailure, OrbitServiceError, simulate,
  startRescreen, startScreen, verify,
} from "../convex/lib/orbitClient";

const TOKEN = "test-only-service-token";
beforeEach(() => {
  vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test/");
  vi.stubEnv("ORBIT_SERVICE_TOKEN", TOKEN);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
const codeOf = async (p: Promise<unknown>) => {
  const error = await p.catch(e => e);
  expect(error).toBeInstanceOf(OrbitServiceError);
  return (error as OrbitServiceError).code;
};

const SNAP = "gp-20261024T2134Z";
const EV = "ev-7";
const spread = { gpMissKm: 0.42, supgpMissKm: null, minKm: 0.42, maxKm: 0.42, gpEpochUtc: "2026-10-24T21:00:00Z", supgpEpochUtc: null };
const event = { objectA: "48211", objectB: "799501621", tcaUtc: "2026-10-26T04:12:00Z", missKm: 0.42, relSpeedKmS: 11.8, spread };
const fullCoverage = { complete: true, catalogScope: "celestrak_gp full catalog", excludedObjects: 0, reasons: [] };
const screenReq = { scanId: "scan-1", snapshotId: SNAP, primaryObjectIds: ["48211", "48212"], fromUtc: "2026-10-25T00:00:00Z", toUtc: "2026-10-28T00:00:00Z" };
const job = (over: Record<string, unknown>) => ({
  jobId: "job-1", kind: "screen", status: "running", phase: "screening", progress: null,
  counts: { primaryObjects: 2, primariesCompleted: 1 }, coverage: null, result: null, error: null, ...over,
});

describe("configuration and transport", () => {
  it("refuses to call anything without a URL and token", async () => {
    vi.stubEnv("ORBIT_SERVICE_TOKEN", "");
    const fetch = mockFetch();
    expect(await codeOf(startScreen(screenReq))).toBe("ORBIT_NOT_CONFIGURED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, "ORBIT_ACCESS_DENIED"], [403, "ORBIT_ACCESS_DENIED"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"],
    [422, "REQUEST_REJECTED"], [500, "UPSTREAM_UNAVAILABLE"], [503, "UPSTREAM_UNAVAILABLE"]])(
    "makes one attempt on HTTP %s and never leaks the upstream body", async (status, code) => {
      const fetch = mockFetch(json({ detail: "secret diagnostic" }, status));
      const error = await startScreen(screenReq).catch(e => e);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(orbitFailure(error).code).toBe(code);
      expect(orbitFailure(error).message).not.toContain("secret diagnostic");
    });

  it("maps a network failure or timeout without exposing the URL or token", async () => {
    mockFetch(new TypeError(`fetch failed https://orbit.test/screen ${TOKEN}`));
    const failure = orbitFailure(await startScreen(screenReq).catch(e => e));
    expect(failure.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).not.toContain("orbit.test");
  });

  it("rejects a non-JSON body", async () => {
    mockFetch(new Response("<html>gateway</html>", { status: 200 }));
    expect(await codeOf(startScreen(screenReq))).toBe("INVALID_RESPONSE");
  });

  it("hides unknown errors behind a generic failure", () => {
    expect(orbitFailure(new Error("secret diagnostic"))).toEqual({
      code: "UPSTREAM_UNAVAILABLE", message: expect.not.stringContaining("secret"),
    });
  });
});

describe("POST /screen and GET /jobs/{id}", () => {
  it("sends the pinned scope with the service token and returns only the job ID", async () => {
    const fetch = mockFetch(json({ jobId: "job-1" }));
    expect(await startScreen({ ...screenReq, extra: "dropped" } as typeof screenReq)).toEqual({ jobId: "job-1" });
    const c = call(fetch);
    expect(c.url).toBe("https://orbit.test/screen");
    expect(c.method).toBe("POST");
    expect(c.headers["X-Service-Token"]).toBe(TOKEN);
    expect(c.body).toEqual(screenReq);
  });

  it.each([
    ["no primaries", { primaryObjectIds: [] }],
    ["duplicate primaries", { primaryObjectIds: ["48211", "48211"] }],
    ["bad object ID", { primaryObjectIds: ["ISS"] }],
    ["reversed window", { fromUtc: "2026-10-28T00:00:00Z", toUtc: "2026-10-25T00:00:00Z" }],
    ["non-UTC time", { fromUtc: "2026-10-25T00:00:00+03:00" }],
    ["missing snapshot", { snapshotId: "" }],
  ])("checks the request before sending it: %s", async (_, over) => {
    const fetch = mockFetch();
    expect(await codeOf(startScreen({ ...screenReq, ...over }))).toBe("INVALID_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a running job with indeterminate progress as null, not 0", async () => {
    const fetch = mockFetch(json(job({})));
    const result = await getScreenJob("job/1 ?", { scanId: "scan-1", snapshotId: SNAP }).catch(e => e);
    expect(call(fetch).url).toBe("https://orbit.test/jobs/job%2F1%20%3F");
    expect(call(fetch).method).toBe("GET");
    expect(orbitFailure(result).code).toBe("INVALID_RESPONSE");   // echoed jobId differs from the requested one

    mockFetch(json(job({})));
    const running = await getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP });
    expect(running.progress).toBeNull();
    expect(running.result).toBeNull();
    expect(running.counts).toEqual({ primaryObjects: 2, primariesCompleted: 1 });
  });

  it("returns a completed result and keeps unavailable spread values null", async () => {
    mockFetch(json(job({ status: "completed", phase: "done", progress: 1, coverage: fullCoverage,
      result: { scanId: "scan-1", snapshotId: SNAP, coverage: fullCoverage, events: [event] } })));
    const done = await getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP });
    expect(done.result?.events).toEqual([event]);
    expect(done.result?.events[0].spread.supgpMissKm).toBeNull();
  });

  it("passes partial coverage through so an empty result is never read as all clear", async () => {
    const partial = { complete: false, catalogScope: "celestrak_gp", excludedObjects: 31, reasons: [{ reason: "stale_epoch", count: 31 }] };
    mockFetch(json(job({ status: "completed", phase: "done", progress: 1, coverage: partial,
      result: { scanId: "scan-1", snapshotId: SNAP, coverage: partial, events: [] } })));
    const done = await getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP });
    expect(done.result?.coverage.complete).toBe(false);
    expect(done.result?.events).toEqual([]);
  });

  it("accepts complete coverage that discloses unusable objects it excluded", async () => {
    const disclosed = { ...fullCoverage, excludedObjects: 3, reasons: [{ reason: "decayed", count: 3 }] };
    mockFetch(json(job({ coverage: disclosed })));
    expect((await getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP })).coverage).toEqual(disclosed);
  });

  it("aborts a request that outlives the timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      vi.stubGlobal("fetch", fetch);
      const pending = startScreen(screenReq).catch(e => e);
      await vi.advanceTimersByTimeAsync(ORBIT_TIMEOUT_MS);
      expect(orbitFailure(await pending).code).toBe("UPSTREAM_UNAVAILABLE");
    } finally { vi.useRealTimers(); }
  });

  it("passes a failed job's error through", async () => {
    mockFetch(json(job({ status: "failed", phase: "failed", error: { code: "SNAPSHOT_MISSING", message: "Snapshot not loaded." } })));
    const failed = await getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP });
    expect(failed.error).toEqual({ code: "SNAPSHOT_MISSING", message: "Snapshot not loaded." });
  });

  it.each([
    ["a result for another scan", job({ status: "completed", phase: "done", result: { scanId: "scan-2", snapshotId: SNAP, coverage: fullCoverage, events: [] } })],
    ["a result for another snapshot", job({ status: "completed", phase: "done", result: { scanId: "scan-1", snapshotId: "gp-old", coverage: fullCoverage, events: [] } })],
    ["completed without a result", job({ status: "completed", phase: "done" })],
    ["failed without an error", job({ status: "failed", phase: "failed" })],
    ["running with a result", job({ result: { scanId: "scan-1", snapshotId: SNAP, coverage: fullCoverage, events: [] } })],
    ["a re-screen job", job({ kind: "rescreen" })],
    ["a made-up percentage", job({ progress: 37 })],
    ["an unknown status", job({ status: "done" })],
    ["an extra key", { ...job({}), percent: 50 }],
    ["a zeroed miss instead of null", job({ status: "completed", phase: "done", result: { scanId: "scan-1", snapshotId: SNAP, coverage: fullCoverage,
      events: [{ ...event, spread: { ...spread, supgpMissKm: "n/a" } }] } })],
    ["a self-pair", job({ status: "completed", phase: "done", result: { scanId: "scan-1", snapshotId: SNAP, coverage: fullCoverage,
      events: [{ ...event, objectB: event.objectA }] } })],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    expect(await codeOf(getScreenJob("job-1", { scanId: "scan-1", snapshotId: SNAP }))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /rescreen", () => {
  const req = { snapshotId: SNAP, evidenceVersion: EV, objectId: "48211",
    maneuver: { burnTimeUtc: "2026-10-25T22:00:00Z", deltaVMs: 0.12, direction: "prograde" as const },
    fromUtc: "2026-10-25T22:00:00Z", toUtc: "2026-10-28T22:00:00Z" };
  const pass = { snapshotId: SNAP, evidenceVersion: EV, passed: true, objectsChecked: 19468, horizonH: 72,
    originalMissAfterKm: 3.4, newConjunctions: [{ objectId: "25544", name: "ISS", tcaUtc: "2026-10-27T01:00:00Z", missKm: 6.1 }], refusalReason: null };
  const rjob = (over: Record<string, unknown>) => job({ kind: "rescreen", phase: "done", status: "completed", progress: 1, ...over });

  it("sends the exact trajectory with echoed versions and returns only the job ID", async () => {
    const fetch = mockFetch(json({ jobId: "job-r" }));
    expect(await startRescreen(req)).toEqual({ jobId: "job-r" });
    expect(call(fetch).url).toBe("https://orbit.test/rescreen");
    expect(call(fetch).body).toEqual(req);
  });

  it("rejects a non-positive burn before sending", async () => {
    const fetch = mockFetch();
    expect(await codeOf(startRescreen({ ...req, maneuver: { ...req.maneuver, deltaVMs: 0 } }))).toBe("INVALID_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a pass and a refusal with its reason", async () => {
    mockFetch(json(rjob({ result: pass })));
    expect((await getRescreenJob("job-1", { snapshotId: SNAP, evidenceVersion: EV })).result?.passed).toBe(true);
    const refusal = { ...pass, passed: false, newConjunctions: [{ ...pass.newConjunctions[0], missKm: 0.3 }], refusalReason: "New conjunction under 1 km." };
    mockFetch(json(rjob({ result: refusal })));
    expect((await getRescreenJob("job-1", { snapshotId: SNAP, evidenceVersion: EV })).result?.refusalReason).toBe("New conjunction under 1 km.");
  });

  it.each([
    ["a pass with a new conjunction under 1 km", { ...pass, newConjunctions: [{ ...pass.newConjunctions[0], missKm: 0.5 }] }],
    ["a pass with the original miss under 1 km", { ...pass, originalMissAfterKm: 0.8 }],
    ["a refusal without a reason", { ...pass, passed: false }],
    ["another evidence version", { ...pass, evidenceVersion: "ev-6" }],
    ["a missing echo", (({ evidenceVersion: _, ...rest }) => rest)(pass)],
  ])("rejects %s", async (_, result) => {
    mockFetch(json(rjob({ result })));
    expect(await codeOf(getRescreenJob("job-1", { snapshotId: SNAP, evidenceVersion: EV }))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /candidates", () => {
  const req = { eventId: "evt-1", snapshotId: SNAP, evidenceVersion: EV, objectA: "48211", objectB: "799501621",
    tcaUtc: "2026-10-26T04:12:00Z", allowedMovingObjectIds: ["48211"] };
  const maneuver = { kind: "maneuver", movingObjectId: "48211", burnTimeUtc: "2026-10-25T22:00:00Z", direction: "prograde",
    deltaVMs: 0.12, estimatedFuelKg: null, missAfterKm: 3.4, reviewCondition: null, assumptions: ["impulsive burn"] };
  const wait = { kind: "wait", movingObjectId: null, burnTimeUtc: null, direction: null, deltaVMs: null,
    estimatedFuelKg: null, missAfterKm: null, reviewCondition: "Next CDM update", assumptions: [] };
  const response = { eventId: "evt-1", evidenceVersion: EV, snapshotId: SNAP, simulated: false, candidates: [maneuver, wait] };

  it("sends the event version and allowed movers, and returns the card-mapper shape", async () => {
    const fetch = mockFetch(json(response));
    const result = await getCandidates(req);
    expect(call(fetch).url).toBe("https://orbit.test/candidates");
    expect(call(fetch).body).toEqual(req);
    expect(result).toEqual(response);
    expect(result.candidates[0].estimatedFuelKg).toBeNull();
  });

  it("refuses an allowed mover outside the pair before sending", async () => {
    const fetch = mockFetch();
    expect(await codeOf(getCandidates({ ...req, allowedMovingObjectIds: ["25544"] }))).toBe("INVALID_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["debris as the moving object", { ...response, candidates: [{ ...maneuver, movingObjectId: "799501621" }] }],
    ["another event", { ...response, eventId: "evt-2" }],
    ["another evidence version", { ...response, evidenceVersion: "ev-6" }],
    ["a wait card with a burn", { ...response, candidates: [{ ...wait, deltaVMs: 0.1 }] }],
    ["a maneuver without a burn time", { ...response, candidates: [{ ...maneuver, burnTimeUtc: null }] }],
    ["fuel reported as a string", { ...response, candidates: [{ ...maneuver, estimatedFuelKg: "1.2 kg" }] }],
    ["a policy field the service must not send", { ...response, candidates: [{ ...maneuver, feasibility: "feasible" }] }],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    expect(await codeOf(getCandidates(req))).toBe("INVALID_RESPONSE");
  });
});

describe("POST /simulate", () => {
  const req = { targetObjectId: "48211", tcaUtc: "2026-10-26T04:12:00Z", name: "Demo Sat" };
  const body = { objectId: "SIM-0001", omm: { OBJECT_NAME: "Demo Sat", NORAD_CAT_ID: "SIM-0001" },
    event: { ...event, objectA: "48211", objectB: "SIM-0001" } };

  it("returns a reserved simulated ID paired with the target", async () => {
    const fetch = mockFetch(json(body));
    expect(await simulate(req)).toEqual(body);
    expect(call(fetch).body).toEqual(req);
  });

  it.each([
    ["a real catalog number", { ...body, objectId: "48299", event: { ...body.event, objectB: "48299" } }],
    ["an event for another target", { ...body, event: { ...body.event, objectA: "25544" } }],
    ["an empty OMM", { ...body, omm: {} }],
  ])("rejects %s", async (_, response) => {
    mockFetch(json(response));
    expect(await codeOf(simulate(req))).toBe("INVALID_RESPONSE");
  });

  it("refuses to simulate against another simulated object", async () => {
    const fetch = mockFetch();
    expect(await codeOf(simulate({ ...req, targetObjectId: "SIM-0002" }))).toBe("INVALID_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("POST /verify", () => {
  const req = { objectId: "48211", expected: { deltaAKm: 0.21, sign: 1 as const } };
  const base = { kind: "replay", label: "evidence consistent with plan", expected: req.expected, elementSetCount: 9,
    series: [{ epochUtc: "2026-10-26T06:00:00Z", smaKm: 6921.4 }],
    thresholds: { z: 5, minDeltaAKm: 0.05, sizeTolerance: 0.5, minSets: 8 }, method: "SMA step vs. pre-burn baseline",
    limitations: ["Public GP elements only"], missing: [],
    sources: [{ name: "gp_history", url: null, epochUtc: "2026-10-26T06:00:00Z", fetchedAt: null }] };
  const consistent = { ...base, result: "consistent", observed: { deltaAKm: 0.2, z: 7.1, epochUtc: "2026-10-26T06:00:00Z" } };

  it("returns a verdict with its observation", async () => {
    const fetch = mockFetch(json(consistent));
    expect(await verify(req)).toEqual(consistent);
    expect(call(fetch).url).toBe("https://orbit.test/verify");
    expect(call(fetch).body).toEqual(req);
  });

  it("keeps missing evidence explicit while awaiting data", async () => {
    const awaiting = { ...base, result: "awaiting_data", label: "awaiting verification data", observed: null,
      elementSetCount: 2, missing: ["Fewer than 8 post-burn element sets"] };
    mockFetch(json(awaiting));
    const result = await verify(req);
    expect(result.observed).toBeNull();
    expect(result.missing).toEqual(["Fewer than 8 post-burn element sets"]);
  });

  it.each([
    ["a verdict without an observation", { ...consistent, observed: null }],
    ["awaiting data with an observation", { ...consistent, result: "awaiting_data" }],
    ["another expectation", { ...consistent, expected: { deltaAKm: 0.5, sign: 1 } }],
    ["an unknown source", { ...consistent, sources: [{ ...base.sources[0], name: "spacetrack" }] }],
  ])("rejects %s", async (_, body) => {
    mockFetch(json(body));
    expect(await codeOf(verify(req))).toBe("INVALID_RESPONSE");
  });
});
