---
quick_id: 261025-4ss
status: complete
completed: 2026-10-25
branch: kostya/r4-shared-scheduling (from main 82a7ac4)
key-files:
  created:
    - tests/sharedScheduling.test.ts
    - tests/schedulerFlow.test.ts
  modified:
    - convex/maneuvers.ts
    - docs/specification.md
    - docs/functionality.md
---

# 261025-4ss: shared-mover scheduling through the trajectory plan

This is the follow-up to issue #6, Round 4, Kostya, "Scheduler wiring". Until now `convex/maneuvers.ts` scheduled single-event intents only, and a shared mover (one burn of one spacecraft that affects several linked incidents) always failed `SHARED_TRAJECTORY_REQUIRED`. Now a shared mover is scheduled once through its trajectory plan: one intent per plan version, every affected incident re-checked, one re-screen per partner, one schedule write.

The entry points are unchanged (`requestPreview` and `requestSchedule`, both `{ eventId }`), so the hooks in `advanceSelection` and `approvals.approve` need no edit. Single-event maneuvers keep their event intent and `trajectory: null`. No schema edit.

## Behavior

- **Plan detection** (`context()`, maneuver cards only).
  - Candidate plans: `trajectoryPlans` rows of the moving object, not `superseded`, with the event's `demoRunId` and more than one `affectedEventIds` entry.
  - The plan of this incident is the one whose `eventRefs` contain its exact current selection (event, proposal, revision, selection generation).
  - With a plan: it authorizes only if it is not `review_required` and its `affectedEventIds` include every linked incident. Linked: another active event of the mover with TCA inside the burn's 72 h horizon, same demo run, not a pair duplicate (same pair, TCA within 60 s). Else `SHARED_TRAJECTORY_REQUIRED`.
  - Without a plan: a linked incident, or any non-superseded shared plan of the mover in the same run, still fails `SHARED_TRAJECTORY_REQUIRED`. An approval that carries a plan id or version without a covering plan fails the same way.
- **Authorization over every affected incident** (`scope()`).
  - The authorization unit is the plan: `scope()` runs the full `context()` check for each `eventRefs` entry and requires each to resolve to the same plan.
  - One incident's approvals never authorize another: each part checks its own selection, approvals, workflow and responsibility.
  - Every required approval of every part must carry `trajectoryPlanId` and the plan's current `planVersion`, else `APPROVAL_REQUIRED`.
  - Pins are merged: the head's snapshot, every part's evidence key, policy and assignment versions.
- **Same burn.** Every part must be a maneuver card with the same moved object, burn time, delta-v, direction, operator file path and OMM snapshot, else `SHARED_TRAJECTORY_REQUIRED`.
- **One intent per plan version.**
  - The intent key is `trajectory:<planId>:version:<n>`.
  - The worker gets `trajectory: { id, version }` on `/prepare`, `/commit` and every job read.
  - The plan's first `eventRefs` entry is the worker's ref and schedule entry, whichever incident triggered the call.
- **Preview.**
  - `requestPreview` from any affected incident schedules one `/prepare`. A second request returns `prepared`.
  - `recordPreview` refuses if any part already has a different preview or an approval older than its revision's first preview.
  - It then writes the same `schedulePreviewDiff` / `schedulePreviewHash` on every affected revision.
  - It inserts one `maneuvers` row with `refs` for all parts, `trajectoryPlanId` / `trajectoryPlanVersion` set, a `maneuverEvents` link per incident, and sets `plan.maneuverId`.
- **Waiting for the last incident.**
  - `requestSchedule` on an affected incident whose own approvals are complete returns `{ status: "waiting", code: "PLAN_APPROVALS_PENDING" }` while another part is not yet approved. No log row, approvals stay current, the row stays `preview`.
  - The approval that completes the last affected incident schedules it.
  - If the triggering incident fails its own checks, that is a normal logged `schedule_failed`.
- **One re-screen per partner.**
  - The moved trajectory is re-screened once for each affected incident's partner. Each job uses that incident's evidence, partner object and TCA, and the head's burn.
  - Job ids are `<rescreenJobId>` for the first partner and `<rescreenJobId>-<n>` for the rest.
  - The next partner is submitted only after the previous one passes. `combined` folds the results into one verdict: a pass only if every partner passed, else the first refusal is the reason.
- **One commit.** `reserveCommit`, the prepared-job read-back and `/commit` run once under the plan intent, with the head's ref and the plan trajectory.
- **Success.** `recordCommit` marks every affected event `scheduled` and its candidate set `scheduled`, sets the plan `scheduled` with its `maneuverId`, and logs `schedule_committed` on every incident.
- **Refusal or reset.** `reset` resets every incident of the row: approvals cleared, selection generation advanced, event back to `agents`, each with its own message ("Both approvals reset:" for bilateral). The plan of that version becomes `review_required`. `rescreened` / `refused` and `schedule_failed` rows are logged on every incident.
- **Staleness.**
  - `currentFor` also requires the current scope's intent key and refs to equal the row's.
  - `maneuvers.get` flags `reviewRequired` on a preview row once the plan's intent key has moved.
  - `requestSchedule` resumes a handed-over row through any `maneuverEvents` link that covers the current selection.

