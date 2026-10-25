import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");
const api = anyApi as any; // codegen needs a deployment; functions are addressed by path, as the team's web does
type T = ReturnType<typeof convexTest>;

const SERVICE = "test-service-token-0123456789";
afterEach(() => vi.unstubAllEnvs());

// Russian and Mandarin sample text as escapes: the package keeps non-English characters out of its files.
const RU = "\u041c\u044b \u043c\u043e\u0436\u0435\u043c \u0441\u0434\u0432\u0438\u043d\u0443\u0442\u044c\u0441\u044f \u27e6v1\u27e7";
const ZH = "\u6211\u4eec\u53ef\u4ee5\u673a\u52a8 \u27e6v1\u27e7";

async function room() {
  vi.stubEnv("CALL_DEV_IDENTITY", "on");
  vi.stubEnv("CALL_SERVICE_TOKEN", SERVICE);
  const t = convexTest(schema, modules);
  const { roomId, tokens } = await t.mutation(api.call.demo.seed, {});
  const members = await t.run((ctx) => ctx.db.query("call_members").collect());
  const by = (lang: string) => members.find((m: any) => m.lang === lang)!;
  return { t, roomId, tokens, en: by("en"), ru: by("ru"), zh: by("zh"), observer: members.find((m: any) => m.role === "observer")! };
}
type Room = Awaited<ReturnType<typeof room>>;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: any) => e.data?.code ?? e.message);

const phraseBody = (r: Room, over: Record<string, unknown> = {}) => ({
  roomId: r.roomId, eventId: null, segId: `${r.roomId}:user-${r.en.userId}:1:1`, rev: 1, speakerIdentity: `user-${r.en.userId}`,
  originalLang: "en", original: "We can move 0.2 m/s", translations: { ru: RU, zh: ZH },
  values: [{ placeholder: "\u27e6v1\u27e7", kind: "unit", text: "0.2 m/s" }], translationStatus: { ru: "ok", zh: "ok" }, startedAtMs: Date.now() - 1500,
  ...over,
});
const post = (t: T, body: unknown, token: string | null = SERVICE) =>
  t.fetch("/call/phrase", { method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { "x-call-service-token": token }) },
    body: typeof body === "string" ? body : JSON.stringify(body) });

