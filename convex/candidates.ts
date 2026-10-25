import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { candidate } from "./lib/policyValidators";
import { validateCandidates } from "./lib/policies";
import { loadFacts } from "./lib/events";
import { inputKey } from "./lib/analyst";
import { supersede } from "./lib/runs";
import { ommSnapshotId } from "./lib/publishCandidates";
import { syncProposals } from "./lib/proposals";
import { RESOLVED_STATUSES } from "./lib/decision";
import type { Id } from "./_generated/dataModel";

export const publish = internalMutation({
  args: {
    eventId: v.id("events"), baseVersion: v.union(v.number(), v.null()), candidates: v.array(candidate), start: v.optional(v.boolean()),
    // What the candidates were computed on; an event that moved on since then is refused rather than mislabeled.
    expectedEvidenceKey: v.optional(v.string()), expectedSnapshotId: v.optional(v.string()),
    expectedOmmSnapshotId: v.optional(v.string()),
    expectedDemoRunId: v.optional(v.union(v.id("demoRuns"), v.null())),
  },
  handler: async (ctx, { eventId, baseVersion, candidates, start = true, expectedEvidenceKey, expectedSnapshotId, expectedOmmSnapshotId, expectedDemoRunId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    // A remote calculation can outlive its event or a burn. Recheck inside this transaction before any writes.
    if (expectedEvidenceKey !== undefined && (!event.active || event.tcaMs <= Date.now() || event.workflow === "internal_review" ||
      candidates.some(c => c.kind === "maneuver" && Date.parse(c.burnTimeUtc!) <= Date.now()))) {
      throw new ConvexError({ code: "STALE_REVISION", message: "The event or an offered burn is no longer available; recompute candidates." });
    }
    if (expectedDemoRunId !== undefined && expectedDemoRunId !== (event.demoRunId ?? null)) {
      throw new ConvexError({ code: "STALE_REVISION", message: "The event's demo run changed while candidates were computed." });
    }
    if (event.demoRunId) {
      const run = await ctx.db.get(event.demoRunId);
      if (!run || run.state !== "open" || run.closedAt !== null) {
        throw new ConvexError({ code: "STALE_REVISION", message: "The demo run is no longer open for candidate publication." });
      }
    }
    const facts = await loadFacts(ctx, event);
    if (expectedEvidenceKey !== undefined && expectedEvidenceKey !== inputKey(facts)) {
      throw new ConvexError({ code: "STALE_REVISION", message: "The event's evidence changed while candidates were computed; recompute them." });
    }
    const snapshot = await ctx.db.get(event.snapshotId);
    if (expectedSnapshotId !== undefined && expectedSnapshotId !== snapshot?.snapshotId) {
      throw new ConvexError({ code: "STALE_REVISION", message: "The event's snapshot changed while candidates were computed; recompute them." });
    }
    if (expectedOmmSnapshotId !== undefined && (!snapshot || expectedOmmSnapshotId !== ommSnapshotId(snapshot))) {
      throw new ConvexError({ code: "STALE_REVISION", message: "The orbital catalog changed while candidates were computed; recompute them." });
    }
    validateCandidates(candidates, facts);
    const [companyAId, companyBId] = await Promise.all([facts.objectA.objectId, facts.objectB.objectId].map(async objectId =>
      (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique())?.companyId ?? null));
    // Only a server-confirmed debris event runs with one operator; a missing active counterpart stays bilateral (spec §1).
    if (event.workflow === "unilateral_debris") {
      const active = companyAId && !companyBId ? "A" : companyBId && !companyAId ? "B" : null;
      if (!active || (event.requiredApprovalSides && event.requiredApprovalSides.join() !== active)) {
        throw new ConvexError({ code: "INVALID_STATE", message: "Confirmed debris needs exactly one registered operator, on its active side." });
      }
      if (candidates.some(c => c.kind === "maneuver" && c.movingSide !== active)) {
        throw new ConvexError({ code: "INVALID_STATE", message: "Only the active object can maneuver around debris." });
      }
    } else if (!companyAId || !companyBId || companyAId === companyBId) {
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
    if (previous && !previous.reviewRequired && previous.companyAId === companyAId && previous.companyBId === companyBId &&
      previous.evidenceKey === evidenceKey && JSON.stringify(previous.candidateRevisionIds) === JSON.stringify(candidateRevisionIds)) {
      // Existing candidate sets predate the proposal projection. Repair missing projections even when calculations
      // are unchanged, without moving an existing decision or scheduling another negotiation.
      await syncProposals(ctx, event, candidateRevisionIds, { candidateSetChanged: false, preserveDecision: RESOLVED_STATUSES.has(event.status ?? "new") });
      return { version: previous.version, changed: false };
    }
    // Consensus may be backfilled above, but changed calculations never silently replace an agreed plan.
    if (RESOLVED_STATUSES.has(event.status ?? "new")) throw new ConvexError({ code: "INVALID_STATE", message: "This incident is decided; its candidates can no longer change." });
    const value = { eventId, companyAId, companyBId,
      version: (previous?.version ?? 0) + 1, evidenceKey, candidateRevisionIds, state: "open" as const, reviewRequired: false };
    if (previous) await ctx.db.replace(previous._id, value);
    else await ctx.db.insert("candidateSets", value);
    await syncProposals(ctx, event, candidateRevisionIds);
    const runs = await ctx.db.query("agentRuns").withIndex("by_event_role_company", q => q.eq("eventId", eventId).eq("role", "operator_advocate")).collect();
    for (const run of runs) if (run.status === "running" || run.status === "succeeded") await supersede(ctx, run._id);
    if (start) await ctx.scheduler.runAfter(0, internal.agents.advocate.negotiate, { eventId });
    return { version: value.version, changed: true };
  },
});
