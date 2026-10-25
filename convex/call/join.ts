// call.join (spec §3.4, §5 step 1): a 2-hour LiveKit token for this coordination room, with the member's language
// and company as signed participant attributes. The room name is `coordination-<roomId>`, the identity
// `user-<userId>`; the worker publishes `tr:<lang>:<identity>` tracks for it.

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { callError, identityOf, memberBy, roomNameOf } from "./core";
import { mintLiveKitToken } from "./livekitToken";

export const TOKEN_TTL_S = 2 * 3600;

export const memberForJoin = internalQuery({
  args: { roomId: v.string(), subject: v.union(v.string(), v.null()), devToken: v.optional(v.string()) },
  handler: (ctx, { roomId, subject, devToken }) => memberBy(ctx, roomId, subject, devToken),
});
const memberRef = makeFunctionReference<"query", { roomId: string; subject: string | null; devToken?: string }, Doc<"call_members">>(
  "call/join:memberForJoin");

export const join = action({
  args: { roomId: v.string(), devToken: v.optional(v.string()) },
  handler: async (ctx, { roomId, devToken }) => {
    const subject = (await ctx.auth.getUserIdentity())?.subject ?? null;
    const member = await ctx.runQuery(memberRef, { roomId, subject, devToken });
    const serverUrl = process.env.LIVEKIT_URL, apiKey = process.env.LIVEKIT_API_KEY, apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!serverUrl || !apiKey || !apiSecret) callError("FEATURE_DISABLED", "Voice calls are not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
    const identity = identityOf(member);
    const roomName = roomNameOf(roomId);
    const token = await mintLiveKitToken({
      apiKey, apiSecret, identity, name: member.name, room: roomName,
      attributes: { lang: member.lang, companyId: member.companyId }, ttlS: TOKEN_TTL_S, nowS: Math.floor(Date.now() / 1000),
      canPublish: member.role === "operator", agentName: process.env.LIVEKIT_AGENT_NAME || "orbit-translator",
    });
    return { serverUrl, token, roomName, identity, language: member.lang, role: member.role };
  },
});
