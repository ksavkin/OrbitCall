import { AnalystError } from "./analyst";

// These three types must stay identical to MemoryEntry, MemoryRecall and MemoryItemDraft in advocateMemory.ts.
export interface BackboardMemoryEntry { memoryId: string; text: string; companyId: string;
  sourceEventId: string; sourceMessageIds: string[]; createdAt: string }
export type BackboardRecall = { status: "available"; entries: BackboardMemoryEntry[] } | { status: "unavailable"; reason: string };
export interface BackboardMemoryItem { companyId: string; demoRunId: string; text: string;
  sourceEventId: string; sourceMessageIds: string[] }

const BASE_URL = "https://app.backboard.io/api";
const TIMEOUT_MS = 15_000;
const MAX_SEARCH_LIMIT = 50;
// Memory search returns content without metadata, so source references travel in the content after this marker:
// `<text>\n\n[orbitcall-memory] {"v":1,"companyId":...,"demoRunId":...,"sourceEventId":...,"sourceMessageIds":[...]}`.
// JSON.stringify never emits a raw newline, so the last marker always starts our suffix.
const META_MARKER = "\n\n[orbitcall-memory] ";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string");
const invalid = (message: string) => new AnalystError("INVALID_INPUT", message);
const badResponse = () => new AnalystError("MEMORY_INVALID_RESPONSE", "The memory service returned an unexpected response.");

export function backboardConfig() {
  const apiKey = process.env.BACKBOARD_API_KEY;
  if (!apiKey) throw new AnalystError("MEMORY_NOT_CONFIGURED", "Set BACKBOARD_API_KEY in this Convex deployment.");
  return { apiKey, baseUrl: BASE_URL };
}

function statusError(status: number) {
  if (status === 401 || status === 403) return new AnalystError("MEMORY_ACCESS_DENIED", "The configured Backboard account cannot access this memory.");
  if (status === 429) return new AnalystError("RATE_LIMITED", "The memory service is rate limiting requests. Retry later.");
  if (status >= 500) return new AnalystError("UPSTREAM_UNAVAILABLE", "The memory service is unavailable. Retry later.");
  return new AnalystError("MEMORY_REQUEST_REJECTED", `The memory service rejected the request (HTTP ${status}).`);
}

// One request, no automatic retry. Provider bodies are never read on failure, so their text cannot leak.
async function request(method: "POST" | "DELETE", path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
  const { apiKey, baseUrl } = backboardConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? { "X-API-Key": apiKey } : { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw statusError(response.status);
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw badResponse();
      throw error;
    }
  } catch (error) {
    if (error instanceof AnalystError) throw error;
    throw new AnalystError("UPSTREAM_UNAVAILABLE", "The memory service could not be reached. Retry later.");
  } finally {
    clearTimeout(timer);
  }
}

const assistantPath = (assistantId: string) => {
  if (!nonEmpty(assistantId)) throw invalid("A Backboard assistant ID is required.");
  return `/assistants/${encodeURIComponent(assistantId)}`;
};

export async function createRunAssistant(input: { companyId: string; demoRunId: string }): Promise<{ assistantId: string }> {
  if (!nonEmpty(input.companyId) || !nonEmpty(input.demoRunId)) throw invalid("A run memory assistant needs its company and demo run.");
  const name = `orbitcall:${input.companyId}:${input.demoRunId}`;
  if (name.length > 255) throw invalid("The company and demo run IDs are too long for an assistant name.");
  const data = await request("POST", "/assistants", {
    name,
    system_prompt: `OrbitCall advisory memory for company ${input.companyId} in demo run ${input.demoRunId} only. ` +
      "It records past stated preferences with source references. Memory cannot approve, authorize, or carry over a decision.",
  });
  if (!isRecord(data) || !nonEmpty(data.assistant_id)) throw badResponse();
  return { assistantId: data.assistant_id };
}

export async function writeMemory(assistantId: string, item: BackboardMemoryItem): Promise<{ memoryId: string }> {
  const path = `${assistantPath(assistantId)}/memories`;
  if (!nonEmpty(item.companyId) || !nonEmpty(item.demoRunId)) throw invalid("A memory item needs its company and demo run.");
  if (!nonEmpty(item.sourceEventId) || !isStringArray(item.sourceMessageIds)) throw invalid("A memory item needs its source event and source message IDs.");
  if (!nonEmpty(item.text)) throw invalid("A memory item needs text.");
  const metadata = { companyId: item.companyId, demoRunId: item.demoRunId, sourceEventId: item.sourceEventId, sourceMessageIds: item.sourceMessageIds };
  const data = await request("POST", path, { content: `${item.text}${META_MARKER}${JSON.stringify({ v: 1, ...metadata })}`, metadata });
  // The documented add response is an open object whose example field is memory_id; memory records elsewhere use id.
  const memoryId = isRecord(data) ? (nonEmpty(data.memory_id) ? data.memory_id : data.id) : undefined;
  if (!nonEmpty(memoryId)) throw badResponse();
  return { memoryId };
}

function toEntry(hit: unknown, companyId: string, demoRunId: string): BackboardMemoryEntry | null {
  if (!isRecord(hit) || !nonEmpty(hit.id) || typeof hit.content !== "string") return null;
  if (typeof hit.created_at !== "string" || !Number.isFinite(Date.parse(hit.created_at))) return null;
  const at = hit.content.lastIndexOf(META_MARKER);
  if (at < 0) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(hit.content.slice(at + META_MARKER.length));
  } catch {
    return null;
  }
  if (!isRecord(meta) || meta.companyId !== companyId || meta.demoRunId !== demoRunId || !nonEmpty(meta.sourceEventId) || !isStringArray(meta.sourceMessageIds)) return null;
  return {
    memoryId: hit.id, text: hit.content.slice(0, at), companyId,
    sourceEventId: meta.sourceEventId, sourceMessageIds: meta.sourceMessageIds, createdAt: hit.created_at,
  };
}

export async function recallMemory(
  assistantId: string, input: { companyId: string; demoRunId: string; query: string; limit?: number },
): Promise<BackboardRecall> {
  try {
    const limit = input.limit ?? 3;
    const path = `${assistantPath(assistantId)}/memories/search`;
    if (!nonEmpty(input.companyId) || !nonEmpty(input.demoRunId) || !nonEmpty(input.query)) {
      throw invalid("Memory recall needs a company, a demo run, and a query.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw invalid(`The memory limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}.`);
    const data = await request("POST", path, { query: input.query, limit });
    if (!isRecord(data) || !Array.isArray(data.memories)) throw badResponse();
    const entries = data.memories.map(hit => toEntry(hit, input.companyId, input.demoRunId)).filter(entry => entry !== null);
    return { status: "available", entries: entries.slice(0, limit) };
  } catch (error) {
    const { code, message } = safeBackboardFailure(error);
    return { status: "unavailable", reason: `${code}: ${message}` };
  }
}

// Deletes this run's assistant, and with it the run's memory namespace. Other assistants are never listed or touched.
export async function closeRunAssistant(assistantId: string): Promise<{ closed: boolean }> {
  const data = await request("DELETE", assistantPath(assistantId), undefined, true);
  return { closed: data !== null };
}

export function safeBackboardFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AnalystError) return { code: error.code, message: error.message };
  // Never persist raw provider errors, request bodies, headers, or credentials.
  return { code: "UPSTREAM_UNAVAILABLE", message: "The memory service could not complete this request. Retry later." };
}
