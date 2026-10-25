"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  connectTiger, ensureObservationTable, readSeries, safeTigerFailure, withTiger, writeObservations,
  type TigerObservation, type TigerSeries, type TigerSql, type TigerWriteResult,
} from "./lib/tiger";
import { toSeriesPoints, toTigerObservation } from "./lib/tigerExport";

// The Tiger side of convex/history.ts. `pg` needs the Node runtime, and Convex allows only actions in a "use node"
// file, so the export and refresh actions live here and report back through history.ts mutations.

// Creates the hypertable if absent, then one parameterized INSERT ... ON CONFLICT DO NOTHING.
export async function exportWith(db: TigerSql, observation: TigerObservation): Promise<TigerWriteResult> {
  await ensureObservationTable(db);
  return writeObservations(db, [observation]);
}

// Real observations carry no run; simulated ones are read for the event's current demo run only.
export async function readHistory(db: TigerSql, eventId: string, demoRunId: string | null): Promise<Pick<TigerSeries, "real" | "simulated">> {
  const real = await readSeries(db, { eventId, runId: null });
  const run = demoRunId === null ? real : await readSeries(db, { eventId, runId: demoRunId });
  return { real: real.real, simulated: run.simulated };
}

export const exportObservation = internalAction({
  args: { exportId: v.id("observationExports") },
  returns: v.null(),
  handler: async (ctx, { exportId }): Promise<null> => {
    const row = await ctx.runMutation(internal.history.claimExport, { exportId });
    if (!row) return null;
    const attempt = { attempts: row.attempts, claimedAt: row.updatedAt };
    try {
      await withTiger(db => exportWith(db, toTigerObservation(row)), connectTiger);
    } catch (error) {
      await ctx.runMutation(internal.history.markFailed, { exportId, ...attempt, ...safeTigerFailure(error) });
      return null;
    }
    await ctx.runMutation(internal.history.markExported, { exportId, ...attempt });
    return null;
  },
});

export const refreshSeries = internalAction({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }): Promise<null> => {
    const scope = await ctx.runQuery(internal.history.seriesScope, { eventId });
    if (!scope) return null;
    const fetchedAt = Date.now();
    let series: Pick<TigerSeries, "real" | "simulated">;
    try {
      series = await withTiger(db => readHistory(db, eventId, scope.demoRunId), connectTiger);
    } catch (error) {
      await ctx.runMutation(internal.history.markSeriesFailed, { eventId, ...safeTigerFailure(error), fetchedAt, ...scope });
      return null;
    }
    const points = [...toSeriesPoints(series.real), ...toSeriesPoints(series.simulated)];
    await ctx.runMutation(internal.history.storeSeries, { eventId, points, fetchedAt, ...scope });
    return null;
  },
});
