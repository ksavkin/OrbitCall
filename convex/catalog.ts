import { query } from "./_generated/server";
import { v } from "convex/values";
import { sourceRef } from "./lib/validators";

// The newest real snapshot. Fixture snapshots (`fixture:` ids) are development data, never the catalog.
export const snapshot = query({
  args: {},
  returns: v.union(v.null(), v.object({
    snapshotId: v.string(), takenAt: v.union(v.string(), v.null()), ommUrl: v.null(),
    gpUrl: v.union(v.string(), v.null()), sources: v.array(sourceRef),
  })),
  handler: async ctx => {
    for await (const stored of ctx.db.query("snapshots").order("desc")) {
      if (stored.snapshotId.startsWith("fixture:")) continue;
      const gp = stored.sources.find(s => s.name === "celestrak_gp");
      const socrates = stored.sources.find(s => s.name === "socrates");
      return {
        snapshotId: stored.snapshotId, takenAt: gp?.fetchedAt ?? socrates?.fetchedAt ?? null,
        ommUrl: null, gpUrl: gp?.url ?? null, sources: stored.sources,
      };
    }
    return null;
  },
});
