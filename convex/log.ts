import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./session";
import { requireReader } from "./lib/operatorAccess";
import { isoUtc } from "./lib/events";

// The shared audit record (spec §3.6, LOG-4): newest first, 50 per page, only incidents the caller is a party to.
// A company's own policy changes and its agents' private work stay with that company.
const PAGE = 50;
const values = v.union(v.record(v.string(), v.union(v.number(), v.string(), v.null())), v.null());
const entry = v.object({
  logId: v.id("log"), at: v.string(), eventId: v.union(v.id("events"), v.null()),
  actor: v.union(
    v.object({ kind: v.literal("human"), userId: v.id("users"), name: v.string(), side: v.union(v.literal("A"), v.literal("B"), v.null()) }),
    v.object({ kind: v.literal("agent"), role: v.string(), side: v.union(v.literal("A"), v.literal("B"), v.null()) }),
    v.object({ kind: v.literal("system") }),
  ),
  action: v.string(), summary: v.string(), texts: v.union(v.record(v.string(), v.string()), v.null()), before: values, after: values,
  proposalId: v.union(v.id("proposals"), v.null()), revision: v.union(v.number(), v.null()), simulated: v.boolean(),
});

function shared(row: Doc<"log">, companyId: Id<"companies">) {
  const owner = row.actor.kind === "system" ? null : row.actor.companyId;
  if (row.action === "policy_changed") return owner === companyId;
  return row.actor.kind !== "agent" || owner === null || owner === companyId;
}
function view(row: Doc<"log">) {
  const a = row.actor;
  const actor = a.kind === "human" ? { kind: a.kind, userId: a.userId, name: a.name, side: a.side }
    : a.kind === "agent" ? { kind: a.kind, role: a.role as string, side: a.side } : { kind: a.kind };
  return { logId: row._id, at: isoUtc(row.at), eventId: row.eventId, actor, action: row.action as string, summary: row.summary,
    texts: (row.texts as Record<string, string> | null) ?? null, before: row.before, after: row.after, proposalId: row.proposalId,
    revision: row.revision, simulated: row.simulated };
}
export const list = query({
  args: { eventId: v.optional(v.id("events")), cursor: v.optional(v.string()) },
  returns: v.object({ entries: v.array(entry), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { eventId, cursor }) => {
    // Convex pagination orders by the index plus creation time, so rows sharing a timestamp are neither lost nor
    // repeated and a page never exceeds 50; filtering can make a page shorter, and `nextCursor` still moves on.
    const opts = { numItems: PAGE, cursor: cursor ?? null };
    if (eventId) {
      const { user } = await requireReader(ctx, eventId);
      const p = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", eventId)).order("desc").paginate(opts);
      return { entries: p.page.filter(r => shared(r, user.companyId)).map(view), nextCursor: p.isDone ? null : p.continueCursor };
    }
    const { user } = await requireUser(ctx);
    if (user.role === "demo_observer") throw new ConvexError({ code: "FORBIDDEN", message: "Use the observer view for your authorized demonstration." });
    const readable = new Map<Id<"events">, boolean>();
    const party = async (ctx: QueryCtx, id: Id<"events">) => {
      if (!readable.has(id)) readable.set(id, await requireReader(ctx, id).then(() => true, () => false));
      return readable.get(id)!;
    };
    const p = await ctx.db.query("log").withIndex("by_at").order("desc").paginate(opts);
    const kept: Doc<"log">[] = [];
    for (const row of p.page) if (row.eventId && shared(row, user.companyId) && await party(ctx, row.eventId)) kept.push(row);
    return { entries: kept.map(view), nextCursor: p.isDone ? null : p.continueCursor };
  },
});
