// Inputs for later candidate integration, not calculated maneuvers or executable proposals.
// No policies or Operator Advocate are implemented by this fixture.
export const testCandidates = [
  {
    label: "P1", revision: 1, kind: "maneuver", movingSide: "A",
    movingObjectId: "SIM-0001", burnTimeUtc: "2026-10-24T21:14:07Z",
    deltaVMs: 0.2, direction: "prograde", estimatedFuelKg: null,
    missBeforeKm: 0.18, missAfterKm: 3.2, indicative: true,
    reviewCondition: null, simulated: true,
    assumptions: ["Fictional fixture geometry; not produced by the orbital service."],
  },
  {
    label: "P2", revision: 1, kind: "maneuver", movingSide: "A",
    movingObjectId: "SIM-0001", burnTimeUtc: "2026-10-24T23:14:07Z",
    deltaVMs: 0.3, direction: "retrograde", estimatedFuelKg: null,
    missBeforeKm: 0.18, missAfterKm: 2.1, indicative: true,
    reviewCondition: null, simulated: true,
    assumptions: ["Fictional fixture geometry; not produced by the orbital service."],
  },
  {
    label: "P3", revision: 1, kind: "wait", movingSide: null,
    movingObjectId: null, burnTimeUtc: null, deltaVMs: null, direction: null,
    estimatedFuelKg: null, missBeforeKm: 0.18, missAfterKm: null, indicative: true,
    reviewCondition: "Reassess when a new source observation arrives.", simulated: true,
    assumptions: ["Waiting is not a maneuver or a claim of safety."],
  },
] as const;
