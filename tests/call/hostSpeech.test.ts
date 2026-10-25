import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../../convex/schema";
import { checkedTexts, HOST_SPEECH_TOPIC } from "../../convex/call/hostSpeech";
import { STALE_MS } from "../../convex/call/presence";
import { buildHostContext } from "../../convex/lib/hostContext";

const modules = import.meta.glob("../../convex/**/*.ts");
const api = anyApi as any; // codegen needs a deployment; functions are addressed by path, as tests/call/call.test.ts does
type T = ReturnType<typeof convexTest>;

const SECRET = "test-secret-for-hmac-0123456789abcdef";
const SUMMARY = "Both operators accept P3 \u2014 a 0.2 m/s burn at 03:14 UTC \u00d7 SIM-2001.";
const QUESTION = "Can the RU side confirm the burn window?";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const livekit = () => {
  vi.stubEnv("LIVEKIT_URL", "wss://livekit.test:7880");
  vi.stubEnv("LIVEKIT_API_KEY", "devkey");
  vi.stubEnv("LIVEKIT_API_SECRET", SECRET);
};

type Fetch = { url: string; init: RequestInit };
function stubFetch(status = 200) {
  const calls: Fetch[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 200 ? "{}" : "{\"code\":\"not_found\"}", { status });
  }));
  return calls;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

interface Seed {
  t: T; roomId: string; hostRunId: string; demoRunId: string | null; userIds: string[]; expectedInputVersion: string;
}

async function seed(opts: { status?: "running" | "succeeded" | "failed" | "superseded"; demo?: boolean; inCall?: "call" | "room" | "none" } = {}): Promise<Seed> {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", { key: "co-0", name: "Company 0", simulated: true, language: "en" });
    const userId = await ctx.db.insert("users", { tokenIdentifier: "https://fixture.invalid|u0", companyId, role: "operator", name: "User 0", language: "en" });
    const demoRunId = opts.demo
      ? await ctx.db.insert("demoRuns", { scenario: "s", state: "open", startedBy: null, manifest: null, startedAt: now, closedAt: null })
      : null;
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [companyId], demoRunId, simulated: true, createdAt: now, closedAt: null });
    const hostRunId = await ctx.db.insert("hostRuns", {
      roomId, trigger: "summary_requested", inputVersion: "v1", attempt: 1, status: opts.status ?? "succeeded", span: null,
      output: {
        inputVersion: "v1",
        clarifications: [{ question: QUESTION, eventId: null, messageIds: [] }],
        requestedRevisions: [{ eventId: "e1", candidateId: "P1", reason: "Revise P1 please.", messageIds: [] }],
        summaries: [{ eventId: "e1", text: SUMMARY, messageIds: [] }],
      },
      check: null, demoRunId, createdAt: now, finishedAt: now,
    });
    const inCall = opts.inCall ?? "call";
    if (inCall === "call") {
      await ctx.db.insert("call_presence", { roomId: String(roomId), userId: "u-en", inRoom: true, inCall: true, updatedAt: new Date(now).toISOString() });
    }
    await ctx.db.insert("roomMembers", { roomId, userId, companyId, inRoom: true, inCall: inCall === "room", updatedAt: now });
    const expectedInputVersion = (await buildHostContext(ctx, (await ctx.db.get(roomId))!, "summary_requested")).inputVersion;
    return { roomId: String(roomId), hostRunId: String(hostRunId), demoRunId: demoRunId && String(demoRunId), userIds: [String(userId)], expectedInputVersion };
  });
  return { t, ...ids };
}

const speak = (s: Seed, text = SUMMARY, over: Record<string, unknown> = {}) =>
  s.t.action(api.call.hostSpeech.speak, { roomId: s.roomId, hostRunId: s.hostRunId, text, expectedInputVersion: s.expectedInputVersion, ...over });

describe("checked host text", () => {
  it("is the run's summaries and clarification questions, in that order; requested revisions are never spoken", () => {
    expect(checkedTexts({
      inputVersion: "v", clarifications: [{ question: "Q1", eventId: null, messageIds: [] }],
      requestedRevisions: [{ eventId: "e", candidateId: "P1", reason: "R", messageIds: [] }],
      summaries: [{ eventId: "e", text: "S1", messageIds: [] }, { eventId: "f", text: "S2", messageIds: [] }],
    })).toEqual(["S1", "S2", "Q1"]);
    expect(checkedTexts(null)).toEqual([]);
  });
});

