import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireEventReader } from "./lib/access";

export const rerun = mutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const { user, owns } = await requireEventReader(ctx, eventId);
    if (user.role !== "operator" || !owns) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Only a party operator can retry an agent." });
    }
    const run = await ctx.db.query("agentRuns").withIndex("by_event_role", q =>
      q.eq("eventId", eventId).eq("role", "incident_analyst")).order("desc").first();
    if (run?.status === "running" && !run.stalled) {
      throw new ConvexError({ code: "INVALID_STATE", message: "The Analyst is still making progress." });
    }
    if (run?.status === "succeeded") {
      throw new ConvexError({ code: "INVALID_STATE", message: "This attempt already succeeded." });
    }
    if (run?.status === "running") await ctx.db.patch(run._id, {
      status: "superseded", stage: "superseded", finishedAt: Date.now(), stalled: false,
    });
    await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    return null;
  },
});
