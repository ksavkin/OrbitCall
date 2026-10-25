import { ConvexError, v, type Infer } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./session";
import { loadFacts } from "./lib/events";
import { inputKey } from "./lib/analyst";
import { validateCandidates } from "./lib/policies";
import { evidenceVersionOf, ommSnapshotId, wholeSecondUtc } from "./lib/publishCandidates";
import { getRescreenJob, orbitFailure, startRescreen, type RescreenRequest } from "./lib/orbitClient";
import { eventRef, pinnedInputs, rescreen } from "./schema/schedule";
import { commitSchedule, getScheduleJob, prepareSchedule, retryScheduleJob, scheduleConfig, ScheduleServiceError, type ScheduleJob,
  type ScheduleRef } from "./lib/scheduleClient";

// Convex owns authorization and durable job state; the Factory worker only builds and writes the checked artifact.
// requestPreview (after a selection) asks the worker to /prepare the exact append and records its diff on the revision
// before any approval; requestSchedule (after all required approvals) re-screens and then /commits under the same intent
// key. Worker failures stay visible and retry the same intent. No substitute writer. A shared mover (one burn that
// affects several linked incidents) is authorized only through its trajectory plan: one intent per plan version, every
// affected incident re-checked and re-screened, one schedule write; without a covering plan it stays
// SHARED_TRAJECTORY_REQUIRED.
// All write entry points are internal: only an approval mutation / scheduler may initiate them, not a browser.
const selectionRef = v.object({ ...eventRef.fields, approvalRuleVersion: v.number() });
type Ref = Infer<typeof selectionRef>;
type Pins = Infer<typeof pinnedInputs>;
type Maneuver = Doc<"maneuvers">;
export const POLL_LIMIT = 24;
export const POLL_DELAY_MS = 5_000;
// A Droid session takes tens of seconds and the worker runs jobs one at a time, so preparation may wait longer.
export const PREPARE_POLL_LIMIT = 60;
export const HORIZON_H = 72;
// The worker and the schedule client accept artifacts up to 256 KB; a smaller limit here would strand valid previews.
const MAX_ARTIFACT = 256_000;
const calls = {
  submit: makeFunctionReference<"action">("maneuvers:submit"),
  poll: makeFunctionReference<"action">("maneuvers:poll"),
  jobInput: makeFunctionReference<"query">("maneuvers:jobInput"),
  finishRescreen: makeFunctionReference<"mutation">("maneuvers:finishRescreen"),
  fail: makeFunctionReference<"mutation">("maneuvers:recordFailure"),
  reserve: makeFunctionReference<"mutation">("maneuvers:reserveCommit"),
  commit: makeFunctionReference<"action">("maneuvers:commit"),
  preview: makeFunctionReference<"query">("maneuvers:preview"),
  prepare: makeFunctionReference<"action">("maneuvers:prepare"),
  syncPlans: makeFunctionReference<"mutation">("trajectoryPlans:sync"),
  recordPreview: makeFunctionReference<"mutation">("maneuvers:recordPreview"),
  prepareFailed: makeFunctionReference<"mutation">("maneuvers:recordPrepareFailure"),
  commitIntent: makeFunctionReference<"query">("maneuvers:commitIntent"),
  recordCommit: makeFunctionReference<"mutation">("maneuvers:recordCommit"),
  requestSchedule: makeFunctionReference<"mutation">("maneuvers:requestSchedule"),
};

