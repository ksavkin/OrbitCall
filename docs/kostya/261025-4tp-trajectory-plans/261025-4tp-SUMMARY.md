---
phase: quick-261025-4tp
plan: 01
subsystem: convex
tags: [convex, approvals, trajectory-plans, scheduling]
status: complete

requires:
  - "origin/main 975db06 with #56 (approvals and proposals on main)"
provides:
  - "convex/trajectoryPlans.ts: authorized (internal query), refuse and sync (internal mutations); syncPlans, planFor (exported helpers)"
  - "convex/approvals.ts: approve binds trajectoryPlanId and trajectoryPlanVersion; veto records the version it rejected"
  - "convex/lib/approvalState.ts: advanceSelection keeps shared plans current; reset reasons trajectory_changed and trajectory_refused"
affects: [convex/approvals.ts, convex/lib/approvalState.ts, convex/maneuvers.ts]

key-files:
  created: [convex/trajectoryPlans.ts, tests/trajectoryPlans.test.ts, tests/trajectoryHorizon.test.ts, tests/trajectoryDrop.test.ts]
  modified: [convex/approvals.ts, convex/lib/approvalState.ts, convex/maneuvers.ts, tests/sharedScheduling.test.ts, docs/specification.md, docs/functionality.md]
---

# 261025-4tp Summary: shared trajectory plans (issue #6, Round 4)

## Behavior

- **One plan per shared mover, by burn horizon.** A selected maneuver can move a spacecraft that is also a party in another event inside the burn's horizon. Affected means: the mover is object A or B, the event is active and not closed (`verified`, `no_action_needed`), its TCA lies in [burn, burn + 72 h] (`HORIZON_H`), and it is in the same demo run. No room is needed. This is the same set as the `linked` set of `maneuvers.ts` `context()`, so the scheduler and the plan agree. That spacecraft then has one `trajectoryPlans` row. The row lists the selecting event and every affected event and, per event, the exact selection it signs: `{ eventId, proposalId, revision, selectionGeneration }`. An affected event without a selected card yet is listed without a ref. A row of the same pair in the other object order (±60 s) is the same encounter and does not count as a second event. A selecting event whose own TCA lies outside its burn's horizon is not part of any plan.
- **A version is a row.** Every selection change in any affected event supersedes the active row and inserts the next `planVersion` as `draft`. Changes include a new card, a revision, a veto, and any reset that advances a generation. Old signatures stop counting through the existing check in `countingApprovals` (a superseded plan, another version, or a ref that is no longer listed). They are never revived.
- **Resets.** Each other affected event that holds approvals is reset with reason `trajectory_changed`. The reset goes through `advanceSelection`, so it brings its own generation, system message and log entry. The event where the change happened keeps its own reason (`selection_changed`, `vetoed`, ...). An affected event that had already reached `approved` on its own consensus returns to `proposal`, and both sides can sign the new version. An event whose schedule write is reserved or committed is flagged for review instead (`invalidateEventApprovals`). A maneuver reserved for the superseded version, including a scheduled one, gets `reviewRequired`. Linked events without the spacecraft keep their approvals.
- **Approve.** `approvals.approve` stores the active plan's id and version on the row, and the first approval moves the plan to `authorizing`. Events without a shared mover keep `null`, as before. If a plan has to change at approve time because the change did not pass through a selection write (for example a new event that appeared in the burn's horizon), the event is reset and the click is not recorded. The reset and its message stay, and the caller gets `allRequiredApproved: false`.
- **Authorization for the scheduler.** `internal.trajectoryPlans.authorized({ id, version })` returns `{ authorized, reason, eventRefs }`. It is true only when all of these hold:
  - the version is current and `authorizing` or `scheduled`;
  - the demo run is open;
  - every affected event's current selection equals its ref;
  - every affected event has all required approvals counting;
  - every counted approval is bound to `{ id, version }`.

  It reads the stored refs, not the room, because the room closes on the last consensus.
