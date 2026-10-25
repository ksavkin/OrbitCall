import { describe, expect, it } from "vitest";
import { validatePolicies, validateCandidates } from "../convex/lib/policies";
import { advocatePrompt, checkRecommendation, evaluateCandidates, shareEvaluations } from "../convex/lib/advocate";
import { advocateCandidates, advocateEvent, policyA, policyB } from "../fixtures/policies";
import { FIXTURE_NOW } from "../fixtures/events";

const evaluate = (policy = policyA) => evaluateCandidates(advocateEvent, advocateCandidates, "A", policy, FIXTURE_NOW);

describe("private policy evaluation", () => {
  it("treats protected windows as hard limits and preferred windows as preferences", () => {
    const result = evaluate();
    expect(result[0]).toMatchObject({ outcome: "infeasible", categories: expect.arrayContaining(["mission_window"]) });
    expect(result[1]).toMatchObject({ outcome: "pending", preferenceScore: 1 });
    expect(result[1].categories).toContain("risk");
  });
  it("cannot let a preference override a protected window", () => {
    const result = evaluate({ ...policyA, protectedWindows: policyA.preferredWindows });
    expect(result[1].outcome).toBe("infeasible");
    expect(() => checkRecommendation('{"preferredCandidateId":"P2"}', result, true)).toThrow();
  });
  it("blocks a fuel violation only for the moving company's satellite", () => {
    const a = evaluate(), b = evaluateCandidates(advocateEvent, advocateCandidates, "B", policyB, FIXTURE_NOW);
    expect(a[3].outcome).toBe("pending");
    expect(b[3]).toMatchObject({ outcome: "infeasible", categories: expect.arrayContaining(["fuel"]) });
  });
  it("accepts exactly the reserve boundary and keeps missing fuel pending", () => {
    const policy = { ...policyA, minFuelReserveKg: 7.5, currentFuelKg: 8, protectedWindows: [] };
    const candidates = [{ ...advocateCandidates[1], estimatedFuelKg: 0.5 }, { ...advocateCandidates[3], movingSide: "A" as const, estimatedFuelKg: null }];
    const result = evaluateCandidates(advocateEvent, candidates, "A", policy, FIXTURE_NOW);
    expect(result[0].categories).not.toContain("fuel");
    expect(result[1].categories).toContain("fuel");
    expect(result[1].outcome).toBe("pending");
  });
  it("evaluates wait against supplied probability and never fabricates post-maneuver probability", () => {
    expect(evaluate()[2].outcome).toBe("infeasible");
    expect(evaluate({ ...policyA, acceptablePc: 0.0002 })[2].outcome).toBe("feasible");
    const missing = { ...advocateEvent, pc: { ...advocateEvent.pc, value: null } };
    expect(evaluateCandidates(missing, advocateCandidates, "A", policyA, FIXTURE_NOW)[2].outcome).toBe("pending");
    expect(evaluate()[1].outcome).toBe("pending");
  });
  it("has no recommendation without an own-satellite policy", () => {
    const result = evaluateCandidates(advocateEvent, advocateCandidates, "A", null, FIXTURE_NOW);
    expect(result.every(r => r.outcome === "pending")).toBe(true);
    expect(() => checkRecommendation('{"preferredCandidateId":"P2"}', result, false)).toThrow();
  });
  it("does not recommend an option the counterpart has explicitly rejected", () => {
    expect(() => checkRecommendation('{"preferredCandidateId":"P2"}', evaluate(), true, [
      { candidateId: "P2", outcome: "infeasible", recommended: false, categories: ["fuel"] },
    ])).toThrow();
  });
  it("rejects expired burns and encounters", () => {
    const result = evaluateCandidates(advocateEvent, advocateCandidates, "A", policyA, Date.parse("2026-10-24T23:30:00Z"));
    expect(result[1].outcome).toBe("infeasible");
  });
  it("shares only checked outcomes and categories, without policy values or ranking scores", () => {
    const shared = shareEvaluations(evaluate(), "P2");
    expect(shared[1]).toMatchObject({ recommended: true, outcome: "pending" });
    expect(JSON.stringify(shared)).not.toContain("7.625");
    expect(JSON.stringify(shared)).not.toContain("PRIVATE_A");
    expect(JSON.stringify(shared)).not.toContain("preferenceScore");
  });
  it.each(['{"preferredCandidateId":"P1"}', '{"preferredCandidateId":"made-up"}', '{"preferredCandidateId":"P2","reason":"PRIVATE_A"}', 'P2', '{"preferredCandidateId":7.625}'])("rejects unchecked model output %s", raw => {
    expect(() => checkRecommendation(raw, evaluate(), true)).toThrow();
  });
  it("includes only its own policy and typed shared counterpart outcomes in the prompt", () => {
    const prompt = advocatePrompt({ facts: advocateEvent, candidates: advocateCandidates, side: "A", policy: policyA, evaluations: evaluate(), counterpart: [] });
    expect(prompt.user).toContain("PRIVATE_A_IMAGING_WINDOW");
    expect(prompt.user).not.toContain(String(policyB.dryMassKg));
  });
  it("validates policy numbers, duplicate satellites and impossible or reversed UTC windows", () => {
    expect(() => validatePolicies([policyA, policyB])).not.toThrow();
    for (const policies of [
      [policyA, policyA], [{ ...policyA, currentFuelKg: -1 }], [{ ...policyA, ispS: 0 }],
      [{ ...policyA, acceptablePc: Infinity }], [{ ...policyA, acceptablePc: 1.01 }],
      [{ ...policyA, protectedWindows: [{ startUtc: "2026-02-30T01:00:00Z", endUtc: "2026-03-01T01:00:00Z", reason: "" }] }],
      [{ ...policyA, protectedWindows: [{ startUtc: "2026-10-24T23:00:00Z", endUtc: "2026-10-24T22:00:00Z", reason: "" }] }],
    ]) expect(() => validatePolicies(policies)).toThrow();
  });
  it("validates candidate identity, quantities, simulation and review conditions", () => {
    expect(() => validateCandidates(advocateCandidates, advocateEvent)).not.toThrow();
    for (const candidates of [
      [...advocateCandidates, { ...advocateCandidates[0], candidateId: "P5" }],
      [{ ...advocateCandidates[0], movingObjectId: "other" }],
      [{ ...advocateCandidates[0], missBeforeKm: 18 }],
      [{ ...advocateCandidates[0], simulated: false }],
      [{ ...advocateCandidates[0], deltaVMs: -1 }],
      [{ ...advocateCandidates[2], reviewCondition: null }],
      [{ ...advocateCandidates[2], deltaVMs: 0.2 }],
    ]) expect(() => validateCandidates(candidates, advocateEvent)).toThrow();
  });
});