## Contract for the trajectory-plans branch

What `maneuvers.ts` requires before it schedules a shared mover:

- **Plan row.**
  - `objectId` is the moving spacecraft.
  - `state` is `draft`, `authorizing` or `scheduled`. `superseded` is ignored and `review_required` refuses.
  - `demoRunId` equals the incidents' run (`null` outside demo runs).
  - `affectedEventIds` has more than one entry and covers every active event of the mover with TCA in [burn, burn + 72 h] in the same run (pair duplicates exempt).
  - `eventRefs` has one entry per affected event, listing the same events as `affectedEventIds`. Each entry equals that event's current selection (`eventId`, `proposalId`, `revision`, `selectionGeneration`). The first entry is the head.
- **Selections.** Every affected event selects a maneuver card with the same burn (object, time, delta-v, direction), the same moving company and the same OMM snapshot.
- **Approvals.** Every required side of every affected event approves its current selection with `trajectoryPlanId` = the plan and `trajectoryPlanVersion` = its current `planVersion`.
- **After a reset.** Any new selection, veto or reset on an affected event advances its selection generation, so the plan's `eventRefs` stop matching. The plan must be advanced with fresh refs, including after the reset `maneuvers.ts` itself does on refusal; a `review_required` plan authorizes again only after it is advanced to a new version.
- **Preview trigger.** After creating or advancing a plan, schedule `internal.maneuvers.requestPreview({ eventId })` for one affected event. Otherwise the new version is never previewed, and approval stays gated while the worker is configured.
- **Supersede.** Any non-superseded shared plan of the mover (including a `scheduled` one) blocks every other maneuver of that mover in the same run with "already belongs to a shared trajectory plan". Supersede a plan once it no longer applies.
- **Written by `maneuvers.ts`.** `plan.maneuverId` (on preview and commit), and the states `scheduled` (on commit) and `review_required` (on refusal or reset).

## Other changes

- `MAX_ARTIFACT` is 256 KB, aligned with the worker and the schedule client; the old 128 KB limit could strand valid previews.
- `recordPrepareFailure` takes the intent key, so plan intents log and deduplicate under `trajectory:…`.

## Files

- `convex/maneuvers.ts`
  - New: `scope()`, `combined()`, `handedFor()`, `resetEvent()`, `trajectoryOf()`; type `Scope`.
  - Changed: `context()` (plan detection, plan-bound approvals), `preview`, `requestPreview`, `prepare`, `recordPrepareFailure`, `recordPreview`, `reset`, `previewedAt`, `currentFor`, `start`, `requestSchedule`, `startIntent`, `jobInput`, `submit`, `poll`, `finishRescreen`, `recordFailure`, `reserveCommit`, `commitIntent`, `commit`, `readHanded`, `settleCommit`, `recordCommit`, `get`.
- `tests/sharedScheduling.test.ts` (new): shared-mover cases. The plan row is inserted directly, as the plans branch would.
- `tests/schedulerFlow.test.ts` (new): one single-event path through the app's own mutations.

## Shared docs

Per `261025-4ss-PROPOSALS.md`:
- `docs/specification.md` §4.1: the last Maneuver Scheduler bullet only.
- `docs/functionality.md`: one clause on EXE-2.

The approve steps, "Shared maneuvers" and "Resets" in §4.1 are left to the trajectory-plans branch.

## Tests

- `tests/sharedScheduling.test.ts`: 14 tests (new).
  - One plan-bound preview for both events, whichever asks first.
  - Waiting for the second event, then one re-screen per partner and one commit for both.
  - A refusal against either partner resets both events and marks the plan `review_required`.
  - No write with an approval on another plan version, an approval not bound to the plan, or a superseded plan.
  - `SHARED_TRAJECTORY_REQUIRED` for a plan that omits a linked event or for selections that disagree on the burn.
  - A single-event maneuver keeps its event intent and `trajectory: null`.
  - A plan whose affected incidents and event refs disagree (or repeat) is refused.
  - An affected incident with incomplete approvals asking to schedule waits quietly; an invalid workflow on another affected incident fails visibly instead.
- `tests/schedulerFlow.test.ts`: 4 tests (new).
  - Select, prepare, both approvals and commit through the app's mutations.
  - Approval refused before the diff exists.
  - No worker: no gate and one `WORKER_UNAVAILABLE`.
  - Veto while the diff is missing.
- `npm run check`: 1494 tests passing (1476 on main).

## Known limits

- **No plan rows yet.** Plans come from the trajectory-plans branch. Until it lands no plan exists, and shared movers stay `SHARED_TRAJECTORY_REQUIRED`.
- **Shared movers cannot publish yet.** Discussion revisions (`TRAJECTORY_PLAN_REQUIRED`) and summary edits (`SHARED_TRAJECTORY_REQUIRED`) of shared movers still refuse until they publish against the plan (Andrew's code).
- **Same operator file.** A commit after another write to the same operator file (since the prepare) is refused by the worker's previous-hash check and needs a new revision.
- **Sequential re-screens.** They run one per partner, one after another; a refusal stops the chain, so later partners are not screened.
- **No automatic retry after a logged failure**, as for single-event intents.
