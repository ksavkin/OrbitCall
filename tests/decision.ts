import { makeFunctionReference } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { advocateCandidates, advocateEvent, policyA } from "../fixtures/policies";
import { backend, catalogObject, insertEvent, type Backend } from "./helpers";

// Shared seed for tests/proposals.test.ts and tests/approvals.test.ts. proposals.ts and approvals.ts are new function
// files and convex/_generated is regenerated on main only (#6), so the tests reference them by path.
export const fn = {
  list: makeFunctionReference<"query">("proposals:list"),
  select: makeFunctionReference<"mutation">("proposals:select"),
  approve: makeFunctionReference<"mutation">("approvals:approve"),
  veto: makeFunctionReference<"mutation">("approvals:veto"),
  status: makeFunctionReference<"query">("approvals:status"),
  startWorkflow: makeFunctionReference<"mutation">("rooms:startWorkflow"),
};

export const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
export const as = (t: Backend, name: string) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/" });
export const code = async (p: Promise<unknown>) => {
  const outcome = await p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  if (outcome.ok) throw new Error(`Expected a failure, got ${JSON.stringify(outcome.value)}`);
  return (outcome.error as { data?: { code?: string } }).data?.code;
};
type Role = "operator" | "head_of_ops" | "demo_observer";
const member = (name: string, role: Role, assignedObjectIds: string[] = []) =>
  ({ tokenIdentifier: token(name), role, assignedObjectIds, name: name.toUpperCase() });
export const companyA = (aAssigned = ["SIM-1001"], objectIds = ["SIM-1001"]) => ({
  key: "a", name: "Company A", simulated: true, objectIds,
  members: [member("a", "operator", aAssigned), member("unassigned", "operator"), member("head", "head_of_ops"), member("eye", "demo_observer")],
});

// Company A operates SIM-1001 (a assigned; unassigned, head and eye are not), B operates SIM-1002 (b), C an unrelated
// SIM-3001 (c). policyA is stored so privacy checks have something real to leak. Candidates P1-P4 at revision 1,
// published with start: false (no Advocate run).
export async function seed() {
  const t = backend();
  const eventId = await insertEvent(t, advocateEvent);
  await t.run(async ctx => { await ctx.db.insert("spaceObjects", catalogObject("SIM-3001")); });
  await t.mutation(internal.operators.provision, companyA());
  await t.mutation(internal.operators.provision, {
    key: "b", name: "Company B", simulated: true, objectIds: ["SIM-1002"], members: [member("b", "operator", ["SIM-1002"])],
  });
  await t.mutation(internal.operators.provision, {
    key: "c", name: "Company C", simulated: true, objectIds: ["SIM-3001"], members: [member("c", "operator", ["SIM-3001"])],
  });
  await as(t, "a").mutation(api.policies.update, { satellites: [policyA] });
  await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, candidates: advocateCandidates, start: false });
  return { t, eventId };
}

export const proposalId = (t: Backend, eventId: Id<"events">, candidateId: string) => t.run(async ctx =>
  (await ctx.db.query("proposals").withIndex("by_event_candidate", q => q.eq("eventId", eventId).eq("candidateId", candidateId)).first())!._id);
export const selection = (t: Backend, eventId: Id<"events">) => t.run(ctx =>
  ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique());
export const userId = (t: Backend, name: string) => t.run(async ctx =>
  (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token(name))).unique())!._id);
export const withCard = (id: string, patch: object) => advocateCandidates.map(c => c.candidateId === id ? { ...c, ...patch } : c);

/** Selects a card as `name` at the current generation. */
export async function pick(t: Backend, name: string, eventId: Id<"events">, candidateId: string, revision = 1) {
  const generation = (await selection(t, eventId))?.generation ?? 0;
  await as(t, name).mutation(fn.select, { eventId, proposalId: await proposalId(t, eventId, candidateId), revision, expectedGeneration: generation });
  return generation + 1;
}
/** The approve/veto arguments for the current selection. */
export async function tick(t: Backend, eventId: Id<"events">) {
  const s = (await selection(t, eventId))!;
  return { eventId, proposalId: s.proposalId!, revision: s.revision!, selectionGeneration: s.generation, approvalRuleVersion: 1 };
}
