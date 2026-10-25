// Room presence (spec §3.4 rooms.join / rooms.leave / rooms.setInCall, scoped to the call): "has B joined",
// "B is in the call". The client calls join on the room screen and setInCall on LiveKit connect / disconnect, and
// repeats the current one every HEARTBEAT_MS (beforeunload is unreliable). Staleness is not computed in the query
// (a query is not re-run by the clock): list returns updatedAt and the client treats a row older than STALE_MS as
// absent; expireStale clears such rows: each heartbeat in the call schedules it for its room, and a team cron may sweep
// every room. When the last operator leaves the call (leave, setInCall(false) or expiry) and nobody returns within
// CALL_END_GRACE_MS, the room's Coordination Host is asked for a call_ended run (issue #6).

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { memberOf, nowIso } from "./core";

type HostTrigger = "final_message" | "call_ended";
// Addressed by path like the call module's other references; the team's hostTriggers.request dedupes per input version.
const hostRequestRef = makeFunctionReference<"mutation", { roomId: Id<"rooms">; trigger: HostTrigger }, Id<"hostRuns"> | null>(
  "hostTriggers:request");

/**
 * Schedules a Coordination Host run for the team room behind a call room. Only a call room keyed by an existing
 * rooms id (rooms.startWorkflow provisions String(room._id)) has a host; a demo room (demo-<hex>) is skipped. Never
 * throws: a presence or phrase write must not fail because the host could not be asked.
 */
export async function requestHost(ctx: MutationCtx, roomId: string, trigger: HostTrigger) {
  try {
    const teamRoomId = ctx.db.normalizeId("rooms", roomId);
    if (!teamRoomId || !(await ctx.db.get(teamRoomId))) return;
    await ctx.scheduler.runAfter(0, hostRequestRef, { roomId: teamRoomId, trigger });
  } catch {
    // The hook is best effort: the write that called it stands.
  }
}

const staleCutoff = () => new Date(Date.now() - STALE_MS).toISOString(); // ISO UTC strings order like the instants

/** Whether an operator of the room is still in the call; observers never count, a row without a heartbeat is absent. */
async function operatorInCall(ctx: MutationCtx, roomId: string) {
  const cutoff = staleCutoff();
  const rows = await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId)).collect();
  const present = new Set(rows.filter((r) => r.inCall && r.updatedAt >= cutoff).map((r) => r.userId));
  if (!present.size) return false;
  const members = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
  return members.some((m) => m.role === "operator" && present.has(m.userId));
}

export const CALL_END_GRACE_MS = 15_000;
const confirmRef = makeFunctionReference<"mutation", { roomId: string }, null>("call/presence:confirmCallEnded");
const expireRef = makeFunctionReference<"mutation", { roomId?: string }, number>("call/presence:expireStale");

/** No operator left in the call: confirm the end after the grace, so a LiveKit reconnect does not end the call. */
async function endIfLast(ctx: MutationCtx, roomId: string) {
  try {
    if (!(await operatorInCall(ctx, roomId))) await ctx.scheduler.runAfter(CALL_END_GRACE_MS, confirmRef, { roomId });
  } catch {
    // Best effort, like requestHost: the presence write that called it stands.
  }
}

/** call_ended once the room still has no operator in the call after the grace; a returned operator cancels it. */
export const confirmCallEnded = internalMutation({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    try {
      if (!(await operatorInCall(ctx, roomId))) await requestHost(ctx, roomId, "call_ended");
    } catch {
      // Best effort, like the other hooks: a failed check ends nothing.
    }
    return null;
  },
});

// The room's own expiry check, one per write that refreshes an in-call row: while heartbeats continue it finds nothing; the one after
// the last heartbeat clears the row and ends the call, with or without a team cron.
async function scheduleExpiry(ctx: MutationCtx, roomId: string) {
  try {
    await ctx.scheduler.runAfter(STALE_MS + 1_000, expireRef, { roomId });
  } catch {
    // Best effort: a missed check leaves the row to the next heartbeat's check or a sweep.
  }
}

async function upsert(ctx: MutationCtx, roomId: string, devToken: string | undefined, patch: { inRoom?: boolean; inCall?: boolean }) {
  const member = await memberOf(ctx, roomId, devToken);
  const row = await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId).eq("userId", member.userId)).unique();
  const next = { inRoom: patch.inRoom ?? row?.inRoom ?? false, inCall: patch.inCall ?? row?.inCall ?? false };
  if (next.inCall) next.inRoom = true; // being in the call means being in the room
  let wrote = !row;
  if (row) {
    // A repeated join / setInCall(true) is the heartbeat: it refreshes updatedAt even when nothing changed.
    if (row.inRoom !== next.inRoom || row.inCall !== next.inCall || patch.inCall === true || patch.inRoom === true) {
      await ctx.db.patch(row._id, { ...next, updatedAt: nowIso() });
      wrote = true;
    }
  } else {
    await ctx.db.insert("call_presence", { roomId, userId: member.userId, ...next, updatedAt: nowIso() });
  }
  // The leaver's own heartbeat age is ignored: a stored inCall is the call it is leaving, and a stale row that
  // expireStale already cleared reads inCall = false here, so the end is requested once.
  if (row?.inCall && !next.inCall && member.role === "operator") await endIfLast(ctx, roomId);
  // Every write that refreshes an in-call row schedules its check, join's carry-over included: otherwise a tab that
  // dies between a beat's join and its setInCall(true) leaves a fresh row that no check outlives. Two checks per web
  // beat (join + setInCall) is the accepted cost; each is one indexed room read.
  if (next.inCall && wrote) await scheduleExpiry(ctx, roomId);
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
 * per run; idempotent. Each heartbeat in the call schedules the room form. An optional global sweep for a team cron:
 *   crons.interval("expire stale call presence", { minutes: 1 }, internal.call.presence.expireStale, {})
 * `inCall` implies `inRoom`, so the rows still marked present are exactly the inRoom = true range of the index.
 */
export const expireStale = internalMutation({
  args: { roomId: v.optional(v.string()) },
  handler: async (ctx, { roomId }) => {
    const cutoff = staleCutoff();
    const stale = roomId
      ? (await ctx.db.query("call_presence").withIndex("by_room_user", (q) => q.eq("roomId", roomId)).collect())
        .filter((r) => (r.inRoom || r.inCall) && r.updatedAt < cutoff)
      : await ctx.db.query("call_presence").withIndex("by_in_room_updated", (q) => q.eq("inRoom", true).lt("updatedAt", cutoff)).take(EXPIRE_BATCH);
    for (const r of stale) await ctx.db.patch(r._id, { inRoom: false, inCall: false, updatedAt: nowIso() });
    // By the staleness rule the call already ended when the last heartbeat aged out; the expiry is when the server
    // notices. One check per room that lost an operator from the call.
    const rooms = new Set<string>();
    try {
      for (const r of stale) {
        if (!r.inCall || rooms.has(r.roomId)) continue;
        const m = await ctx.db.query("call_members").withIndex("by_room_user", (q) => q.eq("roomId", r.roomId).eq("userId", r.userId)).first();
        if (m?.role === "operator") rooms.add(r.roomId);
      }
    } catch {
      // The expiry stands even if the end check cannot run.
    }
    for (const id of rooms) await endIfLast(ctx, id);
    return stale.length;
  },
});
