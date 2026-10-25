---
quick_id: 261025-4sw
status: complete
completed: 2026-10-25
branch: kostya/r4-scheduler-wiring (from main b002651)
key-files:
  modified:
    - convex/maneuvers.ts
    - tests/maneuvers.test.ts
    - docs/specification.md
---

# 261025-4sw: scheduler wiring to the Factory worker

This is issue #6, Round 4, Kostya, "Scheduler wiring". `convex/maneuvers.ts` now calls the Factory schedule worker through `convex/lib/scheduleClient.ts`:
- `/prepare` builds the checked append after a selection and records its diff on the revision before anyone approves.
- `/commit` writes that exact prepared artifact under the same intent key after the re-screen passes.

Convex keeps authorization and durable job state; the worker only builds and writes the artifact. There is no substitute writer, and no schema edit.

Nothing calls the two new entry points yet. The triggers change (PROPOSALS) wires them into `advanceSelection` (every selection write) and `approvals.approve`.

## Entry points

Both are `internalMutation`s that take only `{ eventId }`. They read the event's current selection (proposal, revision, selection generation, approval rule version) themselves, so the caller passes no pins.

### `internal.maneuvers.requestPreview({ eventId })`

**When.** Once after a selection changes, scheduled from the selecting mutation (`runAfter(0, …)`). Calling it again is harmless.

**Returns** `{ status, code }`:

| `status` | `code` | Meaning |
| --- | --- | --- |
| `requested` | `null` | `maneuvers.prepare` is scheduled |
| `prepared` | `null` | This intent already has a maneuver row (any status); nothing to do |
| `skipped` | `NOT_SELECTED` | No complete selection |
| `skipped` | `WORKER_UNAVAILABLE` | No valid `SCHEDULE_SERVICE_URL` / `SCHEDULE_SERVICE_TOKEN`; nothing is logged per selection, `requestSchedule` reports it once |
| `skipped` | `NO_ARTIFACT` | A wait card, or the candidate set is no longer open |
| `skipped` | `PREVIEW_AFTER_APPROVAL` | The revision was never previewed but approvals already exist; a `schedule_failed` log row says so |
| `skipped` | any context code | `STALE_REVISION`, `SHARED_TRAJECTORY_REQUIRED`, `APPROVAL_REQUIRED`, `INVALID_STATE`…; no log row |

**What `prepare` does** (internal action):
1. POSTs Factory `/prepare` with:
   - the intent key `event:<id>:proposal:<id>:revision:<n>:generation:<n>`;
   - the file path `operators/<moving company id>/schedule.json`;
   - the selection ref, `trajectory: null`, and the single schedule entry.
2. Polls `GET /jobs/{id}` every 5 s, up to 60 polls (`PREPARE_POLL_LIMIT`). A Factory session takes tens of seconds and the worker runs one job at a time.
3. Retries a failed job once per poll through `/jobs/{id}/retry`. The worker refuses (409) a retry that is unsafe or over its attempt limit.
4. On completion, `recordPreview`:
   - checks the artifact (append of exactly the selected entry, canonical lines, exact diff);
   - writes `schedulePreviewDiff` and `schedulePreviewHash` on the revision;
   - inserts a `preview` maneuver row with its `maneuverEvents` link.

The pins read before the request travel with every poll. If evidence, policy, ownership or assignments change while the worker runs, `recordPreview` fails `STALE_REVISION` instead of binding the diff to newer inputs.

**Failure before a maneuver row exists.** It is a `schedule_failed` log row with `after.intentKey`, through `recordPrepareFailure`. Repeats of the same summary for the same intent are deduplicated. Nothing is logged when the selection already moved on, or when another chain already recorded the preview.

### `internal.maneuvers.requestSchedule({ eventId })`

**When.** Once, when the event reaches `approved` (every required side), from the same mutation that records the last approval.

**Returns** `{ maneuverId, status, code }`. `status` is `skipped`, `preparing`, `monitoring`, `rescreening`, `committing`, `committed` or `failed`.

**Never throws a coded failure.** Authorization and state failures (`ConvexError` with a code) are logged as `schedule_failed` and returned as `{ status: "failed", code }`, so the approving transaction is unaffected. Uncoded errors still throw.

**Flow:**
- **Wait card.** The event moves to `monitoring`, with no maneuver.
- **Maneuver.**
  1. Re-screen through the existing orbit path (`submit` / `poll` / `finishRescreen`). A refusal resets approvals as before.
  2. On a pass, the `commit` action runs. `reserveCommit` re-checks authorization and the approval times.
  3. It reads the completed `/prepare` job back from the worker, because the row stores only the diff. Its content hash, diff and file path must match the approved preview, else `INVALID_RESPONSE`.
  4. It POSTs `/commit` with the prepared job id, content hash, previous file hash and previous Git commit.
  5. It polls the commit job every 5 s, up to 24 polls (`POLL_LIMIT`). Polls read the reserved intent without re-authorizing (`commitIntent`), because the write is already handed over.
  6. `recordCommit` checks the committed content hash against the revision's preview hash, stores the commit SHA, marks the event `scheduled` and the candidate set `scheduled`. If inputs moved after reservation, the row is kept as `committed` with `reviewRequired` and approvals reset.