function fail(code: string, message: string): never { throw new ConvexError({ code, message }); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const intentOf = (r: Ref) => `event:${r.eventId}:proposal:${r.proposalId}:revision:${r.revision}:generation:${r.selectionGeneration}`;
const eventReference = ({ approvalRuleVersion: _rule, ...ref }: Ref) => ref;
const workerRef = (r: Ref): ScheduleRef => ({ eventId: String(r.eventId), proposalId: String(r.proposalId), revision: r.revision,
  selectionGeneration: r.selectionGeneration, approvalRuleVersion: r.approvalRuleVersion });
async function sha256(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const validVersion = (n: number) => Number.isSafeInteger(n) && n >= 1;
// Each pair's cards come from its own orbit call, so only a waiting card or the very same burn can join a shared write.
const ONE_BURN = "The affected incidents disagree on the moved trajectory: every other affected incident must select the waiting card or the same burn.";
// A normal wait, not a failure: the plan lists an affected incident that has not selected a card yet.
const PLAN_PENDING = "An affected incident has not selected a card for the shared trajectory yet.";

/** Reads a complete authorization snapshot in one transaction. The caller must carry its returned pins through
 * every asynchronous step. Approval generation alone does not substitute for the evidence/policy/assignment pins. */
async function context(ctx: QueryCtx, ref: Ref, approved = false, allowPast = false) {
  if (![ref.revision, ref.selectionGeneration, ref.approvalRuleVersion].every(validVersion)) fail("VALIDATION", "Invalid selection version.");
  const event = await ctx.db.get(ref.eventId);
  if (!event) fail("NOT_FOUND", "Incident not found.");
  if (!event.active || (!allowPast && event.tcaMs <= Date.now())) fail("INVALID_STATE", "The incident is no longer active.");
  if (event.demoRunId) {
    const run = await ctx.db.get(event.demoRunId);
    if (!run || run.state !== "open" || run.closedAt !== null) fail("INVALID_STATE", "The demo run is closed.");
  }
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", ref.eventId)).unique();
  if (!selection || selection.proposalId !== ref.proposalId || selection.revision !== ref.revision || selection.generation !== ref.selectionGeneration) {
    fail("NOT_SELECTED", "The selected proposal revision or generation changed.");
  }
  const proposal = await ctx.db.get(ref.proposalId);
  const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", ref.proposalId).eq("revision", ref.revision)).unique();
  if (!proposal || proposal.eventId !== ref.eventId || proposal.latestRevision !== ref.revision || !revision || revision.eventId !== ref.eventId ||
      proposal.demoRunId !== (event.demoRunId ?? null)) fail("STALE_REVISION", "The current immutable proposal revision is required.");
  const candidate = await ctx.db.get(revision.candidateRevisionId);
  const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", ref.eventId)).unique();
  if (!candidate || candidate.eventId !== ref.eventId || candidate.candidateId !== proposal.candidateId || candidate.revision !== ref.revision ||
      !set || set.state === "closed" || set.reviewRequired || !set.candidateRevisionIds.includes(candidate._id)) {
    fail("STALE_REVISION", "The proposal is no longer a current, reviewed candidate.");
  }
  const facts = await loadFacts(ctx, event);
  if (set.evidenceKey !== inputKey(facts)) fail("STALE_REVISION", "Orbital evidence changed after candidate calculation.");
  validateCandidates([candidate], facts);
  const snapshot = await ctx.db.get(event.snapshotId);
  const snapshotId = snapshot && ommSnapshotId(snapshot);
  if (!snapshotId) fail("INVALID_STATE", "The pinned OMM catalog is unavailable.");
  const objectIds = { A: facts.objectA.objectId, B: facts.objectB.objectId };
  const owners = await Promise.all((["A", "B"] as const).map(async side =>
    (await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectIds[side])).unique())?.companyId ?? null));
  if (set.companyAId !== owners[0] || set.companyBId !== owners[1]) fail("STALE_REVISION", "Satellite ownership changed.");
  const companies = { A: owners[0], B: owners[1] };
  const required = event.requiredApprovalSides ?? [];
  const bilateral = event.workflow === "bilateral" && owners[0] && owners[1] && owners[0] !== owners[1] && same([...required].sort(), ["A", "B"]);
  const activeSide = owners[0] && !owners[1] ? "A" : owners[1] && !owners[0] ? "B" : null;
  const debris = event.workflow === "unilateral_debris" && activeSide && same(required, [activeSide]);
  if ((!bilateral && !debris) || event.approvalRuleVersion !== ref.approvalRuleVersion) fail("APPROVAL_REQUIRED", "The current workflow does not authorize this schedule.");
  if (candidate.kind === "maneuver" && (!candidate.movingSide || !required.includes(candidate.movingSide) ||
      (!allowPast && Date.parse(candidate.burnTimeUtc!) <= Date.now()) || Date.parse(candidate.burnTimeUtc!) % 1000 !== 0)) {
    fail("INVALID_STATE", "The selected burn is unavailable or does not belong to an active operator.");
  }
  const policyRevisions: Pins["policyRevisions"] = [];
  let materialAt = Math.max(event.updatedAt, revision.createdAt, selection.at);
  for (const companyId of [...new Set(owners.filter((id): id is Id<"companies"> => id !== null))].sort()) {
    const policy = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
    policyRevisions.push({ companyId, revision: policy?.revision ?? 0 });
    materialAt = Math.max(materialAt, policy?.updatedAt ?? 0);
  }
  const authority: { userId: Id<"users">; companyId: Id<"companies">; version: number; objects: string[] }[] = [];
  for (const side of required) {
    const assignments = await ctx.db.query("fleetAssignments").withIndex("by_object", q => q.eq("objectId", objectIds[side])).collect();
    for (const assignment of assignments.filter(a => a.active)) {
      const user = await ctx.db.get(assignment.userId);
      if (!user || user.role !== "operator" || user.companyId !== companies[side]) continue;
      const existing = authority.find(a => a.userId === user._id);
      if (existing) existing.objects.push(objectIds[side]);
      else authority.push({ userId: user._id, companyId: user.companyId, version: user.assignmentVersion ?? 1, objects: [objectIds[side]] });
    }
  }
  authority.sort((a, b) => a.userId.localeCompare(b.userId));
  for (const a of authority) a.objects.sort();
  let plan: Doc<"trajectoryPlans"> | null = null;
  const plansOf = async (objectId: string) => (await ctx.db.query("trajectoryPlans").withIndex("by_object_state", q => q.eq("objectId", objectId)).collect())
    .filter(p => p.state !== "superseded" && p.demoRunId === (event.demoRunId ?? null) && p.affectedEventIds.length > 1);
  const lists = (p: Doc<"trajectoryPlans">) => p.eventRefs.some(r => same(r, eventReference(ref)));
  if (candidate.kind === "maneuver") {
    // Pair duplicates are one encounter; another encounter in the burn's horizon needs all-event trajectory
    // authorization even if it has not yet been put in a coordination room.
    const moverId = candidate.movingSide === "A" ? event.objectAId : event.objectBId;
    const lower = Date.parse(candidate.burnTimeUtc!), upper = lower + HORIZON_H * 3_600_000;
    const others = [
      ...await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", moverId)).collect(),
      ...await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", moverId).gte("tcaMs", lower).lte("tcaMs", upper)).collect(),
    ];
    const duplicate = (e: Doc<"events">) => Math.abs(e.tcaMs - event.tcaMs) <= 60_000 &&
      ((e.objectAId === event.objectAId && e.objectBId === event.objectBId) || (e.objectAId === event.objectBId && e.objectBId === event.objectAId));
    const linked = others.filter(e => e._id !== event._id && e.active && !["verified", "no_action_needed"].includes(e.status ?? "") && e.tcaMs >= lower && e.tcaMs <= upper &&
      (e.demoRunId ?? null) === (event.demoRunId ?? null) && !duplicate(e));
    const plans = await plansOf(candidate.movingObjectId!);
    const listing = plans.filter(lists), open = listing.filter(p => p.state !== "review_required");
    // Two live versions naming one selection would leave the bound version ambiguous: fail closed.
    if (open.length > 1) fail("SHARED_TRAJECTORY_REQUIRED", "This selection belongs to more than one shared trajectory plan.");
    plan = open[0] ?? listing[0] ?? null;
    if (plan) {
      // The plan authorizes the shared mover only while it is open and lists every incident this burn affects.
      if (plan.state === "review_required" || linked.some(e => !plan!.affectedEventIds.includes(e._id))) {
        fail("SHARED_TRAJECTORY_REQUIRED", "The trajectory plan does not cover every incident this burn affects.");
      }
    } else if (linked.length > 0) {
      fail("SHARED_TRAJECTORY_REQUIRED", "This spacecraft affects another incident; all-event trajectory authorization is required.");
    } else if (plans.some(p => p.state !== "scheduled")) {
      // A committed plan that does not list this selection is history; only an open one still claims the spacecraft.
      fail("SHARED_TRAJECTORY_REQUIRED", "This spacecraft already belongs to a shared trajectory plan.");
    } else if ((await plansOf(candidate.movingSide === "A" ? objectIds.B : objectIds.A)).some(lists)) {
      // The other spacecraft's shared burn also changes this encounter: one write cannot authorize a second burn.
      fail("SHARED_TRAJECTORY_REQUIRED", ONE_BURN);
    }
  } else {
    // A waiting card consents to another incident's shared burn of one of this incident's spacecraft when that burn's
    // plan lists this exact selection; the plan then schedules this incident with it.
    const plans = [...await plansOf(objectIds.A), ...objectIds.B !== objectIds.A ? await plansOf(objectIds.B) : []];
    const listing = plans.filter(lists), open = listing.filter(p => p.state !== "review_required");
    if (open.length > 1) fail("SHARED_TRAJECTORY_REQUIRED", "This selection belongs to more than one shared trajectory plan.");
    plan = open[0] ?? listing[0] ?? null;
    if (plan?.state === "review_required") fail("SHARED_TRAJECTORY_REQUIRED", "The trajectory plan covering this incident needs review.");
    // An open plan that names this incident but not this selection has not caught up with it: never wait alone meanwhile.
    if (!plan && plans.some(p => p.state !== "scheduled" && p.affectedEventIds.includes(event._id))) {
      fail("SHARED_TRAJECTORY_REQUIRED", "This incident belongs to a shared trajectory plan that does not list its selection.");
    }
  }
  const approvals = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", ref.eventId).eq("current", true)).collect();
  if (approved) {
    if (!["approved", "scheduled", "monitoring"].includes(event.status ?? "new")) fail("APPROVAL_REQUIRED", "Required human approvals have not completed.");
    for (const side of required) {
      const sideApprovals = approvals.filter(a => a.side === side);
      const approval = sideApprovals.sort((a, b) => b.at - a.at || b._creationTime - a._creationTime)[0];
      if (!approval || approval.status !== "approved" || approval.proposalId !== ref.proposalId || approval.revision !== ref.revision ||
          approval.selectionGeneration !== ref.selectionGeneration || approval.approvalRuleVersion !== ref.approvalRuleVersion ||
          approval.companyId !== companies[side] || approval.demoRunId !== (event.demoRunId ?? null) || approval.at < materialAt ||
          sideApprovals.some(a => a.status === "vetoed") || !authority.some(a => a.userId === approval.userId &&
            a.version === approval.assignmentVersion && a.objects.includes(objectIds[side]))) {
        fail("APPROVAL_REQUIRED", "Every required side must explicitly approve the current revision with current responsibility.");
      }
      if (plan && (approval.trajectoryPlanId !== plan._id || approval.trajectoryPlanVersion !== plan.planVersion)) {
        fail("APPROVAL_REQUIRED", "Every required side must approve the current version of the shared trajectory plan.");
      }
      if (!plan && (approval.trajectoryPlanId !== null || approval.trajectoryPlanVersion !== null)) fail("SHARED_TRAJECTORY_REQUIRED", "This approval belongs to a trajectory plan that no longer covers the incident.");
    }
  }
  // Frozen Round 1.5 schema has no candidate-set/rule pin columns. A versioned opaque authorization fingerprint
  // in evidenceKey binds those to the orbital evidence, ownership and authority. Private policy values stay out.
  const authorizationKey = `schedule-v1:${await sha256(canonical({ evidence: inputKey(facts), snapshotId, ref,
    candidateSetId: set._id, candidateVersion: set.version, candidateRevisionIds: set.candidateRevisionIds, candidate,
    workflow: event.workflow, required, owners, authority, demoRunId: event.demoRunId ?? null }))}`;
  const pinned: Pins = { snapshotId, evidenceKeys: [{ eventId: event._id, evidenceKey: authorizationKey }], policyRevisions,
    assignmentVersions: authority.map(a => ({ userId: a.userId, version: a.version })) };
  const movingCompany = candidate.movingSide ? companies[candidate.movingSide] : null;
  const filePath = movingCompany ? `operators/${movingCompany}/schedule.json` : null;
  // The immutable revision's content does not embed selectionGeneration: selecting the same revision again needs
  // fresh approval but may reuse its identical prepared content. The worker deduplicates via the separate intentKey.
  const entry = candidate.kind === "wait" ? null : { eventId: String(event._id), proposalId: String(ref.proposalId),
    revision: ref.revision, objectId: candidate.movingObjectId!,
    burnTimeUtc: wholeSecondUtc(Date.parse(candidate.burnTimeUtc!)), deltaVMs: candidate.deltaVMs!, direction: candidate.direction!, simulated: candidate.simulated };
  return { ref, event, selection, revision, candidate, set, facts, pinned, filePath, entry, approvals, plan };
}
type Context = Awaited<ReturnType<typeof context>>;
type Trajectory = { id: string; version: number } | null;
type Scope = { head: Context; parts: Context[]; plan: Doc<"trajectoryPlans"> | null; intentKey: string;
  refs: Infer<typeof eventRef>[]; pinned: Pins; trajectory: Trajectory };
