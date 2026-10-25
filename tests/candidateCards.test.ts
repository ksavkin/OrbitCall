import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { parseCandidatesResponse, type OrbitCandidatesResponse } from "../convex/lib/candidateCards";
import { advocateEvent } from "../fixtures/policies";

// advocateEvent: SIM-1001 (A) and SIM-1002 (B), closest approach 2026-10-25T03:14:07Z, miss 0.18 km.
const at = (hoursBeforeTca: number) =>
  new Date(Date.parse(advocateEvent.tcaUtc) - hoursBeforeTca * 3_600_000).toISOString().replace(".000Z", "Z");
type Item = OrbitCandidatesResponse["candidates"][number];
const maneuver = (over: Partial<Item> = {}): Item => ({
  kind: "maneuver", movingObjectId: "SIM-1001", burnTimeUtc: at(6), direction: "prograde",
  deltaVMs: 0.05, estimatedFuelKg: 0.12, missAfterKm: 1.4, reviewCondition: null,
  assumptions: ["Along-track impulse; indicative geometry."], ...over,
});
const wait = (over: Partial<Item> = {}): Item => ({
  kind: "wait", movingObjectId: null, burnTimeUtc: null, direction: null, deltaVMs: null,
  estimatedFuelKg: null, missAfterKm: null, reviewCondition: "Reassess when a new source observation arrives.",
  assumptions: ["Waiting is not a claim of safety."], ...over,
});
const response = (candidates: Item[], over: Partial<OrbitCandidatesResponse> = {}): OrbitCandidatesResponse => ({
  eventId: "event-1", evidenceVersion: "evidence-7", snapshotId: "snapshot-3", simulated: false, candidates, ...over,
});
function expectValidation(fn: () => unknown) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe("VALIDATION");
    return;
  }
  throw new Error("Expected a VALIDATION error.");
}

describe("parseCandidatesResponse", () => {
  it("accepts the provisional /candidates shape", () => {
    const value = response([maneuver(), wait()]);
    expect(parseCandidatesResponse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it.each<[string, unknown]>([
    ["non-object", "nope"],
    ["missing echo", { ...response([]), snapshotId: undefined }],
    ["extra top-level field", { ...response([]), pc: 0.0002 }],
    ["extra candidate field", response([{ ...maneuver(), postManeuverPc: 1e-6 } as Item])],
    ["unknown kind", response([{ ...maneuver(), kind: "abort" } as unknown as Item])],
    ["unknown direction", response([maneuver({ direction: "radial" as "prograde" })])],
    ["numeric object id", response([maneuver({ movingObjectId: 1001 as unknown as string })])],
    ["non-finite delta-v", response([maneuver({ deltaVMs: Infinity })])],
    ["string fuel", response([maneuver({ estimatedFuelKg: "0.1" as unknown as number })])],
    ["non-string assumption", response([maneuver({ assumptions: [7 as unknown as string] })])],
    ["non-boolean simulated", { ...response([]), simulated: "yes" }],
    ["candidates not an array", { ...response([]), candidates: {} }],
  ])("rejects %s", (_name, value) => {
    expectValidation(() => parseCandidatesResponse(value));
  });
});
