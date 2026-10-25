import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as backboard from "../convex/lib/backboard";
import {
  backboardConfig, closeRunAssistant, createRunAssistant, recallMemory, safeBackboardFailure, writeMemory,
  type BackboardMemoryEntry, type BackboardMemoryItem, type BackboardRecall,
} from "../convex/lib/backboard";

const BASE = "https://app.backboard.io/api";
const KEY = "test-only-not-a-key";
const ASSISTANT = "123e4567-e89b-12d3-a456-426655440000";
const SECRET = "sk-live-SECRET-provider-diagnostic";
const item: BackboardMemoryItem = {
  companyId: "company-a", demoRunId: "run-7", text: "Prefers scheduling after the imaging pass.",
  sourceEventId: "event-1", sourceMessageIds: ["msg-1", "msg-2"],
};

beforeEach(() => { vi.stubEnv("BACKBOARD_API_KEY", KEY); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function stubFetch(...responses: (Response | Error)[]) {
  const fetch = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetch.mockRejectedValueOnce(response);
    else fetch.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function call(fetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, options] = fetch.mock.calls[index] as [string, RequestInit];
  return { url: String(url), options, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body };
}
const bodyFailure = (error: Error) =>
  ({ ok: true, status: 200, json: () => Promise.reject(error) }) as unknown as Response;
const stored = (text: string, meta: unknown) => `${text}\n\n[orbitcall-memory] ${JSON.stringify(meta)}`;
const meta = (companyId = "company-a") => ({
  v: 1, companyId, demoRunId: "run-7", sourceEventId: "event-1", sourceMessageIds: ["msg-1"],
});
const searchHit = (id: string, content: string, created_at: string | null = "2026-10-24T10:30:00Z") =>
  ({ id, content, score: 0.9, created_at });

describe("Backboard configuration", () => {
  it("reads the API key and uses the documented base URL", () => {
    expect(backboardConfig()).toEqual({ apiKey: KEY, baseUrl: BASE });
  });

  it("fails as not configured without BACKBOARD_API_KEY and makes no request", async () => {
    vi.stubEnv("BACKBOARD_API_KEY", "");
    const fetch = stubFetch();
    expect(() => backboardConfig()).toThrow("BACKBOARD_API_KEY");
    const error = await createRunAssistant({ companyId: "company-a", demoRunId: "run-7" }).catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("MEMORY_NOT_CONFIGURED");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createRunAssistant", () => {
  it("creates one assistant whose name and prompt encode the company and demo run", async () => {
    const fetch = stubFetch(json({ assistant_id: ASSISTANT, name: "x", created_at: "2026-10-24T10:00:00Z" }));
    await expect(createRunAssistant({ companyId: "company-a", demoRunId: "run-7" })).resolves.toEqual({ assistantId: ASSISTANT });
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, options, body } = call(fetch);
    expect(url).toBe(`${BASE}/assistants`);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "X-API-Key": KEY, "Content-Type": "application/json" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(body).sort()).toEqual(["name", "system_prompt"]);
    expect(body.name).toBe("orbitcall:company-a:run-7");
    expect(body.system_prompt).toContain("company-a");
    expect(body.system_prompt).toContain("run-7");
    expect(body.system_prompt).toMatch(/cannot approve/i);
  });

  it("rejects missing company or run before any request", async () => {
    const fetch = stubFetch();
    for (const input of [{ companyId: "", demoRunId: "run-7" }, { companyId: "company-a", demoRunId: " " }]) {
      const error = await createRunAssistant(input).catch(error => error);
      expect(safeBackboardFailure(error).code).toBe("INVALID_INPUT");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response without an assistant ID", async () => {
    stubFetch(json({ name: "x" }));
    const error = await createRunAssistant({ companyId: "company-a", demoRunId: "run-7" }).catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("MEMORY_INVALID_RESPONSE");
  });
});

describe("writeMemory", () => {
  it("adds one memory with text, parseable source metadata, and the API metadata field", async () => {
    const fetch = stubFetch(json({ memory_id: "mem_abc123" }, 201));
    await expect(writeMemory(ASSISTANT, item)).resolves.toEqual({ memoryId: "mem_abc123" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, options, body } = call(fetch);
    expect(url).toBe(`${BASE}/assistants/${ASSISTANT}/memories`);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "X-API-Key": KEY, "Content-Type": "application/json" });
    const metadata = { companyId: "company-a", demoRunId: "run-7", sourceEventId: "event-1", sourceMessageIds: ["msg-1", "msg-2"] };
    expect(body).toEqual({ content: stored(item.text, { v: 1, ...metadata }), metadata });
  });

  it("escapes the assistant ID in the path", async () => {
    const fetch = stubFetch(json({ memory_id: "mem_1" }, 201));
    await writeMemory("a/b?c", item);
    expect(call(fetch).url).toBe(`${BASE}/assistants/a%2Fb%3Fc/memories`);
  });

  it.each([
    ["missing companyId", { ...item, companyId: "" }],
    ["missing demoRunId", { ...item, demoRunId: "" }],
    ["missing sourceEventId", { ...item, sourceEventId: " " }],
    ["empty text", { ...item, text: "   " }],
    ["non-string source messages", { ...item, sourceMessageIds: [1] as unknown as string[] }],
  ])("rejects %s before any request", async (_, bad) => {
    const fetch = stubFetch();
    const error = await writeMemory(ASSISTANT, bad).catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("INVALID_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing assistant ID before any request", async () => {
    const fetch = stubFetch();
    const error = await writeMemory("", item).catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("INVALID_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response without a memory ID", async () => {
    stubFetch(json({ status: "queued" }, 201));
    const error = await writeMemory(ASSISTANT, item).catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("MEMORY_INVALID_RESPONSE");
  });
});

describe("recallMemory", () => {
  it("searches once and maps checked results for this company", async () => {
    const fetch = stubFetch(json({
      memories: [searchHit("mem_1", stored("Prefers scheduling after the imaging pass.", meta()))], total_count: 1,
    }));
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "imaging pass" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, options, body } = call(fetch);
    expect(url).toBe(`${BASE}/assistants/${ASSISTANT}/memories/search`);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "X-API-Key": KEY, "Content-Type": "application/json" });
    expect(body).toEqual({ query: "imaging pass", limit: 3 });
    expect(recall).toEqual({ status: "available", entries: [{
      memoryId: "mem_1", text: "Prefers scheduling after the imaging pass.", companyId: "company-a",
      sourceEventId: "event-1", sourceMessageIds: ["msg-1"], createdAt: "2026-10-24T10:30:00Z",
    }] });
  });

  it("drops entries from another company and entries with missing or unparseable metadata", async () => {
    stubFetch(json({ memories: [
      searchHit("mem_other", stored("Other company preference.", meta("company-b"))),
      searchHit("mem_plain", "A memory Backboard extracted without our metadata."),
      searchHit("mem_broken", "Broken.\n\n[orbitcall-memory] {not json"),
      searchHit("mem_partial", stored("Partial.", { v: 1, companyId: "company-a", sourceEventId: "event-1" })),
      searchHit("mem_bad_ids", stored("Bad IDs.", { ...meta(), sourceMessageIds: "msg-1" })),
      searchHit("mem_no_date", stored("No date.", meta()), null),
      { content: stored("No ID.", meta()), created_at: "2026-10-24T10:30:00Z" },
      searchHit("mem_ok", stored("Kept.", meta())),
    ] }));
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "preferences", limit: 10 });
    expect(recall.status).toBe("available");
    if (recall.status !== "available") return;
    expect(recall.entries.map(entry => entry.memoryId)).toEqual(["mem_ok"]);
    expect(recall.entries.every(entry => entry.companyId === "company-a")).toBe(true);
  });

  it("drops entries tagged with another demo run", async () => {
    stubFetch(json({ memories: [
      searchHit("mem_old", stored("Old run preference.", { ...meta(), demoRunId: "run-OLD" })),
      searchHit("mem_no_run", stored("No run.", { v: 1, companyId: "company-a", sourceEventId: "event-1", sourceMessageIds: ["msg-1"] })),
      searchHit("mem_current", stored("Current run preference.", meta())),
    ] }));
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q" });
    expect(recall.status === "available" && recall.entries.map(entry => entry.memoryId)).toEqual(["mem_current"]);
  });

  it("keeps the full text when the text itself contains the metadata marker", async () => {
    const text = "Quoted [orbitcall-memory] marker.\n\n[orbitcall-memory] {}";
    stubFetch(json({ memories: [searchHit("mem_1", stored(text, meta()))] }));
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q" });
    expect(recall.status === "available" && recall.entries[0].text).toBe(text);
  });

  it("caps results at the limit", async () => {
    const fetch = stubFetch(json({ memories: [1, 2, 3, 4].map(n => searchHit(`mem_${n}`, stored(`Entry ${n}.`, meta()))) }));
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q", limit: 2 });
    expect(call(fetch).body.limit).toBe(2);
    expect(recall.status === "available" && recall.entries.map(entry => entry.memoryId)).toEqual(["mem_1", "mem_2"]);
  });

  it.each([
    ["missing key", () => { vi.stubEnv("BACKBOARD_API_KEY", ""); stubFetch(); }, "MEMORY_NOT_CONFIGURED"],
    ["network error", () => stubFetch(new TypeError(`connect ECONNREFUSED ${SECRET}`)), "UPSTREAM_UNAVAILABLE"],
    ["timeout", () => stubFetch(new DOMException(SECRET, "TimeoutError")), "UPSTREAM_UNAVAILABLE"],
    ["401", () => stubFetch(json({ detail: SECRET }, 401)), "MEMORY_ACCESS_DENIED"],
    ["429", () => stubFetch(json({ detail: SECRET }, 429)), "RATE_LIMITED"],
    ["500", () => stubFetch(json({ detail: SECRET }, 500)), "UPSTREAM_UNAVAILABLE"],
    ["malformed JSON", () => stubFetch(new Response(`<html>${SECRET}`, { status: 200 })), "MEMORY_INVALID_RESPONSE"],
    ["wrong shape", () => stubFetch(json({ results: SECRET })), "MEMORY_INVALID_RESPONSE"],
    ["body stream failure", () => stubFetch(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError(`socket hang up ${SECRET}`)); },
    }), { status: 200 })), "UPSTREAM_UNAVAILABLE"],
    ["abort while reading the body", () => stubFetch(bodyFailure(new DOMException(SECRET, "AbortError"))), "UPSTREAM_UNAVAILABLE"],
    ["socket failure while reading the body", () => stubFetch(bodyFailure(new TypeError(`terminated ${SECRET}`))), "UPSTREAM_UNAVAILABLE"],
  ])("never throws and reports unavailable on %s", async (_, arrange, code) => {
    arrange();
    const recall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q" });
    expect(recall.status).toBe("unavailable");
    if (recall.status !== "unavailable") return;
    expect(recall.reason.startsWith(`${code}: `)).toBe(true);
    expect(recall.reason).not.toContain(SECRET);
    expect(recall.reason).not.toContain(KEY);
  });

  it("reports invalid input as unavailable without a request", async () => {
    const fetch = stubFetch();
    for (const [assistantId, input] of [
      ["", { companyId: "company-a", demoRunId: "run-7", query: "q" }],
      [ASSISTANT, { companyId: "", demoRunId: "run-7", query: "q" }],
      [ASSISTANT, { companyId: "company-a", demoRunId: " ", query: "q" }],
      [ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: " " }],
      [ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q", limit: 0 }],
      [ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q", limit: 51 }],
    ] as const) {
      const recall = await recallMemory(assistantId, input);
      expect(recall.status === "unavailable" && recall.reason.startsWith("INVALID_INPUT: ")).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("closeRunAssistant", () => {
  it("deletes only the named assistant with one request", async () => {
    const fetch = stubFetch(json({ message: "deleted", assistant_id: ASSISTANT, deleted_at: "2026-10-24T11:00:00Z" }));
    await expect(closeRunAssistant(ASSISTANT)).resolves.toEqual({ closed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, options } = call(fetch);
    expect(url).toBe(`${BASE}/assistants/${ASSISTANT}`);
    expect(options.method).toBe("DELETE");
    expect(options.headers).toEqual({ "X-API-Key": KEY });
    expect(options.body).toBeUndefined();
  });

  it("reports an already-missing assistant as not closed", async () => {
    stubFetch(json({ detail: SECRET }, 404));
    await expect(closeRunAssistant(ASSISTANT)).resolves.toEqual({ closed: false });
  });

  it("rejects a missing assistant ID before any request", async () => {
    const fetch = stubFetch();
    const error = await closeRunAssistant(" ").catch(error => error);
    expect(safeBackboardFailure(error).code).toBe("INVALID_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Backboard failures", () => {
  const operations: [string, () => Promise<unknown>][] = [
    ["createRunAssistant", () => createRunAssistant({ companyId: "company-a", demoRunId: "run-7" })],
    ["writeMemory", () => writeMemory(ASSISTANT, item)],
    ["closeRunAssistant", () => closeRunAssistant(ASSISTANT)],
  ];
  const failures: [string, () => Response | Error, string][] = [
    ["401", () => json({ detail: SECRET }, 401), "MEMORY_ACCESS_DENIED"],
    ["403", () => json({ detail: SECRET }, 403), "MEMORY_ACCESS_DENIED"],
    ["429", () => json({ detail: SECRET }, 429), "RATE_LIMITED"],
    ["503", () => json({ detail: SECRET }, 503), "UPSTREAM_UNAVAILABLE"],
    ["422", () => json({ detail: [{ msg: SECRET }] }, 422), "MEMORY_REQUEST_REJECTED"],
    ["network error", () => new TypeError(`fetch failed ${SECRET}`), "UPSTREAM_UNAVAILABLE"],
    ["timeout", () => new DOMException(SECRET, "TimeoutError"), "UPSTREAM_UNAVAILABLE"],
  ];
  for (const [name, run] of operations) {
    it.each(failures)(`${name} makes one request on %s, does not retry, and hides provider text`, async (_, failure, code) => {
      const fetch = stubFetch(failure(), json({ assistant_id: ASSISTANT, memory_id: "mem_1" }));
      const error = await run().then(() => null, (error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(safeBackboardFailure(error).code).toBe(code);
      expect(error?.message).not.toContain(SECRET);
      expect(safeBackboardFailure(error).message).not.toContain(SECRET);
    });
  }

  it("aborts a hung request after 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException(SECRET, "AbortError")));
      })));
      const pending = recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q" });
      await vi.advanceTimersByTimeAsync(14_999);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ status: "unavailable", reason: expect.stringMatching(/^UPSTREAM_UNAVAILABLE: /) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides unknown errors", () => {
    expect(safeBackboardFailure(new Error(SECRET))).toEqual({
      code: "UPSTREAM_UNAVAILABLE", message: expect.not.stringContaining(SECRET),
    });
  });
});

describe("approval boundary", () => {
  it("exports only the memory client functions, nothing approval-shaped", () => {
    expect(Object.keys(backboard).sort()).toEqual([
      "backboardConfig", "closeRunAssistant", "createRunAssistant", "recallMemory", "safeBackboardFailure", "writeMemory",
    ]);
    for (const value of Object.values(backboard)) expect(typeof value).toBe("function");
    expect(Object.keys(backboard).some(name => /approv|authori|sign|consent/i.test(name))).toBe(false);
  });

  it("returns a failed recall as data the advocate shows as memory unavailable", async () => {
    stubFetch(json({ detail: SECRET }, 503));
    const recall: BackboardRecall = await recallMemory(ASSISTANT, { companyId: "company-a", demoRunId: "run-7", query: "q" });
    expect(recall).toEqual({ status: "unavailable", reason: expect.any(String) });
    expect(Object.keys(recall).sort()).toEqual(["reason", "status"]);
  });

  it("matches the advocate memory contract types", () => {
    interface MemoryEntry { memoryId: string; text: string; companyId: string; sourceEventId: string; sourceMessageIds: string[]; createdAt: string }
    type MemoryRecall = { status: "available"; entries: MemoryEntry[] } | { status: "unavailable"; reason: string };
    interface MemoryItemDraft { companyId: string; demoRunId: string; text: string; sourceEventId: string; sourceMessageIds: string[] }
    const entry: MemoryEntry = {} as BackboardMemoryEntry;
    const entryBack: BackboardMemoryEntry = {} as MemoryEntry;
    const recall: MemoryRecall = {} as BackboardRecall;
    const recallBack: BackboardRecall = {} as MemoryRecall;
    const draft: MemoryItemDraft = {} as BackboardMemoryItem;
    const draftBack: BackboardMemoryItem = {} as MemoryItemDraft;
    expect([entry, entryBack, recall, recallBack, draft, draftBack]).toHaveLength(6);
  });
});
