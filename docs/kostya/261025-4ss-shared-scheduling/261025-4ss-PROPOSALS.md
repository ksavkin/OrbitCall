# Proposed changes for shared-mover scheduling

Status: proposed; the doc edits below are not applied yet. The issue #6 text and the notes for the trajectory-plans branch and Andrew are still for the team to act on.

The backend for this is on `kostya/r4-shared-scheduling` (summary: `261025-4ss-SUMMARY.md`).

## Proposed for docs/specification.md

1. **§4.1, last Maneuver Scheduler bullet.** Replaces "Until trajectory plans are connected, scheduling covers single-event intents only; a shared mover fails `SHARED_TRAJECTORY_REQUIRED`." with: "A shared mover is scheduled through its trajectory plan: one intent per plan version, every affected incident's approvals on that version re-checked, one re-screen per partner encounter and one schedule write. Without a covering plan it fails `SHARED_TRAJECTORY_REQUIRED`."

The approve steps, "Shared maneuvers" and "Resets" are not touched; the trajectory-plans branch edits them.

## Proposed for docs/functionality.md

1. **EXE-2.** Adds: "For a shared maneuver, every affected partner encounter is re-screened."

## Issue #6, Round 4 (Kostya), text to add under the Kostya bullets

> - Shared-mover scheduling (follow-up): `maneuvers.ts` schedules a shared mover through its trajectory plan. One intent per plan version (`trajectory:<planId>:version:<n>`, the worker gets `trajectory: { id, version }`), every affected incident fully re-checked with its approvals on that plan version, one preview row with refs for all incidents, one re-screen per partner encounter (all must pass), one commit. Success schedules every incident and the plan; a refusal resets every incident and marks the plan `review_required`. Without a covering plan it stays `SHARED_TRAJECTORY_REQUIRED`. Edits `convex/maneuvers.ts`, adds `tests/sharedScheduling.test.ts` and `tests/schedulerFlow.test.ts`, plus one §4.1 bullet of `docs/specification.md` and EXE-2 of `docs/functionality.md`.
>   - Takes effect once the trajectory-plans branch writes plan rows.

## Trajectory-plans branch

Contract (details in `261025-4ss-SUMMARY.md`):
- A plan row: not `superseded` or `review_required`; `demoRunId` equal to the incidents' run; `affectedEventIds` (more than one) covering every active event of the mover in the 72 h burn horizon; `eventRefs` listing the same events, each equal to that event's current selection, first entry the head.
- All affected selections carry the same burn, moving company and OMM snapshot.
- Approvals carry `trajectoryPlanId` and the current `trajectoryPlanVersion`.
- After creating or advancing a plan (including after a reset), schedule `internal.maneuvers.requestPreview({ eventId })` for one affected event; otherwise the new version is never previewed and approval stays gated while the worker is configured.
- `maneuvers.ts` sets `plan.maneuverId` and the `scheduled` / `review_required` states. A `review_required` plan authorizes again only after it is advanced to a new version with fresh refs.
- Any non-superseded shared plan of the mover, including a `scheduled` one, blocks every other maneuver of that mover in the same run; supersede a plan once it no longer applies.
- The "Shared maneuvers" paragraph of §4.1 says the trajectory is "re-screened once" and the intent is "keyed by object and `planVersion`". The code runs one re-screen per partner encounter (each against the full catalog) and keys the intent by plan id and version. Align the paragraph when that branch edits it.

## Andrew

- Discussion revisions (`TRAJECTORY_PLAN_REQUIRED`) and summary edits (`SHARED_TRAJECTORY_REQUIRED`) of shared movers can publish once plans exist, against the plan instead of a single incident.
- The scheduler already accepts plan intents: no further scheduler change is needed for that.
