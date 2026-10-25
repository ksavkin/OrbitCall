// Room presence (spec §3.4 rooms.join / rooms.leave / rooms.setInCall, scoped to the call): "has B joined",
// "B is in the call". The client calls join on the room screen and setInCall on LiveKit connect / disconnect, and
// repeats the current one every HEARTBEAT_MS (beforeunload is unreliable). Staleness is not computed in the query
// (a query is not re-run by the clock): list returns updatedAt and the client treats a row older than STALE_MS as
// absent; expireStale (internal, for a cron) clears such rows for everyone.

import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { memberOf, nowIso } from "./core";

async function upsert(ctx: MutationCtx, roomId: string, devToken: string | undefined, patch: { inRoom?: boolean; inCall?: boolean }) {
  const member = await memberOf(ctx, roomId, devToken);
  const row = await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId).eq("userId", member.userId)).unique();
  const next = { inRoom: patch.inRoom ?? row?.inRoom ?? false, inCall: patch.inCall ?? row?.inCall ?? false };
  if (next.inCall) next.inRoom = true; // being in the call means being in the room
  if (row) {
    // A repeated join / setInCall(true) is the heartbeat: it refreshes updatedAt even when nothing changed.
    if (row.inRoom !== next.inRoom || row.inCall !== next.inCall || patch.inCall === true || patch.inRoom === true) {
      await ctx.db.patch(row._id, { ...next, updatedAt: nowIso() });
    }
  } else {
    await ctx.db.insert("call_presence", { roomId, userId: member.userId, ...next, updatedAt: nowIso() });
  }
  return null;
}

const args = { roomId: v.string(), devToken: v.optional(v.string()) };

export const join = mutation({ args, handler: (ctx, a) => upsert(ctx, a.roomId, a.devToken, { inRoom: true }) });

/** Leaving the room also leaves the call. */
export const leave = mutation({ args, handler: (ctx, a) => upsert(ctx, a.roomId, a.devToken, { inRoom: false, inCall: false }) });

export const setInCall = mutation({
  args: { ...args, inCall: v.boolean() },
  handler: (ctx, a) => upsert(ctx, a.roomId, a.devToken, { inCall: a.inCall }),
});

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 75_000;

/** The room's members with their stored presence. The client applies STALE_MS to updatedAt on its own clock. */
export const list = query({
  args,
  handler: async (ctx, { roomId, devToken }) => {
    await memberOf(ctx, roomId, devToken);
    const members = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    const rows = await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId)).collect();
    return members.map((m) => {
      const p = rows.find((r) => r.userId === m.userId);
      return { userId: m.userId, name: m.name, companyId: m.companyId, language: m.lang, role: m.role,
        inRoom: !!p?.inRoom, inCall: !!p?.inCall, updatedAt: p?.updatedAt ?? null, heartbeatMs: HEARTBEAT_MS, staleMs: STALE_MS };
    });
  },
});

export const EXPIRE_BATCH = 500;

/**
 * Clears presence without a heartbeat for STALE_MS, in one room or (no roomId) everywhere, at most EXPIRE_BATCH rows
 * per run; idempotent. For a team cron that knows no room ids:
 *   crons.interval("expire stale call presence", { minutes: 1 }, internal.call.presence.expireStale, {})
 * `inCall` implies `inRoom`, so the rows still marked present are exactly the inRoom = true range of the index.
 */
export const expireStale = internalMutation({
  args: { roomId: v.optional(v.string()) },
  handler: async (ctx, { roomId }) => {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString(); // ISO UTC strings order like the instants
    const stale = roomId
      ? (await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId)).collect())
        .filter((r) => (r.inRoom || r.inCall) && r.updatedAt < cutoff)
      : await ctx.db.query("call_presence").withIndex("by_in_room_updated", (q) => q.eq("inRoom", true).lt("updatedAt", cutoff)).take(EXPIRE_BATCH);
    for (const r of stale) await ctx.db.patch(r._id, { inRoom: false, inCall: false, updatedAt: nowIso() });
    return stale.length;
  },
});
