import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { advanceSelection, allApproved, countingApprovals, invalidateEventApprovals, type ResetReason } from "./lib/approvalState";
import { eventRef } from "./schema/schedule";

// Shared trajectory plans (spec §2.5 TrajectoryPlan, §4.1 "Shared maneuvers", ROOM-15, issue #6). When the selected
// card of an event moves a spacecraft that is also a party in another event inside the burn's horizon, that spacecraft
// has one plan row listing every affected event and the exact selection each one signs. Each event keeps its own selection and
// approvals; approvals.approve binds them to the plan's id and version, and lib/approvalState.countingApprovals stops
// counting them once that version is superseded. A version is a row: any change supersedes the active row and
// inserts the next version, so an old signature can never be revived. After a sync at most one non-superseded row
// exists per (objectId, demoRunId) (refuse keeps its refused row beside the next draft until then); every writer
// supersedes before it inserts, and OCC serializes concurrent writers on the by_object_state and by_object_version
// ranges they read.

type Ref = { eventId: Id<"events">; proposalId: Id<"proposals">; revision: number; selectionGeneration: number };
type Plan = Doc<"trajectoryPlans">;
type Desired = { anchorId: Id<"events">; affectedEventIds: Id<"events">[]; eventRefs: Ref[] } | null;

const ACTIVE = ["draft", "authorizing"] as const;
// A scheduled version is also replaced by a change: its write is flagged for review, never left live beside a draft.
const LIVE = [...ACTIVE, "scheduled"] as const;
// A refused version authorizes nothing and blocks the mover until the next sync advances or drops it (contract §4ss).
const OPEN = [...LIVE, "review_required"] as const;
// Same encounter, other object order or source: one conjunction, not a second affected event (maneuvers.ts uses 60 s).
const DUPLICATE_MS = 60_000;
const RESERVED = ["rescreening", "committing", "committed"];
// maneuvers.ts HORIZON_H; not imported, because maneuvers.ts reaches this module through lib/approvalState.
const HORIZON_MS = 72 * 3_600_000;
// An event closed without the burn (or already verified) no longer shares it; maneuvers.ts context() skips the same.
const CLOSED = ["verified", "no_action_needed"];
const requestPreview = makeFunctionReference<"mutation", { eventId: Id<"events"> }>("maneuvers:requestPreview");

const runOpen = async (ctx: QueryCtx, demoRunId: Id<"demoRuns"> | null) => {
  if (!demoRunId) return true;
  const run = await ctx.db.get(demoRunId);
  return !!run && run.state === "open" && run.closedAt === null;
};

async function activePlans(ctx: QueryCtx, objectId: string, demoRunId: Id<"demoRuns"> | null, states: readonly Plan["state"][] = ACTIVE) {
  const rows = await Promise.all(states.map(state => ctx.db.query("trajectoryPlans").withIndex("by_object_state", q =>
    q.eq("objectId", objectId).eq("state", state)).collect()));
  return rows.flat().filter(p => p.demoRunId === demoRunId).sort((a, b) => b.planVersion - a.planVersion);
}

async function selectionOf(ctx: QueryCtx, eventId: Id<"events">) {
  return ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
}

async function refOf(ctx: QueryCtx, eventId: Id<"events">): Promise<Ref | null> {
  const s = await selectionOf(ctx, eventId);
  return s?.proposalId && s.revision !== null
    ? { eventId, proposalId: s.proposalId, revision: s.revision, selectionGeneration: s.generation } : null;
}

// The event's selected card when it is a maneuver of this spacecraft.
async function moves(ctx: QueryCtx, eventId: Id<"events">, objectId: string) {
  const s = await selectionOf(ctx, eventId);
  if (!s?.proposalId || s.revision === null) return null;
  const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
    q.eq("proposalId", s.proposalId!).eq("revision", s.revision!)).unique();
  const card = revision && await ctx.db.get(revision.candidateRevisionId);
  return card?.kind === "maneuver" && card.movingObjectId === objectId && card.burnTimeUtc ? card : null;
}

/**
 * The events one burn affects: the anchor and every open event of the mover in the same run with TCA in
 * [burn, burn + HORIZON_H], except pair duplicates of the anchor. This must match the `linked` set of maneuvers.ts
 * context(), which refuses a plan that omits one of them. An anchor whose own encounter lies outside its burn's
 * horizon affects no plan.
 */
