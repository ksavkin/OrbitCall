---
quick_id: 261025-4st
status: complete
completed: 2026-10-25
branch: kostya/r4-scheduler-triggers (on kostya/r4-scheduler-wiring)
key-files:
  created:
    - tests/schedulerTriggers.test.ts
  modified:
    - convex/lib/approvalState.ts
    - convex/approvals.ts
    - tests/proposals.test.ts
    - docs/functionality.md
---

# 261025-4st: hooks from the decision flow into the Maneuver Scheduler

This is the companion of issue #6, Round 4, Kostya "Scheduler wiring". That PR adds the internal entry points
`maneuvers.requestPreview` and `maneuvers.requestSchedule`, but the bullet edits `convex/maneuvers.ts` only, so nothing called
them. This change adds the two calls and the approval gate they need. It is stacked on `kostya/r4-scheduler-wiring` and merges
after it: before that, the scheduled names do not exist.

## Behavior

- **Every selection asks for the schedule preview.**
  - `advanceSelection` (`convex/lib/approvalState.ts`) is the one writer of `selections`: `proposals.select`, a new revision or
    candidate set from `candidates.publish` (agent revisions, `summary.edit`, `revisions`), a veto and every reset go through it.
  - When the new selection names a card, it schedules `maneuvers.requestPreview({ eventId })` in the same transaction. A cleared
    selection (withdrawn proposal, demo reset) schedules nothing.
  - `requestPreview` reads the current selection itself, so a request overtaken by a newer selection is a no-op. Waits, closed
    candidate sets, shared movers and already prepared intents are no-ops too. Re-clicking the current card writes nothing and
    schedules nothing.
- **Consensus starts the Maneuver Scheduler.**
  - The `approvals.approve` call that moves the event to `approved` schedules `maneuvers.requestSchedule({ eventId })`, once:
    a second approve of a decided event is `ALREADY_DECIDED`.
  - `requestSchedule` never throws for authorization or worker failures; it writes a `schedule_failed` log row, so the approval
    transaction and the agreed status are never undone by the scheduler.
- **A maneuver is approved on its prepared diff (EXE-4, ROOM-9).**
  - While `SCHEDULE_SERVICE_URL` is set, a new approval of a maneuver card whose revision has no `schedulePreviewHash` yet is
    refused with `INVALID_STATE` ("Factory is still preparing this plan's schedule diff"). The UI can show the preparing state
    from `maneuvers.get` (no row yet) and enable Approve when the diff appears.
  - Veto, wait cards and re-approving an existing tick are never gated.
  - Without the worker configured, approvals record as before and the scheduler's `WORKER_UNAVAILABLE` stays visible in the log
    and on the maneuver row. This keeps a deployment without Factory usable for wait decisions and honest about maneuvers.

## How to use it

- Frontend: no extra call is needed after `proposals.select`; subscribe to `maneuvers.get({ eventId })`. No row means the preview is still
  being prepared (or failed: read `schedule_failed` rows in the event log). A `preview` row carries the diff to show beside Approve.
- Backend writers of selections must keep going through `advanceSelection`; a direct `selections` write would skip the preview.
- Deploy: set `SCHEDULE_SERVICE_URL=https://<api host>/scheduler` and `SCHEDULE_SERVICE_TOKEN` in Convex together with the
  scheduler service (see `deploy/README.md`). Setting the URL turns the approval gate on.

## Known limits

- Single-event intents only (see the scheduler wiring summary): a shared mover gets no preview and its approval is gated only by
  the trajectory-plan rules; scheduling it stays `SHARED_TRAJECTORY_REQUIRED`.
- A Factory preparation takes tens of seconds; the side in turn waits for it before Approve works.
- If preparation fails, Approve on that maneuver stays refused until the plan is selected again (a new intent is prepared).

## Tests

- `tests/schedulerTriggers.test.ts`: a preview request per selection change; one scheduling request on
  consensus and none before; the approval gate with and without the worker configured.
- `tests/proposals.test.ts`: selecting schedules exactly the preview request, a re-click schedules nothing, and nothing is approved.
- `npm run check` (with the scheduler wiring underneath): 1476 tests passing.
