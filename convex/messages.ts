import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActiveMember, requireMember, roomTurns } from "./rooms";
import { lang, languageStatus, protectedValue } from "./schema/call";
import { messageAuthor, messageKind, summaryForm } from "./schema/rooms";

// Room text lines (spec §3.4 messages.send / messages.list, ROOM-6, LANG-7) on the round 1.5 `messages` table. send
// stores the original at once and arms a trailing debounce (roadmap §6: a final human message triggers the host).
// A burst of lines schedules several debounces, and only the latest human line starts one host request, so a burst
// does not start several Gemini and Grok pipelines that are then discarded as superseded. No model is called here.
// Only human lines trigger: agent and system lines are written elsewhere and never schedule a host run, so the host
// cannot loop on its own output. A line can never stand in for an approval (ROOM-7).

export const MAX_TEXT = 2000;
export const HOST_DEBOUNCE_MS = 5000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

type Lang = Doc<"messages">["originalLang"];

export const messageView = v.object({
  messageId: v.id("messages"), roomId: v.id("rooms"), eventId: v.union(v.id("events"), v.null()), at: v.string(),
  author: messageAuthor, kind: messageKind,
  text: v.string(), originalText: v.string(), originalLang: lang, translationStatus: languageStatus,
  values: v.array(protectedValue),
  refs: v.object({ eventId: v.optional(v.id("events")), proposalId: v.optional(v.id("proposals")), revision: v.optional(v.number()) }),
  form: v.union(summaryForm, v.null()), simulated: v.boolean(),
});

/**
 * A line as one viewer reads it (spec §2.4). The viewer's own language reads the original as "ok"; a translated
 * language reads its text once its check passed; a language never requested reads the original as "original_only",
 * never an endless "pending" (NOT_TRANSLATED in call/messages.ts).
 */
export function toMessage(row: Doc<"messages">, viewerLang: Lang) {
  const own = viewerLang === row.originalLang;
  const status = own ? "ok" as const : row.translationStatus[viewerLang] ?? "original_only" as const;
  return {
    messageId: row._id, roomId: row.roomId, eventId: row.eventId, at: new Date(row.createdAt).toISOString(),
    author: row.author, kind: row.kind,
    text: !own && status === "ok" ? row.translations[viewerLang] ?? row.originalText : row.originalText,
    originalText: row.originalText, originalLang: row.originalLang, translationStatus: status,
    values: row.values, refs: row.refs, form: row.form, simulated: row.simulated,
  };
}

/** Posts a line in an open room. Operators only; the author comes from the caller's rows, never the client (ACC-2). */
export const send = mutation({
  args: {
    roomId: v.id("rooms"), eventId: v.optional(v.id("events")), text: v.string(),
    refs: v.optional(v.object({ proposalId: v.id("proposals"), revision: v.number() })),
  },
  returns: v.object({ messageId: v.id("messages") }),
  handler: async (ctx, { roomId, eventId, text, refs }) => {
    const { scope, room, pairs } = await requireActiveMember(ctx, roomId);
    const { user, company } = scope;
    // Decision turns: everyone discusses before a decision opens; while one is open, only the side in turn writes.
    // A line about one incident needs the turn on that incident; a room-wide line needs it on every open decision.
    const outOfTurn = (await roomTurns(ctx, scope, pairs, true))
      .filter(e => e.deciding && !e.myTurn && (eventId === undefined || e.eventId === eventId));
    if (outOfTurn.length) {
      throw new ConvexError({ code: "INVALID_STATE", message: `Side ${outOfTurn[0].turn} is deciding; wait for your turn.` });
    }
    const original = text.trim();
    if (!original || original.length > MAX_TEXT) throw new ConvexError({ code: "VALIDATION", message: "A message must be 1 to 2000 characters." });
    // A line is filed only under an incident of this room; the room is the privacy boundary (ROOM-15).
    const linked = new Set(pairs.map(p => p.event._id));
    if (eventId !== undefined && !linked.has(eventId)) throw new ConvexError({ code: "VALIDATION", message: "That event is not part of this room." });
    if (refs) {
      const proposal = await ctx.db.get(refs.proposalId);
      if (!proposal || !linked.has(proposal.eventId)) throw new ConvexError({ code: "VALIDATION", message: "That proposal is not part of this room." });
    }
    const messageId = await ctx.db.insert("messages", {
      roomId: room._id, eventId: eventId ?? null,
      // The provisioned name, else the company's; the stored author needs a display name (schema/rooms.ts).
      author: { kind: "human", userId: user._id, companyId: company._id, name: user.name ?? company.name },
      kind: "text", originalText: original, originalLang: user.language ?? company.language ?? "en",
      translations: {}, translationStatus: {}, values: [],
      refs: { ...(eventId === undefined ? {} : { eventId }), ...(refs ?? {}) }, form: null,
      demoRunId: room.demoRunId, simulated: room.simulated || company.simulated, createdAt: Date.now(),
    });
    // Queued only if this write commits. hostDebounce asks for the host only when this line is still the latest
    // human text in the room. request then reads the input version itself, dedupes by room, input version and
    // trigger, and returns null for a closed room or a reset demo run (hostTriggers.ts).
    await ctx.scheduler.runAfter(HOST_DEBOUNCE_MS, internal.messages.hostDebounce, { roomId: room._id, messageId });
    return { messageId };
  },
});

// The latest human text line in the room, read through by_room_created. Agent and system lines do not count.
async function latestHumanText(ctx: MutationCtx, roomId: Id<"rooms">) {
  for await (const row of ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", roomId)).order("desc")) {
    if (row.kind === "text" && row.author.kind === "human") return row;
  }
  return null;
}

/** After the trailing debounce, starts one host request if this line is still the room's latest human text. */
export const hostDebounce = internalMutation({
  args: { roomId: v.id("rooms"), messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, { roomId, messageId }) => {
    const latest = await latestHumanText(ctx, roomId);
    if (!latest || latest._id !== messageId) return null;
    await ctx.scheduler.runAfter(0, internal.hostTriggers.request, { roomId, trigger: "final_message" });
    return null;
  },
});

/** The newest page of a room's lines, oldest first; `before` (ISO time) pages older lines. Any member reads. */
export const list = query({
  args: { roomId: v.id("rooms"), eventId: v.optional(v.id("events")), before: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(messageView),
  handler: async (ctx, { roomId, eventId, before, limit }) => {
    const { scope: { user, company } } = await requireMember(ctx, roomId);
    if (limit !== undefined && !Number.isFinite(limit)) throw new ConvexError({ code: "VALIDATION", message: "limit must be a number." });
    const beforeMs = before === undefined ? undefined : Date.parse(before);
    if (beforeMs !== undefined && Number.isNaN(beforeMs)) throw new ConvexError({ code: "VALIDATION", message: "before must be an ISO 8601 time." });
    const n = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const rows = eventId !== undefined
      ? await ctx.db.query("messages").withIndex("by_room_event_created", q => {
        const range = q.eq("roomId", roomId).eq("eventId", eventId);
        return beforeMs === undefined ? range : range.lt("createdAt", beforeMs);
      }).order("desc").take(n)
      : await ctx.db.query("messages").withIndex("by_room_created", q => {
        const range = q.eq("roomId", roomId);
        return beforeMs === undefined ? range : range.lt("createdAt", beforeMs);
      }).order("desc").take(n);
    return rows.reverse().map(row => toMessage(row, user.language ?? company.language ?? "en"));
  },
});
