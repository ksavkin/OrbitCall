import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../../convex/schema";
import { CALL_END_GRACE_MS, STALE_MS } from "../../convex/call/presence";
import { FIXTURE_NOW, redEvent } from "../../fixtures/events";
import { insertEvent } from "../helpers";

const modules = import.meta.glob("../../convex/**/*.ts");
const api = anyApi as any; // functions are addressed by path, as in call.test.ts
type T = ReturnType<typeof convexTest>;

const SERVICE = "test-service-token-0123456789";
// Fake timers keep every scheduled host request pending, so the tests read the queue and nothing reaches the host.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

/** A call room seeded by the demo seed: a team `rooms` row's id (as rooms.startWorkflow provisions it) or a demo id. */
async function callRoom(kind: "team" | "demo" = "team") {
  vi.stubEnv("CALL_DEV_IDENTITY", "on");
  vi.stubEnv("CALL_SERVICE_TOKEN", SERVICE);
  const t = convexTest(schema, modules);
  // No roomEvents: even a host request that did run would return null without a model call.
  const teamRoomId = kind === "team"
    ? await t.run((ctx) => ctx.db.insert("rooms", { state: "open", companyIds: [], demoRunId: null, simulated: true, createdAt: Date.now(), closedAt: null }))
    : null;
  const { roomId, tokens } = await t.mutation(api.call.demo.seed, teamRoomId ? { roomId: String(teamRoomId) } : {});
  const members = await t.run((ctx) => ctx.db.query("call_members").collect());
  const by = (lang: string) => members.find((m: any) => m.lang === lang && m.role === "operator")!;
  return { t, roomId: roomId as string, teamRoomId, tokens, en: by("en"), ru: by("ru"), zh: by("zh") };
}
type Room = Awaited<ReturnType<typeof callRoom>>;

const hostRequests = (t: T) => t.run(async (ctx) =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name === "hostTriggers:request").map((f: any) => f.args[0]));

const phraseBody = (r: Room, over: Record<string, unknown> = {}) => ({
  roomId: r.roomId, eventId: null, segId: `${r.roomId}:user-${r.en.userId}:1:1`, rev: 2, speakerIdentity: `user-${r.en.userId}`,
  originalLang: "en", original: "We can move at 0.2 m/s", translations: { ru: "ru text" }, values: [],
  translationStatus: { ru: "ok" }, startedAtMs: Date.now() - 1500, ...over,
});
const pending = { translations: {}, translationStatus: { ru: "pending" } };
const post = async (r: Room, body: unknown) => {
  const res = await r.t.fetch("/call/phrase", { method: "POST", headers: { "content-type": "application/json", "x-call-service-token": SERVICE },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe("voice hook: a final phrase requests a host run (final_message)", () => {
  it("rev 1 (pending) requests nothing; rev 2 (final) requests once; a repeated rev 2 and a later rev 3 do not", async () => {
    const r = await callRoom();
    expect(await post(r, phraseBody(r, { rev: 1, ...pending }))).toEqual({ status: 200, body: { ok: true, applied: true } });
    expect(await hostRequests(r.t)).toEqual([]);
    expect((await post(r, phraseBody(r, { rev: 2 }))).body.applied).toBe(true);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "final_message" }]);
    expect((await post(r, phraseBody(r, { rev: 2 }))).body.applied).toBe(false);
    // rev 3: a voice failed after the final text; the phrase is updated, the host is not asked again
    expect((await post(r, phraseBody(r, { rev: 3, errors: { ru: { code: "TTS_FAILED", message: "timeout" } } }))).body.applied).toBe(true);
    expect(await hostRequests(r.t)).toHaveLength(1);
  });

  it("rev 2 arriving before rev 1 requests once; the late rev 1 is ignored and requests nothing", async () => {
    const r = await callRoom();
    expect((await post(r, phraseBody(r, { rev: 2 }))).body.applied).toBe(true);
    expect((await post(r, phraseBody(r, { rev: 1, ...pending }))).body.applied).toBe(false);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "final_message" }]);
    const [row] = await r.t.run((ctx) => ctx.db.query("call_phrases").collect());
    expect(row).toMatchObject({ rev: 2, translationStatus: { ru: "ok" } });
  });

  it("rev 3 (voice failure) arriving first requests once; the late rev 2 and rev 1 are ignored", async () => {
    const r = await callRoom();
    expect((await post(r, phraseBody(r, { rev: 3, errors: { ru: { code: "TTS_FAILED", message: "timeout" } } }))).body.applied).toBe(true);
    expect((await post(r, phraseBody(r, { rev: 2 }))).body.applied).toBe(false);
    expect((await post(r, phraseBody(r, { rev: 1, ...pending }))).body.applied).toBe(false);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "final_message" }]);
  });

  it("a final phrase with no listener languages requests a run; each phrase requests its own", async () => {
    const r = await callRoom();
    await post(r, phraseBody(r, { rev: 1, translations: {}, translationStatus: {} }));
    await post(r, phraseBody(r, { rev: 2, translations: {}, translationStatus: {} }));
    await post(r, phraseBody(r, { segId: `${r.roomId}:user-${r.en.userId}:1:2`, rev: 2 }));
    expect(await hostRequests(r.t)).toHaveLength(2);
  });

  it("a phrase still marked pending is not final, whatever its rev", async () => {
    const r = await callRoom();
    await post(r, phraseBody(r, { rev: 2, ...pending }));
    expect(await hostRequests(r.t)).toEqual([]);
  });

  it("a demo room (not a rooms id) stores the phrase and requests nothing", async () => {
    const r = await callRoom("demo");
    expect(r.roomId.startsWith("demo-")).toBe(true);
    expect(await post(r, phraseBody(r, { rev: 1, ...pending }))).toEqual({ status: 200, body: { ok: true, applied: true } });
    expect(await post(r, phraseBody(r, { rev: 2 }))).toEqual({ status: 200, body: { ok: true, applied: true } });
    expect(await hostRequests(r.t)).toEqual([]);
    expect(await r.t.run((ctx) => ctx.db.query("call_phrases").collect())).toMatchObject([{ rev: 2 }]);
  });

  it("a call room keyed by a rooms id whose room is gone stores the phrase and requests nothing", async () => {
    const r = await callRoom();
    await r.t.run((ctx) => ctx.db.delete(r.teamRoomId!));
    expect(await post(r, phraseBody(r))).toEqual({ status: 200, body: { ok: true, applied: true } });
    expect(await hostRequests(r.t)).toEqual([]);
  });
});

