import type { SatellitePolicy, Candidate } from "../convex/lib/policies";
import { redEvent } from "./events";
import { testCandidates } from "./candidates";

// Fully synthetic two-operator test, separate from real catalog ownership or the UI's fleet demo.
export const advocateEvent = {
  ...redEvent,
  objectA: { ...redEvent.objectA, objectId: "SIM-1001", name: "Advocate fixture A" },
  objectB: { ...redEvent.objectA, objectId: "SIM-1002", name: "Advocate fixture B" },
};
export const policyA: SatellitePolicy = {
  objectId: "SIM-1001", minFuelReserveKg: 7.625, currentFuelKg: 8.125, dryMassKg: 153.75, ispS: 221.5,
  protectedWindows: [{ startUtc: "2026-10-24T21:00:00Z", endUtc: "2026-10-24T22:00:00Z", reason: "PRIVATE_A_IMAGING_WINDOW" }],
  preferredWindows: [{ startUtc: "2026-10-24T22:30:00Z", endUtc: "2026-10-24T23:30:00Z", reason: "PRIVATE_A_PREFERENCE" }],
  acceptablePc: 0.0001, missionPriority: "normal",
};
export const policyB: SatellitePolicy = {
  objectId: "SIM-1002", minFuelReserveKg: 3.5, currentFuelKg: 3.875, dryMassKg: 98.25, ispS: 198.5,
  protectedWindows: [], preferredWindows: [], acceptablePc: 0.00005, missionPriority: "high",
};
export const advocateCandidates: Candidate[] = [
  ...testCandidates.map(c => ({ ...c, candidateId: c.label, assumptions: [...c.assumptions],
    movingObjectId: c.kind === "maneuver" ? "SIM-1001" : null, estimatedFuelKg: c.kind === "maneuver" ? 0.2 : null })),
  { ...testCandidates[0], candidateId: "P4", label: "P4", movingSide: "B", movingObjectId: "SIM-1002",
    burnTimeUtc: "2026-10-24T22:30:00Z", estimatedFuelKg: 0.4, assumptions: [...testCandidates[0].assumptions] },
];
