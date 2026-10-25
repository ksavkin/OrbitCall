---
quick_id: 261025-4ur
status: complete
completed: 2026-10-25
branch: kostya/r4-ui-reads (from main b6dc14f)
key-files:
  created:
    - convex/log.ts
    - convex/config.ts
    - tests/uiReads.test.ts
  modified:
    - convex/proposals.ts
    - convex/rooms.ts
    - docs/specification.md
---

# 261025-4ur: backend reads the frontend needs to leave the simulator

Wiring the web app to Convex showed four reads missing or too narrow. This change adds them; it does not change any write path.

## Behavior

- **`log.list({ eventId?, cursor? })`** (spec §3.6, LOG-4): the shared audit record, newest first, at most 50 per page, with an opaque `nextCursor` for the next older page (Convex pagination: rows sharing a timestamp are neither lost nor repeated). With `eventId` the caller must be a party to the incident (`requireReader`); without it, only rows of incidents the caller is a party to. Shared entries only: another company's `policy_changed` rows and its agents' private rows are left out. The returned actor carries no company id. This is how the UI reads `schedule_failed` rows (preparation failures, `PREVIEW_AFTER_APPROVAL`, `WORKER_UNAVAILABLE` before a maneuver row exists).
- **`config.flags({})`** (spec §3.1): `{ demoLaunch, voice, droid, secondModel }`, booleans only. `droid` uses the schedule client's own configuration check, so it is exactly the condition that gates Approve on a prepared diff.
- **`proposals.list`**: each card's `latest` also carries `candidateId`, `changeSummary`, `sourceMessageIds`, the checked `rationale` (null unless `numbersChecked`; an unchecked explanation never reaches a card, AGT-5) and the revision's `schedulePreviewDiff` (ROOM-9). Feasibility and the Advocates' recommendation stay in `advocates.list`, which applies the policy privacy rules.
- **`rooms.forEvent({ eventId })`**: the incident's most recent room, open or closed, with the same party access as `rooms.get` (a demo observer is refused). `rooms.get` still returns null after the room closes (spec §3.4); a reloaded page uses `forEvent` to find the closed room and `rooms.byId` to read its history.

## How to use

- Decision Center: show the diff from `proposals.list` (`latest.schedulePreviewDiff`) or `maneuvers.get`; when `config.flags().droid` is true and the diff is still null, show "Preparing the schedule diff" instead of an enabled Approve.
- Failures: list `log.list({ eventId })` rows with `action: "schedule_failed"` beside the maneuver status.

## Tests

- `tests/uiReads.test.ts` (new): log pagination, party access and privacy; config flags without values; the extra card fields; `rooms.forEvent` before, during and after a room.
- `npm run check`: 1508 tests passing (1494 on main).

## Known limits

- Filtering (privacy, and without `eventId` the incidents the caller is a party to) happens after pagination, so a page can be short and still have a `nextCursor`.
- Spec items still missing: `proposals.revisions`, `events.orbits`, `validation.latest`, `data.refresh`.
