import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { latestRun, supersede } from "./lib/runs";

// Internal until sign-in arrives in Phase 2: an anonymous retry would be an open model-call endpoint.
export const rerun = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const run = await latestRun(ctx, eventId);
    if (run?.status === "running" && !run.stalled) {
      throw new ConvexError({ code: "INVALID_STATE", message: "The Analyst is still making progress." });
    }
    if (run?.status === "succeeded") {
      throw new ConvexError({ code: "INVALID_STATE", message: "This attempt already succeeded." });
    }
    if (run?.status === "running") await supersede(ctx, run._id);
    await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    return null;
  },
});
