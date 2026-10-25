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

// Round 2 owns authorization and durable job state, not the Factory worker. preview exposes a preparation request;
// recordPreview / recordCommit accept results from a future trusted worker adapter. They never write a file. The
// commit action deliberately fails with WORKER_UNAVAILABLE until Round 4 wires the Round 3 worker. No substitute.
// All write entry points are internal: only an approval mutation / scheduler may initiate them, not a browser.
const selectionRef = v.object({ ...eventRef.fields, approvalRuleVersion: v.number() });
type Ref = Infer<typeof selectionRef>;
type Pins = Infer<typeof pinnedInputs>;
type Maneuver = Doc<"maneuvers">;
export const POLL_LIMIT = 24;
export const POLL_DELAY_MS = 5_000;
export const HORIZON_H = 72;
const MAX_ARTIFACT = 128_000;
const WORKER_UNAVAILABLE = "WORKER_UNAVAILABLE: The Factory schedule worker is not connected. No schedule was written.";
const calls = {
  submit: makeFunctionReference<"action">("maneuvers:submit"),
  poll: makeFunctionReference<"action">("maneuvers:poll"),
  jobInput: makeFunctionReference<"query">("maneuvers:jobInput"),
  finishRescreen: makeFunctionReference<"mutation">("maneuvers:finishRescreen"),
  fail: makeFunctionReference<"mutation">("maneuvers:recordFailure"),
  reserve: makeFunctionReference<"mutation">("maneuvers:reserveCommit"),
  commit: makeFunctionReference<"action">("maneuvers:commit"),
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
async function sha256(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const validVersion = (n: number) => Number.isSafeInteger(n) && n >= 1;

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
  if (candidate.kind === "maneuver") {
    // R4 supplies all-event trajectory authorization. Pair duplicates are one encounter; another encounter in the
    // burn's horizon needs that contract even if it has not yet been put in a coordination room.
    const moverId = candidate.movingSide === "A" ? event.objectAId : event.objectBId;
    const lower = Date.parse(candidate.burnTimeUtc!), upper = lower + HORIZON_H * 3_600_000;
    const others = [
      ...await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", moverId)).collect(),
      ...await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", moverId).gte("tcaMs", lower).lte("tcaMs", upper)).collect(),
    ];
    const duplicate = (e: Doc<"events">) => Math.abs(e.tcaMs - event.tcaMs) <= 60_000 &&
      ((e.objectAId === event.objectAId && e.objectBId === event.objectBId) || (e.objectAId === event.objectBId && e.objectBId === event.objectAId));
    if (others.some(e => e._id !== event._id && e.active && e.tcaMs >= lower && e.tcaMs <= upper &&
        (e.demoRunId ?? null) === (event.demoRunId ?? null) && !duplicate(e))) {
      fail("SHARED_TRAJECTORY_REQUIRED", "This spacecraft affects another incident; all-event trajectory authorization is required.");
    }
    const plans = await ctx.db.query("trajectoryPlans").withIndex("by_object_state", q => q.eq("objectId", candidate.movingObjectId!)).collect();
    if (plans.some(plan => plan.state !== "superseded" && plan.demoRunId === (event.demoRunId ?? null) && plan.affectedEventIds.length > 1)) {
      fail("SHARED_TRAJECTORY_REQUIRED", "This spacecraft already belongs to a shared trajectory plan.");
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
      if (approval.trajectoryPlanId !== null || approval.trajectoryPlanVersion !== null) fail("SHARED_TRAJECTORY_REQUIRED", "Trajectory-plan scheduling is not connected yet.");
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
  return { ref, event, selection, revision, candidate, set, facts, pinned, filePath, entry, approvals };
}
type Context = Awaited<ReturnType<typeof context>>;

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
    const c = await context(ctx, ref);
    if (c.set.state !== "open") fail("INVALID_STATE", "A scheduled candidate set cannot prepare a replacement schedule.");
    return { kind: c.candidate.kind, ref, pinned: c.pinned, intentKey: intentOf(ref), filePath: c.filePath, entry: c.entry,
      workerAvailable: false, error: c.entry ? WORKER_UNAVAILABLE : null };
  },
});

