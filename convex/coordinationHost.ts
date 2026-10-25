"use node";

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { AnalystError } from "./lib/analyst";
import {
  agentSpanValidator, checkHostOutput, hostContextValidator, hostOutputValidator, hostPrompt, hostResponseSchema,
  providerFailure, traceSpan, validateHostContext, type AgentSpan, type HostOutput,
} from "./lib/host";

function geminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_HOST_MODEL;
  if (!apiKey || !model) throw new AnalystError("MODEL_NOT_CONFIGURED", "Set GEMINI_API_KEY and GEMINI_HOST_MODEL in this Convex deployment.");
  return { apiKey, model };
}

export async function callGemini(prompt: { system: string; user: string }): Promise<{ raw: string; model: string; usage: AgentSpan["usage"] }> {
  const { apiKey, model } = geminiConfig();
  // Retries are explicit attempts. The SDK retries only when retryOptions is set; attempts: 1 keeps
  // one request per attempt even if a later SDK version enables retries by default.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } } });
  let result;
  try {
    result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      config: { systemInstruction: prompt.system, responseMimeType: "application/json", responseJsonSchema: hostResponseSchema },
    });
  } catch (error) {
    if (error instanceof ApiError) throw providerFailure(error.status);
    throw error;
  }
  const raw = result.text;
  if (result.candidates?.[0]?.finishReason !== FinishReason.STOP || !raw) {
    throw new AnalystError("INVALID_OUTPUT", "The model did not finish a complete response.");
  }
  const usage = result.usageMetadata;
  return {
    raw, model: result.modelVersion ?? model,
    // Thinking tokens are billed as output but reported separately from candidate tokens.
    usage: usage?.promptTokenCount === undefined ? null : {
      inputTokens: usage.promptTokenCount,
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    },
  };
}

export const run = internalAction({
  args: { context: hostContextValidator, attempt: v.number() },
  returns: v.object({ span: agentSpanValidator, output: v.union(hostOutputValidator, v.null()) }),
  handler: async (_ctx, { context, attempt }): Promise<{ span: AgentSpan; output: HostOutput | null }> => {
    const { span, value } = await traceSpan({
      role: "coordination_host", provider: "google", model: process.env.GEMINI_HOST_MODEL || "unconfigured",
      inputVersion: context.inputVersion, attempt,
    }, async measured => {
      validateHostContext(context);
      const call = await callGemini(hostPrompt(context));
      measured(call);
      return checkHostOutput(call.raw, context);
    });
    return { span, output: value };
  },
});
