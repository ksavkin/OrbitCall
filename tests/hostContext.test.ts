import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { buildHostContext } from "../convex/lib/hostContext";
import { MAX_MESSAGES } from "../convex/lib/host";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { backend, insertEvent, type Backend } from "./helpers";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());

async function setup(t: Backend) {
  const eventId = await insertEvent(t);
  return t.run(async ctx => {
    const companyId = await ctx.db.insert("companies", { key: "voice-a", name: "Voice A", simulated: true });
    const userId = await ctx.db.insert("users", { tokenIdentifier: "voice-a", companyId, role: "operator", name: "Voice operator", language: "ru" });
    await ctx.db.insert("satelliteOwners", { objectId: redEvent.objectA.objectId, companyId });
    const assignmentId = await ctx.db.insert("fleetAssignments", { userId, objectId: redEvent.objectA.objectId, active: true });
    const roomId = await ctx.db.insert("rooms", { state: "open", companyIds: [companyId], demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null });
    await ctx.db.insert("roomEvents", { roomId, eventId, linkedAt: FIXTURE_NOW });
    await ctx.db.insert("roomMembers", { roomId, userId, companyId, inRoom: false, inCall: false, updatedAt: FIXTURE_NOW });
    return { roomId, eventId, companyId, userId, assignmentId };
  });
}
type Room = Awaited<ReturnType<typeof setup>>;
async function phrase(t: Backend, r: Room, minute: number, patch: Partial<Omit<Doc<"call_phrases">, "_id" | "_creationTime">> = {}) {
  const at = new Date(FIXTURE_NOW + minute * 60_000).toISOString();
  return t.run(ctx => ctx.db.insert("call_phrases", {
    roomId: r.roomId, eventId: r.eventId, segId: `${r.roomId}:user-${r.userId}:test:${minute}`, rev: 2,
    speaker: { userId: r.userId, companyId: r.companyId, name: "Voice operator", identity: `user-${r.userId}` },
    originalLang: "ru", original: "Предпочитаю подождать.", translations: { en: "I prefer to wait." },
    translationStatus: { en: "ok" }, errors: {}, values: [], startedAtMs: FIXTURE_NOW + minute * 60_000,
    simulated: true, createdAt: at, updatedAt: at, ...patch,
  }));
}
async function typed(t: Backend, r: Room, minute: number, host = false) {
  return t.run(ctx => ctx.db.insert("messages", { roomId: r.roomId, eventId: r.eventId,
    author: host ? { kind: "agent", role: "coordination_host", companyId: null } : { kind: "human", userId: r.userId, companyId: r.companyId, name: "Voice operator" },
    kind: "text", originalText: host ? "Host output" : "Typed preference", originalLang: "en", translations: {}, translationStatus: {}, values: [], refs: {}, form: null,
    demoRunId: null, simulated: true, createdAt: FIXTURE_NOW + minute * 60_000 }));
}
const context = (t: Backend, roomId: Id<"rooms">) => t.run(async ctx => buildHostContext(ctx, (await ctx.db.get(roomId))!, "final_message"));

