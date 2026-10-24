import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { eventFacts } from "./lib/validators";
import { inputKey, isRed, validateFacts } from "./lib/analyst";
import { factsFromEvent } from "./lib/events";

// Reference ingestion adapter for Kostya. It fetches no catalog data itself.
export const ingest = internalMutation({
  args: { sourceKey: v.string(), facts: eventFacts },
  handler: async (ctx, { sourceKey, facts }) => {
    validateFacts(facts);
    const previous = await ctx.db.query("events").withIndex("by_source_key", q => q.eq("sourceKey", sourceKey)).unique();
    const changed = !previous || inputKey(factsFromEvent(previous)) !== inputKey(facts);
    const red = isRed(facts, Date.now());
    const color = red ? "red" as const : facts.pc.value !== null && facts.pc.value >= 1e-5 ? "yellow" as const : "none" as const;
    const updated = { ...facts, sourceKey, color, updatedAt: new Date().toISOString() };
    const eventId = previous?._id ?? await ctx.db.insert("events", {
      ...updated, status: "new", agentsWorking: false, agentsStalled: false,
    });
    if (previous) await ctx.db.patch(eventId, updated);
    // Publishing a changed input also invalidates any result still being computed for it.
    if (changed && previous) {
      const active = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
        q.eq("eventId", eventId).eq("status", "running")).collect();
      for (const run of active) await ctx.db.patch(run._id, {
        status: "superseded", stage: "superseded", finishedAt: Date.now(), stalled: false,
      });
      await ctx.db.patch(eventId, { agentsWorking: false, agentsStalled: false });
    }
    if (red && (changed || previous?.color !== "red")) {
      await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    }
    return { eventId, scheduled: red && (changed || previous?.color !== "red") };
  },
});
