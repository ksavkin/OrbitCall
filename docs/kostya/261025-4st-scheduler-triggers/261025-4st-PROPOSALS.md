# Proposed changes for the scheduler hooks

Status: proposed; the functionality edit below is not applied yet. The specification note and the issue #6
text are still for the team to post.

## Proposed for docs/functionality.md

1. **ROOM-9.** Adds: while the schedule worker is configured, Approve on a maneuver waits until its diff is prepared.

## Not applied

- **docs/specification.md §4.1, `approvals.approve` steps.** Could add after step 4: "While the schedule worker is configured, a
  maneuver revision without its prepared diff returns `INVALID_STATE`." Left out because the approve steps belong to the
  parallel trajectory-plans branch; that branch or a later pass can add it.
- **docs/specification.md §3.4 `proposals.select` row.** Could note that a selection schedules the Factory preview.

## Issue #6, Round 4 (Kostya), text to add under "Scheduler wiring"

> - Hooks (stacked on the scheduler wiring PR): every selection (`advanceSelection`) schedules
>   `maneuvers.requestPreview`; the approval that completes consensus schedules `maneuvers.requestSchedule`; while the worker
>   is configured, a maneuver is approved only after its diff is prepared. Edits `convex/lib/approvalState.ts` and
>   `convex/approvals.ts` (one call and one gate) only.

## Note for the trajectory-plans branch

- The hook lines are one `runAfter` after the `selections` write in `advanceSelection`, and `requirePreview` plus one `runAfter`
  in `approvals.approve`. Keep plan-version hunks away from those lines; a conflict there is resolved by keeping both.

## Note for the frontend

- Approve on a maneuver returns `INVALID_STATE` until `maneuvers.get` shows the prepared diff (while the worker is configured).
  Show "Preparing the schedule diff" instead of an enabled Approve.