export const recordPreview = internalMutation({
  args: { ref: selectionRef, expectedPinned: pinnedInputs, before: v.union(v.string(), v.null()), after: v.string(), diff: v.string() },
  handler: async (ctx, { ref, expectedPinned, before, after, diff }) => {
    const c = await context(ctx, ref);
    if (!same(c.pinned, expectedPinned)) fail("STALE_REVISION", "Authorization inputs changed while Factory prepared the preview.");
    checkedArtifact(c, before, after, diff);
    const hash = await sha256(after);
    const existing = await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", intentOf(ref))).unique();
    if (existing) {
      if (!same(existing.pinned, expectedPinned) || existing.diff !== diff || c.revision.schedulePreviewHash !== hash) fail("STALE_REVISION", "An intent's prepared artifact is immutable; publish a new revision.");
      return existing._id;
    }
    if (c.set.state !== "open") fail("INVALID_STATE", "A scheduled candidate set cannot prepare a replacement schedule.");
    if (c.approvals.some(a => a.status === "approved")) fail("INVALID_STATE", "Prepare the checked preview before collecting human approvals.");
    if (c.revision.schedulePreviewHash !== null && c.revision.schedulePreviewHash !== hash) fail("STALE_REVISION", "This revision already has a different preview.");
    await ctx.db.patch(c.revision._id, { schedulePreviewDiff: diff, schedulePreviewHash: hash });
    const maneuverId = await ctx.db.insert("maneuvers", { refs: [eventReference(ref)], trajectoryPlanId: null, trajectoryPlanVersion: null,
      pinned: c.pinned, intentKey: intentOf(ref), status: "preview", filePath: c.filePath!, diff, commitSha: null, writtenBy: "droid",
      rescreenJobId: null, rescreen: null, error: null, reviewRequired: false, demoRunId: c.event.demoRunId ?? null, updatedAt: Date.now() });
    await ctx.db.insert("maneuverEvents", { maneuverId, eventId: ref.eventId });
    return maneuverId;
  },
});