- **Polls are bound to what was sent.** The ref sent with `/commit` (including its approval rule version) travels with every poll, so a later rule change cannot hide a handed-over write; `recordCommit` then keeps it `committed` with `reviewRequired`. An unreachable worker during a poll is a missed poll, not a failure, until the poll limit.
- **Retries.** The same intent returns the same worker job, never a second entry. A failed write is retried through the worker only right after `reserveCommit` re-authorized it; a failure seen while polling is recorded as `failed`, and the next `requestSchedule` re-authorizes before the retry.
- **Resume.** For a row whose write may already be with the worker (`committing`, or `failed` after a passed re-screen, e.g. a missed poll), `requestSchedule` first reads back the existing commit job and records it (or keeps polling) without re-authorizing. The row keeps no rule version, so the read-back looks for the version the job was sent with, newest first. Only a missing or failed job goes through `reserveCommit` (re-authorization) before a new `/commit` or a retry.

## Approvals and preview timing

- An approval counts only if it was given after the revision's first recorded preview (`previewedAt`, any generation). `recordPreview` refuses earlier approvals with `INVALID_STATE`, and `currentFor` refuses them with `APPROVAL_REQUIRED`.
- A revision keeps one preview hash. A reset that only advances the selection generation of an already previewed revision keeps that preview: the reset still clears approvals, but the new generation's approvals count without a new preview first. When they complete, `requestSchedule` schedules `prepare` with `thenSchedule`, the worker returns the byte-identical diff (same content hash), and scheduling continues automatically. Its status in the meantime is `preparing`.
- An approval given before the first preview cannot be backed by a later one: `requestPreview` logs `PREVIEW_AFTER_APPROVAL`, and only a new selection (a new intent) recovers.

## Other changes

- `maneuvers.preview` returns `trajectory: null` and no longer reports `workerAvailable: false` or a fixed `WORKER_UNAVAILABLE` error.
- `start` keeps its pinned form and shares `startIntent` with `requestSchedule`.
- Worker errors arrive masked (`SCHEDULE_JOB_FAILED` with a fixed message); `failure()` passes the client's fixed codes and messages through.

## Failure visibility

| Code | Where |
| --- | --- |
| `WORKER_UNAVAILABLE` | Missing or invalid `SCHEDULE_SERVICE_URL` / `SCHEDULE_SERVICE_TOKEN`, or the worker unreachable or refusing. Prepare: a log row. Commit: a `failed` maneuver row. `requestSchedule` with no prepared row: a log row |
| `SCHEDULE_CONFLICT` | The worker answered 409, including a refused retry |
| `SCHEDULE_JOB_FAILED` | The worker job failed (masked message) |
| `INVALID_RESPONSE` | The worker's job or artifact does not match the request or the approved preview |
| `PREPARE_TIMEOUT` | 60 prepare polls without a result; select the plan again |
| `RESCREEN_TIMEOUT`, `SCHEDULE_TIMEOUT` | 24 polls without a result; retrying the same intent reads the same job |
| `PREVIEW_AFTER_APPROVAL` | See above |

The client accepts only an HTTPS URL (or http to localhost) without credentials, query or fragment, and a token of at least 32 characters without newlines.

## Files

- `convex/maneuvers.ts`
  - New: `requestPreview`, `prepare`, `recordPrepareFailure`, `requestSchedule`, `commitIntent`; helpers `currentRef`, `previewedAt`, `startIntent`, `settleCommit`; `PREPARE_POLL_LIMIT = 60`.
  - Changed: `preview`, `recordPreview` (approval-after-first-preview rule), `currentFor` (same rule), `start`, `reserveCommit` (returns the ref), `commit` (worker `/commit` with polling), `failure`.
- `convex/lib/scheduleClient.ts`: unchanged; used as is.
- `tests/maneuvers.test.ts`: worker-backed preview and schedule cases.

## Shared docs

Per `261025-4sw-PROPOSALS.md`:
- `docs/specification.md` §4.1: the Maneuver Scheduler bullets only.
- `docs/functionality.md`: unchanged; EXE-1 and EXE-4 already describe this behavior.

The approve steps, "Shared maneuvers" and "Resets" in §4.1 are left to the trajectory-plans branch.

## Tests

- `tests/maneuvers.test.ts`: 51 tests (14 new) against an in-memory worker that follows the `services/scheduler` HTTP contract.
- `npm run check`: 1474 tests passing (1460 before).

## Known limits

- **Single-event intents only.** A shared mover stays `SHARED_TRAJECTORY_REQUIRED`: another active event of the mover in the 72 h horizon, a multi-event trajectory plan, or an approval carrying a trajectory plan. The worker always gets `trajectory: null`.
- **A shared mover is silent at selection time.** `requestPreview` returns it as `skipped` with no log row; it becomes visible when `requestSchedule` logs it.
- **Shared-mover scheduling is the follow-up** after the trajectory-plans branch: one intent per object and plan version, one re-screen, refs for every affected event.
- **An approval before the first preview** of a revision cannot be backed by a later preview and needs a new selection. The triggers change gates approval on the preview.
- **A rule-version change between prepare and commit** makes the intent fail closed.
- **Demo runs share the operator schedule file.** Their entries are marked `simulated`.
- **Nothing calls these entry points** until the triggers change lands.
- **No automatic retry after a logged failure** (no cron, no schema change): a failed preparation needs the plan selected again; a failed or timed-out write needs `requestSchedule` again (or a new selection).
- **A worker-refused retry** (`SCHEDULE_CONFLICT`, e.g. a write failure the worker marks unsafe to retry or the three-attempt limit) needs manual reconciliation of the worker job before a new selection is scheduled; approvals stay current and the failure is visible.
- **A reset that changes the schedule file** (another maneuver committed to the same operator file since the first preview) makes the re-prepared diff differ; `recordPreview` refuses it and the plan needs a new selection.
