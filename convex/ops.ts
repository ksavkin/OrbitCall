import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { getHealth, getScreenJob } from "./lib/orbitClient";

// Manual operator check from the deployed Convex runtime. Reads an existing job; never starts a scan, writes
// product data, publishes candidates, or contacts operators. The internal action is unavailable to browser users.
export const checkOrbit = internalAction({
  args: {
    snapshotId: v.string(),
    screen: v.optional(v.object({ jobId: v.string(), scanId: v.string(), evidenceVersion: v.optional(v.string()) })),
  },
  handler: async (_ctx, { snapshotId, screen }) => {
    const health = await getHealth(snapshotId);
    if (!screen) return { health, screen: null };
    const job = await getScreenJob(screen.jobId, { scanId: screen.scanId, snapshotId, evidenceVersion: screen.evidenceVersion });
    return {
      health,
      screen: {
        jobId: job.jobId, status: job.status, phase: job.phase, progress: job.progress,
        counts: job.result?.counts ?? job.counters, coverage: job.coverage,
        runtimeS: job.result?.runtimeS ?? null, error: job.error,
      },
    };
  },
});
