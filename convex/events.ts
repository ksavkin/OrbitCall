import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { AnalystError, inputKey, isRed, validateFacts } from "./lib/analyst";
import { buildFacts, findEncounter, findObject, loadFacts, upsertObject } from "./lib/events";
import { supersede } from "./lib/runs";
import { objectInput } from "./lib/validators";

// Stores one encounter from a registered snapshot. It fetches no catalog data itself.
export const ingest = internalMutation({
  args: {
    snapshotId: v.id("snapshots"), objectA: objectInput, objectB: objectInput,
    tcaUtc: v.string(), missKm: v.number(), relSpeedKmS: v.number(),
    pcValue: v.union(v.number(), v.null()), simulated: v.boolean(),
  },
  handler: async (ctx, { snapshotId, objectA, objectB, tcaUtc, ...measured }) => {
    const snapshot = await ctx.db.get(snapshotId);
    if (!snapshot) throw new ConvexError({ code: "NOT_FOUND", message: "Snapshot not found." });
    const tcaMs = Date.parse(tcaUtc);
    if (!Number.isFinite(tcaMs)) throw new AnalystError("INVALID_INPUT", "Encounter time or units are invalid.");
    validateFacts({ ...buildFacts({ ...measured, tcaMs }, objectA, objectB, snapshot.sources), tcaUtc });

    // Read the previous evidence before object metadata changes underneath it.
    const [knownA, knownB] = await Promise.all([findObject(ctx, objectA.objectId), findObject(ctx, objectB.objectId)]);
    const previous = knownA && knownB ? await findEncounter(ctx, knownA._id, knownB._id, tcaMs) : null;
    const before = previous && inputKey(await loadFacts(ctx, previous));
    const objectAId = await upsertObject(ctx, objectA, measured.simulated);
    const objectBId = await upsertObject(ctx, objectB, measured.simulated);
    const [a, b] = await Promise.all([ctx.db.get(objectAId), ctx.db.get(objectBId)]);
    const facts = buildFacts({ ...measured, tcaMs }, a!, b!, snapshot.sources);
    const changed = before !== inputKey(facts);

    const now = Date.now();
    const red = isRed(facts, now);
    const color = red ? "red" as const : facts.pc.value !== null && facts.pc.value >= 1e-5 ? "yellow" as const : "none" as const;
    const row = { objectAId, objectBId, snapshotId, tcaMs, ...measured, color, active: tcaMs > now };
    // updatedAt moves only when the evidence does; an identical reload keeps it.
    const eventId = previous?._id ?? await ctx.db.insert("events", { ...row, updatedAt: now });
    if (previous) await ctx.db.patch(eventId, changed ? { ...row, updatedAt: now } : row);
    // Publishing a changed input also invalidates any result still being computed for it.
    if (changed && previous) {
      const active = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
        q.eq("eventId", eventId).eq("status", "running")).collect();
      for (const run of active) await supersede(ctx, run._id);
    }
    const scheduled = red && (changed || previous?.color !== "red");
    if (scheduled) await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    return { eventId, scheduled };
  },
});
