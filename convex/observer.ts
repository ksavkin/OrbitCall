import { ConvexError, v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { requireUser } from "./session";
import { inputKey } from "./lib/analyst";
import { loadFacts } from "./lib/events";
import { eventStatus } from "./lib/validators";
import { maneuverStatus } from "./schema/schedule";
import { verificationResult } from "./schema/records";
import { scanPhase, scanStatus } from "./schema/scans";

// The large display's read model: spec §3.1 `demo.publicView`, hosted here as `api.observer.publicView` because
// issue #6 allocates this module (the same precedent as `fleet.*` in fleetQuery.ts). A provisioned observer role
// alone is insufficient: the server grants one specific run in its scalar manifest, and only that run is readable.

// The observer projection's allowlist (spec §3.1 demo.publicView: shared globe/scan/proposal/job/results only).
// The returns validator is the enforcement: every field the observer may see is listed here, and the handler
// picks each one by name, so a new column on any source table can never reach the large display by accident.
const observerCard = v.object({
  proposalId: v.id("proposals"),
  candidateId: v.string(),
  revision: v.number(),
  label: v.string(),
  kind: v.union(v.literal("maneuver"), v.literal("wait")),
  movingObjectId: v.union(v.string(), v.null()),
  burnTimeUtc: v.union(v.string(), v.null()),
  deltaVMs: v.union(v.number(), v.null()),
  direction: v.union(v.literal("prograde"), v.literal("retrograde"), v.null()),
  missAfterKm: v.union(v.number(), v.null()),
  simulated: v.boolean(),
});
const observerJob = v.object({
  maneuverId: v.id("maneuvers"),
  status: maneuverStatus,
  reviewRequired: v.boolean(),
  rescreen: v.union(v.object({ passed: v.boolean(), objectsChecked: v.number(), horizonH: v.number() }), v.null()),
  commitSha: v.union(v.string(), v.null()),
});
const observerVerification = v.object({
  kind: v.union(v.literal("live"), v.literal("replay")),
  result: verificationResult,
  label: v.string(),
  simulated: v.boolean(),
  elementSetCount: v.number(),
});
const observerEvent = v.object({
  eventId: v.id("events"),
  objects: v.array(v.union(v.object({ objectId: v.string(), name: v.string() }), v.null())),
  tcaUtc: v.string(),
  missKm: v.number(),
  probability: v.union(v.number(), v.null()),
  status: eventStatus,
  simulated: v.boolean(),
  candidates: v.array(observerCard),
  selection: v.union(observerCard, v.null()),
  // Counts of valid current signatures only; per-side approval state and signer identities are not projected.
  approval: v.object({ approved: v.number(), required: v.number(), allRequiredApproved: v.boolean() }),
  jobs: v.array(observerJob),
  verification: v.union(observerVerification, v.null()),
});
const observerScan = v.object({
  scanId: v.id("scanRuns"),
  status: scanStatus,
  phase: scanPhase,
  progress: v.union(v.number(), v.null()),
  counts: v.object({
    primaryObjects: v.number(), catalogObjects: v.number(), primariesCompleted: v.number(),
    pairsChecked: v.number(), eventsFound: v.number(),
  }),
  coverage: v.object({
    complete: v.boolean(), catalogScope: v.string(), excludedObjects: v.number(),
    reasons: v.array(v.object({ reason: v.string(), count: v.number() })),
    missingPrimaryIds: v.array(v.string()),
  }),
});
const publicViewResult = v.object({
  demoRunId: v.id("demoRuns"),
  scenario: v.string(),
  state: v.union(v.literal("open"), v.literal("closed")),
  events: v.array(observerEvent),
  scans: v.array(observerScan),
  truncated: v.boolean(),
});


/** Grants one provisioned observer the read of one open demo run (internal: run from the CLI or a seed). */
export const authorize = internalMutation({
  args: { demoRunId: v.id("demoRuns"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { demoRunId, userId }) => {
    const [run, user] = await Promise.all([ctx.db.get(demoRunId), ctx.db.get(userId)]);
    if (!run || run.state !== "open" || !user || user.role !== "demo_observer") {
      throw new ConvexError({ code: "FORBIDDEN", message: "An open run and a provisioned observer are required." });
    }
    await ctx.db.patch(demoRunId, { manifest: { ...run.manifest, observerUserId: String(userId) } });
    return null;
  },
});

// Open runs are few (reset closes the previous one), so a short newest-first scan finds the grant.
const MAX_OPEN_RUNS = 20;

/**
 * The open run this observer is granted, newest first, or null while none is (spec §1 and §3.1 `demo.myRun`). The large display
 * subscribes to it, so a reset and a new grant move the screen to the new run without a new link.
 */
export const myRun = query({
  args: {},
  returns: v.union(v.object({ demoRunId: v.id("demoRuns"), scenario: v.string() }), v.null()),
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    if (user.role !== "demo_observer") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Only a demonstration observer has a run to watch." });
    }
    const open = await ctx.db.query("demoRuns").withIndex("by_state", q => q.eq("state", "open")).order("desc")
      .take(MAX_OPEN_RUNS);
    const run = open.find(r => r.closedAt === null && r.manifest?.observerUserId === String(user._id));
    return run ? { demoRunId: run._id, scenario: run.scenario } : null;
  },
});

