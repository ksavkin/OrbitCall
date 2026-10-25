"use node";

import Anthropic from "@anthropic-ai/sdk";
import { AnalystError } from "./analyst";

export function claudeConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) throw new AnalystError("MODEL_NOT_CONFIGURED", "Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL in this Convex deployment.");
  return { apiKey, model };
}

export async function callClaude(prompt: { system: string; user: string }) {
  const { apiKey, model } = claudeConfig();
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 90_000 });
  const result = await client.messages.create({
    model, max_tokens: 1600, system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  if (result.stop_reason !== "end_turn") {
    throw new AnalystError("INVALID_OUTPUT", "The model did not finish a complete response.");
  }
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
  return { raw: text, model: result.model, usage: {
    inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
  } };
}

export function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AnalystError) return { code: error.code, message: error.message };
  if (error instanceof Anthropic.APIError && error.status === 429) return {
    code: "RATE_LIMITED", message: "The model provider is rate limiting requests. Retry later.",
  };
  if (error instanceof Anthropic.APIError && [401, 403].includes(error.status ?? 0)) return {
    code: "MODEL_ACCESS_DENIED", message: "The configured API account cannot access the model.",
  };
  // Never persist raw provider errors, request bodies, headers, or credentials.
  return { code: "UPSTREAM_UNAVAILABLE", message: "The agent could not complete this attempt. Check backend connectivity and retry." };
}