describe("membership and identity [ACC-2]", () => {
  it("a member joins by dev token; other rooms' tokens, short tokens and a disabled seam are refused", async () => {
    const r = await room();
    await r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: r.tokens.en });
    const other = await r.t.mutation(api.call.demo.seed, {});
    expect(await code(r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: other.tokens.ru }))).toBe("FORBIDDEN");
    expect(await code(r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: "short" }))).toBe("UNAUTHENTICATED");
    expect(await code(r.t.mutation(api.call.presence.join, { roomId: r.roomId }))).toBe("UNAUTHENTICATED");
    vi.stubEnv("CALL_DEV_IDENTITY", "off");
    expect(await code(r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: r.tokens.en }))).toBe("UNAUTHENTICATED");
  });

  it("a real identity always wins over a dev token", async () => {
    const r = await room();
    await r.t.withIdentity({ subject: r.ru.subject }).mutation(api.call.presence.join, { roomId: r.roomId });
    expect(await code(r.t.withIdentity({ subject: "auth0|stranger" }).mutation(api.call.presence.join, { roomId: r.roomId, devToken: r.tokens.en })))
      .toBe("FORBIDDEN");
  });

  // Presence tests use the real clock: stale rows are written directly with timestamps relative to Date.now().
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const setUpdated = (r: Room, userId: string, roomId: string, updatedAt: string) => r.t.run(async (ctx) => {
    const row = await ctx.db.query("call_presence").withIndex("by_room_user", (q: any) => q.eq("roomId", roomId).eq("userId", userId)).unique();
    await ctx.db.patch(row!._id, { updatedAt });
  });

  it("presence: list returns the stored row with updatedAt; a heartbeat refreshes it; expireStale clears rows without one for 75 s", async () => {
    const r = await room();
    const before = Date.now();
    await r.t.mutation(api.call.presence.setInCall, { roomId: r.roomId, devToken: r.tokens.en, inCall: true });
    await r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: r.tokens.ru });
    const en = async () => (await r.t.query(api.call.presence.list, { roomId: r.roomId, devToken: r.tokens.ru })).find((m: any) => m.language === "en");
    const first = await en();
    expect(first).toMatchObject({ inRoom: true, inCall: true, heartbeatMs: 30000, staleMs: 75000 });
    expect(Date.parse(first.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    await setUpdated(r, r.en.userId, r.roomId, ago(60_000)); // last heartbeat a minute ago
    await r.t.mutation(api.call.presence.setInCall, { roomId: r.roomId, devToken: r.tokens.en, inCall: true }); // heartbeat
    expect(Date.parse((await en()).updatedAt)).toBeGreaterThan(Date.now() - 30_000);
    await setUpdated(r, r.en.userId, r.roomId, ago(80_000)); // en: 80 s without a heartbeat
    await setUpdated(r, r.ru.userId, r.roomId, ago(140_000)); // ru: 140 s
    expect(await r.t.mutation(api.call.presence.expireStale, { roomId: r.roomId })).toBe(2);
    expect(await en()).toMatchObject({ inRoom: false, inCall: false });
    expect(await r.t.mutation(api.call.presence.expireStale, { roomId: r.roomId })).toBe(0); // idempotent
  });

  it("presence: expireStale without a room id clears stale rows of every room, leaves fresh ones (team cron)", async () => {
    const r = await room();
    const other = await r.t.mutation(api.call.demo.seed, {});
    await r.t.mutation(api.call.presence.setInCall, { roomId: r.roomId, devToken: r.tokens.en, inCall: true });
    await r.t.mutation(api.call.presence.join, { roomId: other.roomId, devToken: other.tokens.ru });
    await r.t.mutation(api.call.presence.leave, { roomId: other.roomId, devToken: other.tokens.zh }); // already absent
    await r.t.mutation(api.call.presence.join, { roomId: r.roomId, devToken: r.tokens.zh }); // fresh
    const members = await r.t.run((ctx) => ctx.db.query("call_members").collect());
    const otherRu = members.find((m: any) => m.roomId === other.roomId && m.lang === "ru")!;
    const otherZh = members.find((m: any) => m.roomId === other.roomId && m.lang === "zh")!;
    await setUpdated(r, r.en.userId, r.roomId, ago(90_000));
    await setUpdated(r, otherRu.userId, other.roomId, ago(90_000));
    await setUpdated(r, otherZh.userId, other.roomId, ago(90_000)); // stale but not present: not counted
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(2);
    const rows = await r.t.run((ctx) => ctx.db.query("call_presence").collect());
    expect(rows.filter((p: any) => p.inRoom).map((p: any) => p.userId)).toEqual([r.zh.userId]);
    expect(await r.t.mutation(api.call.presence.expireStale, {})).toBe(0);
  });

  it("presence: join, in call, leave", async () => {
    const r = await room();
    const as = { roomId: r.roomId, devToken: r.tokens.zh };
    await r.t.mutation(api.call.presence.setInCall, { ...as, inCall: true });
    let p = await r.t.run((ctx) => ctx.db.query("call_presence").collect());
    expect(p).toMatchObject([{ userId: r.zh.userId, inRoom: true, inCall: true }]);
    await r.t.mutation(api.call.presence.setInCall, { ...as, inCall: false });
    await r.t.mutation(api.call.presence.leave, as);
    p = await r.t.run((ctx) => ctx.db.query("call_presence").collect());
    expect(p).toMatchObject([{ inRoom: false, inCall: false }]);
  });
});

