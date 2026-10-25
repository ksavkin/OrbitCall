// Shared helpers of the call module: errors (spec §6 codes) and who is calling in which room.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { stillResponsibleForCall } from "../lib/roomCall";

export type CallErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "FEATURE_DISABLED";

export function callError(code: CallErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

export const nowIso = () => new Date(Date.now()).toISOString();

/** Dev tokens are random secrets of at least this length; anything shorter is never looked up. */
export const MIN_DEV_TOKEN = 16;

/**
 * The caller's membership in this room, resolved on the server [ACC-2]: identity subject → call_members. Without
 * sign-in, a secret per-member `devToken` is accepted only with CALL_DEV_IDENTITY=on; a real identity always wins.
 * Language and company come from the row, never from the client.
 */
export async function memberOf(ctx: QueryCtx, roomId: string, devToken?: string): Promise<Doc<"call_members">> {
  const subject = (await ctx.auth.getUserIdentity())?.subject ?? null;
  return memberBy(ctx, roomId, subject, devToken);
}

/** The same resolution with the subject passed in (actions read ctx.auth themselves and call an internal query). */
export async function memberBy(ctx: QueryCtx, roomId: string, subject: string | null, devToken?: string) {
  let member: Doc<"call_members"> | null;
  if (subject) {
    member = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", roomId).eq("subject", subject)).unique();
  } else if (process.env.CALL_DEV_IDENTITY === "on" && devToken && devToken.length >= MIN_DEV_TOKEN) {
    const row = await ctx.db.query("call_members").withIndex("by_dev_token", (q) => q.eq("devToken", devToken)).unique();
    member = row && row.roomId === roomId ? row : null;
  } else {
    return callError("UNAUTHENTICATED", "Sign in first");
  }
  if (!member) return callError("FORBIDDEN", "You are not a member of this room");
  // A provisioned operator (userId is a users id, written by rooms.ts) in a coordination room (a rooms id) follows
  // current responsibility, as rooms.requireMember does: a revoked assignment ends call access. Demo seed members
  // (call/demo.ts: "demo-…" user ids, dev tokens, also when seeded into a rooms id) are not users and keep their rows.
  const room = ctx.db.normalizeId("rooms", roomId), user = ctx.db.normalizeId("users", member.userId);
  if (room && user && !await stillResponsibleForCall(ctx, room, user)) return callError("FORBIDDEN", "You are not a member of this room");
  return member;
}

/** The LiveKit identity of a member; the worker names translated tracks after it (tr:<lang>:<identity>). */
export const identityOf = (member: Pick<Doc<"call_members">, "userId">) => `user-${member.userId}`;
export const roomNameOf = (roomId: string) => `coordination-${roomId}`;
