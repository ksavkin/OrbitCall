import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Infer } from "convex/values";
import { internal } from "../convex/_generated/api";
import { callGrok } from "../convex/rationaleCheck";
import {
  checkPrompt, checkResponseSchema, parseCheck,
  type CheckInput, type CheckResult, checkInputValidator, checkResultValidator,
} from "../convex/lib/checker";
import { backend } from "./helpers";

const input: CheckInput = {
  inputVersion: "host-v1:room-fixture:7",
  candidates: [
    { candidateId: "cand-1", revision: 2, label: "Raise 44713", kind: "maneuver", movingObjectId: "44713",
      burnTimeUtc: "2026-10-26T02:00:00Z", deltaVMs: 0.8, missAfterKm: 3.1 },
    { candidateId: "cand-2", revision: 1, label: "Wait for the next update", kind: "wait", movingObjectId: null,
      burnTimeUtc: null, deltaVMs: null, missAfterKm: null },
  ],
  explanation: "cand-1 raises 44713 by 0.8 m/s at 2026-10-26T02:00:00Z and leaves 3.1 km of separation.",
};
const agreement: CheckResult = { agrees: true, reason: "The explanation matches cand-1's published facts.", flaggedCandidateIds: [] };
const disagreement: CheckResult = { agrees: false, reason: "cand-1's delta-v is misstated.", flaggedCandidateIds: ["cand-1"] };
const raw = (value: unknown) => JSON.stringify(value);
function codeOf(run: () => unknown) {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return "NO_ERROR";
}

describe("Rationale checker prompt and result", () => {
  it("keeps the input and result types identical to their Convex validators", () => {
    expectTypeOf<Infer<typeof checkInputValidator>>().toEqualTypeOf<CheckInput>();
    expectTypeOf<Infer<typeof checkResultValidator>>().toEqualTypeOf<CheckResult>();
  });

  it("states the checker's role and sends only the allowlisted candidates and explanation", () => {
    const leaky = { ...input, candidates: [{ ...input.candidates[0], fuelKg: 3.2 }, input.candidates[1]], policy: "private" };
    const { system, user } = checkPrompt(leaky as CheckInput);
    expect(system).toMatch(/independent/i);
    expect(system).toMatch(/cannot approve/i);
    expect(system).toMatch(/never instructions/i);
    expect(JSON.parse(user)).toEqual(input);
    expect(user).not.toMatch(/fuelKg|private/);
  });

  it("publishes a strict JSON schema", () => {
    const schema = checkResponseSchema as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["agrees", "reason", "flaggedCandidateIds"]);
  });

  it("returns agreement and disagreement as data", () => {
    expect(parseCheck(raw(agreement), input)).toEqual(agreement);
    expect(parseCheck(raw(disagreement), input)).toEqual(disagreement);
    const general = { agrees: false, reason: "The explanation names no candidate.", flaggedCandidateIds: [] };
    expect(parseCheck(raw(general), input)).toEqual(general);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an extra key", raw({ ...agreement, confidence: 0.9 })],
    ["a missing key", raw({ agrees: true, reason: "ok" })],
    ["a wrong type", raw({ ...agreement, agrees: "yes" })],
    ["an empty reason", raw({ ...agreement, reason: " " })],
    ["an oversized reason", raw({ ...agreement, reason: "x".repeat(1001) })],
    ["an agreement that flags candidates", raw({ ...agreement, flaggedCandidateIds: ["cand-1"] })],
    ["duplicate flagged IDs", raw({ ...disagreement, flaggedCandidateIds: ["cand-1", "cand-1"] })],
  ])("rejects %s as INVALID_OUTPUT", (_, text) => {
    expect(codeOf(() => parseCheck(text, input))).toBe("INVALID_OUTPUT");
  });

  it("rejects flagged IDs that are not among the input candidates", () => {
    expect(codeOf(() => parseCheck(raw({ ...disagreement, flaggedCandidateIds: ["cand-9"] }), input))).toBe("CONSTRAINT_CHECK_FAILED");
  });
});