const sortedUnique = <T>(rows: T[], key: (row: T) => string) =>
  [...new Map(rows.map(row => [key(row), row])).values()].sort((a, b) => key(a).localeCompare(key(b)));

/** The authorization unit of one physical schedule write: the incident itself, or every incident of its trajectory
 * plan, each fully re-checked, with the plan's first incident that selects the burn as the worker's request ref and
 * schedule entry. An incident that selects the waiting card consents to that burn: it is re-checked like the others but
 * adds no entry. One incident's approvals never authorize another: each part checks its own selection, approvals and
 * responsibility. */
async function scope(ctx: QueryCtx, ref: Ref, approved = false, allowPast = false, own?: Context): Promise<Scope> {
  const mine = own ?? await context(ctx, ref, approved, allowPast);
  if (!mine.plan) return { head: mine, parts: [mine], plan: null, intentKey: intentOf(ref), refs: [eventReference(ref)], pinned: mine.pinned, trajectory: null };
  const plan = mine.plan, parts: Context[] = [];
  // The plan's two event lists must name the same incidents once each, or an affected incident could skip its checks.
  const listed = plan.eventRefs.map(r => String(r.eventId)), affected = plan.affectedEventIds.map(String);
  if (new Set(listed).size !== listed.length || new Set(affected).size !== affected.length || listed.some(id => !affected.includes(id))) {
    fail("SHARED_TRAJECTORY_REQUIRED", "The trajectory plan's incidents are inconsistent.");
  }
  if (listed.length !== affected.length) fail("SHARED_TRAJECTORY_REQUIRED", PLAN_PENDING);
  for (const r of plan.eventRefs) {
    if (r.eventId === ref.eventId) { parts.push(mine); continue; }
    const event = await ctx.db.get(r.eventId);
    const c = await context(ctx, { ...r, approvalRuleVersion: event?.approvalRuleVersion ?? 0 }, approved, allowPast);
    if (c.plan?._id !== plan._id) fail("SHARED_TRAJECTORY_REQUIRED", "The affected incidents do not share one trajectory plan.");
    parts.push(c);
  }
  // Plan order, not the entry point, picks the head, so every affected incident reaches the same intent and worker ref.
  const head = parts.find(c => c.entry);
  if (!head) fail("SHARED_TRAJECTORY_REQUIRED", "No affected incident selects the shared burn.");
  const burn = (c: Context) => c.entry && canonical({ objectId: c.entry.objectId, burnTimeUtc: c.entry.burnTimeUtc, deltaVMs: c.entry.deltaVMs,
    direction: c.entry.direction, filePath: c.filePath, snapshotId: c.pinned.snapshotId });
  if (parts.some(c => c.entry && burn(c) !== burn(head))) fail("SHARED_TRAJECTORY_REQUIRED", ONE_BURN);
  // Every partner encounter, a waiting one included, is re-screened against the head's catalog.
  if (parts.some(c => c.pinned.snapshotId !== head.pinned.snapshotId)) fail("SHARED_TRAJECTORY_REQUIRED", "The affected incidents are pinned to different catalogs.");
  const pinned: Pins = { snapshotId: head.pinned.snapshotId, evidenceKeys: parts.flatMap(c => c.pinned.evidenceKeys),
    policyRevisions: sortedUnique(parts.flatMap(c => c.pinned.policyRevisions), r => `${r.companyId}:${r.revision}`),
    assignmentVersions: sortedUnique(parts.flatMap(c => c.pinned.assignmentVersions), r => `${r.userId}:${r.version}`) };
  // The head's ref comes first: commitIntent and recordCommit read refs[0] as the ref the worker jobs are bound to.
  const refs = [...plan.eventRefs.filter(r => r.eventId === head.ref.eventId), ...plan.eventRefs.filter(r => r.eventId !== head.ref.eventId)];
  return { head, parts, plan, intentKey: `trajectory:${plan._id}:version:${plan.planVersion}`, refs, pinned,
    trajectory: { id: String(plan._id), version: plan.planVersion } };
}

/** One entry per line, with commas at the start of subsequent entry lines: append-only diffs need not disclose any
 * previous, unrelated maneuver to the other incident party. These functions validate/render worker output only. */
export function scheduleContent(entries: unknown[]): string {
  return `{"maneuvers":[\n${entries.map((entry, i) => `${i ? "," : ""}${canonical(entry)}\n`).join("")}]}\n`;
}
export function scheduleDiff(filePath: string, before: string | null, after: string) {
  const entries = (JSON.parse(after) as { maneuvers: unknown[] }).maneuvers;
  const header = `--- ${before === null ? "/dev/null" : `a/${filePath}`}\n+++ b/${filePath}\n`;
  if (before === null) return `${header}@@ -0,0 +1,${entries.length + 2} @@\n${after.trimEnd().split("\n").map(line => `+${line}\n`).join("")}`;
  const count = (JSON.parse(before) as { maneuvers: unknown[] }).maneuvers.length;
  return `${header}@@ -${count + 1},0 +${count + 2} @@\n+${count ? "," : ""}${canonical(entries[count])}\n`;
}
function checkedArtifact(c: Context, before: string | null, after: string, diff: string) {
  if (!c.entry || !c.filePath || after.length > MAX_ARTIFACT || (before?.length ?? 0) > MAX_ARTIFACT || diff.length > 2 * MAX_ARTIFACT) fail("VALIDATION", "Invalid schedule artifact.");
  let previous: { maneuvers: Record<string, unknown>[] }, next: unknown;
  try { previous = before === null ? { maneuvers: [] } : JSON.parse(before); next = JSON.parse(after); }
  catch { fail("VALIDATION", "The prepared schedule is not valid JSON."); }
  if (!previous || !Array.isArray(previous.maneuvers) || Object.keys(previous).join() !== "maneuvers" ||
      previous.maneuvers.some(entry => !entry || typeof entry !== "object" || (entry.eventId === c.entry!.eventId && entry.proposalId === c.entry!.proposalId && entry.revision === c.entry!.revision)) ||
      !same(next, { maneuvers: [...previous.maneuvers, c.entry] }) || after !== scheduleContent([...previous.maneuvers, c.entry]) ||
      (before !== null && before !== scheduleContent(previous.maneuvers)) || diff !== scheduleDiff(c.filePath, before, after)) {
    fail("VALIDATION", "The worker preview must append only the exact selected maneuver, with its checked diff.");
  }
}

export const preview = internalQuery({
  args: { ref: selectionRef },
  handler: async (ctx, { ref }) => {
    const s = await scope(ctx, ref);
    if (s.parts.some(c => c.set.state !== "open")) fail("INVALID_STATE", "A scheduled candidate set cannot prepare a replacement schedule.");
    // For a plan, the worker request carries the plan's head (its first incident selecting the burn) as ref and entry.
    return { kind: s.head.candidate.kind, ref: s.head.ref, pinned: s.pinned, intentKey: s.intentKey, filePath: s.head.filePath, entry: s.head.entry,
      trajectory: s.trajectory };
  },
});

