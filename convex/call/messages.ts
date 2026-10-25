// Call captions for the room (spec §5 step 5, §2 Message): every phrase in the viewer's language with the original
// attached. Members of the room only; the viewer's language comes from the member row.

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { callError, memberOf } from "./core";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

type Lang = Doc<"call_members">["lang"];

/** A language the worker never translated this phrase into: the listener joined after it was spoken. */
export const NOT_TRANSLATED = { code: "NOT_TRANSLATED", message: "joined after this phrase" };

/**
 * The phrase as the viewer reads it. The viewer's own language → the original, "ok". A translated language → its
 * text when the check passed ("ok"; ingest guarantees the text exists), else the original with "pending" or
 * "original_only". A language with no status at all was never requested (the listener joined later): original_only
 * with NOT_TRANSLATED, never an endless "pending". `voiceError`: the text arrived but its voice failed (R13).
 */
export function forViewer(p: Doc<"call_phrases">, viewerLang: Lang) {
  const own = viewerLang === p.originalLang;
  const requested = own || p.translationStatus[viewerLang] !== undefined;
  const status = own ? "ok" : (p.translationStatus[viewerLang] ?? "original_only");
  const text = !own && status === "ok" ? p.translations[viewerLang]! : p.original;
  const error = own ? null : (p.errors[viewerLang] ?? null);
  return {
    messageId: p._id, roomId: p.roomId, eventId: p.eventId, at: p.createdAt,
    author: { kind: "human" as const, userId: p.speaker.userId, companyId: p.speaker.companyId, name: p.speaker.name, side: null },
    kind: "voice" as const, text, originalText: p.original, originalLang: p.originalLang, translationStatus: status,
    values: p.values, refs: {}, form: null, simulated: p.simulated, segId: p.segId, rev: p.rev,
    // why this language shows the original: a failed check, a failed step, or never requested
    translationError: status !== "original_only" ? null : requested ? error : NOT_TRANSLATED,
    voiceError: status === "ok" ? error : null,
  };
}

export const list = query({
  args: { roomId: v.string(), eventId: v.optional(v.string()), limit: v.optional(v.number()), devToken: v.optional(v.string()) },
  handler: async (ctx, { roomId, eventId, limit, devToken }) => {
    const viewer = await memberOf(ctx, roomId, devToken);
    if (limit !== undefined && !Number.isFinite(limit)) callError("VALIDATION", "limit must be a number");
    const n = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const rows = eventId
      ? await ctx.db.query("call_phrases").withIndex("by_room_event_created", (q) => q.eq("roomId", roomId).eq("eventId", eventId)).order("desc").take(n)
      : await ctx.db.query("call_phrases").withIndex("by_room_created", (q) => q.eq("roomId", roomId)).order("desc").take(n);
    return rows.reverse().map((p) => forViewer(p, viewer.lang)); // the newest page, oldest first
  },
});