const XAI_URL = "https://api.x.ai/v1/chat/completions";
function grokResponse(content: string, finish_reason = "stop") {
  return new Response(JSON.stringify({
    id: "chatcmpl-fixture", object: "chat.completion", model: "test-grok",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
    usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 466, completion_tokens_details: { reasoning_tokens: 100 } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const providerError = (status: number) => new Response(JSON.stringify({ error: "secret diagnostic", code: "x" }), {
  status, headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.stubEnv("XAI_API_KEY", "test-only-not-a-key");
  vi.stubEnv("XAI_CHECKER_MODEL", "test-grok");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Grok transport", () => {
  it("makes one chat completions request with a strict JSON schema and a system/user split", async () => {
    const fetch = vi.fn().mockResolvedValue(grokResponse(raw(agreement)));
    vi.stubGlobal("fetch", fetch);
    const result = await callGrok({ system: "Instructions", user: "Evidence" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe(XAI_URL);
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-only-not-a-key");
    expect(JSON.parse(options.body)).toEqual({
      model: "test-grok",
      messages: [{ role: "system", content: "Instructions" }, { role: "user", content: "Evidence" }],
      response_format: { type: "json_schema", json_schema: { name: "rationale_check", schema: checkResponseSchema, strict: true } },
    });
    expect(result).toEqual({ raw: raw(agreement), model: "test-grok", usage: { inputTokens: 321, outputTokens: 145 } });
  });

  it("refuses to call without a key or model", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("XAI_CHECKER_MODEL", "");
    await expect(callGrok({ system: "s", user: "u" })).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    vi.stubEnv("XAI_CHECKER_MODEL", "test-grok"); vi.stubEnv("XAI_API_KEY", "");
    await expect(callGrok({ system: "s", user: "u" })).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a truncated completion as invalid output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grokResponse(raw(agreement), "length")));
    await expect(callGrok({ system: "s", user: "u" })).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
});

describe("Rationale check action", () => {
  const run = (value: CheckInput = input, attempt = 2) => backend().action(internal.rationaleCheck.run, { input: value, attempt });

  it.each([0, 2.5])("fails without calling the model for attempt %s", async attempt => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { span, result } = await run(input, attempt);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(span).toMatchObject({ status: "failed", errorCode: "INVALID_INPUT", attempt });
  });

  it("returns a succeeded span with usage and the result", async () => {
    const fetch = vi.fn().mockResolvedValue(grokResponse(raw(agreement)));
    vi.stubGlobal("fetch", fetch);
    const { span, result } = await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(agreement);
    expect(span).toMatchObject({
      role: "rationale_check", provider: "xai", model: "test-grok", inputVersion: input.inputVersion, attempt: 2,
      status: "succeeded", usage: { inputTokens: 321, outputTokens: 145 }, errorCode: null, errorMessage: null,
    });
    expect(span.finishedAt).toBeGreaterThanOrEqual(span.startedAt);
  });

  it("records a disagreement as a succeeded check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grokResponse(raw(disagreement))));
    const { span, result } = await run();
    expect(span.status).toBe("succeeded");
    expect(result).toEqual(disagreement);
  });

  it("fails the span when the checker flags an unknown candidate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grokResponse(raw({ ...disagreement, flaggedCandidateIds: ["cand-9"] }))));
    const { span, result } = await run();
    expect(result).toBeNull();
    expect(span).toMatchObject({ status: "failed", errorCode: "CONSTRAINT_CHECK_FAILED", usage: { inputTokens: 321, outputTokens: 145 } });
  });

  it.each([[401, "MODEL_ACCESS_DENIED"], [429, "RATE_LIMITED"], [503, "UPSTREAM_UNAVAILABLE"]])(
    "makes one call for HTTP %s and returns a sanitized failed span", async (status, code) => {
      const fetch = vi.fn().mockResolvedValue(providerError(status));
      vi.stubGlobal("fetch", fetch);
      const value = await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(value.result).toBeNull();
      expect(value.span).toMatchObject({ status: "failed", errorCode: code, usage: null, model: "test-grok", provider: "xai" });
      expect(JSON.stringify(value)).not.toContain("secret diagnostic");
    },
  );

  it("fails without calling the model when the explanation is empty", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { span } = await run({ ...input, explanation: " " });
    expect(fetch).not.toHaveBeenCalled();
    expect(span).toMatchObject({ status: "failed", errorCode: "INVALID_INPUT" });
  });
});