/** The event's current selection as a scheduling ref, or null when nothing complete is selected. */
async function currentRef(ctx: QueryCtx, eventId: Id<"events">): Promise<Ref | null> {
  const event = await ctx.db.get(eventId);
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  if (!event || !selection?.proposalId || selection.revision === null) return null;
  return { eventId, proposalId: selection.proposalId, revision: selection.revision, selectionGeneration: selection.generation,
    approvalRuleVersion: event.approvalRuleVersion ?? 0 };
}
const codeOf = (error: unknown) => error instanceof ConvexError && typeof error.data?.code === "string" ? error.data.code as string : null;

/** Call after a selection changes (one scheduled call per selection). Asks Factory to prepare the selected maneuver's
 * checked diff before anyone approves it. Idempotent per intent; a wait, a closed set or an already prepared intent
 * needs nothing. Approvals on a revision that was never previewed cannot be backed by a later preview, so that case is
 * logged instead (the selection must change for a new intent). */
export const requestPreview = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const ref = await currentRef(ctx, eventId);
    if (!ref) return { status: "skipped" as const, code: "NOT_SELECTED" };
    // Without a configured worker every selection would log the same failure; scheduling reports it once instead.
    try { scheduleConfig(); } catch { return { status: "skipped" as const, code: "WORKER_UNAVAILABLE" }; }
    let s: Scope;
    try { s = await scope(ctx, ref); }
    catch (error) {
      const code = codeOf(error);
      if (!code) throw error;
      // Otherwise approval later refuses for a preview that never comes. Once per selection; a partner that has not
      // selected yet is a normal wait.
      const message = (error as ConvexError<{ message: string }>).data.message;
      if (code === "SHARED_TRAJECTORY_REQUIRED" && message !== PLAN_PENDING) await auditOnce(ctx, ref, `${code}: ${message}`, intentOf(ref));
      return { status: "skipped" as const, code };
    }
    if (!s.head.entry || s.parts.some(c => c.set.state !== "open")) return { status: "skipped" as const, code: "NO_ARTIFACT" };
    // Every incident of a plan requests the head's preparation, so the scan below sees one chain per intent.
    const target = s.plan ? s.head.ref : ref;
    const existing = await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", s.intentKey)).unique();
    if (existing) return { status: "prepared" as const, code: null };
    // Selection and plan changes may each request the same selection before its first /prepare is recorded. Only a
    // first attempt counts (a poll has already pinned its scope); one that started reads the plan version in that same
    // run, so only a plan change inside that window is missed. Bounded scan of the newest jobs: a miss only repeats an
    // idempotent /prepare (same intentKey, same job id).
    const recent = await ctx.db.system.query("_scheduled_functions").order("desc").take(200);
    if (recent.some(job => {
      const args = job.args[0] as { ref?: unknown; attempt?: unknown; expectedPinned?: unknown } | undefined;
      return (job.state.kind === "pending" || job.state.kind === "inProgress") && /^maneuvers(\.js)?:prepare$/.test(job.name) && args?.attempt === 0 && args.expectedPinned === undefined && same(args.ref, target);
    })) return { status: "requested" as const, code: null };
    const early = s.parts.find(c => c.approvals.some(a => a.status === "approved") && c.revision.schedulePreviewHash === null);
    if (early) {
      await audit(ctx, early, "schedule_failed", "PREVIEW_AFTER_APPROVAL: An approval arrived before Factory prepared the schedule diff; select the plan again to prepare it.", { intentKey: s.intentKey });
      return { status: "skipped" as const, code: "PREVIEW_AFTER_APPROVAL" };
    }
    await ctx.scheduler.runAfter(0, calls.prepare, { ref: target, attempt: 0 });
    return { status: "requested" as const, code: null };
  },
});

/** Drives one Factory /prepare job to completion. The pins read before the request travel with every poll, so a
 * change while Droid works fails recordPreview instead of binding the diff to newer inputs. */
export const prepare = internalAction({
  args: { ref: selectionRef, attempt: v.number(), expectedPinned: v.optional(pinnedInputs), thenSchedule: v.optional(v.boolean()) },
  handler: async (ctx, { ref, attempt, expectedPinned, thenSchedule }) => {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= PREPARE_POLL_LIMIT) fail("VALIDATION", "Invalid polling attempt.");
    let intentKey: string | undefined;
    try {
      const p = await ctx.runQuery(calls.preview, { ref });
      if (!p.entry || !p.filePath) return null;
      intentKey = p.intentKey as string;
      const pinned = expectedPinned ?? p.pinned;
      const expected = { intentKey: p.intentKey, kind: "prepare" as const, ref: workerRef(p.ref), trajectory: p.trajectory as Trajectory };
      let job: ScheduleJob = attempt === 0
        ? await prepareSchedule({ intentKey: p.intentKey, filePath: p.filePath, ref: expected.ref, trajectory: expected.trajectory, entry: p.entry })
        : await getScheduleJob(await sha256(`prepare:${p.intentKey}`), expected);
      // Job errors arrive masked; the worker itself refuses (409) a retry that is unsafe or over its attempt limit.
      if (job.status === "failed") job = await retryScheduleJob(job.jobId, job.attempt, expected);
      if (job.status === "completed") {
        const a = job.result!;
        await ctx.runMutation(calls.recordPreview, { ref, expectedPinned: pinned, before: a.before, after: a.after, diff: a.diff });
        if (thenSchedule) await ctx.runMutation(calls.requestSchedule, { eventId: ref.eventId });
      } else if (job.status === "failed") await ctx.runMutation(calls.prepareFailed, { ref, intentKey, code: job.error!.code, message: job.error!.message });
      else if (attempt + 1 >= PREPARE_POLL_LIMIT) await ctx.runMutation(calls.prepareFailed, { ref, intentKey, code: "PREPARE_TIMEOUT", message: "Factory preparation polling reached its limit; select the plan again to retry." });
      else await ctx.scheduler.runAfter(POLL_DELAY_MS, calls.prepare, { ref, attempt: attempt + 1, expectedPinned: pinned, thenSchedule });
    } catch (error) { await ctx.runMutation(calls.prepareFailed, { ref, intentKey, ...failure(error) }); }
    return null;
  },
});

