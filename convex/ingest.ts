import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { AnalystError } from "./lib/analyst";
import { ingestEncounter } from "./lib/events";
import { objectInput, sourceRef } from "./lib/validators";

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
    if (JSON.stringify(stored.sources) !== JSON.stringify(sources)) await ctx.db.patch(stored._id, { sources });
    if (stored.ommUrl !== ommUrl) await ctx.db.patch(stored._id, { ommUrl });
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
