import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { latestRun, supersede } from "./lib/runs";
import { inputKey } from "./lib/analyst";
import { loadFacts } from "./lib/events";
import { requireFleetScope } from "./fleetQuery";
import { buildHostContext } from "./lib/hostContext";

const MAX_RERUNS = 3;
const HOST_TIMEOUT_MS = 10 * 60_000;
const invalid = (message: string) => new ConvexError({ code: "INVALID_STATE", message });
const limit = () => new ConvexError({ code: "RETRY_LIMIT", message: "Retry limit reached for the current inputs. Review the failure before requesting work on new inputs." });

/** Explicit, audited operator retry; no branch writes selections, approvals, candidates, or schedules. */
export const rerun = mutation({
  args: { eventId: v.id("events"), role: v.optional(v.union(v.literal("incident_analyst"), v.literal("coordination_host"))) },
  returns: v.null(),
  handler: async (ctx, { eventId, role = "incident_analyst" }): Promise<null> => {
    const { user, objects, companyObjects } = await requireFleetScope(ctx);
    if (user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "An assigned operator must request the retry." });
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    const pair = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
    const owned = new Set(companyObjects.map(o => o.objectId));
    const assigned = new Set(objects.filter(o => owned.has(o.objectId)).map(o => o.objectId));
    if (!pair.some(o => o && assigned.has(o.objectId))) throw new ConvexError({ code: "FORBIDDEN", message: "Current responsibility for this incident is required." });
    if (!event.active || event.tcaMs <= Date.now()) throw invalid("This incident is no longer active.");
    if (event.demoRunId) {
      const demo = await ctx.db.get(event.demoRunId);
      if (!demo || demo.state !== "open" || demo.closedAt !== null) throw invalid("This demonstration is closed.");
    }
    let roomId: Id<"rooms"> | null = null;
    let key: string;
    let attempt: number;
    let scheduledId: Id<"_scheduled_functions"> | null = null;
    let hostRunId: Id<"hostRuns"> | null = null;
    if (role === "incident_analyst") {
      const evidenceKey = inputKey(await loadFacts(ctx, event));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidenceKey));
      key = `analyst-v1:${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
      const run = await latestRun(ctx, eventId);
      if (run?.inputKey === evidenceKey && run.status === "running" && !run.stalled) throw invalid("The Analyst is still making progress.");
      if (run?.inputKey === evidenceKey && run.status === "succeeded") throw invalid("The Analyst already succeeded on these inputs.");
      const retries = (await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).collect())
        .filter(row => row.action === "agents_rerun" && row.after?.role === role && row.after?.inputVersion === key);
      for (const retry of retries) {
        const id = retry.after?.scheduledId;
        if (typeof id !== "string") continue;
        const job = await ctx.db.system.get(id as Id<"_scheduled_functions">);
        if (job?.state.kind === "pending" || (job?.state.kind === "inProgress" && !run?.stalled)) throw invalid("The Analyst retry is already queued.");
      }
      if (retries.length >= MAX_RERUNS) throw limit();
      attempt = retries.length + 1;
      if (run?.status === "running") await supersede(ctx, run._id);
      scheduledId = await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId });
    } else {
      const links = await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect();
      const rooms = (await Promise.all(links.map(link => ctx.db.get(link.roomId)))).filter(room =>
        room && room.state === "open" && room.closedAt === null && room.demoRunId === (event.demoRunId ?? null));
      if (rooms.length !== 1 || !rooms[0]) throw invalid("The Host needs this incident's open workflow room.");
      const room = rooms[0]; roomId = room._id;
      const previous = await ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", room._id)).order("desc").first();
      const trigger = previous?.trigger ?? "summary_requested";
      const context = await buildHostContext(ctx, room, trigger); key = context.inputVersion;
      const rows = await ctx.db.query("hostRuns").withIndex("by_room_input_trigger", q => q.eq("roomId", room._id).eq("inputVersion", key).eq("trigger", trigger)).collect();
      if (rows.some(row => row.status === "succeeded")) throw invalid("The Host already succeeded on these inputs.");
      if (rows.some(row => row.status === "running" && row.createdAt >= Date.now() - HOST_TIMEOUT_MS)) throw invalid("The Host is still making progress.");
      if (rows.filter(row => row.status === "failed" || row.status === "running").length >= MAX_RERUNS) throw limit();
      hostRunId = await ctx.runMutation(internal.hostTriggers.request, { roomId, trigger, inputVersion: key });
      if (!hostRunId) throw invalid("There is no current Host work to retry.");
      const claimed = await ctx.db.get(hostRunId);
      if (!claimed || claimed.status !== "running") throw limit();
      attempt = claimed.attempt;
    }
    await ctx.db.insert("log", { eventId, actor: { kind: "human", userId: user._id, companyId: user.companyId, name: user.name ?? "Operator", side: null },
      action: "agents_rerun", summary: role === "incident_analyst" ? "Operator requested an Incident Analyst retry." : "Operator requested a Coordination Host retry.",
      texts: null, before: null, after: { role, inputVersion: key, attempt, scheduledId, hostRunId }, proposalId: null, revision: null,
      roomId, demoRunId: event.demoRunId ?? null, simulated: event.simulated, at: Date.now() });
    return null;
  },
});
