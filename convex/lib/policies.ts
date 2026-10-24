import { ConvexError, type Infer } from "convex/values";
import type { satellitePolicy, candidate, side, category } from "./policyValidators";
import type { EventFacts } from "./analyst";

export type SatellitePolicy = Infer<typeof satellitePolicy>;
export type Candidate = Infer<typeof candidate>;
export type Side = Infer<typeof side>;
export type Category = Infer<typeof category>;

export function validUtc(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function invalid(message: string): never { throw new ConvexError({ code: "VALIDATION", message }); }
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;

export function validatePolicies(satellites: SatellitePolicy[]) {
  if (satellites.length > 100 || new Set(satellites.map(s => s.objectId)).size !== satellites.length) invalid("Use at most one policy per owned satellite, up to one hundred.");
  for (const policy of satellites) {
    if (!/^(?:\d{1,9}|SIM-\d+)$/.test(policy.objectId) ||
      ![policy.minFuelReserveKg, policy.currentFuelKg, policy.dryMassKg, policy.ispS, policy.acceptablePc].every(nonnegative) ||
      policy.dryMassKg === 0 || policy.ispS === 0 || policy.acceptablePc > 1) invalid("Policy numbers or object identifier are invalid.");
    for (const windows of [policy.protectedWindows, policy.preferredWindows]) {
      if (windows.length > 100) invalid("Too many mission windows.");
      for (const window of windows) {
        if (!validUtc(window.startUtc) || !validUtc(window.endUtc) || Date.parse(window.startUtc) >= Date.parse(window.endUtc) || window.reason.length > 500) invalid("Mission windows need valid ordered UTC times and a short reason.");
      }
    }
  }
}

export function validateCandidates(candidates: Candidate[], facts: EventFacts) {
  if (candidates.length > 4 || new Set(candidates.map(c => c.candidateId)).size !== candidates.length) invalid("Supply at most four uniquely identified candidates.");
  for (const c of candidates) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(c.candidateId) || !Number.isSafeInteger(c.revision) || c.revision < 1 ||
      !c.label.trim() || c.label.length > 80 || c.assumptions.length > 20 || c.assumptions.some(s => s.length > 500) ||
      !nonnegative(c.missBeforeKm) || c.missBeforeKm !== facts.missKm ||
      [c.deltaVMs, c.estimatedFuelKg, c.missAfterKm].some(n => n !== null && !nonnegative(n))) invalid("Candidate identity, revision or numeric evidence is invalid.");
    if (facts.simulated && !c.simulated) invalid("Candidates for a simulated incident must be labeled simulated.");
    if (c.kind === "wait") {
      if ([c.movingSide, c.movingObjectId, c.burnTimeUtc, c.deltaVMs, c.direction, c.estimatedFuelKg, c.missAfterKm].some(x => x !== null) ||
        !c.reviewCondition?.trim() || c.reviewCondition.length > 500) invalid("Waiting needs a review condition and cannot contain a maneuver.");
    } else {
      const object = c.movingSide === "A" ? facts.objectA : c.movingSide === "B" ? facts.objectB : null;
      if (!object || c.movingObjectId !== object.objectId || c.burnTimeUtc === null || !validUtc(c.burnTimeUtc) ||
        Date.parse(c.burnTimeUtc) >= Date.parse(facts.tcaUtc) || c.deltaVMs === null || c.deltaVMs === 0 || !c.direction || c.reviewCondition !== null) invalid("A maneuver must identify its moving object, burn before closest approach and positive delta-v.");
    }
  }
}

export function changedCategories(before: SatellitePolicy[], after: SatellitePolicy[]): Category[] {
  const groups: [Category, (keyof SatellitePolicy)[]][] = [
    ["fuel", ["minFuelReserveKg", "currentFuelKg", "dryMassKg", "ispS"]],
    ["mission_window", ["protectedWindows", "preferredWindows"]],
    ["risk", ["acceptablePc"]], ["priority", ["missionPriority"]],
  ];
  if (before.map(p => p.objectId).sort().join() !== after.map(p => p.objectId).sort().join()) return groups.map(([category]) => category);
  return groups.filter(([, keys]) => after.some(p => {
    const old = before.find(o => o.objectId === p.objectId)!;
    return keys.some(key => JSON.stringify(old[key]) !== JSON.stringify(p[key]));
  })).map(([category]) => category);
}