- **Refusal.** `internal.trajectoryPlans.refuse({ id, version })` marks the version `review_required`. It resets every affected event with `trajectory_refused`, returns those events to `agents` (EXE-3), and starts the next version as a draft. A late or repeated call for a version that is no longer active returns `false` and changes nothing. The refused row stays as the record until the next sync.
- **A refusal never strands the mover.** A sync loads every non-superseded plan of the mover, `review_required` included, and supersedes each one that is not the current plan. A `review_required` plan is never kept as current. The scheduler's own refusal (a failed re-screen or changed inputs in `maneuvers.ts` `reset()`) marks the version `review_required` and schedules `trajectoryPlans:sync` for the row's first event. That sync drafts a new `planVersion` with fresh refs while the mover is still shared, or leaves no live plan once it is not (for example, the partner event was resolved); then each open event that was in the plan gets `maneuvers:requestPreview` for its own single-event schedule. The same holds for an event that leaves a plan which still covers others. A version refused when no next version follows is superseded at once. Every new version schedules `maneuvers:requestPreview` for its selecting event.
- **Isolation and concurrency.** Plans, versions and refs are scoped by `demoRunId`. Nothing runs for a closed run. At most one non-superseded row exists per `(objectId, demoRunId)` after a sync (refuse keeps its refused row beside the next draft until then): every writer supersedes before it inserts, and Convex OCC serializes concurrent writers on the plan ranges they read.

## Files

- `convex/trajectoryPlans.ts` (new): affected-set and desired-plan computation (`affectedBy`, `desiredPlan`), `syncPlans` (line 158), `planFor` (199), `authorized` (221), `refuse` (255), and the repair entry point `sync` (273).
- `convex/approvals.ts`:
  - approve syncs the plan and binds it (lines 111-125);
  - veto records the rejected version (lines 168-177).
- `convex/lib/approvalState.ts`, the one lib change, kept minimal:
  - two reset reasons (line 11);
  - the `syncPlans` call at the end of `advanceSelection` (lines 121-123).

  Every selection writer (`proposals.select`, candidate publication, withdrawal, veto, evidence, policy and assignment invalidation, expiry) already goes through `advanceSelection`, and those files are owned elsewhere. This hook is the only way the plan version follows a change in the same transaction. Without it, a stale approval in the other event would keep counting until its next approve. Resets made by the plan itself carry a `trajectory_` reason and do not re-enter.
- `convex/maneuvers.ts`:
  - `context()` skips closed events (`verified`, `no_action_needed`) in its `linked` set, the same filter as the plans;
  - `reset()` schedules `trajectoryPlans:sync` when the row belongs to a plan;
  - `requestPreview` returns `requested` without a second `/prepare` while a prepare job for the same selection is pending or in progress (selection and plan changes may each request it).
- `docs/specification.md` §4.1 "Shared maneuvers" and `docs/functionality.md` ROOM-15: the behavior above.

## Tests

`tests/trajectoryPlans.test.ts`, 12 tests:
- one plan for a shared mover across two linked events, versioned by row;
- both events' approvals on the same version, with `authorized` false until every affected event approved and true after the room closed;
- a new selection in one event resets both events, each with its own reason, and an approved event reopens while the unrelated linked event keeps its approvals;
- a veto supersedes the version;
- a reserved maneuver of a superseded version is flagged;
- a scheduled version is superseded on a later change, with its write and every affected event flagged for review;
- a refusal is idempotent per version;
- a refusal after the partner event left the horizon supersedes the refused version, so no plan is left to block the mover;
- a non-shared maneuver and a reversed-order duplicate keep `trajectoryPlanId: null`;
- demo-run isolation;
- concurrent approvals in both events;
- the approve-time reset when a new event appears in the burn's horizon after an approval (adapted: it used a late room link, which no longer matters).

`tests/trajectoryHorizon.test.ts`, 8 tests (acceptance spec, unchanged):
- two events without a room form one plan, all four approvals sign it, and the shared burn commits once;
- events of the mover outside [burn, burn + 72 h] stay out, even one that selects the same burn;
- a failed re-screen against either partner (2 cases) and a veto supersede the version and draft fresh refs, with no `review_required` plan left;
- a resolved partner drops the plan, and the remaining event previews on its own with a single `/prepare`;
- a single-event maneuver (no other event, or others only outside the horizon; 2 cases) creates no plan and commits unbound.

`tests/trajectoryDrop.test.ts`, 3 tests: a sync that drops the plan requests the remaining event's single-event preview by itself (no manual `requestPreview`), and every `/prepare` carries the same single-event intent; an event that leaves a plan which still covers two others gets its own preview request; a sync that finds the current draft unchanged retires only the refused version beside it.

`tests/sharedScheduling.test.ts`: the refused re-screen case now expects the plan `superseded` (was `review_required`), because the sync after the reset supersedes it.

The concurrency test interleaves calls; convex-test runs mutations one at a time, so it shows that repeated and interleaved approvals stay idempotent on one version, not OCC retries themselves. Without the hook 4 of the tests fail, and without the binding 6 fail.

