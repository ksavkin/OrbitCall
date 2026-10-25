import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { advanceSelection, allApproved, countingApprovals, invalidateEventApprovals, type ResetReason } from "./lib/approvalState";
import { eventRef } from "./schema/schedule";

// Shared trajectory plans (spec §2.5 TrajectoryPlan, §4.1 "Shared maneuvers", ROOM-15, issue #6). When the selected
// card of an event moves a spacecraft that is also a party in another linked event, that spacecraft has one plan row
// listing every affected event and the exact selection each one signs. Each event keeps its own selection and
// approvals; approvals.approve binds them to the plan's id and version, and lib/approvalState.countingApprovals stops
// counting them once that version is superseded. A version is a row: any change supersedes the active row and
// inserts the next version, so an old signature can never be revived. At most one draft, authorizing or scheduled row
// exists per (objectId, demoRunId); every writer supersedes before it inserts, and OCC serializes concurrent writers on the
// by_object_state and by_object_version ranges they read.

type Ref = { eventId: Id<"events">; proposalId: Id<"proposals">; revision: number; selectionGeneration: number };
type Plan = Doc<"trajectoryPlans">;
type Desired = { affectedEventIds: Id<"events">[]; eventRefs: Ref[] } | null;

const ACTIVE = ["draft", "authorizing"] as const;
// A scheduled version is also replaced by a change: its write is flagged for review, never left live beside a draft.
const LIVE = [...ACTIVE, "scheduled"] as const;
// Same encounter, other object order or source: one conjunction, not a second affected event (maneuvers.ts uses 60 s).
const DUPLICATE_MS = 60_000;
const RESERVED = ["rescreening", "committing", "committed"];

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

// Whether the event's selected card is a maneuver of this spacecraft.
async function moves(ctx: QueryCtx, eventId: Id<"events">, objectId: string) {
  const s = await selectionOf(ctx, eventId);
  if (!s?.proposalId || s.revision === null) return false;
  const revision = await ctx.db.query("proposalRevisions").withIndex("by_proposal_revision", q =>
    q.eq("proposalId", s.proposalId!).eq("revision", s.revision!)).unique();
  const card = revision && await ctx.db.get(revision.candidateRevisionId);
  return card?.kind === "maneuver" && card.movingObjectId === objectId;
}

async function openRoomOf(ctx: QueryCtx, eventId: Id<"events">) {
  for (const link of await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect()) {
    const room = await ctx.db.get(link.roomId);
    if (room && room.state === "open" && room.closedAt === null && await runOpen(ctx, room.demoRunId)) return room;
  }
  return null;
}

/**
 * The plan this spacecraft should have now, seen from `event`: the active, future events of the event's open room
 * (or, once the room has closed on consensus, the previous plan's events) that have the spacecraft as a party, one
 * per encounter. A plan exists only for two or more such events and a selected maneuver of the spacecraft in one.
 */
async function desiredPlan(ctx: QueryCtx, event: Doc<"events">, objectId: string, previous: Plan | null): Promise<Desired> {
  const run = event.demoRunId ?? null;
  const object = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
  if (!object) return null;
  const room = await openRoomOf(ctx, event._id);
  const ids = room
    ? (await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect()).map(l => l.eventId)
    : previous?.affectedEventIds ?? [];
  const now = Date.now();
  const affected: Doc<"events">[] = [];
  // The triggering event first, so its row represents the encounter when duplicates exist.
  for (const id of [event._id, ...ids.filter(id => id !== event._id)]) {
    const e = await ctx.db.get(id);
    if (!e || !e.active || e.tcaMs <= now || (e.demoRunId ?? null) !== run || (e.objectAId !== object._id && e.objectBId !== object._id)) continue;
    const duplicate = affected.some(o => Math.abs(o.tcaMs - e.tcaMs) <= DUPLICATE_MS &&
      ((o.objectAId === e.objectAId && o.objectBId === e.objectBId) || (o.objectAId === e.objectBId && o.objectBId === e.objectAId)));
    if (!duplicate && !affected.some(o => o._id === e._id)) affected.push(e);
  }
  if (affected.length < 2) return null;
  let moved = false;
  for (const e of affected) moved ||= await moves(ctx, e._id, objectId);
  if (!moved) return null;
  return { affectedEventIds: affected.map(e => e._id).sort(), eventRefs: await refsOf(ctx, affected.map(e => e._id)) };
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
  if (event.active && (reason === "trajectory_refused" || event.status === "approved")) {
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
 * Brings the plans of the event's two objects up to date with the current selections. A change supersedes the
 * active version, resets every other affected event that still holds current approvals (each its own reset), and
 * inserts the next version as a draft from the selections as they are after those resets. With `trigger` the event's
 * own approvals were already retired by the selection change that called this. Without it the event is reset like
 * the others, and the result says so, so an approve in progress does not record a click on a reset selection.
 */
export async function syncPlans(ctx: MutationCtx, event: Doc<"events">, opts: { trigger?: boolean; previous?: Plan } = {}) {
  const run = event.demoRunId ?? null;
  if (!await runOpen(ctx, run)) return false;
  const objects = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
  let selfReset = false;
  for (const objectId of new Set(objects.flatMap(o => o ? [o.objectId] : []))) {
    if (opts.previous && opts.previous.objectId !== objectId) continue;
    const active = await activePlans(ctx, objectId, run, LIVE);
    const existing = active[0] ?? null;
    const desired = await desiredPlan(ctx, event, objectId, existing ?? opts.previous ?? null);
    if (!desired && !active.length) continue;
    if (desired && existing && active.length === 1 && samePlan(existing, desired)) continue;
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
    if (!desired) continue;
    await ctx.db.insert("trajectoryPlans", {
      objectId, planVersion: await nextVersion(ctx, objectId, run), state: "draft",
      affectedEventIds: desired.affectedEventIds, eventRefs: await refsOf(ctx, desired.affectedEventIds),
      maneuverId: null, demoRunId: run, createdAt: now, updatedAt: now,
    });
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