describe("voice hook: the last operator leaving the call requests call_ended", () => {
  const as = (r: Room, who: "en" | "ru" | "zh" | "observer") => ({ roomId: r.roomId, devToken: r.tokens[who] });
  const inCall = (r: Room, who: "en" | "ru" | "zh" | "observer", value = true) =>
    r.t.mutation(api.call.presence.setInCall, { ...as(r, who), inCall: value });
  const ended = [{ trigger: "call_ended" }];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const setUpdated = (r: Room, userId: string, updatedAt: string) => r.t.run(async (ctx) => {
    const row = await ctx.db.query("call_presence").withIndex("by_room_user", (q: any) => q.eq("roomId", r.roomId).eq("userId", userId)).unique();
    await ctx.db.patch(row!._id, { updatedAt });
  });
  // Moves the fake clock and runs the scheduled functions that came due (expiry checks, end confirmations).
  const advance = async (r: Room, ms: number) => { vi.advanceTimersByTime(ms); await r.t.finishInProgressScheduledFunctions(); };
  const afterGrace = (r: Room) => advance(r, CALL_END_GRACE_MS + 1);
  const scheduled = (t: T, name: string) => t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name === name));

  it("two operators: the first leaving requests nothing, the last leaving requests call_ended once after the grace", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "ru");
    await inCall(r, "en", false);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([]);
    await r.t.mutation(api.call.presence.leave, as(r, "ru"));
    expect(await hostRequests(r.t)).toEqual([]); // not yet: a reconnect within the grace keeps the call
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "call_ended" }]);
    // leaving the room after the call, or a repeated leave, is not a second end
    await r.t.mutation(api.call.presence.leave, as(r, "en"));
    await r.t.mutation(api.call.presence.leave, as(r, "ru"));
    await afterGrace(r);
    expect(await hostRequests(r.t)).toHaveLength(1);
  });

  it("the last operator reconnecting within the grace keeps the call: no call_ended", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "en", false); // LiveKit dropped
    await advance(r, CALL_END_GRACE_MS / 3);
    await inCall(r, "en"); // reconnected
    await afterGrace(r);
    expect(await scheduled(r.t, "call/presence:confirmCallEnded")).toMatchObject([{ state: { kind: "success" } }]);
    expect(await hostRequests(r.t)).toEqual([]);
    await inCall(r, "en", false); // this time nobody returns
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "call_ended" }]);
  });

  it("setInCall(false) of the last operator ends the call; an observer still listening does not keep it open", async () => {
    const r = await callRoom();
    await inCall(r, "observer");
    await inCall(r, "zh");
    await inCall(r, "zh", false);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toMatchObject(ended);
  });

  it("an observer leaving or expiring never ends the call; only the last operator does", async () => {
    const r = await callRoom();
    await inCall(r, "observer");
    await r.t.mutation(api.call.presence.leave, as(r, "observer"));
    await inCall(r, "en");
    await inCall(r, "observer");
    await inCall(r, "observer", false);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([]);
    await inCall(r, "en", false); // the call ended here: one request
    await inCall(r, "observer");
    const observerId = (await r.t.run((ctx) => ctx.db.query("call_members").collect())).find((m: any) => m.role === "observer")!.userId;
    await setUpdated(r, observerId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(1); // the observer's expiry is no second end
    await afterGrace(r);
    expect(await hostRequests(r.t)).toMatchObject(ended);
  });

  it("a member who was never in the call requests nothing by leaving", async () => {
    const r = await callRoom();
    await r.t.mutation(api.call.presence.join, as(r, "en"));
    await r.t.mutation(api.call.presence.leave, as(r, "en"));
    await r.t.mutation(api.call.presence.leave, as(r, "ru")); // no presence row at all
    await afterGrace(r);
    expect(await scheduled(r.t, "call/presence:confirmCallEnded")).toEqual([]);
    expect(await hostRequests(r.t)).toEqual([]);
  });

  it("an operator whose heartbeat went stale does not keep the call open for the one leaving", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "ru");
    await setUpdated(r, r.ru.userId, ago(80_000)); // ru: 80 s without a heartbeat, absent
    await inCall(r, "en", false);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toMatchObject(ended);
  });

  it("every heartbeat in the call schedules a room expiry check; the check after the last heartbeat ends the call once", async () => {
    const r = await callRoom();
    const t0 = Date.now();
    await inCall(r, "en");
    const [check] = await scheduled(r.t, "call/presence:expireStale");
    expect(check.args[0]).toEqual({ roomId: r.roomId });
    expect(check.scheduledTime - t0).toBeGreaterThanOrEqual(STALE_MS + 1_000); // just after the row turns stale
    expect(check.scheduledTime - t0).toBeLessThan(STALE_MS + 1_100);
    // the web's beat is join + setInCall(true): each refreshes the in-call row and schedules a check; then the tab dies
    for (let i = 0; i < 2; i++) { await advance(r, 30_000); await r.t.mutation(api.call.presence.join, as(r, "en")); await inCall(r, "en"); }
    expect(await scheduled(r.t, "call/presence:expireStale")).toHaveLength(5);
    await advance(r, 80_000); // the checks of the first two heartbeats find a fresh row; the last one expires it
    expect(await r.t.run((ctx) => ctx.db.query("call_presence").collect())).toMatchObject([{ inRoom: false, inCall: false }]);
    expect(await hostRequests(r.t)).toEqual([]);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "call_ended" }]);
    await advance(r, 5 * STALE_MS);
    expect(await hostRequests(r.t)).toHaveLength(1);
  });

  it("a tab dying between a beat's join and its setInCall(true) still ends the call once", async () => {
    const r = await callRoom();
    await inCall(r, "en"); // check due at +76 s
    await advance(r, 30_000);
    await r.t.mutation(api.call.presence.join, as(r, "en")); // refreshes the in-call row; the paired setInCall never arrives
    expect(await scheduled(r.t, "call/presence:expireStale")).toHaveLength(2);
    await advance(r, 50_000); // the first check finds the row refreshed by the join (50 s old) and clears nothing
    expect(await r.t.run((ctx) => ctx.db.query("call_presence").collect())).toMatchObject([{ inCall: true }]);
    await advance(r, 30_000); // the join's own check clears it
    expect(await r.t.run((ctx) => ctx.db.query("call_presence").collect())).toMatchObject([{ inCall: false }]);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "call_ended" }]);
    await advance(r, 5 * STALE_MS);
    expect(await hostRequests(r.t)).toHaveLength(1);
  });

  it("an expiry check while heartbeats continue finds nothing and ends nothing", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    for (let i = 0; i < 6; i++) { await advance(r, 30_000); await inCall(r, "en"); }
    expect(await r.t.run((ctx) => ctx.db.query("call_presence").collect())).toMatchObject([{ inCall: true }]);
    expect(await scheduled(r.t, "call/presence:confirmCallEnded")).toEqual([]);
    expect(await hostRequests(r.t)).toEqual([]);
  });

  it("expireStale clearing the last operator in the call requests call_ended once per room", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "ru");
    await setUpdated(r, r.en.userId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, { roomId: r.roomId })).toBe(1);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([]); // ru is still in the call
    await setUpdated(r, r.ru.userId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(1); // the optional global sweep, no room id
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([{ roomId: r.teamRoomId, trigger: "call_ended" }]);
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(0);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toHaveLength(1);
  });

  it("expireStale of two operators of one room requests once; a stale row only in the room (not the call) requests nothing", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "ru");
    await r.t.mutation(api.call.presence.join, as(r, "zh"));
    await setUpdated(r, r.zh.userId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, { roomId: r.roomId })).toBe(1);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toEqual([]);
    await setUpdated(r, r.en.userId, ago(90_000));
    await setUpdated(r, r.ru.userId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, { roomId: r.roomId })).toBe(2);
    await afterGrace(r);
    expect(await hostRequests(r.t)).toMatchObject(ended);
  });

  it("a demo room (not a rooms id) ends its call without a host request", async () => {
    const r = await callRoom("demo");
    await inCall(r, "en");
    await r.t.mutation(api.call.presence.leave, as(r, "en"));
    await inCall(r, "ru");
    await setUpdated(r, r.ru.userId, ago(90_000));
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(1);
    await afterGrace(r);
    expect(await scheduled(r.t, "call/presence:confirmCallEnded")).toHaveLength(2);
    expect(await hostRequests(r.t)).toEqual([]);
    expect(await r.t.run((ctx) => ctx.db.query("call_presence").collect())).toMatchObject([{ inCall: false }, { inCall: false }]);
  });

  it("the scheduled request carries a valid rooms id: hostTriggers.request accepts it (no linked events: no run)", async () => {
    const r = await callRoom();
    await inCall(r, "en");
    await inCall(r, "en", false);
    await afterGrace(r);
    const [args] = await hostRequests(r.t);
    expect(await r.t.mutation(anyApi.hostTriggers.request, args)).toBeNull();
  });
});

