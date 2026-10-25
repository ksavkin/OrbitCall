import { defineTable } from "convex/server";
import { v } from "convex/values";

// The voice module owns these tables (prefix `call_`): who may join a coordination room's call, presence, and the
// translated phrases the worker writes (spec §5 step 5, §2 Message). The team owns `rooms` and `messages`; `roomId`
// is a string here and becomes the team's Id<"rooms"> at integration.

export const lang = v.union(v.literal("en"), v.literal("ru"), v.literal("zh"));
export const valueKind = v.union(
  v.literal("number"), v.literal("unit"), v.literal("datetime"), v.literal("timezone"), v.literal("object_id"), v.literal("sign"),
);
export const protectedValue = v.object({ placeholder: v.string(), kind: valueKind, text: v.string() });
export const languageStatus = v.union(v.literal("ok"), v.literal("pending"), v.literal("original_only"));
/** Per listener language: a language whose placeholder check failed is "original_only" (shown, not voiced, LANG-2). */
export const translationStatus = v.object({ en: v.optional(languageStatus), ru: v.optional(languageStatus), zh: v.optional(languageStatus) });
export const translations = v.object({ en: v.optional(v.string()), ru: v.optional(v.string()), zh: v.optional(v.string()) });
/** Per language: why a step (STT / translation / voice) failed, shown with the original (livekit-lessons R13). */
export const phraseError = v.object({ code: v.string(), message: v.string() });
export const phraseErrors = v.object({ en: v.optional(phraseError), ru: v.optional(phraseError), zh: v.optional(phraseError) });
export const memberRole = v.union(v.literal("operator"), v.literal("observer"));

export const callTables = {
  // Identity seam until sign-in: identity subject → member of one room, with the language and company that the
  // client never sends [ACC-2]. `devToken`: random secret per member, used only with CALL_DEV_IDENTITY=on.
  call_members: defineTable({
    roomId: v.string(), subject: v.string(), userId: v.string(), companyId: v.string(), name: v.string(), lang,
    role: memberRole, // an observer listens and reads; its token cannot publish (spec §5)
    devToken: v.optional(v.string()), simulated: v.boolean(),
  }).index("by_room", ["roomId", "subject"]).index("by_room_user", ["roomId", "userId"]).index("by_subject", ["subject"])
    .index("by_dev_token", ["devToken"]),
  call_presence: defineTable({
    roomId: v.string(), userId: v.string(), inRoom: v.boolean(), inCall: v.boolean(), updatedAt: v.string(),
  }).index("by_room_user", ["roomId", "userId"]).index("by_in_room_updated", ["inRoom", "updatedAt"]),
  // One row per spoken phrase; the worker upserts it by segId while it is recognized, translated and voiced.
  call_phrases: defineTable({
    roomId: v.string(), eventId: v.union(v.string(), v.null()), segId: v.string(), rev: v.number(),
    speaker: v.object({ userId: v.string(), companyId: v.string(), name: v.string(), identity: v.string() }),
    originalLang: lang, original: v.string(), translations, values: v.array(protectedValue), translationStatus,
    errors: phraseErrors,
    startedAtMs: v.number(), simulated: v.boolean(), createdAt: v.string(), updatedAt: v.string(),
  }).index("by_room_created", ["roomId", "createdAt"]).index("by_room_event_created", ["roomId", "eventId", "createdAt"])
    .index("by_seg", ["segId"]),
};