export const publicView = query({
  args: { demoRunId: v.id("demoRuns") },
  returns: publicViewResult,
  handler: async (ctx, { demoRunId }) => {
    const { user } = await requireUser(ctx), run = await ctx.db.get(demoRunId);
    if (user.role !== "demo_observer" || !run || run.manifest?.observerUserId !== String(user._id)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "This observer is not authorized for that demonstration." });
    }
    if (run.state === "closed" || run.closedAt !== null) {
      return { demoRunId, scenario: run.scenario, state: run.state, events: [], scans: [], truncated: false };
    }
    const rows = await ctx.db.query("events").withIndex("by_demo_run", q => q.eq("demoRunId", demoRunId)).take(101);
    const scans = await ctx.db.query("scanRuns").withIndex("by_demo_run", q => q.eq("demoRunId", demoRunId)).take(21);
    let truncated = rows.length > 100 || scans.length > 20;
    const events = [];
    for (const e of rows.slice(0, 100)) {
      const [a, b, selection, proposals, approvals, links, verifications] = await Promise.all([
        ctx.db.get(e.objectAId),
        ctx.db.get(e.objectBId),
        ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", e._id)).unique(),
        ctx.db.query("proposals").withIndex("by_event", q => q.eq("eventId", e._id)).take(5),
        ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", e._id).eq("current", true)).order("desc").take(21),
        ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", e._id)).take(21),
        ctx.db.query("verifications").withIndex("by_event", q => q.eq("eventId", e._id)).order("desc").take(21),
      ]);
      truncated ||= proposals.length > 4 || approvals.length > 20 || links.length > 20 || verifications.length > 20;
      const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", e._id)).unique();
      const currentSet = set && set.state !== "closed" && set.evidenceKey === inputKey(await loadFacts(ctx, e)) ? set : null;

      // Cards: only the current revision of a proposal in this run, bound to the current candidate set.
      const cards = [];
      for (const p of proposals.slice(0, 4)) {
        if (p.demoRunId !== demoRunId) continue;
        const revision = await ctx.db.query("proposalRevisions")
          .withIndex("by_proposal_revision", q => q.eq("proposalId", p._id).eq("revision", p.latestRevision)).unique();
        const c = revision && await ctx.db.get(revision.candidateRevisionId);
        if (
          c && c.eventId === e._id && revision?.eventId === e._id && c.candidateId === p.candidateId &&
          c.revision === p.latestRevision && currentSet?.candidateRevisionIds.includes(c._id)
        ) {
          cards.push({
            proposalId: p._id, candidateId: p.candidateId, revision: p.latestRevision, label: p.label,
            kind: c.kind, movingObjectId: c.movingObjectId, burnTimeUtc: c.burnTimeUtc, deltaVMs: c.deltaVMs,
            direction: c.direction, missAfterKm: c.missAfterKm, simulated: c.simulated,
          });
        }
      }

      // Approvals: a side counts only when its newest current row signs the current selection and is still valid.
      const required = e.requiredApprovalSides ?? [], valid = new Set<string>(), seen = new Set<string>();
      for (const approval of approvals.slice(0, 20)) {
        // A newer veto/pending row dominates an older current approval, even during a partial migration.
        if (seen.has(approval.side)) continue;
        seen.add(approval.side);
        if (!currentSet || currentSet.reviewRequired || !["bilateral", "unilateral_debris"].includes(e.workflow ?? "") || approvals.length > 20) continue;
        if (
          approval.status !== "approved" || approval.demoRunId !== demoRunId || approval.proposalId !== selection?.proposalId ||
          approval.revision !== selection.revision || approval.selectionGeneration !== selection.generation ||
          approval.approvalRuleVersion !== e.approvalRuleVersion || !required.includes(approval.side)
        ) continue;
        const approver = await ctx.db.get(approval.userId), object = approval.side === "A" ? a : b;
        if (
          !approver || approver.role !== "operator" || approver.companyId !== approval.companyId || !object ||
          approval.assignmentVersion !== (approver.assignmentVersion ?? 1)
        ) continue;
        const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
        const assignment = await ctx.db.query("fleetAssignments")
          .withIndex("by_user_object", q => q.eq("userId", approver._id).eq("objectId", object.objectId)).unique();
        const company = approval.side === "A" ? currentSet.companyAId : currentSet.companyBId;
        if (owner?.companyId !== approval.companyId || company !== approval.companyId || !assignment?.active) continue;
        if (approval.trajectoryPlanId) {
          const plan = await ctx.db.get(approval.trajectoryPlanId);
          if (
            !plan || plan.demoRunId !== demoRunId || plan.planVersion !== approval.trajectoryPlanVersion ||
            ["superseded", "review_required"].includes(plan.state) || !plan.affectedEventIds.includes(e._id) ||
            !plan.eventRefs.some(r =>
              r.eventId === e._id && r.proposalId === approval.proposalId && r.revision === approval.revision &&
              r.selectionGeneration === approval.selectionGeneration)
          ) continue;
        } else if (approval.trajectoryPlanVersion !== null) continue;
        valid.add(approval.side);
      }
      const selected = cards.find(c => c.proposalId === selection?.proposalId && c.revision === selection.revision) ?? null;

      // Jobs and results: schedule writes of this run, and evidence bound to the newest committed one only.
      const jobs = [], committed = [];
      for (const link of links.slice(0, 20)) {
        const m = await ctx.db.get(link.maneuverId);
        if (m?.demoRunId === demoRunId && m.refs.some(r => r.eventId === e._id)) {
          if (m.status === "committed") committed.push(m);
          jobs.push({
            maneuverId: m._id, status: m.status, reviewRequired: m.reviewRequired,
            rescreen: m.rescreen
              ? { passed: m.rescreen.passed, objectsChecked: m.rescreen.objectsChecked, horizonH: m.rescreen.horizonH }
              : null,
            commitSha: m.commitSha,
          });
        }
      }
      const currentManeuver = committed.sort((x, y) => y._creationTime - x._creationTime)[0];
      const signed = currentManeuver?.refs.find(r => r.eventId === e._id);
      const audit = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", e._id)).order("desc").take(501);
      truncated ||= audit.length > 500;
      const resultLine = currentManeuver && !currentManeuver.reviewRequired && links.length <= 20 && audit.length <= 500
        ? audit.find(l =>
          l.action === "verified" && l.demoRunId === demoRunId && l.proposalId === signed?.proposalId &&
          l.revision === signed?.revision && l.after?.intentKey === currentManeuver.intentKey)
        : null;
      const verification = resultLine && verifications.find(x =>
        x.demoRunId === demoRunId && x.kind === "live" && String(x._id) === resultLine.after?.verificationId);

      events.push({
        eventId: e._id,
        objects: [a, b].map(o => o ? { objectId: o.objectId, name: o.name } : null),
        tcaUtc: new Date(e.tcaMs).toISOString(),
        missKm: e.missKm,
        probability: e.pcValue,
        status: e.status ?? "new",
        simulated: e.simulated,
        candidates: cards,
        selection: selected,
        approval: {
          approved: selected ? valid.size : 0,
          required: required.length,
          allRequiredApproved: !!selected && e.workflow !== "internal_review" && required.length > 0 && required.every(s => valid.has(s)),
        },
        jobs,
        verification: verification
          ? {
            kind: verification.kind, result: verification.result, label: verification.label,
            simulated: verification.simulated, elementSetCount: verification.elementSetCount,
          }
          : null,
      });
    }
    return {
      demoRunId,
      scenario: run.scenario,
      state: run.state,
      events,
      truncated,
      scans: scans.slice(0, 20).map(s => ({
        scanId: s._id, status: s.status, phase: s.phase, progress: s.progress,
        counts: {
          primaryObjects: s.counts.primaryObjects, catalogObjects: s.counts.catalogObjects,
          primariesCompleted: s.counts.primariesCompleted, pairsChecked: s.counts.pairsChecked, eventsFound: s.counts.eventsFound,
        },
        coverage: {
          complete: s.coverage.complete, catalogScope: s.coverage.catalogScope, excludedObjects: s.coverage.excludedObjects,
          reasons: s.coverage.reasons.map(r => ({ reason: r.reason, count: r.count })),
          missingPrimaryIds: [...s.coverage.missingPrimaryIds],
        },
      })),
    };
  },
});