describe("final voice phrases in Host context", () => {
  it("merges typed and spoken originals chronologically with real source IDs, even after the speaker leaves", async () => {
    const t = backend(), r = await setup(t);
    const a = await typed(t, r, 1), b = await phrase(t, r, 2), c = await typed(t, r, 3);
    await typed(t, r, 4, true);
    const result = await context(t, r.roomId);
    expect(result.messages.map(m => m.messageId)).toEqual([a, b, c]);
    expect(result.messages[1]).toEqual({ messageId: b, companyId: r.companyId, language: "ru", text: "Предпочитаю подождать.", createdAt: new Date(FIXTURE_NOW + 120_000).toISOString().replace(".000Z", "Z") });
    expect(JSON.stringify(result)).not.toContain("I prefer to wait.");
  });
  it.each([
    { rev: 1, translationStatus: {} },
    { rev: 2, translationStatus: { en: "pending" as const } },
  ])("does not include pending worker rows: %j", async patch => {
    const t = backend(), r = await setup(t);
    await phrase(t, r, 1, patch);
    expect((await context(t, r.roomId)).messages).toEqual([]);
  });
  it("includes original-only failures and does not duplicate a later voice-error revision", async () => {
    const t = backend(), r = await setup(t);
    const id = await phrase(t, r, 1, { translations: {}, translationStatus: { en: "original_only" }, errors: { en: { code: "VALUE_CHECK_FAILED", message: "Unavailable" } } });
    const before = await context(t, r.roomId);
    await t.run(ctx => ctx.db.patch(id, { rev: 3, updatedAt: new Date(FIXTURE_NOW + 180_000).toISOString(), errors: { en: { code: "TTS_FAILED", message: "Unavailable" } } }));
    const after = await context(t, r.roomId);
    expect(after.messages).toHaveLength(1);
    expect(after.inputVersion).toBe(before.inputVersion);
    await t.run(ctx => ctx.db.patch(id, { rev: 4, original: "Исправление предпочтения." }));
    expect((await context(t, r.roomId)).inputVersion).not.toBe(before.inputVersion);
  });
  it.each(["observer", "revoked", "company", "identity", "foreign_event", "simulation", "before_room", "foreign_room"])("excludes unauthorized or mismatched %s phrases", async bad => {
    const t = backend(), r = await setup(t);
    const id = await phrase(t, r, 1);
    await t.run(async ctx => {
      if (bad === "observer") await ctx.db.patch(r.userId, { role: "demo_observer" });
      if (bad === "revoked") await ctx.db.patch(r.assignmentId, { active: false });
      if (bad === "company") await ctx.db.patch(id, { speaker: { userId: r.userId, companyId: "foreign", name: "Fake", identity: `user-${r.userId}` } });
      if (bad === "identity") await ctx.db.patch(id, { speaker: { userId: r.userId, companyId: r.companyId, name: "Fake", identity: "host:ru" } });
      if (bad === "foreign_event") await ctx.db.patch(id, { eventId: "unlinked" });
      if (bad === "simulation") await ctx.db.patch(id, { simulated: false });
      if (bad === "before_room") await ctx.db.patch(id, { startedAtMs: FIXTURE_NOW - 1 });
      if (bad === "foreign_room") await ctx.db.patch(id, { roomId: "other-room" });
    });
    expect((await context(t, r.roomId)).messages).toEqual([]);
  });
  it("keeps one shared recent-message limit across both channels", async () => {
    const t = backend(), r = await setup(t);
    const ids: string[] = [];
    for (let i = 1; i <= MAX_MESSAGES + 4; i++) ids.push(i % 2 ? await typed(t, r, i) : await phrase(t, r, i));
    expect((await context(t, r.roomId)).messages.map(m => m.messageId)).toEqual(ids.slice(-MAX_MESSAGES));
  });
  it("includes active understood entries in freshness without reading corrected history", async () => {
    const t = backend(), r = await setup(t), source = await typed(t, r, 1);
    const before = await context(t, r.roomId);
    const id = await t.run(ctx => ctx.db.insert("understood", { roomId: r.roomId, eventId: r.eventId, kind: "preference", hard: false, text: "Prefer to wait", originalLang: "en", side: "A", sourceMessageId: source, status: "active", correctedById: null, hostRunId: null, demoRunId: null, createdAt: FIXTURE_NOW }));
    const result = await context(t, r.roomId) as Awaited<ReturnType<typeof context>> & { understood: { understoodId: string; text: string }[] };
    expect(result.understood).toEqual([expect.objectContaining({ understoodId: id, text: "Prefer to wait" })]);
    expect(result.inputVersion).not.toBe(before.inputVersion);
    await t.run(ctx => ctx.db.patch(id, { status: "corrected" }));
    expect((await context(t, r.roomId)).inputVersion).toBe(before.inputVersion);
  });
});
