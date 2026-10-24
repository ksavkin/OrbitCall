import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callClaude, safeFailure } from "../convex/lib/claude";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-key");
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function response(stop_reason = "end_turn") {
  return new Response(JSON.stringify({
    id: "msg_fixture", type: "message", role: "assistant", model: "test-model",
    content: [{ type: "text", text: '{"lines":[]}' }],
    stop_reason, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 17 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Claude transport", () => {
  it("makes one Messages request with separate instructions and evidence and records usage", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const result = await callClaude({ system: "Instructions", user: "Evidence" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(options.body)).toEqual({
      model: "test-model", max_tokens: 1600, system: "Instructions",
      messages: [{ role: "user", content: "Evidence" }],
    });
    expect(result).toEqual({ raw: '{"lines":[]}', model: "test-model", usage: { inputTokens: 42, outputTokens: 17 } });
  });

  it("rejects truncated output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("max_tokens")));
    await expect(callClaude({ system: "Instructions", user: "Evidence" })).rejects.toThrow("did not finish");
  });

  it.each([[429, "RATE_LIMITED"], [401, "MODEL_ACCESS_DENIED"], [503, "UPSTREAM_UNAVAILABLE"]])(
    "does not automatically retry HTTP %s and hides raw provider errors", async (status, code) => {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        type: "error", error: { type: "api_error", message: "secret diagnostic" },
      }), { status, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetch);
      const error = await callClaude({ system: "Instructions", user: "Evidence" }).catch(error => error);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(safeFailure(error).code).toBe(code);
      expect(safeFailure(error).message).not.toContain("secret diagnostic");
    },
  );
});
