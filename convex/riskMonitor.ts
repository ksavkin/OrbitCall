import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { inputKey } from "./lib/analyst";
import { colorOf, loadFacts } from "./lib/events";
import { compareQueue } from "./lib/queue";
import { latestRun } from "./lib/runs";

export const ANALYST_TOP_K = 3;

// Every 5 minutes (crons.ts) and after a bulk load. Color depends on "now", so it is stored here and
// never computed in a query. Then the Analyst starts for the top red real events that have no run for
// their current evidence; failed runs are retried by hand (agents.rerun).
export const recolor = internalMutation({
  args: {},
  returns: v.object({ checked: v.number(), recolored: v.number(), deactivated: v.number(), started: v.number() }),
  handler: async ctx => {
    const now = Date.now();
    const stored = await ctx.db.query("events").withIndex("by_active", q => q.eq("active", true)).collect();
    const events = [];
    let recolored = 0, deactivated = 0;
    for (const event of stored) {
      const next = { ...event, color: colorOf(event, now), active: event.tcaMs > now };
      if (next.color !== event.color) recolored++;
      if (next.active !== event.active) deactivated++;
      if (next.color !== event.color || next.active !== event.active) {
        await ctx.db.patch(event._id, { color: next.color, active: next.active });
      }
      events.push(next);
    }

    let started = 0;
    // Without a configured model a started run would fail, and a failed run blocks autostart for that evidence.
    const enabled = process.env.ANALYST_AUTOSTART !== "false" && process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL;
    if (enabled) {
      const top = events.filter(e => e.active && e.color === "red" && !e.simulated).sort(compareQueue).slice(0, ANALYST_TOP_K);
      for (const event of top) {
        const run = await latestRun(ctx, event._id);
        if (run?.inputKey === inputKey(await loadFacts(ctx, event))) continue;
        await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId: event._id });
        started++;
      }
    }
    return { checked: stored.length, recolored, deactivated, started };
  },
});
