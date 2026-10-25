import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Seeded demo cases (seedCases.ts) carry their summary and plan cards; their rooms never call an agent out.
export const SEEDED_SCENARIO = "seeded-cases";

/** True when the event or room belongs to a run of seeded demo cases. */
export async function isSeededRun(ctx: QueryCtx, demoRunId: Id<"demoRuns"> | null | undefined) {
  if (!demoRunId) return false;
  return (await ctx.db.get(demoRunId))?.scenario === SEEDED_SCENARIO;
}

/** The run itself while it is an open run of seeded demo cases, else null. */
export async function seededRunOf(ctx: QueryCtx, demoRunId: Id<"demoRuns"> | null | undefined) {
  const run = demoRunId ? await ctx.db.get(demoRunId) : null;
  return run && run.scenario === SEEDED_SCENARIO && run.state === "open" && run.closedAt === null ? run : null;
}
