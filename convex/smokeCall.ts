/**
 * Shared LiveKit room + cross-laptop invite for the product recording.
 * Needs CALL_DEV_IDENTITY=on and LIVEKIT_* on the Convex deployment.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { callError } from "./call/core";

export const SMOKE_ROOM_ID = "smoke-trilateral";
const INVITE_SLOT = "live";

const MEMBERS = [
  { key: "en" as const, lang: "en" as const, name: "Alex Carter", companyId: "asd", userId: "demo-us", voice: "female" as const },
  { key: "ru" as const, lang: "ru" as const, name: "Irina Volkova", companyId: "sever", userId: "demo-ru", voice: "male" as const },
  { key: "zh" as const, lang: "zh" as const, name: "Wei Zhang", companyId: "jade", userId: "demo-cn", voice: "female" as const },
];

/** Stable tokens so every laptop joins the same room without reseeding. */
const TOKENS: Record<(typeof MEMBERS)[number]["key"], string> = {
  en: "smokeus000000000000000000000001",
  ru: "smokeru000000000000000000000001",
  zh: "smokecn000000000000000000000001",
};

export const ensureRoom = mutation({
  args: { who: v.union(v.literal("en"), v.literal("ru"), v.literal("zh")) },
  returns: v.object({ roomId: v.string(), devToken: v.string(), lang: v.union(v.literal("en"), v.literal("ru"), v.literal("zh")) }),
  handler: async (ctx, { who }) => {
    if (process.env.CALL_DEV_IDENTITY !== "on") {
      callError("FEATURE_DISABLED", "Live coordination needs CALL_DEV_IDENTITY=on on this deployment");
    }
    const existing = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", SMOKE_ROOM_ID)).collect();
    for (const m of MEMBERS) {
      const token = TOKENS[m.key];
      const row =
        existing.find((e) => e.devToken === token) ??
        existing.find((e) => e.userId === m.userId) ??
        existing.find((e) => e.subject === `smoke|${m.key}`);
      if (!row) {
        await ctx.db.insert("call_members", {
          roomId: SMOKE_ROOM_ID,
          subject: `smoke|${m.key}`,
          userId: m.userId,
          companyId: m.companyId,
          name: m.name,
          lang: m.lang,
          role: "operator",
          voice: m.voice,
          devToken: token,
          simulated: true,
        });
      } else {
        const patch: { voice?: "male" | "female"; lang?: "en" | "ru" | "zh"; name?: string; devToken?: string; subject?: string } = {};
        if (row.voice !== m.voice) patch.voice = m.voice;
        if (row.lang !== m.lang) patch.lang = m.lang;
        if (row.name !== m.name) patch.name = m.name;
        if (row.devToken !== token) patch.devToken = token;
        if (row.subject !== `smoke|${m.key}`) patch.subject = `smoke|${m.key}`;
        if (Object.keys(patch).length) await ctx.db.patch(row._id, patch);
      }
    }
    return { roomId: SMOKE_ROOM_ID, devToken: TOKENS[who], lang: who };
  },
});

const inviteDoc = v.object({
  eventId: v.string(),
  pair: v.string(),
  hostUserId: v.string(),
  eventJson: v.string(),
  openedAt: v.number(),
});

/** Host publishes the open case so CN / RU laptops see the invite toast. */
export const publishInvite = mutation({
  args: {
    eventId: v.string(),
    pair: v.string(),
    hostUserId: v.string(),
    eventJson: v.string(),
  },
  returns: inviteDoc,
  handler: async (ctx, args) => {
    const openedAt = Date.now();
    const existing = await ctx.db.query("smokeInvites").withIndex("by_slot", (q) => q.eq("slot", INVITE_SLOT)).collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("smokeInvites", { slot: INVITE_SLOT, ...args, openedAt });
    return { ...args, openedAt };
  },
});

/** Active invite for guest laptops (reactive). */
export const activeInvite = query({
  args: {},
  returns: v.union(inviteDoc, v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("smokeInvites").withIndex("by_slot", (q) => q.eq("slot", INVITE_SLOT)).first();
    if (!row) return null;
    return {
      eventId: row.eventId,
      pair: row.pair,
      hostUserId: row.hostUserId,
      eventJson: row.eventJson,
      openedAt: row.openedAt,
    };
  },
});
