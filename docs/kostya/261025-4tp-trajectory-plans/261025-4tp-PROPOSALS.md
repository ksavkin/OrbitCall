# Proposed changes for shared trajectory plans

Status: the edits to `docs/specification.md` §4.1 and `docs/functionality.md` ROOM-15 are applied in this branch. The items below are for the team.

## docs/specification.md

1. **§2.5 TrajectoryPlan** still shows the earlier shape. Proposed text to match the frozen schema:
   - `proposalRefs` becomes `eventRefs: { eventId, proposalId, revision, selectionGeneration }[]`;
   - the states become `"draft" | "authorizing" | "scheduled" | "superseded" | "review_required"`;
   - add `demoRunId`.

   It is not edited here because this item may change only §4.1.

## Issue #6, Round 4 (Kostya)

Proposed text for the trajectory plans bullet, once merged:

> Trajectory plans: done. A selected maneuver whose spacecraft is in several linked events gets one `trajectoryPlans` row. Every affected event's required approvals sign the same plan version, and a change in any affected event (selection, revision, generation, veto, refusal) supersedes it and resets all of them, each with its own reset. New `convex/trajectoryPlans.ts`; `convex/approvals.ts` binds approvals; a minimal hook in `lib/approvalState.advanceSelection` keeps plans current. Scheduler integration remains (see the note below).

## Scheduler note (owner of convex/maneuvers.ts)

- **Find the plan.** The approvals of a shared event carry `trajectoryPlanId` and `trajectoryPlanVersion`, and they are equal across every affected event of the plan.
- **Before /prepare**, call `ctx.runQuery(internal.trajectoryPlans.authorized, { id, version })`. Schedule only on `authorized: true`, and use the returned `eventRefs` as the maneuver's `refs`. `/prepare` must pass `{ id, version }`, never the plan id alone: a newer version of the same plan supersedes the row, and the old id then answers `PLAN_SUPERSEDED` or `STALE_PLAN_VERSION`.
- **Intent key.** Key the write intent by plan id and version, as the `maneuvers` schema comment says. Set `trajectoryPlans.maneuverId` and, after commit, `state: "scheduled"`. A later supersede flags that maneuver `reviewRequired`.
- **On a refused re-screen**, record the refusal on the maneuver first, then call `internal.trajectoryPlans.refuse({ id, version })`. It marks the version `review_required`, resets every affected event, returns them to the agents and starts the next draft. Repeating the call is a no-op.
- **A wait card in an affected event.** #74 already connects plans for the moving event. An affected event that selected the wait card still has its plan-bound approvals refused with `SHARED_TRAJECTORY_REQUIRED`. It should move to `monitoring` once its plan is authorized. Replacing the burn-window "shared" check with the plan's `affectedEventIds` would also keep the two rules from disagreeing.
- **Refusal.** On a refused re-screen, calling `trajectoryPlans.refuse` instead of patching the plan directly also resets the affected events' approvals and starts the next version.