`npm run check`: 50 files and 1328 tests passed on the original base (49 files, 1317 tests). After merging main with the shared scheduling work (#74), 58 files and 1505 tests passed. With the burn-horizon rule on current main: `tsc --noEmit` clean, 60 files and 1527 tests passed (1519 from main plus the 8 horizon tests). After the review fixes: 61 files and 1529 tests passed; after the follow-up fix, 1531.

## Deviations

- **One lib change.** `lib/approvalState.ts` gets the hook and two reset reasons, as agreed with the owner, for the reason given under Files.
- **Code before tests.** The implementation was written first and the tests right after. Each test was checked to fail without the hook or the binding.
- **GSD inline.** The work ran inline, without a separate `/gsd-quick` PLAN.md.
- **Approve may not record a click.** At approve time, a plan change that resets the acting event itself returns `allRequiredApproved: false` without recording the approval. The alternative is a `recorded` flag on the approve result, which changes the §3.4 contract; that is the owner's call. Today it is reachable only when an approval exists and another event of the mover appears in the burn's horizon afterwards.
- **Extra repair entry point.** There is an additional internal `sync({ eventId })` mutation for that case.
- **Veto rows.** Veto rows of a shared event record the plan id and version they rejected.

## Known limits

- **Rooms no longer decide.** Plans follow the burn horizon, not room links. `advocates.linkedMovers` still uses room membership for its own purpose.
- **A selecting event outside its own burn's horizon.** It is not in the plan, yet `context()` still sees the other events of its burn as linked, so its schedule is refused with `SHARED_TRAJECTORY_REQUIRED` until its selection changes.
- **A committed write is superseded too.** A later change supersedes a scheduled plan even when its maneuver is committed and flags that write for review (existing test); it is not kept live.
- **A new event appearing in a horizon** writes no selection. The plan follows on the next selection change or approve in an affected event, or on `internal.trajectoryPlans.sync({ eventId })`.
- **The preview dedup scans only the 200 newest `_scheduled_functions` rows** on each request, and counts only a first `/prepare` attempt for the same selection (pending, or started in that same run). A job older than that is missed, and the same selection is sent again; the worker treats it as the same job (same intentKey). A plan version created while that first attempt runs is not prepared until the next selection change.
- **Closing an event does not sync.** Resolving a partner (`verified`, `no_action_needed`) writes no selection, so its plan stays until the next selection change or approve in an affected event, or `internal.trajectoryPlans.sync({ eventId })`. Until then `authorized` still counts the closed event's approvals.
- **A refused version stays beside the next draft** (state `review_required`) until the next sync; it is superseded at once only when no next version follows. That sync retires it without touching a draft that still matches, so approvals given on the draft stay. The scheduler picks the plan by the selection refs, which the reset renewed, so it does not choose the refused row.
- **The horizon is defined twice.** `trajectoryPlans.ts` keeps its own `HORIZON_MS` (72 h) because importing `HORIZON_H` from `maneuvers.ts` creates a module cycle; change both together.
- **The scheduler reads plans on its own.** Since #74, `maneuvers.ts` reads the plan rows written here and checks that every approval is bound to the plan's version; it does not call `authorized`.
  - An affected event that selected the wait card has no plan of its own in the scheduler, so its plan-bound approvals are refused with `SHARED_TRAJECTORY_REQUIRED`. Before, its approvals were unbound and it went to `monitoring`. Binding it follows the spec, because its geometry uses the moved trajectory.
  - A refused re-screen marks the plan `review_required` there directly, without the event resets of `trajectoryPlans.refuse`, and schedules the sync that supersedes it.
- **One plan slot per approval.** An event whose two objects both have shared plans binds to the plan of its selected card's mover, or, with a wait card, to the first. The other plan cannot be authorized while that event is in it. The frozen schema has one plan slot per approval row.
- **A later change to a scheduled plan.** A scheduled version is superseded like any other, and its write and the affected events are flagged for review. Nothing reopens it: the decision stays with the agents' republication.
- **Consistency across events is not checked.** Two affected events may select different burns of the same spacecraft. The plan lists both, and the single re-screen of the moved trajectory decides.
- **A closed room is not reopened** when a refusal returns its events to the agents. The Decision Center works without the room.
- **Reopened events get no inbox notice.** An affected event reopened by another event's change gets the room system line and its own reset only, even if its operators had seen "The plan is agreed."
- **Several invalidations in one transaction.** An assignment change on the shared spacecraft, for example, invalidates each affected event in turn. That bumps the version once per event and can post more than one reset in an event.
- **Evidence or policy change on an approved event.** That event follows the existing path: it stays `approved` with review required, while the other affected events reopen. The plan cannot be authorized again until the agents republish, the same state a single event reaches today.