/** A failed preparation has no maneuver row yet; the event log keeps the failure visible to the room. */
export const recordPrepareFailure = internalMutation({
  args: { ref: selectionRef, code: v.string(), message: v.string(), intentKey: v.optional(v.string()) },
  handler: async (ctx, { ref, code, message, intentKey = intentOf(ref) }) => {
    const event = await ctx.db.get(ref.eventId), current = await currentRef(ctx, ref.eventId);
    // A preparation overtaken by a newer selection is simply obsolete, and one that another chain already recorded
    // succeeded; neither is a failure to show.
    if (!event || !current || intentOf(current) !== intentOf(ref)) return null;
    if (await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", intentKey)).unique()) return null;
    await auditOnce(ctx, ref, `${code}: ${message}`, intentKey);
    return null;
  },
});
/** Logs a scheduling failure for the room unless the same one was just logged for this intent. */
async function auditOnce(ctx: MutationCtx, ref: Ref, summary: string, intentKey: string) {
  const event = await ctx.db.get(ref.eventId);
  if (!event) return;
  summary = summary.slice(0, 500);
  const recent = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", ref.eventId)).order("desc").take(20);
  if (recent.some(l => l.action === "schedule_failed" && l.summary === summary && l.after?.intentKey === intentKey)) return;
  await audit(ctx, { event, ref }, "schedule_failed", summary, { intentKey });
}

export const recordPreview = internalMutation({
  args: { ref: selectionRef, expectedPinned: pinnedInputs, before: v.union(v.string(), v.null()), after: v.string(), diff: v.string() },
  handler: async (ctx, { ref, expectedPinned, before, after, diff }) => {
    const s = await scope(ctx, ref);
    if (!same(s.pinned, expectedPinned)) fail("STALE_REVISION", "Authorization inputs changed while Factory prepared the preview.");
    checkedArtifact(s.head, before, after, diff);
    const hash = await sha256(after);
    const existing = await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", s.intentKey)).unique();
    if (existing) {
      if (!same(existing.pinned, expectedPinned) || existing.diff !== diff || s.parts.some(c => c.revision.schedulePreviewHash !== hash)) fail("STALE_REVISION", "An intent's prepared artifact is immutable; publish a new revision.");
      return existing._id;
    }
    if (s.parts.some(c => c.set.state !== "open")) fail("INVALID_STATE", "A scheduled candidate set cannot prepare a replacement schedule.");
    for (const c of s.parts) {
      if (c.revision.schedulePreviewHash !== null && c.revision.schedulePreviewHash !== hash) fail("STALE_REVISION", "This revision already has a different preview.");
      // A new generation of an already previewed revision carries byte-identical content, so approvals given after that
      // revision's first preview were given on this diff. Anything else must be prepared before collecting approvals.
      const since = await previewedAt(ctx, c.ref);
      if (c.approvals.some(a => a.status === "approved" && (since === null || a.at < since))) fail("INVALID_STATE", "Prepare the checked preview before collecting human approvals.");
    }
    // Every affected incident shows the same diff: one schedule write for the shared burn.
    for (const c of s.parts) await ctx.db.patch(c.revision._id, { schedulePreviewDiff: diff, schedulePreviewHash: hash });
    const maneuverId = await ctx.db.insert("maneuvers", { refs: s.refs, trajectoryPlanId: s.plan?._id ?? null, trajectoryPlanVersion: s.plan?.planVersion ?? null,
      pinned: s.pinned, intentKey: s.intentKey, status: "preview", filePath: s.head.filePath!, diff, commitSha: null, writtenBy: "droid",
      rescreenJobId: null, rescreen: null, error: null, reviewRequired: false, demoRunId: s.head.event.demoRunId ?? null, updatedAt: Date.now() });
    for (const c of s.parts) await ctx.db.insert("maneuverEvents", { maneuverId, eventId: c.event._id });
    if (s.plan) await ctx.db.patch(s.plan._id, { maneuverId, updatedAt: Date.now() });
    return maneuverId;
  },
});

async function audit(ctx: MutationCtx, c: Pick<Context, "event" | "ref">, action: Doc<"log">["action"], summary: string, after: Doc<"log">["after"] = null) {
  await ctx.db.insert("log", { eventId: c.event._id, actor: { kind: "system" }, action, summary, texts: null, before: null, after,
    proposalId: c.ref.proposalId, revision: c.ref.revision, roomId: null, demoRunId: c.event.demoRunId ?? null, simulated: c.event.simulated, at: Date.now() });
}
/** Resets every incident of the intent, each with its own wording; a plan needs review before it can authorize again. */
async function reset(ctx: MutationCtx, row: Maneuver, reason: string) {
  for (const ref of row.refs) await resetEvent(ctx, row, ref, reason);
  const plan = row.trajectoryPlanId && await ctx.db.get(row.trajectoryPlanId);
  if (plan && plan.state !== "superseded" && plan.planVersion === row.trajectoryPlanVersion) await ctx.db.patch(plan._id, { state: "review_required", updatedAt: Date.now() });
  // The refused version must not strand the mover: the next sync supersedes it and drafts or drops the plan.
  if (row.trajectoryPlanId) await ctx.scheduler.runAfter(0, calls.syncPlans, { eventId: row.refs[0].eventId });
}
async function resetEvent(ctx: MutationCtx, row: Maneuver, ref: Maneuver["refs"][number], reason: string) {
  const event = await ctx.db.get(ref.eventId);
  if (!event) return;
  if (event.requiredApprovalSides?.length === 2) reason = reason.replace(/^Approval reset:/, "Both approvals reset:");
  const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", ref.eventId)).unique();
  // A late result must never invalidate a newer independent selection.
  if (!selection || selection.proposalId !== ref.proposalId || selection.revision !== ref.revision || selection.generation !== ref.selectionGeneration) return;
  for (const approval of await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", ref.eventId).eq("current", true)).collect()) await ctx.db.patch(approval._id, { current: false });
  await ctx.db.patch(selection._id, { generation: selection.generation + 1, lastReset: { at: Date.now(), reason } });
  await ctx.db.patch(event._id, { status: "agents", situation: null });
  await audit(ctx, { event, ref: { ...ref, approvalRuleVersion: event.approvalRuleVersion ?? 0 } }, "approvals_reset", reason,
    { generation: selection.generation + 1, intentKey: row.intentKey });
}
/** When this exact revision's checked diff was first recorded (any generation). recordPreview keeps one content hash per
 * revision, so every intent of the revision shows the same diff. */
async function previewedAt(ctx: QueryCtx, ref: Pick<Ref, "eventId" | "proposalId" | "revision">) {
  let first: number | null = null;
  for (const link of await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", ref.eventId)).collect()) {
    const row = await ctx.db.get(link.maneuverId);
    if (row?.writtenBy === "droid" && row.refs.some(r => r.eventId === ref.eventId && r.proposalId === ref.proposalId && r.revision === ref.revision)) {
      first = Math.min(first ?? Infinity, row._creationTime);
    }
  }
  return first;
}
async function currentFor(ctx: QueryCtx, row: Maneuver, allowPast = false) {
  if (row.writtenBy !== "droid") fail("INVALID_STATE", "A backend substitute cannot authorize a Factory artifact.");
  const ref = row.refs[0], event = await ctx.db.get(ref.eventId);
  const s = await scope(ctx, { ...ref, approvalRuleVersion: event?.approvalRuleVersion ?? 0 }, true, allowPast);
  if (s.intentKey !== row.intentKey || !same(s.refs, row.refs) || !same(s.pinned, row.pinned) || row.reviewRequired ||
      s.parts.some(c => c.revision.schedulePreviewDiff !== row.diff || !c.revision.schedulePreviewHash)) {
    fail("STALE_REVISION", "The prepared intent's pinned inputs changed; review and approve a new revision.");
  }
  for (const c of s.parts) {
    const since = Math.min(row._creationTime, await previewedAt(ctx, c.ref) ?? Infinity);
    if (c.approvals.some(a => a.at < Math.floor(since))) fail("APPROVAL_REQUIRED", "Approval must follow the prepared preview.");
  }
  return s;
}
/** A row whose write may already be with the worker and that covers this exact selection (single or plan intent). */
async function handedFor(ctx: QueryCtx, ref: Ref) {
  for (const link of await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", ref.eventId)).collect()) {
    const row = await ctx.db.get(link.maneuverId);
    if (row && handedOver(row) && row.refs.some(r => same(r, eventReference(ref)))) return row;
  }
  return null;
}

export const start = internalMutation({
  args: { ref: selectionRef, expectedPinned: pinnedInputs },
  handler: async (ctx, { ref, expectedPinned }) => {
    const s = await scope(ctx, ref, true);
    if (!same(s.pinned, expectedPinned)) fail("STALE_REVISION", "Scheduling inputs changed after authorization.");
    return await startIntent(ctx, s);
  },
});

/** Call once the event reaches `approved` (all required sides). Reads the current selection itself, so the caller needs
 * no pins. A failure is logged for the room and returned, never thrown, so the approving transaction is unaffected. */
export const requestSchedule = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const ref = await currentRef(ctx, eventId);
    if (!ref) return { maneuverId: null, status: "skipped", code: "NOT_SELECTED" };
    // A commit chain lost (or failed on a missed poll) after its write may have been handed over resumes without
    // re-authorizing: it only reads back and records that job; any new /commit or retry still goes through reserveCommit.
    const handed = await handedFor(ctx, ref);
    if (handed) {
      await ctx.scheduler.runAfter(0, calls.commit, { maneuverId: handed._id, attempt: 0 });
      return { maneuverId: handed._id, status: "committing", code: null };
    }
    try {
      // A shared burn is scheduled once, when the last affected incident completes its approvals; until then any
      // affected incident (this one included) asking for it waits instead of failing.
      const plan = (await context(ctx, ref)).plan;
      let s: Scope;
      try { s = await scope(ctx, ref, true); }
      catch (error) {
        if (!plan || codeOf(error) !== "APPROVAL_REQUIRED") throw error;
        // APPROVAL_REQUIRED also covers an invalid workflow; only missing approvals wait, so check the plan without them.
        await scope(ctx, ref);
        return { maneuverId: null, status: "waiting", code: "PLAN_APPROVALS_PENDING" };
      }
      // A reset advanced the generation of a revision humans already saw previewed: prepare this intent's identical
      // diff now and continue here once it is recorded (recordPreview re-checks the content and approval times).
      if (s.head.entry && s.parts.every(c => c.revision.schedulePreviewHash !== null) &&
          !await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", s.intentKey)).unique()) {
        await ctx.scheduler.runAfter(0, calls.prepare, { ref, attempt: 0, thenSchedule: true });
        return { maneuverId: null, status: "preparing", code: null };
      }
      return { ...await startIntent(ctx, s), code: null };
    }
    catch (error) {
      const code = codeOf(error), event = await ctx.db.get(eventId);
      if (!code) throw error;
      if (event) await audit(ctx, { event, ref }, "schedule_failed", `${code}: ${(error as ConvexError<{ message: string }>).data.message}`.slice(0, 500), { intentKey: intentOf(ref) });
      return { maneuverId: null, status: "failed", code };
    }
  },
});

