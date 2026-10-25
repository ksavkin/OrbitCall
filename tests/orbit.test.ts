import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { OrbitError, orbit, orbitConfig, orbitRequest, waitForJob, type CandidatesResponse, type ServiceCandidate } from "../convex/lib/orbit";
import { assignRevisions, selectCandidates } from "../convex/lib/orbitCandidates";
import { validateCandidates } from "../convex/lib/policies";
import { backend, insertEvent } from "./helpers";
import { advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";

const config = { url: "https://orbit.test", token: "test-only-token" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function grid(overrides: Partial<ServiceCandidate> & Pick<ServiceCandidate, "movingSide">): ServiceCandidate {
  const side = overrides.movingSide;
  return {
    candidateId: `${side}:T-6h:+0.05`, kind: "maneuver",
    movingObjectId: side === "A" ? advocateEvent.objectA.objectId : advocateEvent.objectB.objectId,
    burnTimeUtc: "2026-10-24T21:14:07Z", leadH: 6, deltaVMs: 0.05, direction: "prograde", deltaAKm: 0.09,
    missBeforeKm: 0.21, missAfterKm: 2.4, tcaAfterUtc: "2026-10-25T03:14:09Z", relSpeedKmS: 7.6,
    passesPairThreshold: true, estimatedFuelKg: null, indicative: true, simulated: true, rank: 1, ...overrides,
  };
}
const wait: ServiceCandidate = { ...grid({ movingSide: null }), candidateId: "wait", kind: "wait", movingObjectId: null,
  burnTimeUtc: null, leadH: null, deltaVMs: null, direction: null, deltaAKm: null, missAfterKm: null, passesPairThreshold: false, rank: null };
const response = (candidates: ServiceCandidate[]): CandidatesResponse => ({
  snapshotId: "gp-20261024T2134Z", evidenceVersion: null,
  objectA: advocateEvent.objectA.objectId, objectB: advocateEvent.objectB.objectId, objects: {}, notMovable: [],
  tcaUtc: advocateEvent.tcaUtc, tcaInputUtc: advocateEvent.tcaUtc, missBeforeKm: 0.21, relSpeedKmS: 7.6, simulated: true,
  candidates, wait, failed: [], assumptions: ["Impulsive burn along the velocity."], method: "SGP4 grid",
});
// The service's own order: passing first, then least Δv.
const serviceGrid = [
  grid({ movingSide: "A", deltaVMs: 0.02, missAfterKm: 1.3, candidateId: "A:T-12h:+0.02", leadH: 12, burnTimeUtc: "2026-10-24T15:14:07Z" }),
  grid({ movingSide: "B", deltaVMs: 0.05, direction: "retrograde", missAfterKm: 2.1 }),
  grid({ movingSide: "A", deltaVMs: 0.1 }),
  grid({ movingSide: "B", deltaVMs: 0.02, missAfterKm: 0.4, passesPairThreshold: false }),
];

describe("orbital service client", () => {
  it("is unavailable, not guessing, when the deployment has no URL or token", () => {
    expect(() => orbitConfig({})).toThrow(OrbitError);
    expect(() => orbitConfig({ ORBIT_SERVICE_URL: "https://orbit.test" })).toThrow("not configured");
    expect(orbitConfig({ ORBIT_SERVICE_URL: "https://orbit.test/", ORBIT_SERVICE_TOKEN: "t" })).toEqual({ url: "https://orbit.test", token: "t" });
  });

  it("sends the service token and a JSON body, and returns the parsed answer", async () => {
    fetchMock.mockResolvedValue(json(200, response(serviceGrid)));
    const body = { objectA: "1", objectB: "2", tcaUtc: advocateEvent.tcaUtc };
    const answer = await orbit.candidates(config, body);
    expect(answer.snapshotId).toBe("gp-20261024T2134Z");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://orbit.test/candidates");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-Service-Token"]).toBe("test-only-token");
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it("keeps fixable request errors and turns the rest into UPSTREAM_UNAVAILABLE without echoing the token", async () => {
    const codeOf = async (res: Response | Error) => {
      fetchMock.mockReset();
      if (res instanceof Error) fetchMock.mockRejectedValue(res); else fetchMock.mockResolvedValue(res);
      try { await orbit.snapshot(config); return "ok"; } catch (e) {
        expect((e as Error).message).not.toContain(config.token);
        return (e as OrbitError).code;
      }
    };
    expect(await codeOf(json(400, { error: { code: "VALIDATION", message: "bad time" } }))).toBe("VALIDATION");
    expect(await codeOf(json(404, { error: { code: "NOT_FOUND", message: "no object" } }))).toBe("NOT_FOUND");
    expect(await codeOf(json(409, { error: { code: "SNAPSHOT_MISMATCH", message: "other snapshot" } }))).toBe("SNAPSHOT_MISMATCH");
    expect(await codeOf(json(503, { error: { code: "NOT_READY", message: "computing" } }))).toBe("NOT_READY");
    expect(await codeOf(json(401, { error: { code: "UNAUTHORIZED", message: "token" } }))).toBe("UPSTREAM_UNAVAILABLE");
    expect(await codeOf(json(500, { error: { code: "ERROR", message: "boom" } }))).toBe("UPSTREAM_UNAVAILABLE");
    expect(await codeOf(new Response("<html>", { status: 200 }))).toBe("UPSTREAM_UNAVAILABLE");
    expect(await codeOf(new TypeError("fetch failed"))).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("gives up on a slow service at the timeout", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await expect(orbitRequest(config, "/health", { timeoutMs: 5 })).rejects.toThrow("timed out");
  });

  it("accepts a job, then polls it to its result; a failed or endless job is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(json(202, { jobId: "rescreen-1", status: "running", created: true, statusUrl: "/jobs/rescreen-1" }));
    const accepted = await orbit.submitRescreen(config, { jobId: "rescreen-1", objectId: "1", maneuver: { burnTimeUtc: "2026-10-24T21:14:07Z", deltaVMs: 0.05, direction: "prograde" } });
    expect(accepted.jobId).toBe("rescreen-1");
    const job = (status: string, result: unknown = null) => json(200, { jobId: "rescreen-1", kind: "rescreen", status, result, error: status === "failed" ? { code: "SERVICE_RESTARTED", message: "" } : null });
    const sleep = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce(job("running")).mockResolvedValueOnce(job("completed", { passed: true }));
    expect((await waitForJob<{ passed: boolean }>(config, "rescreen-1", { sleep })).result.passed).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(job("failed"));
    await expect(waitForJob(config, "rescreen-1", { sleep })).rejects.toThrow("SERVICE_RESTARTED");
    let clock = 0;
    fetchMock.mockImplementation(async () => job("running"));
    await expect(waitForJob(config, "rescreen-1", { sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 3_000 })).rejects.toThrow("did not finish");
  });
});

describe("candidate selection", () => {
  it("keeps the cheapest passing maneuver per side plus wait, in a shape publish accepts", () => {
    const picked = selectCandidates(response(serviceGrid), advocateEvent);
    expect(picked.map(c => c.candidateId)).toEqual(["A-T12h-pro-20mms", "B-T6h-retro-50mms", "wait"]);
    expect(picked.every(c => c.missBeforeKm === advocateEvent.missKm && c.estimatedFuelKg === null && c.simulated)).toBe(true);
    expect(picked[2]).toMatchObject({ kind: "wait", missAfterKm: null, reviewCondition: expect.any(String) });
    expect(() => validateCandidates(assignRevisions(picked, {}), advocateEvent)).not.toThrow();
  });

  it("drops maneuvers that do not clear the pair, burn after closest approach or name the wrong object", () => {
    const picked = selectCandidates(response([
      grid({ movingSide: "A", passesPairThreshold: false }),
      grid({ movingSide: "A", burnTimeUtc: "2026-10-25T04:00:00Z" }),
      grid({ movingSide: "B", movingObjectId: "99999" }),
    ]), advocateEvent);
    expect(picked.map(c => c.candidateId)).toEqual(["wait"]);
  });

  it("keeps an unchanged candidate's revision and bumps a changed one", () => {
    const [first] = assignRevisions(selectCandidates(response(serviceGrid), advocateEvent), {});
    expect(first.revision).toBe(1);
    const again = assignRevisions(selectCandidates(response(serviceGrid), advocateEvent), { [first.candidateId]: first });
    expect(again[0].revision).toBe(1);
    const moved = response([{ ...serviceGrid[0], missAfterKm: 1.5 }]);
    expect(assignRevisions(selectCandidates(moved, advocateEvent), { [first.candidateId]: first })[0].revision).toBe(2);
  });
});

describe("orbit.computeCandidates", () => {
  async function setup(owned = true) {
    vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
    const t = backend(); const eventId = await insertEvent(t, advocateEvent);
    if (owned) {
      await t.mutation(internal.operators.provision, { key: "fixture-a", name: "A", simulated: true, objectIds: [policyA.objectId], members: [] });
      await t.mutation(internal.operators.provision, { key: "fixture-b", name: "B", simulated: true, objectIds: [policyB.objectId], members: [] });
    }
    return { t, eventId };
  }

  it("publishes the service's candidates once and republishes nothing for the same answer", async () => {
    const { t, eventId } = await setup();
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-token");
    fetchMock.mockImplementation(async () => json(200, response(serviceGrid)));
    const first = await t.action(internal.orbit.computeCandidates, { eventId, start: false });
    expect(first).toMatchObject({ status: "published", version: 1, changed: true, snapshotId: "gp-20261024T2134Z" });
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request).toMatchObject({ objectA: "SIM-1001", objectB: "SIM-1002", tcaUtc: advocateEvent.tcaUtc, notBeforeUtc: "2026-10-24T12:00:00Z" });
    const second = await t.action(internal.orbit.computeCandidates, { eventId, start: false });
    expect(second).toMatchObject({ status: "published", version: 1, changed: false });
    const rows = await t.run(ctx => ctx.db.query("candidateRevisions").collect());
    expect(rows.map(r => `${r.candidateId}@${r.revision}`).sort()).toEqual(["A-T12h-pro-20mms@1", "B-T6h-retro-50mms@1", "wait@1"]);
  });

  it("reports the service as unavailable and publishes nothing when it is not configured or down", async () => {
    const { t, eventId } = await setup();
    expect(await t.action(internal.orbit.computeCandidates, { eventId, start: false })).toMatchObject({ status: "failed", code: "UPSTREAM_UNAVAILABLE" });
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-token");
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await t.action(internal.orbit.computeCandidates, { eventId, start: false })).toMatchObject({ status: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(await t.run(ctx => ctx.db.query("candidateSets").collect())).toHaveLength(0);
  });

  it("does not call the service for a pair without two registered operators", async () => {
    const { t, eventId } = await setup(false);
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-token");
    expect(await t.action(internal.orbit.computeCandidates, { eventId })).toEqual({ status: "skipped", reason: "NOT_COORDINATED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Incident Analyst hook", () => {
  const scheduledOrbit = (t: ReturnType<typeof backend>) => t.run(async ctx =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(f => f.name === "orbit:computeCandidates"));

  it("schedules the candidate computation only when the orbital service is configured", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
    const t = backend();
    const off = await insertEvent(t, advocateEvent);
    await t.action(internal.agents.analyst.start, { eventId: off });
    expect(await scheduledOrbit(t)).toHaveLength(0);
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.test"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-only-token");
    const t2 = backend();
    const on = await insertEvent(t2, advocateEvent);
    await t2.action(internal.agents.analyst.start, { eventId: on });
    const scheduled = await scheduledOrbit(t2);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toEqual({ eventId: on });
  });
});
