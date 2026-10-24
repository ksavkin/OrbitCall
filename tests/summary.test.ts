import { describe, expect, it } from "vitest";
import { buildPrompt, checkAndRenderSummary, inputKey, isRed, validateFacts } from "../convex/lib/analyst";
import { FIXTURE_NOW, redEvent, missingProbability, missingMetadata, maximumProbability, sourceDisagreement } from "../fixtures/events";
import { testCandidates } from "../fixtures/candidates";
import { draft } from "./helpers";

describe("checked five-line summary", () => {
  it("preserves exact source fields, units, identifiers and UTC time", () => {
    const lines = checkAndRenderSummary(draft(), redEvent);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("SIM-0001");
    expect(lines[1]).toContain("2026-10-25T03:14:07Z");
    expect(lines[1]).toContain("0.18 km");
    expect(lines[1]).toContain("7.6 km/s");
    expect(lines[2]).toContain("0.0002");
    expect(lines[4]).toContain("Simulated incident");
    expect(lines.join("\n")).not.toContain("{{");
  });

  it.each([missingProbability, missingMetadata, maximumProbability, sourceDisagreement])("handles source variations without fabricating evidence", facts => {
    expect(checkAndRenderSummary(draft(facts), facts)).toHaveLength(5);
  });

  it("distinguishes unavailable probability from a real supplied zero", () => {
    expect(checkAndRenderSummary(draft(missingProbability), missingProbability)[2]).toContain("unavailable");
    const zero = { ...redEvent, pc: { ...redEvent.pc, value: 0 } };
    expect(checkAndRenderSummary(draft(zero), zero)[2]).toContain("probability: 0 from");
  });

  it("labels maximum probability and source disagreement accurately", () => {
    expect(checkAndRenderSummary(draft(maximumProbability), maximumProbability)[2]).toContain("maximum probability");
    expect(checkAndRenderSummary(draft(sourceDisagreement), sourceDisagreement)[3]).toContain("not a confidence interval");
  });

  it.each([
    ["{{missKm}}", "18"],
    ["{{probability}}", "0.00002"],
    ["{{missKm}}", "{{relSpeedKmS}}"],
    ["{{tcaUtc}}", "2026-10-25T13:14:07Z"],
    ["{{objectA}}", "SAT-999"],
    ["{{missKm}} km", "{{missKm}} m"],
  ])("rejects changed numeric content or field binding: %s → %s", (from, to) => {
    expect(() => checkAndRenderSummary(draft().replace(from, to), redEvent)).toThrow("field bindings");
  });

  it("rejects four/six lines, reordered fields and extra output", () => {
    const valid = JSON.parse(draft());
    for (const lines of [valid.lines.slice(1), [...valid.lines, valid.lines[0]], [...valid.lines].reverse()]) {
      expect(() => checkAndRenderSummary(JSON.stringify({ lines }), redEvent)).toThrow();
    }
    expect(() => checkAndRenderSummary(JSON.stringify({ ...valid, approve: true }), redEvent)).toThrow();
    expect(() => checkAndRenderSummary("```json\n" + draft() + "\n```", redEvent)).toThrow();
  });

  it("rejects a probability statement when the input has none", () => {
    expect(() => checkAndRenderSummary(draft(), missingProbability)).toThrow();
  });

  it("rejects invalid units/times, inconsistent source spread and unlabeled simulation", () => {
    for (const bad of [
      { ...redEvent, missKm: -1 },
      { ...redEvent, relSpeedKmS: Infinity },
      { ...redEvent, tcaUtc: "tomorrow" },
      { ...redEvent, tcaUtc: "2026-02-30T12:00:00Z" },
      { ...redEvent, pc: { ...redEvent.pc, value: 2 } },
      { ...redEvent, simulated: false },
      { ...sourceDisagreement, spread: { ...sourceDisagreement.spread!, minKm: 99 } },
    ]) expect(() => validateFacts(bad)).toThrow();
  });

  it("keys input changes independently from run timestamps and excludes private fields", () => {
    const extended = { ...redEvent, updatedAt: "2030-01-01T00:00:00Z", privatePolicy: { fuel: 12345 } };
    expect(inputKey(extended)).toBe(inputKey(redEvent));
    expect(buildPrompt(extended).user).not.toContain("12345");
    expect(inputKey({ ...redEvent, missKm: 0.19 })).not.toBe(inputKey(redEvent));
  });

  it("uses a fixed test clock, not a forecast, for the red-event boundary", () => {
    expect(isRed(redEvent, FIXTURE_NOW)).toBe(true);
    expect(isRed(missingProbability, FIXTURE_NOW)).toBe(false);
    expect(isRed({ ...redEvent, pc: { ...redEvent.pc, value: 1e-4 } }, FIXTURE_NOW)).toBe(false);
    expect(isRed(redEvent, Date.parse(redEvent.tcaUtc))).toBe(false);
  });

  it("provides two maneuver fixtures and a wait fixture without implying execution", () => {
    expect(testCandidates.map(c => c.kind)).toEqual(["maneuver", "maneuver", "wait"]);
    expect(testCandidates.every(c => c.simulated && c.indicative)).toBe(true);
    expect(testCandidates[2].deltaVMs).toBeNull();
  });
});
