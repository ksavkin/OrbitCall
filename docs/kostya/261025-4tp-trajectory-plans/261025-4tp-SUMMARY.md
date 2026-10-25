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
affects: [convex/approvals.ts, convex/lib/approvalState.ts]

key-files:
  created: [convex/trajectoryPlans.ts, tests/trajectoryPlans.test.ts]
  modified: [convex/approvals.ts, convex/lib/approvalState.ts, docs/specification.md, docs/functionality.md]
---

# 261025-4tp Summary: shared trajectory plans (issue #6, Round 4)

## Behavior

- **One plan per shared mover.** A selected maneuver can move a spacecraft that is also a party in another linked event. Linked means active, with a future TCA, in the same open room and the same demo run. That spacecraft then has one `trajectoryPlans` row. The row lists every affected event and, per event, the exact selection it signs: `{ eventId, proposalId, revision, selectionGeneration }`. A row of the same pair in the other object order (±60 s) is the same encounter and does not count as a second event.
- **A version is a row.** Every selection change in any affected event supersedes the active row and inserts the next `planVersion` as `draft`. Changes include a new card, a revision, a veto, and any reset that advances a generation. Old signatures stop counting through the existing check in `countingApprovals` (a superseded plan, another version, or a ref that is no longer listed). They are never revived.
- **Resets.** Each other affected event that holds approvals is reset with reason `trajectory_changed`. The reset goes through `advanceSelection`, so it brings its own generation, system message and log entry. The event where the change happened keeps its own reason (`selection_changed`, `vetoed`, ...). An affected event that had already reached `approved` on its own consensus returns to `proposal`, and both sides can sign the new version. An event whose schedule write is reserved or committed is flagged for review instead (`invalidateEventApprovals`). A maneuver reserved for the superseded version, including a scheduled one, gets `reviewRequired`. Linked events without the spacecraft keep their approvals.
- **Approve.** `approvals.approve` stores the active plan's id and version on the row, and the first approval moves the plan to `authorizing`. Events without a shared mover keep `null`, as before. If a plan has to change at approve time because the change did not pass through a selection write (for example a room link added later), the event is reset and the click is not recorded. The reset and its message stay, and the caller gets `allRequiredApproved: false`.
- **Authorization for the scheduler.** `internal.trajectoryPlans.authorized({ id, version })` returns `{ authorized, reason, eventRefs }`. It is true only when all of these hold:
  - the version is current and `authorizing` or `scheduled`;
  - the demo run is open;
  - every affected event's current selection equals its ref;
  - every affected event has all required approvals counting;
  - every counted approval is bound to `{ id, version }`.

  It reads the stored refs, not the room, because the room closes on the last consensus.
- **Refusal.** `internal.trajectoryPlans.refuse({ id, version })` marks the version `review_required`. It resets every affected event with `trajectory_refused`, returns those events to `agents` (EXE-3), and starts the next version as a draft. A late or repeated call for a version that is no longer active returns `false` and changes nothing.
- **Isolation and concurrency.** Plans, versions and refs are scoped by `demoRunId`. Nothing runs for a closed run. At most one draft or authorizing row exists per `(objectId, demoRunId)`: every writer supersedes before it inserts, and Convex OCC serializes concurrent writers on the plan ranges they read.

## Files

- `convex/trajectoryPlans.ts` (new): affected-set and desired-plan computation (`desiredPlan`), `syncPlans` (line 145), `planFor` (185), `authorized` (207), `refuse` (241), and the repair entry point `sync` (259).
- `convex/approvals.ts`:
  - approve syncs the plan and binds it (lines 111-125);
  - veto records the rejected version (lines 168-177).
- `convex/lib/approvalState.ts`, the one lib change, kept minimal:
  - two reset reasons (line 11);
  - the `syncPlans` call at the end of `advanceSelection` (lines 121-123).

  Every selection writer (`proposals.select`, candidate publication, withdrawal, veto, evidence, policy and assignment invalidation, expiry) already goes through `advanceSelection`, and those files are owned elsewhere. This hook is the only way the plan version follows a change in the same transaction. Without it, a stale approval in the other event would keep counting until its next approve. Resets made by the plan itself carry a `trajectory_` reason and do not re-enter.