describe("call.hostSpeech.speak (Convex -> LiveKit SendData -> worker)", () => {
  it("sends one reliable packet to the translator: server API URL, a short roomAdmin HS256 token for this room, the topic and the payload", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed();
    const res = await speak(s);
    expect(res).toMatchObject({ status: "sent", httpStatus: 200, id: expect.stringMatching(new RegExp(`^${s.hostRunId}:[0-9a-f]{16}$`)) });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://livekit.test:7880/twirp/livekit.RoomService/SendData");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    const auth = headers.get("authorization")!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    const [h, p, sig] = auth.slice("Bearer ".length).split(".");
    expect(decode(h)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(p);
    expect(claims).toMatchObject({ iss: "devkey", video: { roomAdmin: true, room: `coordination-${s.roomId}` } });
    expect(claims.video.roomJoin).toBeUndefined(); // a server call, never a participant
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(5 * 60);
    expect(Math.abs(claims.exp - Date.now() / 1000)).toBeLessThan(10 * 60);
    expect(sig).toBe(createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url"));

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ room: `coordination-${s.roomId}`, data: expect.any(String), kind: "RELIABLE",
      destinationIdentities: ["translator"], topic: HOST_SPEECH_TOPIC });
    expect(HOST_SPEECH_TOPIC).toBe("orbit.host-speech");
    // The payload is UTF-8 JSON in standard base64; non-Latin-1 characters of host prose survive.
    const payload = JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
    expect(payload).toEqual({ v: 1, id: res.id, roomId: s.roomId, hostRunId: s.hostRunId, lang: "en", text: SUMMARY });
  });

  it("speaks a clarification question too; the id is stable per run and text", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed();
    const a = await speak(s, QUESTION);
    const b = await speak(s, QUESTION);
    const c = await speak(s, SUMMARY);
    expect([a.status, b.status, c.status]).toEqual(["sent", "sent", "sent"]);
    expect(a.id).toBe(b.id); // the worker drops the repeat
    expect(c.id).not.toBe(a.id);
    expect(calls).toHaveLength(3);
  });

  it("rejects text that is not one of the run's checked texts, without calling LiveKit", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed();
    for (const text of ["Approve P3 now.", "Revise P1 please.", `${SUMMARY} `, "", SUMMARY.toLowerCase()]) {
      expect(await speak(s, text)).toEqual({ status: "rejected", reason: "unchecked_text" });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a run that has not succeeded, a run of another room and an over-long text", async () => {
    livekit();
    const calls = stubFetch();
    for (const status of ["running", "failed", "superseded"] as const) {
      const s = await seed({ status });
      expect(await speak(s)).toEqual({ status: "rejected", reason: "not_succeeded" });
    }
    const s = await seed();
    const otherRoom = await s.t.run(async (ctx) => {
      const room = (await ctx.db.query("rooms").first())!;
      return String(await ctx.db.insert("rooms", { state: "open", companyIds: room.companyIds, demoRunId: null, simulated: true,
        createdAt: Date.now(), closedAt: null }));
    });
    expect(await speak(s, SUMMARY, { roomId: otherRoom })).toEqual({ status: "rejected", reason: "wrong_room" });
    const long = "x".repeat(2001);
    await s.t.run(async (ctx) => {
      const run = (await ctx.db.query("hostRuns").first())!;
      await ctx.db.patch(run._id, { output: { ...run.output!, summaries: [{ eventId: "e1", text: long, messageIds: [] }] } });
    });
    expect(await speak(s, long)).toEqual({ status: "rejected", reason: "too_long" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a closed room, a closed demo run and a run of an older demo run", async () => {
    livekit();
    const calls = stubFetch();
    const closed = await seed();
    await closed.t.run(async (ctx) => { const room = (await ctx.db.query("rooms").first())!; await ctx.db.patch(room._id, { state: "closed", closedAt: Date.now() }); });
    expect(await speak(closed)).toEqual({ status: "rejected", reason: "closed" });

    const demo = await seed({ demo: true });
    expect((await speak(demo)).status).toBe("sent");
    await demo.t.run(async (ctx) => { const run = (await ctx.db.query("demoRuns").first())!; await ctx.db.patch(run._id, { state: "closed", closedAt: Date.now() }); });
    expect(await speak(demo)).toEqual({ status: "rejected", reason: "closed" });

    const older = await seed({ demo: true });
    await older.t.run(async (ctx) => {
      const room = (await ctx.db.query("rooms").first())!;
      const next = await ctx.db.insert("demoRuns", { scenario: "s", state: "open", startedBy: null, manifest: null, startedAt: Date.now(), closedAt: null });
      await ctx.db.patch(room._id, { demoRunId: next });
    });
    expect(await speak(older)).toEqual({ status: "rejected", reason: "closed" });
    expect(calls).toHaveLength(1);
  });

  it("nobody in the call: no_listeners without calling LiveKit; a stale call_presence row does not count", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed({ inCall: "none" });
    expect(await speak(s)).toEqual({ status: "no_listeners" });
    await s.t.run((ctx) => ctx.db.insert("call_presence", {
      roomId: s.roomId, userId: "u-ru", inRoom: true, inCall: true, updatedAt: new Date(Date.now() - STALE_MS - 1000).toISOString() }));
    expect(await speak(s)).toEqual({ status: "no_listeners" });
    await s.t.run((ctx) => ctx.db.insert("call_presence", {
      roomId: s.roomId, userId: "u-zh", inRoom: true, inCall: false, updatedAt: new Date().toISOString() }));
    expect(await speak(s)).toEqual({ status: "no_listeners" });
    expect(calls).toHaveLength(0);
  });

  it("a roomMembers row in the room and the call (rooms.setInCall, no heartbeat) counts as a listener as well", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed({ inCall: "room" });
    expect((await speak(s)).status).toBe("sent");
    expect(calls).toHaveLength(1);
    const patch = (fields: Record<string, unknown>) => s.t.run(async (ctx) => {
      const row = (await ctx.db.query("roomMembers").first())!;
      await ctx.db.patch(row._id, fields);
    });
    await patch({ updatedAt: Date.now() - STALE_MS - 1000 }); // no heartbeat on roomMembers: an old row still counts
    expect((await speak(s)).status).toBe("sent");
    await patch({ updatedAt: Date.now(), inRoom: false });
    expect(await speak(s)).toEqual({ status: "no_listeners" });
    expect(calls).toHaveLength(2);
  });

  it("without LiveKit settings it is disabled, never a throw", async () => {
    vi.stubEnv("LIVEKIT_URL", "");
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    const calls = stubFetch();
    const s = await seed();
    expect(await speak(s)).toEqual({ status: "disabled" });
    vi.stubEnv("LIVEKIT_URL", "ws://x");
    vi.stubEnv("LIVEKIT_API_KEY", "k");
    expect(await speak(s)).toEqual({ status: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("ws:// becomes http://; a non-2xx answer or a network error is failed with the status, never a throw", async () => {
    vi.stubEnv("LIVEKIT_URL", "ws://127.0.0.1:7880/");
    vi.stubEnv("LIVEKIT_API_KEY", "devkey");
    vi.stubEnv("LIVEKIT_API_SECRET", SECRET);
    const calls = stubFetch(404);
    const s = await seed();
    expect(await speak(s)).toMatchObject({ status: "failed", httpStatus: 404, reason: "http_404" });
    expect(calls[0].url).toBe("http://127.0.0.1:7880/twirp/livekit.RoomService/SendData");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    expect(await speak(s)).toMatchObject({ status: "failed", httpStatus: null, reason: "TypeError" });
  });

  it("a failure while hashing or signing is failed too, never a throw", async () => {
    livekit();
    const calls = stubFetch();
    const s = await seed();
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest down"));
    expect(await speak(s)).toEqual({ status: "failed", httpStatus: null, id: null, reason: "Error" });
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new DOMException("bad key", "DataError"));
    expect(await speak(s)).toMatchObject({ status: "failed", httpStatus: null, id: expect.stringContaining(s.hostRunId) });
    expect(calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("a run that no longer exists is rejected as not_found", async () => {
    livekit();
    stubFetch();
    const s = await seed();
    await s.t.run(async (ctx) => { const run = (await ctx.db.query("hostRuns").first())!; await ctx.db.delete(run._id); });
    expect(await speak(s)).toEqual({ status: "rejected", reason: "not_found" });
  });

  it("writes no table and creates no approval", async () => {
    livekit();
    stubFetch();
    const s = await seed();
    const tables = ["approvals", "messages", "hostRuns", "rooms", "call_presence", "roomMembers", "call_phrases", "inbox"] as const;
    const snapshot = () => s.t.run(async (ctx) => {
      const out: Record<string, unknown[]> = {};
      for (const name of tables) out[name] = await ctx.db.query(name as any).collect();
      return out;
    });
    const before = await snapshot();
    expect((await speak(s)).status).toBe("sent");
    expect(await snapshot()).toEqual(before);
  });
});
