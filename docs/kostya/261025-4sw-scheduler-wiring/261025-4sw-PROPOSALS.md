# Proposed changes for the scheduler wiring

Status: proposed; the doc edits below are not applied yet. The issue #6 text and the notes for the triggers change, the trajectory-plans branch and the deploy are still for the team to act on.

The backend for this is on `kostya/r4-scheduler-wiring` (summary: `261025-4sw-SUMMARY.md`).

## Proposed for docs/specification.md

1. **§4.1, Maneuver Scheduler, new first bullet.** After a selection, the scheduler asks Factory to `/prepare` the selected maneuver and records the checked diff and its hash on the revision before any approval. An approval counts only if given after the revision's first recorded preview. A reset that only advances the selection generation keeps the revision's preview: the new generation's approvals count, and scheduling re-prepares the byte-identical diff before re-screening.
2. **§4.1, maneuver bullet.** Adds after "Droid commits the prepared diff; maneuver `committed`, event `scheduled`.": "The commit reads the completed `/prepare` job back from the worker and checks its content hash, diff and file path against the approved preview."
3. **§4.1, new bullet.** Failures stay visible: a `schedule_failed` log row while no maneuver row exists, a `failed` maneuver row after; a missing or unreachable worker shows `WORKER_UNAVAILABLE`; no substitute writer.
4. **§4.1, new bullet.** Until trajectory plans are connected, scheduling covers single-event intents only, and a shared mover fails `SHARED_TRAJECTORY_REQUIRED`.

The approve steps, "Shared maneuvers" and "Resets" are not touched; the trajectory-plans branch edits them. §2.5 already lists every `ManeuverStatus` used and `schedulePreviewDiff` on the revision, so it is unchanged.

## docs/functionality.md

Not changed. EXE-1 already says Droid prepares the change before approval, Convex reserves an immutable intent, failures stay visible and retry the same intent, and no substitute writer runs. EXE-4 already says the diff is prepared before approval.

## Issue #6, Round 4 (Kostya), text to add

> - [x] Scheduler wiring: `maneuvers.ts` calls the Factory worker, `/prepare` writes `schedulePreviewDiff` on the revision before approval and `/commit` uses the intent key after re-screen. Edits `convex/maneuvers.ts` only.
>   - Done: new internal `maneuvers.requestPreview({ eventId })` (after a selection) and `maneuvers.requestSchedule({ eventId })` (when the event is `approved`). Prepare polls the worker job and records the checked diff; commit reads the prepared job back, checks it against the approved preview and commits it under the same intent key. Failures stay visible (`schedule_failed`, `WORKER_UNAVAILABLE`), no substitute writer. Single-event intents only. Edits `convex/maneuvers.ts` and `tests/maneuvers.test.ts`, plus the §4.1 scheduler bullets of `docs/specification.md`.
>   - Nothing calls the new entry points until the triggers change below lands.

## Triggers change (stacked follow-up `kostya/r4-scheduler-triggers`, `convex/lib/approvalState.ts` and `convex/approvals.ts`)

- `advanceSelection` (every selection write: `proposals.select`, new revisions and candidate sets, vetoes and resets) schedules
  `internal.maneuvers.requestPreview({ eventId })` after it writes a non-empty selection.
- The all-approved branch of `approvals.approve` (the event moves to `approved`) schedules `internal.maneuvers.requestSchedule({ eventId })`. It returns a coded failure instead of throwing, so the approval stands.
- While the worker is configured, `approvals.approve` refuses an approval for a maneuver revision that has no recorded preview yet (`schedulePreviewHash` is null). Otherwise an early approval can never be scheduled and needs a new selection.

## Trajectory-plans branch

- Once multi-event intents exist, the scheduler passes `trajectory: { id, version }` to the worker instead of `null`. The worker then keys the intent by `trajectory:<id>:version:<n>`, which `convex/lib/scheduleClient.ts` already validates.
- One intent per object and plan version, one re-screen, and refs for every affected event replace the current `SHARED_TRAJECTORY_REQUIRED` refusal.

## Deploy

- Convex needs `SCHEDULE_SERVICE_URL=https://<api host>/scheduler` and `SCHEDULE_SERVICE_TOKEN`, as in the deploy README on main (`/scheduler/<path>` is proxied to the worker with the prefix stripped).
- The token is the worker's own `SCHEDULE_SERVICE_TOKEN`: at least 32 characters, no newlines. The URL must be HTTPS without credentials, query or fragment.
- Without both values, preparation logs `WORKER_UNAVAILABLE` and nothing is written.
