"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { AnalystError } from "./lib/analyst";
import { checkInputValidator, checkPrompt, checkResponseSchema, checkResultValidator, parseCheck, validateCheckInput, type CheckResult } from "./lib/checker";
import { agentSpanValidator, providerFailure, traceSpan, type AgentSpan } from "./lib/host";

const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";

function grokConfig() {
  const apiKey = process.env.XAI_API_KEY;
  const model = process.env.XAI_CHECKER_MODEL;
  if (!apiKey || !model) throw new AnalystError("MODEL_NOT_CONFIGURED", "Set XAI_API_KEY and XAI_CHECKER_MODEL in this Convex deployment.");
  return { apiKey, model };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

export async function callGrok(prompt: { system: string; user: string }): Promise<{ raw: string; model: string; usage: AgentSpan["usage"] }> {
  const { apiKey, model } = grokConfig();
  const response = await fetch(XAI_CHAT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
      response_format: { type: "json_schema", json_schema: { name: "rationale_check", schema: checkResponseSchema, strict: true } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw providerFailure(response.status);
  const body = await response.json() as ChatCompletion;
  const choice = body.choices?.[0];
  const raw = choice?.message?.content;
  if (choice?.finish_reason !== "stop" || !raw) {
    throw new AnalystError("INVALID_OUTPUT", "The model did not finish a complete response.");
  }
  const usage = body.usage;
  return {
    raw, model: body.model ?? model,
    // Reasoning tokens are billed as output but reported separately from completion tokens.
    usage: usage?.prompt_tokens === undefined ? null : {
      inputTokens: usage.prompt_tokens,
      outputTokens: (usage.completion_tokens ?? 0) + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  };
}

export const run = internalAction({
  args: { input: checkInputValidator, attempt: v.number() },
  returns: v.object({ span: agentSpanValidator, result: v.union(checkResultValidator, v.null()) }),
  handler: async (_ctx, { input, attempt }): Promise<{ span: AgentSpan; result: CheckResult | null }> => {
    const { span, value } = await traceSpan({
      role: "rationale_check", provider: "xai", model: process.env.XAI_CHECKER_MODEL || "unconfigured",
      inputVersion: input.inputVersion, attempt,
    }, async measured => {
      validateCheckInput(input);
      const call = await callGrok(checkPrompt(input));
      measured(call);
      return parseCheck(call.raw, input);
    });
    return { span, result: value };
  },
});
