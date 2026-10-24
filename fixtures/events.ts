import type { EventFacts } from "../convex/lib/analyst";

// Test evidence only. These values are not measured conjunctions or orbital calculations.
export const FIXTURE_NOW = Date.parse("2026-10-24T12:00:00Z");
export const redEvent: EventFacts = {
  objectA: {
    objectId: "SIM-0001", name: "Fixture satellite 1", ownerName: "Fixture Operator A",
    ownerCompanyId: null, country: null, purpose: "test", launchDate: null,
    simulated: true, celestrakUrl: null,
  },
  objectB: {
    objectId: "25544", name: "Reference object 25544", ownerName: null,
    ownerCompanyId: null, country: null, purpose: null, launchDate: null,
    simulated: false, celestrakUrl: null,
  },
  tcaUtc: "2026-10-25T03:14:07Z", missKm: 0.18, relSpeedKmS: 7.6,
  pc: {
    value: 0.0002, metric: "pc", source: "simulated", epochUtc: "2026-10-24T11:00:00Z",
    sourceUrl: null, emergencyReportable: null,
  },
  sources: [{ name: "simulated", url: null, epochUtc: "2026-10-24T11:00:00Z", fetchedAt: "2026-10-24T11:05:00Z" }],
  spread: null, simulated: true,
};
export const missingProbability: EventFacts = {
  ...redEvent, pc: { ...redEvent.pc, value: null },
};
export const missingMetadata: EventFacts = {
  ...redEvent, sources: [], pc: { ...redEvent.pc, epochUtc: null },
};
export const maximumProbability: EventFacts = {
  ...redEvent, pc: { ...redEvent.pc, metric: "max_prob", source: "socrates" },
};
export const sourceDisagreement: EventFacts = {
  ...redEvent, spread: {
    gpMissKm: 0.18, supgpMissKm: 0.41, minKm: 0.18, maxKm: 0.41,
    gpEpochUtc: "2026-10-24T10:00:00Z", supgpEpochUtc: "2026-10-24T11:00:00Z",
  },
};
