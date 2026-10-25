import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { AnalystError } from "./lib/analyst";
import { ingestEncounter, sameSources, TCA_MATCH_MS } from "./lib/events";
import { supersede } from "./lib/runs";
import { objectInput, sourceRef } from "./lib/validators";
import { invalidateEventApprovals } from "./lib/approvalState";

// Bulk loading of a pinned catalog snapshot (scripts/load_snapshot.mjs). Rows are real, never simulated,
// and never start the Analyst: the recolor step does.
const pair = v.object({
  objectA: objectInput, objectB: objectInput,
  tcaUtc: v.string(), missKm: v.number(), relSpeedKmS: v.number(),
  pcValue: v.union(v.number(), v.null()),
});

// `ommUrl` is not evidence: changing it never reruns the Analyst.
export const register = internalMutation({
  args: { snapshotId: v.string(), sources: v.array(sourceRef), ommUrl: v.optional(v.string()) },
  returns: v.id("snapshots"),
  handler: async (ctx, { snapshotId, sources, ommUrl }) => {
    if (snapshotId.startsWith("fixture:")) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "The fixture: prefix is reserved for development fixtures." });
    }
    const stored = await ctx.db.query("snapshots").withIndex("by_snapshot_id", q => q.eq("snapshotId", snapshotId)).unique();
    if (!stored) return ctx.db.insert("snapshots", { snapshotId, sources, ommUrl });
    const sourcesChanged = !sameSources(stored.sources, sources);
    const orbitChanged = stored.ommUrl !== ommUrl;
    if (sourcesChanged) await ctx.db.patch(stored._id, { sources });
    if (orbitChanged) await ctx.db.patch(stored._id, { ommUrl });
    // The Analyst ignores a URL-only change; approval authorization still pins the orbital catalog it identifies.
    if (sourcesChanged || orbitChanged) {
      for await (const set of ctx.db.query("candidateSets")) {
        const event = await ctx.db.get(set.eventId);
        if (event?.snapshotId === stored._id) await invalidateEventApprovals(ctx, event, "evidence_changed");
      }
    }
    return stored._id;
  },
});

// Rows run one at a time so two pairs that share an object cannot both insert it. A row that fails
// validation is skipped and reported; it never blocks the rest of the batch.
export const upsertBatch = internalMutation({
  args: { snapshot: v.id("snapshots"), pairs: v.array(pair) },
  returns: v.object({
    inserted: v.number(), updated: v.number(), unchanged: v.number(), skipped: v.number(), errors: v.array(v.string()),
  }),
  handler: async (ctx, { snapshot, pairs }) => {
    if (!await ctx.db.get(snapshot)) throw new ConvexError({ code: "NOT_FOUND", message: "Snapshot not found." });
    const result = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] as string[] };
    for (const row of pairs) {
      try {
        const { outcome } = await ingestEncounter(ctx, { ...row, snapshotId: snapshot, simulated: false });
        result[outcome]++;
      } catch (error) {
        // Validation runs before any write, so a skipped row leaves nothing behind.
        if (!(error instanceof AnalystError)) throw error;
        result.skipped++;
        if (result.errors.length < 5) result.errors.push(`${row.objectA.objectId}/${row.objectB.objectId} ${row.tcaUtc}: ${error.message}`);
      }
    }
    return result;
  },
});

// After a full load: this snapshot's active real pairs that the file no longer lists leave the queue
// (a rebuilt file drops rows, for example same-fleet pairs). Events keep their _id and history; only
// `active` changes, and an Analyst still running on them is superseded. The same pair within ±60 s of
// TCA counts as listed, as in ingestEncounter. Fixtures and other snapshots are never touched.
const pairKey = v.object({ objectA: v.string(), objectB: v.string(), tcaUtc: v.string() });
const MAX_ACTIVE = 5000;   // same bound as events.catalogPairs
const RETIRE_LIMIT = 200;  // writes per call; the loader calls again until fewer are retired

export const retireMissing = internalMutation({
  args: { snapshot: v.id("snapshots"), pairs: v.array(pairKey), limit: v.optional(v.number()) },
  returns: v.object({ checked: v.number(), retired: v.number() }),
  handler: async (ctx, { snapshot, pairs, limit }) => {
    if (!await ctx.db.get(snapshot)) throw new ConvexError({ code: "NOT_FOUND", message: "Snapshot not found." });
    const max = Math.max(1, Math.floor(limit ?? RETIRE_LIMIT));
    const unordered = (a: string, b: string) => (a < b ? `${a}/${b}` : `${b}/${a}`);
    const listed = new Map<string, number[]>();
    for (const { objectA, objectB, tcaUtc } of pairs) {
      const tcaMs = Date.parse(tcaUtc);
      if (!Number.isFinite(tcaMs)) throw new ConvexError({ code: "INVALID_INPUT", message: `Invalid tcaUtc ${tcaUtc} for ${objectA}/${objectB}.` });
      const key = unordered(objectA, objectB);
      listed.set(key, [...(listed.get(key) ?? []), tcaMs]);
    }
    const active = await ctx.db.query("events").withIndex("by_active", q => q.eq("active", true)).take(MAX_ACTIVE);
    const mine = active.filter(e => e.snapshotId === snapshot && !e.simulated);
    const objectIds = new Map<Id<"spaceObjects">, string>();
    const objectId = async (id: Id<"spaceObjects">) => {
      if (!objectIds.has(id)) objectIds.set(id, (await ctx.db.get(id))?.objectId ?? "");
      return objectIds.get(id)!;
    };
    let retired = 0;
    for (const event of mine) {
      if (retired >= max) break;
      const times = listed.get(unordered(await objectId(event.objectAId), await objectId(event.objectBId)));
      if (times?.some(t => Math.abs(t - event.tcaMs) <= TCA_MATCH_MS)) continue;
      await ctx.db.patch(event._id, { active: false });
      await invalidateEventApprovals(ctx, event, "evidence_changed");
      const running = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
        q.eq("eventId", event._id).eq("status", "running")).collect();
      for (const run of running) await supersede(ctx, run._id);
      retired++;
    }
    return { checked: mine.length, retired };
  },
});
