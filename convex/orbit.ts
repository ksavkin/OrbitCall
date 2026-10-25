import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, type Infer } from "convex/values";
import { loadFacts } from "./lib/events";
import { candidate } from "./lib/policyValidators";
import { eventFacts } from "./lib/validators";
import { OrbitError, orbit, orbitConfig } from "./lib/orbit";
import { assignRevisions, selectCandidates } from "./lib/orbitCandidates";
import type { Candidate } from "./lib/policies";

// Everything the candidate computation reads from the database, in one consistent read.
export const candidateContext = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.union(v.null(), v.object({
    facts: eventFacts, baseVersion: v.union(v.number(), v.null()),
    open: v.boolean(), coordinated: v.boolean(),
  })),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) return null;
    const facts = await loadFacts(ctx, event);
    const owners = await Promise.all([facts.objectA.objectId, facts.objectB.objectId].map(objectId =>
      ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique()));
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return {
      facts, baseVersion: set?.version ?? null, open: !set || set.state === "open",
      // candidates.publish coordinates two distinct registered operators; debris rooms are a separate path.
      coordinated: Boolean(owners[0] && owners[1] && owners[0].companyId !== owners[1].companyId),
    };
  },
});

export const latestRevisions = internalQuery({
  args: { eventId: v.id("events"), candidateIds: v.array(v.string()) },
  returns: v.record(v.string(), v.union(candidate, v.null())),
  handler: async (ctx, { eventId, candidateIds }) => {
    const latest: Record<string, Candidate | null> = {};
    for (const candidateId of candidateIds) {
      const row = await ctx.db.query("candidateRevisions").withIndex("by_event_candidate_revision", q =>
        q.eq("eventId", eventId).eq("candidateId", candidateId)).order("desc").first();
      if (row) {
        const { _id, _creationTime, eventId: _eventId, ...stored } = row;
        latest[candidateId] = stored;
      } else latest[candidateId] = null;
    }
    return latest;
  },
});

const outcome = v.union(
  v.object({ status: v.literal("published"), version: v.number(), changed: v.boolean(), snapshotId: v.string(), candidateIds: v.array(v.string()) }),
  v.object({ status: v.literal("skipped"), reason: v.string() }),
  v.object({ status: v.literal("failed"), code: v.string(), message: v.string() }),
);

type Outcome = Infer<typeof outcome>;
type Context = { facts: Infer<typeof eventFacts>; baseVersion: number | null; open: boolean; coordinated: boolean } | null;

// Incident Analyst tool [AGT-2]: asks the orbital service for the maneuver grid and publishes the computed
// candidates. Never invents numbers: without the service it reports UPSTREAM_UNAVAILABLE and publishes nothing.
export const computeCandidates = internalAction({
  args: { eventId: v.id("events"), start: v.optional(v.boolean()) },
  returns: outcome,
  handler: async (ctx, { eventId, start }): Promise<Outcome> => {
    const context: Context = await ctx.runQuery(internal.orbit.candidateContext, { eventId });
    if (!context) return { status: "skipped" as const, reason: "NOT_FOUND" };
    if (!context.coordinated) return { status: "skipped" as const, reason: "NOT_COORDINATED" };
    if (!context.open) return { status: "skipped" as const, reason: "PLAN_NOT_OPEN" };
    const { facts } = context;
    if (Date.parse(facts.tcaUtc) <= Date.now()) return { status: "skipped" as const, reason: "TCA_PASSED" };
    try {
      const response = await orbit.candidates(orbitConfig(), {
        objectA: facts.objectA.objectId, objectB: facts.objectB.objectId, tcaUtc: facts.tcaUtc,
        notBeforeUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        // Both sides are registered operators here; the service still keeps debris and dead payloads fixed.
        allowedMovingObjectIds: [facts.objectA.objectId, facts.objectB.objectId],
      });
      const selected = selectCandidates(response, facts);
      const latest = await ctx.runQuery(internal.orbit.latestRevisions, { eventId, candidateIds: selected.map(c => c.candidateId) });
      const candidates = assignRevisions(selected, latest);
      const published: { version: number; changed: boolean } = await ctx.runMutation(internal.candidates.publish, {
        eventId, baseVersion: context.baseVersion, candidates, start: start ?? true,
      });
      return { status: "published" as const, ...published, snapshotId: response.snapshotId, candidateIds: candidates.map(c => c.candidateId) };
    } catch (error) {
      if (error instanceof OrbitError) return { status: "failed" as const, code: error.code, message: error.message };
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      if (data && typeof data.code === "string") return { status: "failed" as const, code: data.code, message: String(data.message ?? "") };
      throw error;
    }
  },
});
