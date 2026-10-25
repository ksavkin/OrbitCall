import { describe, expect, it } from "vitest";
import { ensureTranslator } from "../convex/call/translatorDispatch";

type Call = { url: string; body: unknown; auth: string | null };

// A LiveKit stand-in: answers per Twirp path and records what was asked.
function livekit(answers: Record<string, { status?: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.split("/twirp/")[1];
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const answer = answers[path] ?? { status: 404, body: { code: "not_found" } };
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { calls, fetch, paths: () => calls.map(c => c.url.split("/twirp/")[1]) };
}

const opts = { serverUrl: "wss://lk.example/", apiKey: "key", apiSecret: "secret", room: "coordination-r1", agentName: "orbit-translator", nowS: 1_800_000_000 };
const LIST = "livekit.RoomService/ListParticipants";
const DISPATCHES = "livekit.AgentDispatchService/ListDispatch";
const CREATE = "livekit.AgentDispatchService/CreateDispatch";

describe("explicit translator dispatch before a join", () => {
  it("leaves a room that does not exist yet to the token's dispatch", async () => {
    const lk = livekit({});
    expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("no_room");
    expect(lk.paths()).toEqual([LIST]);
    expect(lk.calls[0].url).toBe("https://lk.example/twirp/livekit.RoomService/ListParticipants");
    expect(lk.calls[0].body).toEqual({ room: "coordination-r1" });
    expect(lk.calls[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("does nothing when the translator is already in the room", async () => {
    const lk = livekit({ [LIST]: { body: { participants: [{ identity: "user-a" }, { identity: "translator" }] } } });
    expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("present");
    expect(lk.paths()).toEqual([LIST]);
  });

  it("dispatches the translator into an existing room without one", async () => {
    const lk = livekit({ [LIST]: { body: { participants: [{ identity: "user-a" }] } }, [DISPATCHES]: { body: {} }, [CREATE]: { body: { id: "AD_1" } } });
    expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("dispatched");
    expect(lk.paths()).toEqual([LIST, DISPATCHES, CREATE]);
    expect(lk.calls[2].body).toEqual({ room: "coordination-r1", agentName: "orbit-translator" });
  });

  it("dispatches again when the earlier translator job has ended", async () => {
    const lk = livekit({
      [LIST]: { body: { participants: [] } },
      [DISPATCHES]: { body: { agentDispatches: [{ agentName: "orbit-translator", state: { jobs: [{ state: { status: "JS_FAILED" } }] } }] } },
      [CREATE]: { body: {} },
    });
    expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("dispatched");
  });

  it("waits for a translator job that is pending or running, in either JSON spelling", async () => {
    for (const listed of [
      { agentDispatches: [{ agentName: "orbit-translator", state: { jobs: [{ state: { status: "JS_RUNNING" } }] } }] },
      { agent_dispatches: [{ agent_name: "orbit-translator", state: { jobs: [{ state: { status: 0 } }] } }] },
      { agentDispatches: [{ agentName: "orbit-translator", state: { jobs: [] } }] },
    ]) {
      const lk = livekit({ [LIST]: { body: { participants: [] } }, [DISPATCHES]: { body: listed } });
      expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("pending");
      expect(lk.paths()).toEqual([LIST, DISPATCHES]);
    }
  });

  it("ignores another agent's dispatch", async () => {
    const lk = livekit({
      [LIST]: { body: { participants: [] } },
      [DISPATCHES]: { body: { agentDispatches: [{ agentName: "someone-else", state: { jobs: [{ state: { status: "JS_RUNNING" } }] } }] } },
      [CREATE]: { body: {} },
    });
    expect(await ensureTranslator({ ...opts, fetch: lk.fetch })).toBe("dispatched");
  });

  it("never throws: a LiveKit error or a network failure reports failed", async () => {
    expect(await ensureTranslator({ ...opts, fetch: livekit({ [LIST]: { status: 500 } }).fetch })).toBe("failed");
    expect(await ensureTranslator({ ...opts, fetch: livekit({ [LIST]: new Error("offline") }).fetch })).toBe("failed");
    const refused = livekit({ [LIST]: { body: { participants: [] } }, [DISPATCHES]: { body: {} }, [CREATE]: { status: 401 } });
    expect(await ensureTranslator({ ...opts, fetch: refused.fetch })).toBe("failed");
  });
});