async function audit(ctx: MutationCtx, c: Pick<Context, "event" | "ref">, action: Doc<"log">["action"], summary: string, after: Doc<"log">["after"] = null) {
  await ctx.db.insert("log", { eventId: c.event._id, actor: { kind: "system" }, action, summary, texts: null, before: null, after,
    proposalId: c.ref.proposalId, revision: c.ref.revision, roomId: null, demoRunId: c.event.demoRunId ?? null, simulated: c.event.simulated, at: Date.now() });
}
async function reset(ctx: MutationCtx, row: Maneuver, reason: string) {
  const ref = row.refs[0], event = ref && await ctx.db.get(ref.eventId);
  if (!ref || !event) return;
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
async function currentFor(ctx: QueryCtx, row: Maneuver, allowPast = false) {
  if (row.refs.length !== 1 || row.trajectoryPlanId !== null) fail("SHARED_TRAJECTORY_REQUIRED", "Only single-event intents are connected.");
  if (row.writtenBy !== "droid") fail("INVALID_STATE", "A backend substitute cannot authorize a Factory artifact.");
  const ref = row.refs[0], event = await ctx.db.get(ref.eventId);
  const c = await context(ctx, { ...ref, approvalRuleVersion: event?.approvalRuleVersion ?? 0 }, true, allowPast);
  if (!same(c.pinned, row.pinned) || row.reviewRequired || c.revision.schedulePreviewDiff !== row.diff || !c.revision.schedulePreviewHash) {
    fail("STALE_REVISION", "The prepared intent's pinned inputs changed; review and approve a new revision.");
  }
  if (c.approvals.some(a => a.at < Math.floor(row._creationTime))) fail("APPROVAL_REQUIRED", "Approval must follow the prepared preview.");
  return c;
}

export const start = internalMutation({
  args: { ref: selectionRef, expectedPinned: pinnedInputs },
  handler: async (ctx, { ref, expectedPinned }) => {
    const c = await context(ctx, ref, true);
    if (!same(c.pinned, expectedPinned)) fail("STALE_REVISION", "Scheduling inputs changed after authorization.");
    if (c.candidate.kind === "wait") {
      if (c.event.status !== "monitoring") {
        await ctx.db.patch(c.event._id, { status: "monitoring", situation: null });
        await audit(ctx, c, "status_changed", "Required operators approved waiting; monitoring continues without a maneuver.", { status: "monitoring" });
      }
      return { maneuverId: null, status: "monitoring" };
    }
    const row = await ctx.db.query("maneuvers").withIndex("by_intent", q => q.eq("intentKey", intentOf(ref))).unique();
    if (!row) fail("WORKER_UNAVAILABLE", "Factory must prepare a checked preview before this maneuver can be scheduled.");
    await currentFor(ctx, row);
    if (["committed", "committing", "rescreening"].includes(row.status)) return { maneuverId: row._id, status: row.status };
    if (row.status === "refused") fail("STALE_REVISION", "A refused intent needs a new approved revision.");
    if (row.rescreen?.passed) {
      await ctx.db.patch(row._id, { status: "committing", error: null, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, calls.commit, { maneuverId: row._id });
      return { maneuverId: row._id, status: "committing" };
    }
    await ctx.db.patch(row._id, { status: "rescreening", error: null, rescreenJobId: `rescreen-${row._id}`, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, calls.submit, { maneuverId: row._id });
    return { maneuverId: row._id, status: "rescreening" };
  },
});

export const jobInput = internalQuery({
  args: { maneuverId: v.id("maneuvers") },
  handler: async (ctx, { maneuverId }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.status !== "rescreening") return null;
    const c = await currentFor(ctx, row);
    if (!c.entry || !row.rescreenJobId) fail("INVALID_STATE", "The re-screen request has no selected maneuver.");
    const request: RescreenRequest = { jobId: row.rescreenJobId, snapshotId: c.pinned.snapshotId, evidenceVersion: evidenceVersionOf(c.facts),
      objectId: c.entry.objectId, partnerObjectId: c.candidate.movingSide === "A" ? c.facts.objectB.objectId : c.facts.objectA.objectId,
      maneuver: { burnTimeUtc: c.entry.burnTimeUtc, deltaVMs: c.entry.deltaVMs, direction: c.entry.direction }, tcaUtc: wholeSecondUtc(c.event.tcaMs),
      fromUtc: c.entry.burnTimeUtc, toUtc: wholeSecondUtc(Date.parse(c.entry.burnTimeUtc) + HORIZON_H * 3_600_000),
      proposalId: String(c.ref.proposalId), revision: c.ref.revision, ...(c.event.demoRunId ? { runId: String(c.event.demoRunId) } : {}) };
    return { request, pinned: row.pinned };
  },
});

function failure(error: unknown) {
  if (error instanceof ConvexError && typeof error.data?.code === "string") return { code: error.data.code, message: "Current scheduling authorization is no longer valid." };
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
    const event = await ctx.db.get(row.refs[0].eventId);
    if (event) await audit(ctx, { event, ref: { ...row.refs[0], approvalRuleVersion: event.approvalRuleVersion ?? 0 } }, "schedule_failed", error, { intentKey: row.intentKey });
    return null;
  },
});
async function failAction(ctx: { runMutation: (ref: typeof calls.fail, args: any) => Promise<any> }, maneuverId: Id<"maneuvers">, error: unknown) {
  const safe = failure(error);
  await ctx.runMutation(calls.fail, { maneuverId, ...safe, reviewRequired: ["STALE_REVISION", "NOT_SELECTED", "APPROVAL_REQUIRED", "INVALID_STATE", "SHARED_TRAJECTORY_REQUIRED"].includes(safe.code) });
}
export const submit = internalAction({
  args: { maneuverId: v.id("maneuvers") },
  handler: async (ctx, { maneuverId }) => {
    try {
      const input = await ctx.runQuery(calls.jobInput, { maneuverId });
      if (!input) return null;
      await startRescreen(input.request);
      await ctx.scheduler.runAfter(0, calls.poll, { maneuverId, attempt: 0 });
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});
export const poll = internalAction({
  args: { maneuverId: v.id("maneuvers"), attempt: v.number() },
  handler: async (ctx, { maneuverId, attempt }) => {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= POLL_LIMIT) fail("VALIDATION", "Invalid polling attempt.");
    try {
      const input = await ctx.runQuery(calls.jobInput, { maneuverId });
      if (!input) return null;
      const req: RescreenRequest = input.request;
      const job = await getRescreenJob(req.jobId, req);
      if (job.status === "failed") await ctx.runMutation(calls.fail, { maneuverId, code: job.error!.code, message: job.error!.message });
      else if (job.status === "completed") {
        const result = job.result!;
        if (result.horizonH !== HORIZON_H || (result.passed && (result.screenedFromUtc !== req.fromUtc || result.screenedToUtc !== req.toUtc)) ||
            (result.proposalId !== undefined && result.proposalId !== req.proposalId) || (result.revision !== undefined && result.revision !== req.revision) ||
            (result.runId ?? undefined) !== req.runId) fail("INVALID_RESPONSE", "Re-screen result does not describe this exact requested trajectory and horizon.");
        await ctx.runMutation(calls.finishRescreen, { maneuverId, jobId: job.jobId, expectedPinned: input.pinned,
          result: { snapshotId: result.snapshotId, evidenceKeys: input.pinned.evidenceKeys, passed: result.passed,
            objectsChecked: result.objectsChecked, horizonH: result.horizonH, originalMissAfterKm: result.originalMissAfterKm,
            newConjunctions: result.newConjunctions.map(({ objectId, name, tcaUtc, missKm }) => ({ objectId, name, tcaUtc, missKm })), refusalReason: result.refusalReason } });
      } else if (attempt + 1 >= POLL_LIMIT) await ctx.runMutation(calls.fail, { maneuverId, code: "RESCREEN_TIMEOUT", message: "Re-screen polling reached its limit; retry the same intent to read the same job." });
      else await ctx.scheduler.runAfter(POLL_DELAY_MS, calls.poll, { maneuverId, attempt: attempt + 1 });
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});
export const finishRescreen = internalMutation({
  args: { maneuverId: v.id("maneuvers"), jobId: v.string(), expectedPinned: pinnedInputs, result: rescreen },
  handler: async (ctx, { maneuverId, jobId, expectedPinned, result }) => {
    const row = await ctx.db.get(maneuverId);
    if (!row || row.status !== "rescreening") return null;
    const c = await currentFor(ctx, row);
    if (jobId !== row.rescreenJobId || !same(expectedPinned, row.pinned) || result.snapshotId !== row.pinned.snapshotId ||
        !same(result.evidenceKeys, row.pinned.evidenceKeys) || result.horizonH !== HORIZON_H ||
        (result.passed && (result.originalMissAfterKm === null || result.originalMissAfterKm < 1 || result.newConjunctions.some(n => n.missKm < 1) || result.refusalReason !== null)) ||
        (!result.passed && !result.refusalReason)) fail("INVALID_RESPONSE", "The re-screen result is not bound to this intent.");
    await ctx.db.patch(row._id, { status: result.passed ? "committing" : "refused", rescreen: result, error: result.refusalReason, updatedAt: Date.now() });
    await audit(ctx, c, result.passed ? "rescreened" : "refused", result.passed ? "The pinned maneuver passed catalog re-screening; its write intent is reserved." : result.refusalReason!, { intentKey: row.intentKey });
    if (!result.passed) await reset(ctx, row, `Approval reset: ${result.refusalReason}`);
    else await ctx.scheduler.runAfter(0, calls.commit, { maneuverId });
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
    const c = await currentFor(ctx, row);
    if (!row.rescreen?.passed || !["committing", "failed"].includes(row.status)) fail("INVALID_STATE", "A passed re-screen is required before reserving the write.");
    if (row.status !== "committing") await ctx.db.patch(row._id, { status: "committing", error: null, updatedAt: Date.now() });
    return { status: "reserved", intentKey: row.intentKey, filePath: row.filePath, diff: row.diff, contentHash: c.revision.schedulePreviewHash, demoRunId: row.demoRunId };
  },
});
export const commit = internalAction({
  args: { maneuverId: v.id("maneuvers") },
  handler: async (ctx, { maneuverId }) => {
    try {
      const intent = await ctx.runMutation(calls.reserve, { maneuverId });
      if (intent.status === "committed") return null;
      await ctx.runMutation(calls.fail, { maneuverId, code: "WORKER_UNAVAILABLE", message: "The Factory schedule worker is not connected. No schedule was written." });
    } catch (error) { await failAction(ctx, maneuverId, error); }
    return null;
  },
});

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
    let c: Context | null = null;
    try { c = await currentFor(ctx, row, true); } catch { /* The actual artifact remains historical even when inputs moved after reservation. */ }
    await ctx.db.patch(row._id, { status: "committed", commitSha, writtenBy: "droid", error: c ? null : "The reserved inputs changed; the committed artifact requires review.",
      reviewRequired: row.reviewRequired || !c, updatedAt: Date.now() });
    const event = await ctx.db.get(ref.eventId);
    if (c) {
      await ctx.db.patch(c.event._id, { status: "scheduled", situation: null });
      await ctx.db.patch(c.set._id, { state: "scheduled" });
    } else await reset(ctx, row, "Approval reset: inputs changed after the schedule write was reserved.");
    if (event) await audit(ctx, { event, ref: { ...ref, approvalRuleVersion: event.approvalRuleVersion ?? 0 } }, "schedule_committed",
      "Factory recorded the schedule artifact; this is not evidence of maneuver execution.", { intentKey, maneuverId, commitSha, reviewRequired: c ? "false" : "true" });
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
        const c = await context(ctx, { ...row.refs[0], approvalRuleVersion: event.approvalRuleVersion ?? 0 }, false, true);
        reviewRequired ||= !same(c.pinned, row.pinned);
      } else await currentFor(ctx, row, true);
    } catch { reviewRequired = true; }
    const screen = row.rescreen && (({ evidenceKeys: _keys, ...shared }) => shared)(row.rescreen);
    return { maneuverId: row._id, refs: row.refs, intentKey: row.intentKey, status: row.status, filePath: row.filePath, diff: row.diff,
      commitSha: row.commitSha, writtenBy: row.writtenBy, rescreen: screen,
      error: row.error, reviewRequired, simulated: event.simulated, demoRunId: row.demoRunId, updatedAt: new Date(row.updatedAt).toISOString(),
      execution: "not_verified" as const };
  },
});
