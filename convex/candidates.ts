import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { candidate } from "./lib/policyValidators";
import { validateCandidates } from "./lib/policies";
import { loadFacts } from "./lib/events";
import { inputKey } from "./lib/analyst";
import { supersede } from "./lib/runs";
import type { Id } from "./_generated/dataModel";

export const publish = internalMutation({
  args: { eventId: v.id("events"), baseVersion: v.union(v.number(), v.null()), candidates: v.array(candidate), start: v.optional(v.boolean()) },
  handler: async (ctx, { eventId, baseVersion, candidates, start = true }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    const facts = await loadFacts(ctx, event);
    validateCandidates(candidates, facts);
    const owners = await Promise.all([facts.objectA.objectId, facts.objectB.objectId].map(objectId =>
      ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique()));
    if (!owners[0] || !owners[1] || owners[0].companyId === owners[1].companyId) {
      throw new ConvexError({ code: "INVALID_STATE", message: "Coordination needs two distinct registered operators." });
    }
    const previous = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    if ((previous?.version ?? null) !== baseVersion) throw new ConvexError({ code: "STALE_REVISION", message: "Candidate set changed; reload it before publishing." });
    if (previous && previous.state !== "open") throw new ConvexError({ code: "INVALID_STATE", message: "Scheduled or closed plans cannot be rewritten by candidate publication." });
    const candidateRevisionIds: Id<"candidateRevisions">[] = [];
    for (const c of candidates) {
      const latest = await ctx.db.query("candidateRevisions").withIndex("by_event_candidate_revision", q =>
        q.eq("eventId", eventId).eq("candidateId", c.candidateId)).order("desc").first();
      if (latest && c.revision <= latest.revision) {
        const { _id, _creationTime, eventId: _eventId, ...stored } = latest;
        // Compare records independently of serialization key ordering.
        if (c.revision !== latest.revision || Object.keys(c).some(key => JSON.stringify(c[key as keyof typeof c]) !== JSON.stringify(stored[key as keyof typeof stored]))) {
          throw new ConvexError({ code: "STALE_REVISION", message: "A changed candidate needs a new immutable revision." });
        }
        candidateRevisionIds.push(_id);
      } else candidateRevisionIds.push(await ctx.db.insert("candidateRevisions", { eventId, ...c }));
    }
    const evidenceKey = inputKey(facts);
    if (previous && previous.evidenceKey === evidenceKey && JSON.stringify(previous.candidateRevisionIds) === JSON.stringify(candidateRevisionIds)) {
      return { version: previous.version, changed: false };
    }
    const value = { eventId, companyAId: owners[0].companyId, companyBId: owners[1].companyId,
      version: (previous?.version ?? 0) + 1, evidenceKey, candidateRevisionIds, state: "open" as const, reviewRequired: false };
    if (previous) await ctx.db.replace(previous._id, value);
    else await ctx.db.insert("candidateSets", value);
    const runs = await ctx.db.query("agentRuns").withIndex("by_event_role_company", q => q.eq("eventId", eventId).eq("role", "operator_advocate")).collect();
    for (const run of runs) if (run.status === "running" || run.status === "succeeded") await supersede(ctx, run._id);
    if (start) await ctx.scheduler.runAfter(0, internal.agents.advocate.negotiate, { eventId });
    return { version: value.version, changed: true };
  },
});
