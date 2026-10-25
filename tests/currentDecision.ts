import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { loadFacts } from "../convex/lib/events";
import { inputKey } from "../convex/lib/analyst";
import { advocateCandidates } from "../fixtures/policies";

// Realistic immutable card lineage for room turn fixtures; incomplete rows must never count as authorization.
export async function currentProposal(ctx: MutationCtx, eventId: Id<"events">) {
  const event = (await ctx.db.get(eventId))!;
  const facts = await loadFacts(ctx, event);
  const [a, b] = await Promise.all([facts.objectA, facts.objectB].map(o => ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", o.objectId)).unique()));
  const card = { ...advocateCandidates.find(c => c.kind === "wait")!, candidateId: "P1", label: "P1", missBeforeKm: event.missKm, simulated: event.simulated };
  const candidateRevisionId = await ctx.db.insert("candidateRevisions", { eventId, ...card });
  await ctx.db.insert("candidateSets", { eventId, companyAId: a?.companyId ?? null, companyBId: b?.companyId ?? null,
    version: 1, evidenceKey: inputKey(facts), candidateRevisionIds: [candidateRevisionId], state: "open", reviewRequired: false });
  const proposalId = await ctx.db.insert("proposals", { eventId, candidateId: "P1", label: "P1", latestRevision: 1, demoRunId: event.demoRunId ?? null, createdAt: Date.now() });
  await ctx.db.insert("proposalRevisions", { eventId, proposalId, revision: 1, candidateRevisionId, changeSummary: null,
    sourceMessageIds: [], rationale: null, schedulePreviewDiff: null, schedulePreviewHash: null, simulated: event.simulated, createdAt: Date.now() });
  return proposalId;
}
