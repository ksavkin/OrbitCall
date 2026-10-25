import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Candidate, Side } from "./policies";
import { inputKey } from "./analyst";
import { loadFacts } from "./events";

export async function loadCandidates(ctx: QueryCtx, set: Doc<"candidateSets">): Promise<Candidate[]> {
  return Promise.all(set.candidateRevisionIds.map(async id => {
    const row = await ctx.db.get(id);
    if (!row || row.eventId !== set.eventId) throw new ConvexError({ code: "NOT_FOUND", message: "Candidate evidence is incomplete." });
    const { _id, _creationTime, eventId, ...candidate } = row;
    return candidate;
  }));
}

export function latestAdvocate(ctx: QueryCtx, eventId: Id<"events">, companyId: Id<"companies">) {
  return ctx.db.query("agentRuns").withIndex("by_event_role_company", q => q.eq("eventId", eventId)
    .eq("role", "operator_advocate").eq("companyId", companyId)).order("desc").first();
}

/** The company acting for a side; null for side B of confirmed debris. */
export const companyOf = (set: Doc<"candidateSets">, side: Side) => side === "A" ? set.companyAId : set.companyBId;

// Public-data references and a revision counter only: never include raw policy in the shared run key.
export const advocateKey = (set: Doc<"candidateSets">, side: Side, policyRevision: number) => JSON.stringify({
  version: "advocate-v1", setId: set._id, candidateVersion: set.version,
  evidenceKey: set.evidenceKey, side, companyId: companyOf(set, side), policyRevision,
});

export async function currentAssessment(ctx: QueryCtx, set: Doc<"candidateSets">, side: Side, evidenceKey: string) {
  const companyId = companyOf(set, side);
  if (!companyId) return null;
  const run = await latestAdvocate(ctx, set.eventId, companyId);
  if (!run || run.status !== "succeeded") return null;
  const message = await ctx.db.query("negotiationMessages").withIndex("by_run", q => q.eq("runId", run._id)).unique();
  return message && message.candidateVersion === set.version && message.evidenceKey === evidenceKey ? message : null;
}

export async function currentEvidenceKey(ctx: QueryCtx, set: Doc<"candidateSets">) {
  const event = await ctx.db.get(set.eventId);
  return event ? inputKey(await loadFacts(ctx, event)) : null;
}