describe("call.join token (spec §5)", () => {
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  it("a 2-hour HS256 LiveKit token for coordination-<roomId> with lang and company as signed attributes", async () => {
    const r = await room();
    vi.stubEnv("LIVEKIT_URL", "ws://livekit.test:7880");
    vi.stubEnv("LIVEKIT_API_KEY", "devkey");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret-for-hmac-0123456789abcdef");
    const res = await r.t.action(api.call.join.join, { roomId: r.roomId, devToken: r.tokens.ru });
    expect(res).toEqual({ serverUrl: "ws://livekit.test:7880", token: expect.any(String), roomName: `coordination-${r.roomId}`,
      identity: `user-${r.ru.userId}`, language: "ru", role: "operator" });
    const [h, p, s] = res.token.split(".");
    expect(decode(h)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(p);
    expect(claims).toMatchObject({ iss: "devkey", sub: `user-${r.ru.userId}`, jti: `user-${r.ru.userId}`, name: "Dispatcher RU",
      attributes: { lang: "ru", companyId: r.ru.companyId },
      video: { room: `coordination-${r.roomId}`, roomJoin: true, canPublish: true, canPublishSources: ["microphone"], canSubscribe: true,
        canPublishData: false, canUpdateOwnMetadata: false },
      roomConfig: { agents: [{ agentName: "orbit-translator" }] } });
    expect(claims.exp - claims.nbf).toBe(7205); // 2 h from now, valid from 5 s back (clock skew)
    expect(Math.abs(claims.exp - 7200 - Date.now() / 1000)).toBeLessThan(60);
    const expected = createHmac("sha256", "test-secret-for-hmac-0123456789abcdef").update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });

  it("an observer's token subscribes but cannot publish", async () => {
    const r = await room();
    vi.stubEnv("LIVEKIT_URL", "ws://x");
    vi.stubEnv("LIVEKIT_API_KEY", "k");
    vi.stubEnv("LIVEKIT_API_SECRET", "s");
    const res = await r.t.action(api.call.join.join, { roomId: r.roomId, devToken: r.tokens.observer });
    expect(res.role).toBe("observer");
    expect(decode(res.token.split(".")[1]).video).toMatchObject({ canPublish: false, canPublishSources: [], canSubscribe: true });
  });

  it("not configured → FEATURE_DISABLED; not a member → FORBIDDEN", async () => {
    const r = await room();
    expect(await code(r.t.action(api.call.join.join, { roomId: r.roomId, devToken: r.tokens.en }))).toBe("FEATURE_DISABLED");
    vi.stubEnv("LIVEKIT_URL", "ws://x");
    vi.stubEnv("LIVEKIT_API_KEY", "k");
    vi.stubEnv("LIVEKIT_API_SECRET", "s");
    expect(await code(r.t.action(api.call.join.join, { roomId: "another-room", devToken: r.tokens.en }))).toBe("FORBIDDEN");
  });
});

describe("POST /call/phrase (worker → Convex)", () => {
  it("needs the service token; without the env it is disabled", async () => {
    const r = await room();
    expect((await post(r.t, phraseBody(r), null)).status).toBe(401);
    expect((await post(r.t, phraseBody(r), "wrong-token")).status).toBe(401);
    vi.stubEnv("CALL_SERVICE_TOKEN", "");
    expect((await post(r.t, phraseBody(r))).status).toBe(503);
  });

  it("upserts by segId: a higher rev wins, an older or equal one is ignored", async () => {
    const r = await room();
    let res = await post(r.t, phraseBody(r, { rev: 1, translationStatus: { ru: "pending", zh: "pending" }, translations: {} }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true });
    res = await post(r.t, phraseBody(r, { rev: 3 }));
    expect(await res.json()).toEqual({ ok: true, applied: true });
    res = await post(r.t, phraseBody(r, { rev: 2, original: "stale" }));
    expect(await res.json()).toEqual({ ok: true, applied: false });
    res = await post(r.t, phraseBody(r, { rev: 3, original: "same rev" }));
    expect(await res.json()).toEqual({ ok: true, applied: false });
    const rows = await r.t.run((ctx) => ctx.db.query("call_phrases").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rev: 3, original: "We can move 0.2 m/s", translationStatus: { ru: "ok", zh: "ok" }, simulated: true,
      speaker: { userId: r.en.userId, companyId: r.en.companyId, name: "Dispatcher US", identity: `user-${r.en.userId}` } });
  });

  it("rejects bad bodies, foreign segments, unknown speakers and over-long text", async () => {
    const r = await room();
    expect((await post(r.t, "not json")).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { original: "x".repeat(2001) }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { translations: { ru: "x".repeat(2001) } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { values: Array.from({ length: 65 }, (_, i) => ({ placeholder: `p${i}`, kind: "number", text: "1" })) }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { translationStatus: { fr: "ok" } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { rev: 1.5 }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { originalLang: "ru" }))).status).toBe(400); // the speaker speaks English
    expect((await post(r.t, phraseBody(r, { speakerIdentity: "user-nobody", segId: `${r.roomId}:user-nobody:1:1` }))).status).toBe(404);
    expect((await post(r.t, phraseBody(r, { roomId: "elsewhere", segId: `elsewhere:user-${r.en.userId}:1:1` }))).status).toBe(404);
    expect((await post(r.t, phraseBody(r, { errors: { ru: "plain string" } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { translations: [RU], translationStatus: ["ok"] }))).status).toBe(400);
    // an observer does not speak in the call
    expect((await post(r.t, phraseBody(r, { segId: `${r.roomId}:user-${r.observer.userId}:1:1`, speakerIdentity: `user-${r.observer.userId}` }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r))).status).toBe(200);
    // a segment id that does not belong to the speaker or room is refused
    expect((await post(r.t, phraseBody(r, { rev: 2, speakerIdentity: `user-${r.ru.userId}`, originalLang: "ru" }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { segId: "s9" }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { rev: 1_000_001 }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { startedAtMs: 1200 }))).status).toBe(400); // relative ms, not an epoch
    expect((await post(r.t, phraseBody(r, { startedAtMs: Date.now() + 49 * 3600 * 1000 }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { startedAtMs: -1 }))).status).toBe(400);
    // "ok" needs its translation; a translation needs a status; no empty text; the spec placeholder form only
    expect((await post(r.t, phraseBody(r, { rev: 5, translations: { ru: RU } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { rev: 5, translationStatus: { ru: "ok", zh: "ok" }, translations: { ru: "", zh: ZH } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { rev: 5, translationStatus: { ru: "ok" }, translations: { ru: RU, zh: ZH } }))).status).toBe(400);
    expect((await post(r.t, phraseBody(r, { rev: 5, values: [{ placeholder: "[[V1]]", kind: "number", text: "1" }] }))).status).toBe(400);
  });

  it("accepts `token` for the placeholder and a missing kind, stores the spec ProtectedValue", async () => {
    const r = await room();
    expect((await post(r.t, phraseBody(r, { values: [{ token: "\u27e6v1\u27e7", text: "0.2" }] }))).status).toBe(200);
    const [row] = await r.t.run((ctx) => ctx.db.query("call_phrases").collect());
    expect(row.values).toEqual([{ placeholder: "\u27e6v1\u27e7", kind: "number", text: "0.2" }]);
  });
});

describe("call/messages:list (spec §2 Message)", () => {
  it("each viewer reads its own language with the original attached; failed checks show the original", async () => {
    const r = await room();
    await post(r.t, phraseBody(r, { translationStatus: { ru: "ok", zh: "original_only" }, translations: { ru: RU, zh: ZH } }));
    await post(r.t, phraseBody(r, { segId: `${r.roomId}:user-${r.en.userId}:1:2`, original: "Second", translations: {}, translationStatus: { ru: "pending", zh: "pending" }, values: [] }));
    const view = (lang: "en" | "ru" | "zh") => r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens[lang] });
    const [ru1, ru2] = await view("ru");
    expect(ru1).toMatchObject({ kind: "voice", text: RU, originalText: "We can move 0.2 m/s", originalLang: "en", translationStatus: "ok",
      author: { kind: "human", userId: r.en.userId, companyId: r.en.companyId, name: "Dispatcher US", side: null }, refs: {}, form: null,
      values: [{ placeholder: "\u27e6v1\u27e7", kind: "unit", text: "0.2 m/s" }], simulated: true, rev: 1 });
    expect(ru2).toMatchObject({ text: "Second", translationStatus: "pending" });
    const [zh1] = await view("zh");
    expect(zh1).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "original_only" });
    const [en1] = await view("en");
    expect(en1).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "ok" });
    expect(await code(r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: "x".repeat(32) }))).toBe("FORBIDDEN");
  });

  it("a failed language shows the original with the failure; other languages are unaffected", async () => {
    const r = await room();
    await post(r.t, phraseBody(r, { translationStatus: { ru: "ok", zh: "original_only" }, translations: { ru: RU },
      errors: { zh: { code: "PLACEHOLDER_CHECK", message: "a value was dropped" } } }));
    const [zh] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.zh });
    expect(zh).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "original_only",
      translationError: { code: "PLACEHOLDER_CHECK", message: "a value was dropped" } });
    const [ru] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.ru });
    expect(ru).toMatchObject({ text: RU, translationStatus: "ok", translationError: null });
    const [en] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.en });
    expect(en).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "ok", translationError: null });
  });

  it("a listener who joined after the phrase reads the original as not translated; a failed voice is voiceError", async () => {
    const r = await room();
    // only ru was requested (zh joined later); ru text arrived but its voice failed
    await post(r.t, phraseBody(r, { translationStatus: { ru: "ok" }, translations: { ru: RU },
      errors: { ru: { code: "TTS_FAILED", message: "voice provider timeout" } } }));
    const [zh] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.zh });
    expect(zh).toMatchObject({ text: "We can move 0.2 m/s", translationStatus: "original_only",
      translationError: { code: "NOT_TRANSLATED", message: "joined after this phrase" }, voiceError: null });
    const [ru] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.ru });
    expect(ru).toMatchObject({ text: RU, translationStatus: "ok", translationError: null,
      voiceError: { code: "TTS_FAILED", message: "voice provider timeout" } });
    const [en] = await r.t.query(api.call.messages.list, { roomId: r.roomId, devToken: r.tokens.en });
    expect(en).toMatchObject({ translationStatus: "ok", translationError: null, voiceError: null });
  });

  it("filters by event, returns the newest page oldest first", async () => {
    const r = await room();
    for (let i = 1; i <= 5; i++) {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-10-25T01:00:00Z") + i * 1000);
      await post(r.t, phraseBody(r, { segId: `${r.roomId}:user-${r.en.userId}:1:${10 + i}`, original: `p${i}`, eventId: i % 2 ? "ev-odd" : "ev-even" }));
      vi.useRealTimers();
    }
    const page = await r.t.query(api.call.messages.list, { roomId: r.roomId, limit: 2, devToken: r.tokens.ru });
    expect(page.map((m: any) => m.originalText)).toEqual(["p4", "p5"]);
    const odd = await r.t.query(api.call.messages.list, { roomId: r.roomId, eventId: "ev-odd", devToken: r.tokens.ru });
    expect(odd.map((m: any) => m.originalText)).toEqual(["p1", "p3", "p5"]);
  });
});