async function startIntent(ctx: MutationCtx, s: Scope) {
  const c = s.head;
  // Only an incident outside any plan waits on its own; a plan's head always selects the burn.
  if (!s.plan && c.candidate.kind === "wait") {
    if (c.event.status !== "monitoring") {
      await ctx.db.patch(c.event._id, { status: "monitoring", situation: null });
      await audit(ctx, c, "status_changed", "Required operators approved waiting; monitoring continues without a maneuver.", { status: "monitoring" });
    }
    return { maneuverId: null, status: "monitoring" };
  }
  const row = await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", s.intentKey)).unique();
  if (!row) fail("WORKER_UNAVAILABLE", "Factory must prepare a checked preview before this maneuver can be scheduled.");
  await currentFor(ctx, row);
  // A commit chain lost after reservation would strand the row; the worker returns the same job for the same intent.
  if (row.status === "committing") await ctx.scheduler.runAfter(0, calls.commit, { maneuverId: row._id, attempt: 0 });
  if (["committed", "committing", "rescreening"].includes(row.status)) return { maneuverId: row._id, status: row.status };
  if (row.status === "refused") fail("STALE_REVISION", "A refused intent needs a new approved revision.");
  if (row.rescreen?.passed) {
    await ctx.db.patch(row._id, { status: "committing", error: null, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, calls.commit, { maneuverId: row._id, attempt: 0 });
    return { maneuverId: row._id, status: "committing" };
  }
  await ctx.db.patch(row._id, { status: "rescreening", error: null, rescreenJobId: `rescreen-${row._id}`, updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, calls.submit, { maneuverId: row._id });
  return { maneuverId: row._id, status: "rescreening" };
}

/** The re-screen of one partner encounter. A shared burn is re-screened against the full catalog for every affected
 * incident's partner (simulated partners are not in the catalog), one job per partner; all must pass. */
export const jobInput = internalQuery({
  args: { maneuverId: v.id("maneuvers"), partner: v.optional(v.number()) },
  handler: async (ctx, { maneuverId, partner = 0 }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.status !== "rescreening") return null;
    const s = await currentFor(ctx, row), c = s.parts[partner], e = s.head.entry;
    if (!c || !e || !row.rescreenJobId) fail("INVALID_STATE", "The re-screen request has no selected maneuver.");
    const request: RescreenRequest = { jobId: partner === 0 ? row.rescreenJobId : `${row.rescreenJobId}-${partner}`, snapshotId: s.pinned.snapshotId,
      evidenceVersion: evidenceVersionOf(c.facts), objectId: e.objectId,
      // The partner is the encounter's other object; a waiting incident selects no moving side of its own.
      partnerObjectId: c.facts.objectA.objectId === e.objectId ? c.facts.objectB.objectId : c.facts.objectA.objectId,
      maneuver: { burnTimeUtc: e.burnTimeUtc, deltaVMs: e.deltaVMs, direction: e.direction }, tcaUtc: wholeSecondUtc(c.event.tcaMs),
      fromUtc: e.burnTimeUtc, toUtc: wholeSecondUtc(Date.parse(e.burnTimeUtc) + HORIZON_H * 3_600_000),
      proposalId: String(c.ref.proposalId), revision: c.ref.revision, ...(c.event.demoRunId ? { runId: String(c.event.demoRunId) } : {}) };
    return { request, pinned: row.pinned, partners: s.parts.length };
  },
});

function failure(error: unknown) {
  if (error instanceof ConvexError && typeof error.data?.code === "string") return { code: error.data.code, message: "Current scheduling authorization is no longer valid." };
  // The schedule client's messages are fixed strings; worker details never reach them.
  if (error instanceof ScheduleServiceError) return { code: error.code, message: error.message };
  return orbitFailure(error);
}
export const recordFailure = internalMutation({
  args: { maneuverId: v.id("maneuvers"), code: v.string(), message: v.string(), reviewRequired: v.optional(v.boolean()) },
  handler: async (ctx, { maneuverId, code, message, reviewRequired = false }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.status === "committed" || row.status === "refused") return null;
    const error = `${code}: ${message}`.slice(0, 500);
    if (row.status === "failed" && row.error === error && row.reviewRequired === reviewRequired) return null;
    await ctx.db.patch(row._id, { status: "failed", error, reviewRequired: row.reviewRequired || reviewRequired, updatedAt: Date.now() });
    if (reviewRequired) await reset(ctx, row, "Approval reset: the pinned scheduling inputs changed.");
    for (const r of row.refs) {
      const event = await ctx.db.get(r.eventId);
      if (event) await audit(ctx, { event, ref: { ...r, approvalRuleVersion: event.approvalRuleVersion ?? 0 } }, "schedule_failed", error, { intentKey: row.intentKey });
    }
    return null;
  },
});
async function failAction(ctx: { runMutation: (ref: typeof calls.fail, args: any) => Promise<any> }, maneuverId: Id<"maneuvers">, error: unknown) {
  const safe = failure(error);
  await ctx.runMutation(calls.fail, { maneuverId, ...safe, reviewRequired: ["STALE_REVISION", "NOT_SELECTED", "APPROVAL_REQUIRED", "INVALID_STATE", "SHARED_TRAJECTORY_REQUIRED"].includes(safe.code) });
}
const screened = v.array(rescreen);
export const submit = internalAction({
  args: { maneuverId: v.id("maneuvers"), partner: v.optional(v.number()), results: v.optional(screened) },
  handler: async (ctx, { maneuverId, partner = 0, results = [] }) => {
    try {
      const input = await ctx.runQuery(calls.jobInput, { maneuverId, partner });
      if (!input) return null;
      await startRescreen(input.request);
      await ctx.scheduler.runAfter(0, calls.poll, { maneuverId, attempt: 0, partner, results });
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});
/** One verdict for the intent: it passes only if every partner passed; the first refusal is the reason. */
function combined(results: Infer<typeof rescreen>[]): Infer<typeof rescreen> {
  const refused = results.find(r => !r.passed), misses = results.map(r => r.originalMissAfterKm).filter((m): m is number => m !== null);
  return { ...results[0], passed: !refused, objectsChecked: Math.max(...results.map(r => r.objectsChecked)),
    originalMissAfterKm: refused ? refused.originalMissAfterKm : misses.length ? Math.min(...misses) : null,
    newConjunctions: results.flatMap(r => r.newConjunctions), refusalReason: refused?.refusalReason ?? null };
}
export const poll = internalAction({
  args: { maneuverId: v.id("maneuvers"), attempt: v.number(), partner: v.optional(v.number()), results: v.optional(screened) },
  handler: async (ctx, { maneuverId, attempt, partner = 0, results = [] }) => {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= POLL_LIMIT) fail("VALIDATION", "Invalid polling attempt.");
    try {
      const input = await ctx.runQuery(calls.jobInput, { maneuverId, partner });
      if (!input) return null;
      const req: RescreenRequest = input.request;
      const job = await getRescreenJob(req.jobId, req);
      if (job.status === "failed") await ctx.runMutation(calls.fail, { maneuverId, code: job.error!.code, message: job.error!.message });
      else if (job.status === "completed") {
        const result = job.result!;
        if (result.horizonH !== HORIZON_H || (result.passed && (result.screenedFromUtc !== req.fromUtc || result.screenedToUtc !== req.toUtc)) ||
            (result.proposalId !== undefined && result.proposalId !== req.proposalId) || (result.revision !== undefined && result.revision !== req.revision) ||
            (result.runId ?? undefined) !== req.runId) fail("INVALID_RESPONSE", "Re-screen result does not describe this exact requested trajectory and horizon.");
        const all = [...results, { snapshotId: result.snapshotId, evidenceKeys: input.pinned.evidenceKeys, passed: result.passed,
          objectsChecked: result.objectsChecked, horizonH: result.horizonH, originalMissAfterKm: result.originalMissAfterKm,
          newConjunctions: result.newConjunctions.map(({ objectId, name, tcaUtc, missKm }) => ({ objectId, name, tcaUtc, missKm })), refusalReason: result.refusalReason }];
        if (result.passed && partner + 1 < input.partners) await ctx.scheduler.runAfter(0, calls.submit, { maneuverId, partner: partner + 1, results: all });
        else await ctx.runMutation(calls.finishRescreen, { maneuverId, jobId: job.jobId, expectedPinned: input.pinned, result: combined(all) });
      } else if (attempt + 1 >= POLL_LIMIT) await ctx.runMutation(calls.fail, { maneuverId, code: "RESCREEN_TIMEOUT", message: "Re-screen polling reached its limit; retry the same intent to read the same job." });
      else await ctx.scheduler.runAfter(POLL_DELAY_MS, calls.poll, { maneuverId, attempt: attempt + 1, partner, results });
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});
export const finishRescreen = internalMutation({
  args: { maneuverId: v.id("maneuvers"), jobId: v.string(), expectedPinned: pinnedInputs, result: rescreen },
  handler: async (ctx, { maneuverId, jobId, expectedPinned, result }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.status !== "rescreening") return null;
    const scoped = await currentFor(ctx, row);
    if (!row.rescreenJobId || (jobId !== row.rescreenJobId && !jobId.startsWith(`${row.rescreenJobId}-`)) || !same(expectedPinned, row.pinned) || result.snapshotId !== row.pinned.snapshotId ||
        !same(result.evidenceKeys, row.pinned.evidenceKeys) || result.horizonH !== HORIZON_H ||
        (result.passed && (result.originalMissAfterKm === null || result.originalMissAfterKm < 1 || result.newConjunctions.some(n => n.missKm < 1) || result.refusalReason !== null)) ||
        (!result.passed && !result.refusalReason)) fail("INVALID_RESPONSE", "The re-screen result is not bound to this intent.");
    await ctx.db.patch(row._id, { status: result.passed ? "committing" : "refused", rescreen: result, error: result.refusalReason, updatedAt: Date.now() });
    for (const c of scoped.parts) await audit(ctx, c, result.passed ? "rescreened" : "refused", result.passed ? "The pinned maneuver passed catalog re-screening; its write intent is reserved." : result.refusalReason!, { intentKey: row.intentKey });
    if (!result.passed) await reset(ctx, row, `Approval reset: ${result.refusalReason}`);
    else await ctx.scheduler.runAfter(0, calls.commit, { maneuverId, attempt: 0 });
    return null;
  },
});

/** Recheck immediately before handing an existing immutable intent to the external worker. It returns the same
 * key on retries. The external append/Git commit is outside this transaction and must deduplicate by that key. */
export const reserveCommit = internalMutation({
  args: { maneuverId: v.id("maneuvers") },
  handler: async (ctx, { maneuverId }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row) fail("NOT_FOUND", "Schedule intent not found.");
    if (row.status === "committed") return { status: "committed", intentKey: row.intentKey, commitSha: row.commitSha };
    const s = await currentFor(ctx, row);
    if (!row.rescreen?.passed || !["committing", "failed"].includes(row.status)) fail("INVALID_STATE", "A passed re-screen is required before reserving the write.");
    if (row.status !== "committing") await ctx.db.patch(row._id, { status: "committing", error: null, updatedAt: Date.now() });
    return { status: "reserved", intentKey: row.intentKey, filePath: row.filePath, diff: row.diff, contentHash: s.head.revision.schedulePreviewHash,
      demoRunId: row.demoRunId, ref: s.head.ref, trajectory: s.trajectory };
  },
});
/** Unauthorized read of a reserved intent for polling its external commit job. A write already handed to the worker
 * must still be recorded when inputs move, so polls do not re-run the authorization check; recordCommit flags it. */
/** A write may have reached the worker: committing, or failed after a passed re-screen (e.g. a missed poll). */
const trajectoryOf = (row: Maneuver): Trajectory =>
  row.trajectoryPlanId && row.trajectoryPlanVersion !== null ? { id: String(row.trajectoryPlanId), version: row.trajectoryPlanVersion } : null;
const handedOver = (row: Maneuver) => row.status === "committing" || (row.status === "failed" && row.rescreen?.passed === true);
export const commitIntent = internalQuery({
  args: { maneuverId: v.id("maneuvers") },
  handler: async (ctx, { maneuverId }) => {
    const row = await ctx.db.get(maneuverId);
    const event = row && row.refs.length > 0 ? await ctx.db.get(row.refs[0].eventId) : null;
    if (!row || !event || !handedOver(row)) return null;
    return { intentKey: row.intentKey, ref: { ...row.refs[0], approvalRuleVersion: event.approvalRuleVersion ?? 0 }, trajectory: trajectoryOf(row) };
  },
});
/** Reserve (attempt 0) or poll the Factory /commit for a passed re-screen. The commit request repeats the exact
 * completed /prepare job (job id, content hash, previous file hash and Git commit), read back from the worker because
 * the maneuver row stores only the diff. Retrying the same intent returns the same worker job, never a second entry. */
export const commit = internalAction({
  args: { maneuverId: v.id("maneuvers"), attempt: v.optional(v.number()), ref: v.optional(selectionRef) },
  handler: async (ctx, { maneuverId, attempt = 0, ref: sentRef }) => {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= POLL_LIMIT) fail("VALIDATION", "Invalid polling attempt.");
    try {
      const known = await ctx.runQuery(calls.commitIntent, { maneuverId });
      if (attempt > 0) {
        if (!known) return null;
        // The worker job is bound to the ref sent with /commit; a later rule-version change must not hide its result.
        const ref = sentRef ?? known.ref;
        let job: ScheduleJob;
        try { job = await getScheduleJob(await sha256(`commit:${known.intentKey}`), { intentKey: known.intentKey, kind: "commit", ref: workerRef(ref), trajectory: known.trajectory }); }
        catch (error) {
          // A write already handed over may still complete: an unreachable worker is only a missed poll, not a failure.
          if (!(error instanceof ScheduleServiceError && error.code === "WORKER_UNAVAILABLE") || attempt + 1 >= POLL_LIMIT) throw error;
          await ctx.scheduler.runAfter(POLL_DELAY_MS, calls.commit, { maneuverId, attempt: attempt + 1, ref });
          return null;
        }
        return await settleCommit(ctx, maneuverId, attempt, job, known.intentKey, ref, known.trajectory, false);
      }
      // A write handed over by a lost chain is read back and recorded before anything is re-authorized; only a new
      // /commit needs current authorization. An unknown job (or an unreachable worker) falls through to the reservation.
      if (known) {
        const handed = await readHanded(known.intentKey, known.ref, known.trajectory);
        // A failed job is retried only after the reservation below has re-authorized the write.
        if (handed && handed.job.status !== "failed") return await settleCommit(ctx, maneuverId, attempt, handed.job, known.intentKey, handed.ref, known.trajectory, false);
      }
      {
        const intent = await ctx.runMutation(calls.reserve, { maneuverId });
        if (intent.status === "committed") return null;
        const { intentKey, ref, trajectory } = intent as { intentKey: string; ref: Ref; trajectory: Trajectory };
        const prepared = await getScheduleJob(await sha256(`prepare:${intentKey}`), { intentKey, kind: "prepare", ref: workerRef(ref), trajectory });
        const a = prepared.result;
        if (prepared.status !== "completed" || !a || a.contentHash !== intent.contentHash || a.diff !== intent.diff || a.filePath !== intent.filePath) {
          fail("INVALID_RESPONSE", "The worker's prepared artifact is not the approved preview.");
        }
        const job = await commitSchedule({ intentKey, preparedJobId: prepared.jobId, contentHash: a.contentHash, expectedPreviousHash: a.expectedPreviousHash,
          expectedPreviousCommit: a.expectedPreviousCommit, ref: workerRef(ref), trajectory });
        return await settleCommit(ctx, maneuverId, attempt, job, intentKey, ref, trajectory, true);
      }
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});
/** The rows keep no approval rule version, and the worker job is bound to the one sent. A resumed chain looks for it,
 * newest first, over a few recent versions; an unknown job or an unreachable worker yields null. */
async function readHanded(intentKey: string, current: Ref, trajectory: Trajectory) {
  const jobId = await sha256(`commit:${intentKey}`);
  for (let version = current.approvalRuleVersion; version >= Math.max(1, current.approvalRuleVersion - 9); version--) {
    const ref = { ...current, approvalRuleVersion: version };
    try { return { job: await getScheduleJob(jobId, { intentKey, kind: "commit", ref: workerRef(ref), trajectory }), ref }; }
    catch (error) {
      if (!(error instanceof ScheduleServiceError)) throw error;
      if (error.code === "WORKER_UNAVAILABLE") return null;
      if (error.code !== "INVALID_RESPONSE" || version === 1) throw error;
    }
  }
  return null;
}
type ActionCtx = { runMutation: (ref: any, args: any) => Promise<any>; scheduler: { runAfter: (ms: number, ref: any, args: any) => Promise<unknown> } };
async function settleCommit(ctx: ActionCtx, maneuverId: Id<"maneuvers">, attempt: number, job: ScheduleJob, intentKey: string, ref: Ref,
    trajectory: Trajectory, authorized: boolean) {
  const expected = { intentKey, kind: "commit" as const, ref: workerRef(ref), trajectory };
  // Only an infrastructure failure is retryable for a write, and only right after reserveCommit re-authorized it; the
  // worker refuses (409) any other retry. A failure seen while polling is recorded; the next request re-authorizes.
  if (job.status === "failed" && authorized) job = await retryScheduleJob(job.jobId, job.attempt, expected);
  if (job.status === "completed") {
    const a = job.result!;
    await ctx.runMutation(calls.recordCommit, { maneuverId, intentKey, filePath: a.filePath, after: a.after, diff: a.diff, commitSha: a.commitSha! });
  } else if (job.status === "failed") await ctx.runMutation(calls.fail, { maneuverId, code: job.error!.code, message: job.error!.message });
  else if (attempt + 1 >= POLL_LIMIT) await ctx.runMutation(calls.fail, { maneuverId, code: "SCHEDULE_TIMEOUT", message: "Factory commit polling reached its limit; retry the same intent to read the same job." });
  else await ctx.scheduler.runAfter(POLL_DELAY_MS, calls.commit, { maneuverId, attempt: attempt + 1, ref });
  return null;
}

export const recordCommit = internalMutation({
  args: { maneuverId: v.id("maneuvers"), intentKey: v.string(), filePath: v.string(), after: v.string(), diff: v.string(), commitSha: v.string() },
  handler: async (ctx, { maneuverId, intentKey, filePath, after, diff, commitSha }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.intentKey !== intentKey || filePath !== row.filePath || diff !== row.diff || !/^[a-f0-9]{40,64}$/.test(commitSha) || after.length > MAX_ARTIFACT) fail("VALIDATION", "Invalid worker commit result.");
    const ref = row.refs[0];
    const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q => q.eq("proposalId", ref.proposalId).eq("revision", ref.revision)).unique();
    if (!revision || await sha256(after) !== revision.schedulePreviewHash) fail("VALIDATION", "The committed content differs from the approved preview.");
    if (row.status === "committed") {
      if (row.commitSha !== commitSha) fail("INVALID_STATE", "This intent already has a different committed artifact.");
      return row._id;
    }
    if (!row.rescreen?.passed || !["committing", "failed"].includes(row.status)) fail("INVALID_STATE", "This write intent was never reserved.");
    let s: Scope | null = null;
    try { s = await currentFor(ctx, row, true); } catch { /* The actual artifact remains historical even when inputs moved after reservation. */ }
    await ctx.db.patch(row._id, { status: "committed", commitSha, writtenBy: "droid", error: s ? null : "The reserved inputs changed; the committed artifact requires review.",
      reviewRequired: row.reviewRequired || !s, updatedAt: Date.now() });
    if (s) {
      for (const c of s.parts) {
        await ctx.db.patch(c.event._id, { status: "scheduled", situation: null });
        await ctx.db.patch(c.set._id, { state: "scheduled" });
      }
      if (s.plan) await ctx.db.patch(s.plan._id, { state: "scheduled", maneuverId: row._id, updatedAt: Date.now() });
    } else await reset(ctx, row, "Approval reset: inputs changed after the schedule write was reserved.");
    for (const r of row.refs) {
      const event = await ctx.db.get(r.eventId);
      if (event) await audit(ctx, { event, ref: { ...r, approvalRuleVersion: event.approvalRuleVersion ?? 0 } }, "schedule_committed",
        "Factory recorded the schedule artifact; this is not evidence of maneuver execution.", { intentKey, maneuverId, commitSha, reviewRequired: s ? "false" : "true" });
    }
    return row._id;
  },
});