async function affectedBy(ctx: QueryCtx, event: Doc<"events">, card: Doc<"candidateRevisions">) {
  const moverId = card.movingSide === "A" ? event.objectAId : event.objectBId;
  const lower = Date.parse(card.burnTimeUtc!), upper = lower + HORIZON_MS;
  if (event.tcaMs < lower || event.tcaMs > upper) return [];
  const others = [
    ...await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", moverId)).collect(),
    ...await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", moverId).gte("tcaMs", lower).lte("tcaMs", upper)).collect(),
  ];
  const duplicate = (e: Doc<"events">) => Math.abs(e.tcaMs - event.tcaMs) <= DUPLICATE_MS &&
    ((e.objectAId === event.objectAId && e.objectBId === event.objectBId) || (e.objectAId === event.objectBId && e.objectBId === event.objectAId));
  const linked = others.filter(e => e._id !== event._id && e.active && !CLOSED.includes(e.status ?? "") && e.tcaMs >= lower && e.tcaMs <= upper &&
    (e.demoRunId ?? null) === (event.demoRunId ?? null) && !duplicate(e));
  return [event._id, ...new Set(linked.map(e => e._id))];
}

/**
 * The plan this spacecraft should have now, seen from `event`. The anchor is the first of the event and the previous
 * plan's events that is active in the event's run and selects a maneuver of the spacecraft affecting another event;
 * the plan lists every event that burn affects (affectedBy). Without such an anchor the spacecraft needs no plan.
 */
async function desiredPlan(ctx: QueryCtx, event: Doc<"events">, objectId: string, previous: Plan | null): Promise<Desired> {
  const run = event.demoRunId ?? null;
  for (const id of new Set([event._id, ...previous?.affectedEventIds ?? []])) {
    const anchor = id === event._id ? event : await ctx.db.get(id);
    if (!anchor || !anchor.active || CLOSED.includes(anchor.status ?? "") || (anchor.demoRunId ?? null) !== run) continue;
    const card = await moves(ctx, anchor._id, objectId);
    if (!card) continue;
    const affected = await affectedBy(ctx, anchor, card);
    if (affected.length < 2) continue;
    return { anchorId: anchor._id, affectedEventIds: [...affected].sort(), eventRefs: await refsOf(ctx, affected) };
  }
  return null;
}

async function refsOf(ctx: QueryCtx, eventIds: Id<"events">[]) {
  const refs = await Promise.all([...eventIds].sort().map(id => refOf(ctx, id)));
  return refs.filter((r): r is Ref => r !== null);
}

const sameRef = (a: Ref, b: Ref) =>
  a.eventId === b.eventId && a.proposalId === b.proposalId && a.revision === b.revision && a.selectionGeneration === b.selectionGeneration;
const samePlan = (plan: Plan, desired: NonNullable<Desired>) =>
  [...plan.affectedEventIds].sort().join() === desired.affectedEventIds.join() && plan.eventRefs.length === desired.eventRefs.length &&
  desired.eventRefs.every(r => plan.eventRefs.some(p => sameRef(p, r)));

/**
 * Invalidates one affected event's approvals with its own reset (selection generation, system message, log) through
 * the existing mechanism. An event already approved on its own consensus returns to the decision, or to the agents on
 * a refusal (EXE-3); one whose schedule write is reserved or committed is flagged for review, never silently reopened.
 */
async function resetEvent(ctx: MutationCtx, eventId: Id<"events">, reason: Extract<ResetReason, `trajectory_${string}`>) {
  const event = await ctx.db.get(eventId);
  if (!event || !await runOpen(ctx, event.demoRunId ?? null)) return;
  let reserved = event.status === "scheduled";
  for (const link of await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect()) {
    const maneuver = await ctx.db.get(link.maneuverId);
    reserved ||= !!maneuver && maneuver.demoRunId === (event.demoRunId ?? null) && RESERVED.includes(maneuver.status);
  }
  if (reserved) return invalidateEventApprovals(ctx, event, reason);
  const s = await selectionOf(ctx, eventId);
  await advanceSelection(ctx, event, s?.proposalId && s.revision !== null ? { proposalId: s.proposalId, revision: s.revision } : null,
    { kind: "agents" }, reason);
  // An event that already went to monitoring on its wait card decides again: the shared burn now moves past it.
  if (event.active && (reason === "trajectory_refused" || event.status === "approved" || event.status === "monitoring")) {
    await ctx.db.patch(eventId, { status: reason === "trajectory_refused" ? "agents" : "proposal", situation: undefined });
  }
}