- `docs/specification.md` §4.1 "Shared maneuvers" and `docs/functionality.md` ROOM-15: the behavior above.

## Tests

`tests/trajectoryPlans.test.ts`, 11 tests:
- one plan for a shared mover across two linked events, versioned by row;
- both events' approvals on the same version, with `authorized` false until every affected event approved and true after the room closed;
- a new selection in one event resets both events, each with its own reason, and an approved event reopens while the unrelated linked event keeps its approvals;
- a veto supersedes the version;
- a reserved maneuver of a superseded version is flagged;
- a scheduled version is superseded on a later change, with its write and every affected event flagged for review;
- a refusal is idempotent per version;
- a non-shared maneuver and a reversed-order duplicate keep `trajectoryPlanId: null`;
- demo-run isolation;
- concurrent approvals in both events;
- the approve-time reset on a stale room link.

The concurrency test interleaves calls; convex-test runs mutations one at a time, so it shows that repeated and interleaved approvals stay idempotent on one version, not OCC retries themselves. Without the hook 4 of the tests fail, and without the binding 6 fail.

`npm run check`: 50 files and 1328 tests passed. The origin/main baseline was 49 files and 1317 tests.

## Deviations

- **One lib change.** `lib/approvalState.ts` gets the hook and two reset reasons, as agreed with the owner, for the reason given under Files.
- **Code before tests.** The implementation was written first and the tests right after. Each test was checked to fail without the hook or the binding.
- **GSD inline.** The work ran inline, without a separate `/gsd-quick` PLAN.md.
- **Approve may not record a click.** At approve time, a plan change that resets the acting event itself returns `allRequiredApproved: false` without recording the approval. The alternative is a `recorded` flag on the approve result, which changes the §3.4 contract; that is the owner's call. Today it is reachable only when an approval exists and a link to a different pair is added to the room afterwards.
- **Extra repair entry point.** There is an additional internal `sync({ eventId })` mutation for that case.
- **Veto rows.** Veto rows of a shared event record the plan id and version they rejected.

## Known limits

- **No app path links different pairs into one room yet.** `rooms.startWorkflow` links only rows of the same pair, and `providerReadiness` a single event. Plans therefore appear only once a writer (the demo launch, for example) links the pairs of a situation into one room, the same rule `advocates.linkedMovers` uses.
- **The scheduler is not connected yet.** `maneuvers.ts` still refuses plan-bound approvals with `SHARED_TRAJECTORY_REQUIRED`. That check runs for every required side, so an affected event that selected the wait card is now refused too. Before, its approvals were unbound and it went to `monitoring`. Binding it follows the spec, because its geometry uses the moved trajectory. The scheduler also decides "shared" by a burn-time window across all events, not by room membership, so an event outside the room can trigger that error with no plan covering it.
- **One plan slot per approval.** An event whose two objects both have shared plans binds to the plan of its selected card's mover, or, with a wait card, to the first. The other plan cannot be authorized while that event is in it. The frozen schema has one plan slot per approval row.
- **A later change to a scheduled plan.** A scheduled version is superseded like any other, and its write and the affected events are flagged for review. Nothing reopens it: the decision stays with the agents' republication.
- **Linking an event into a room** does not write a selection. The plan follows on the next selection change or approve in an affected event, or through `internal.trajectoryPlans.sync({ eventId })`.
- **Consistency across events is not checked.** Two affected events may select different burns of the same spacecraft. The plan lists both, and the single re-screen of the moved trajectory decides.
- **A closed room is not reopened** when a refusal returns its events to the agents. The Decision Center works without the room.
- **Reopened events get no inbox notice.** An affected event reopened by another event's change gets the room system line and its own reset only, even if its operators had seen "The plan is agreed."
- **Several invalidations in one transaction.** An assignment change on the shared spacecraft, for example, invalidates each affected event in turn. That bumps the version once per event and can post more than one reset in an event.
- **Evidence or policy change on an approved event.** That event follows the existing path: it stays `approved` with review required, while the other affected events reopen. The plan cannot be authorized again until the agents republish, the same state a single event reaches today.