export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const { user, company } = await requireUser(ctx);
    const event = await ctx.db.get(eventId);
    const objects = event ? await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]) : [];
    let authorized = false;
    if (user.role === "operator" || user.role === "head_of_ops") for (const object of objects) {
      if (!object) continue;
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
      const assignment = user.role === "operator" ? await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", object.objectId)).unique() : null;
      if (owner?.companyId === company._id && (user.role === "head_of_ops" || assignment?.active)) authorized = true;
    }
    if (!event || !authorized) fail("FORBIDDEN", "This incident is outside your current fleet responsibility.");
    const links = await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect();
    const rows = (await Promise.all(links.map(l => ctx.db.get(l.maneuverId)))).filter((row): row is Maneuver => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime);
    const row = rows[0];
    if (!row) return null;
    let reviewRequired = row.reviewRequired;
    try {
      if (row.status === "preview") {
        const first = await ctx.db.get(row.refs[0].eventId);
        const s = await scope(ctx, { ...row.refs[0], approvalRuleVersion: first?.approvalRuleVersion ?? 0 }, false, true);
        reviewRequired ||= s.intentKey !== row.intentKey || !same(s.pinned, row.pinned);
      } else await currentFor(ctx, row, true);
    } catch { reviewRequired = true; }
    const screen = row.rescreen && (({ evidenceKeys: _keys, ...shared }) => shared)(row.rescreen);
    return { maneuverId: row._id, refs: row.refs, intentKey: row.intentKey, status: row.status, filePath: row.filePath, diff: row.diff,
      commitSha: row.commitSha, writtenBy: row.writtenBy, rescreen: screen,
      error: row.error, reviewRequired, simulated: event.simulated, demoRunId: row.demoRunId, updatedAt: new Date(row.updatedAt).toISOString(),
      execution: "not_verified" as const };
  },
});