const hasCurrentApprovals = async (ctx: QueryCtx, eventId: Id<"events">) =>
  (await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", eventId).eq("current", true)).first()) !== null;

async function nextVersion(ctx: QueryCtx, objectId: string, demoRunId: Id<"demoRuns"> | null) {
  const rows = await ctx.db.query("trajectoryPlans").withIndex("by_object_version", q => q.eq("objectId", objectId)).collect();
  return Math.max(0, ...rows.filter(p => p.demoRunId === demoRunId).map(p => p.planVersion)) + 1;
}

/**
 * Brings the plans of the event's two objects up to date with the current selections. A change supersedes every
 * non-superseded version (a refused one included), resets every other affected event that still holds current
 * approvals (each its own reset), inserts the next version as a draft from the selections as they are after those
 * resets and asks for its preview. With `trigger` the event's own approvals were already retired by the selection
 * change that called this. Without it the event is reset like the others, and the result says so, so an approve in
 * progress does not record a click on a reset selection. `previous` is a version refuse() just marked for review: it
 * stays as the record of the refusal beside the next draft until the next sync, and is superseded at once when no next
 * version follows (the mover is no longer shared).
 */
export async function syncPlans(ctx: MutationCtx, event: Doc<"events">, opts: { trigger?: boolean; previous?: Plan } = {}) {
  const run = event.demoRunId ?? null;
  if (!await runOpen(ctx, run)) return false;
  const objects = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  let selfReset = false;
  for (const objectId of new Set(objects.flatMap(o => o ? [o.objectId] : []))) {
    if (opts.previous && opts.previous.objectId !== objectId) continue;
    const active = (await activePlans(ctx, objectId, run, OPEN)).filter(p => p._id !== opts.previous?._id);
    const existing = active[0] ?? null;
    const desired = await desiredPlan(ctx, event, objectId, existing ?? opts.previous ?? null);
    // With no next version the refused one is not a record of anything pending: it would only block the mover.
    if (!desired && opts.previous && opts.previous.state !== "superseded") active.push(opts.previous);
    if (!desired && !active.length) continue;
    const live = active.filter(p => p.state !== "review_required");
    if (desired && live.length === 1 && samePlan(live[0], desired)) {
      // The current version already matches: only a refused version left beside it is retired, without resets.
      for (const plan of active) if (plan.state === "review_required") await ctx.db.patch(plan._id, { state: "superseded", updatedAt: Date.now() });
      continue;
    }
    const targets = new Set([...active.flatMap(p => p.affectedEventIds), ...desired?.affectedEventIds ?? []]);
    for (const id of targets) {
      if (opts.trigger && id === event._id) continue;
      if (!await hasCurrentApprovals(ctx, id)) continue;
      if (id === event._id) selfReset = true;
      await resetEvent(ctx, id, "trajectory_changed");
    }
    const now = Date.now();
    for (const plan of active) {
      await ctx.db.patch(plan._id, { state: "superseded", updatedAt: now });
      // A write reserved for the old version is flagged, never silently replaced (spec §4.1).
      const maneuver = plan.maneuverId && await ctx.db.get(plan.maneuverId);
      if (maneuver && maneuver.demoRunId === run && !maneuver.reviewRequired) await ctx.db.patch(maneuver._id, { reviewRequired: true, updatedAt: now });
    }
    // Each event that left the plan (all of them once the mover is no longer shared) prepares its own schedule again.
    for (const id of new Set(active.flatMap(p => p.affectedEventIds))) {
      if (desired?.affectedEventIds.includes(id)) continue;
      const row = await ctx.db.get(id);
      if (row?.active && !["verified", "no_action_needed"].includes(row.status ?? "")) await ctx.scheduler.runAfter(0, requestPreview, { eventId: id });
    }
    if (!desired) continue;
    await ctx.db.insert("trajectoryPlans", {
      objectId, planVersion: await nextVersion(ctx, objectId, run), state: "draft",
      affectedEventIds: desired.affectedEventIds, eventRefs: await refsOf(ctx, desired.affectedEventIds),
      maneuverId: null, demoRunId: run, createdAt: now, updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, requestPreview, { eventId: desired.anchorId });
  }
  return selfReset;
}

/**
 * The active plan an approval of this event signs: one listing the event's exact current selection. With two (both
 * objects of the event shared elsewhere) the mover of the selected card wins.
 */
export async function planFor(ctx: QueryCtx, event: Doc<"events">, selection: Doc<"selections">): Promise<Plan | null> {
  const run = event.demoRunId ?? null;
  const objects = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  const plans: Plan[] = [];
  for (const object of objects) {
    if (!object) continue;
    for (const plan of await activePlans(ctx, object.objectId, run)) {
      if (plan.affectedEventIds.includes(event._id) && plan.eventRefs.some(r => r.eventId === event._id && r.proposalId === selection.proposalId &&
        r.revision === selection.revision && r.selectionGeneration === selection.generation)) plans.push(plan);
    }
  }
  for (const plan of plans) if (await moves(ctx, event._id, plan.objectId)) return plan;
  return plans[0] ?? null;
}

const authorization = v.object({ authorized: v.boolean(), reason: v.union(v.string(), v.null()), eventRefs: v.array(eventRef) });

/**
 * For the Maneuver Scheduler before /prepare: true only when this exact plan version is current and every affected
 * event's required approvals count on its own current selection and are all bound to { id, version }. One event's
 * approvals never authorize another. Checks the stored refs, not the room, which closes on the last consensus.
 */
export const authorized = internalQuery({
  args: { id: v.id("trajectoryPlans"), version: v.number() },
  returns: authorization,
  handler: async (ctx, { id, version }) => {
    const plan = await ctx.db.get(id);
    const no = (reason: string) => ({ authorized: false, reason, eventRefs: plan?.eventRefs ?? [] });
    if (!plan) return no("PLAN_NOT_FOUND");
    if (plan.planVersion !== version) return no("STALE_PLAN_VERSION");
    if (plan.state !== "authorizing" && plan.state !== "scheduled") return no(`PLAN_${plan.state.toUpperCase()}`);
    if (!await runOpen(ctx, plan.demoRunId)) return no("DEMO_RUN_CLOSED");
    if (plan.affectedEventIds.length < 2) return no("NOT_SHARED");
    for (const eventId of plan.affectedEventIds) {
      const refs = plan.eventRefs.filter(r => r.eventId === eventId);
      const [event, selection] = await Promise.all([ctx.db.get(eventId), selectionOf(ctx, eventId)]);
      if (!event || (event.demoRunId ?? null) !== plan.demoRunId) return no("EVENT_MISSING");
      // An affected event without a selected card yet, or a malformed row.
      if (refs.length !== 1 || !selection) return no("REF_MISSING");
      const ref = refs[0];
      if (selection.proposalId !== ref.proposalId || selection.revision !== ref.revision || selection.generation !== ref.selectionGeneration) {
        return no("SELECTION_CHANGED");
      }
      const counted = await countingApprovals(ctx, event, selection);
      if (!allApproved(event, counted)) return no("APPROVALS_MISSING");
      if ([...counted.values()].some(a => a.trajectoryPlanId !== plan._id || a.trajectoryPlanVersion !== plan.planVersion)) return no("APPROVALS_ON_OTHER_VERSION");
    }
    return { authorized: true, reason: null, eventRefs: plan.eventRefs };
  },
});

/**
 * The scheduler's refusal of a re-screened plan (EXE-3): the version becomes review_required, every affected event's
 * approvals reset with its own reason and return to the agents, and the next version starts as a draft. Idempotent per
 * (id, version): a late or repeated call for a version that is no longer active changes nothing.
 */
export const refuse = internalMutation({
  args: { id: v.id("trajectoryPlans"), version: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { id, version }) => {
    const plan = await ctx.db.get(id);
    if (!plan || plan.planVersion !== version || !(ACTIVE as readonly string[]).includes(plan.state) || !await runOpen(ctx, plan.demoRunId)) return false;
    const now = Date.now();
    await ctx.db.patch(id, { state: "review_required", updatedAt: now });
    const maneuver = plan.maneuverId && await ctx.db.get(plan.maneuverId);
    if (maneuver && maneuver.demoRunId === plan.demoRunId && !maneuver.reviewRequired) await ctx.db.patch(maneuver._id, { reviewRequired: true, updatedAt: now });
    for (const eventId of plan.affectedEventIds) await resetEvent(ctx, eventId, "trajectory_refused");
    const first = await ctx.db.get(plan.affectedEventIds[0]);
    if (first) await syncPlans(ctx, first, { trigger: true, previous: plan });
    return true;
  },
});

/** Repair entry point for a change that did not pass through a selection write (for example a room link). */
export const sync = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (event) await syncPlans(ctx, event);
    return null;
  },
});