describe("voice hook end to end: a final phrase reaches hostTriggers.request and opens a host run", () => {
  it("a final voice phrase in a team room with a linked event creates a running final_message host run", async () => {
    vi.setSystemTime(FIXTURE_NOW);
    vi.stubEnv("GEMINI_API_KEY", ""); // belt and braces: the host action is never pumped, and could not call a provider anyway
    const t = convexTest(schema, modules);
    // Seeded like tests/hostContext.test.ts: the speaker's company owns object A and the speaker is assigned to it.
    const eventId = await insertEvent(t as any);
    const r = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { key: "voice-a", name: "Voice A", simulated: true });
      const userId = await ctx.db.insert("users", { tokenIdentifier: "https://fixture.invalid|voice-a", companyId, role: "operator", name: "Voice operator", language: "ru" });
      await ctx.db.insert("satelliteOwners", { objectId: redEvent.objectA.objectId, companyId });
      await ctx.db.insert("fleetAssignments", { userId, objectId: redEvent.objectA.objectId, active: true });
      const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [companyId], demoRunId: null, simulated: true, createdAt: FIXTURE_NOW - 60_000, closedAt: null });
      await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: FIXTURE_NOW });
      await ctx.db.insert("roomMembers", { roomId, userId, companyId, inRoom: true, inCall: true, updatedAt: FIXTURE_NOW });
      // The call member as rooms.startWorkflow provisions it: keyed by String(room._id).
      await ctx.db.insert("call_members", { roomId: String(roomId), subject: "voice-a", userId: String(userId), companyId: String(companyId),
        name: "Voice operator", lang: "ru", role: "operator", simulated: true });
      return { roomId, userId };
    });
    const identity = `user-${r.userId}`;
    const phrase = (rev: number, translationStatus: Record<string, string>) => t.mutation(api.call.ingest.upsertPhrase, {
      roomId: String(r.roomId), eventId: null, segId: `${r.roomId}:${identity}:1:1`, rev, speakerIdentity: identity, originalLang: "ru",
      original: "I prefer to wait", translations: rev === 1 ? {} : { en: "I prefer to wait." }, values: [], translationStatus, errors: {},
      startedAtMs: FIXTURE_NOW - 1_500 });
    expect(await phrase(1, { en: "pending" })).toBe(true);
    expect(await phrase(2, { en: "ok" })).toBe(true);
    expect(await hostRequests(t)).toEqual([{ roomId: r.roomId, trigger: "final_message" }]);
    // Run only the due host request; the hostTriggers:run it schedules stays a pending fake timer and never runs.
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    const runs = await t.run((ctx) => ctx.db.query("hostRuns").collect());
    expect(runs).toMatchObject([{ roomId: r.roomId, trigger: "final_message", status: "running", attempt: 1 }]);
    const pending = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name === "hostTriggers:run").map((f: any) => f.state.kind));
    expect(pending).toEqual(["pending"]);
  });
});
