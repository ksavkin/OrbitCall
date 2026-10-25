import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ingestEncounter } from "./lib/events";
import { catalogRow, compareQueue, eventRow } from "./lib/queue";
import { runFlags } from "./lib/runs";
import { objectInput } from "./lib/validators";

// Stores one encounter from a registered snapshot. It fetches no catalog data itself.
export const ingest = internalMutation({
  args: {
    snapshotId: v.id("snapshots"), objectA: objectInput, objectB: objectInput,
    tcaUtc: v.string(), missKm: v.number(), relSpeedKmS: v.number(),
    pcValue: v.union(v.number(), v.null()), simulated: v.boolean(),
  },
  returns: v.object({ eventId: v.id("events"), scheduled: v.boolean() }),
  handler: async (ctx, args) => {
    const { eventId, start } = await ingestEncounter(ctx, args);
    if (start) await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    return { eventId, scheduled: start };
  },
});

// A snapshot loads at most ~1000 events (plan D9). Convex allows 4096 db.get/db.query calls per query and
// each returned row costs up to 3 (its run flags and two objects), so rows stop at MAX_ROWS; the scan of
// active events (one index range) stops at MAX_ACTIVE.
const MAX_ACTIVE = 5000, MAX_ROWS = 1200;

// Real pairs for context (spec §3.2), no sign-in in Phase 1. Every active real pair (up to MAX_ROWS), in
// queue order; the frontend filters. `limit` is optional and only trims the result (older clients send 50).
// Reads the stored color and active flag only, so the result changes when the recolor cron writes,
// not as time passes.
export const catalogPairs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(eventRow),
  handler: async (ctx, { limit }) => {
    const n = Math.min(MAX_ROWS, limit !== undefined && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_ROWS);
    const active = await ctx.db.query("events").withIndex("by_active", q => q.eq("active", true)).take(MAX_ACTIVE);
    const top = active.filter(e => !e.simulated).sort(compareQueue).slice(0, n);
    // Join only the returned rows; objects and snapshots are read once each.
    const unique = <T>(items: T[]) => [...new Set(items)];
    const [snapshots, objects] = await Promise.all([
      Promise.all(unique(top.map(e => e.snapshotId)).map(async id => [id, await ctx.db.get(id)] as const)),
      Promise.all(unique(top.flatMap(e => [e.objectAId, e.objectBId])).map(async id => [id, await ctx.db.get(id)] as const)),
    ]);
    const snapshotById = new Map(snapshots), objectById = new Map(objects);
    const rows = await Promise.all(top.map(async event => {
      const [snapshot, a, b] = [snapshotById.get(event.snapshotId), objectById.get(event.objectAId), objectById.get(event.objectBId)];
      return snapshot && a && b ? catalogRow(event, a, b, snapshot, await runFlags(ctx, event._id)) : null;
    }));
    return rows.filter(row => row !== null);
  },
});
