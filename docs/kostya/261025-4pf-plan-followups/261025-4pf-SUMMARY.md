---
quick_id: 261025-4pf
status: complete
completed: 2026-10-25
branch: kostya/r4-plan-followups (from main after #76, #78 and #79)
key-files:
  created:
    - tests/planClosure.test.ts
    - tests/planWaitCard.test.ts
    - tests/sharedRevisions.test.ts
  modified:
    - convex/lib/approvalState.ts
    - convex/maneuvers.ts
    - convex/trajectoryPlans.ts
    - convex/approvals.ts
    - convex/revisions.ts
    - convex/summary.ts
    - tests/revisions.test.ts
---

# 261025-4pf: trajectory plan follow-ups

A backend audit after the trajectory plans (#76) found paths where a shared mover could never be scheduled in production, or stalled without a message. This change closes them.

## Behavior

- **A waiting partner is part of the plan.** Each pair's cards come from its own orbit call, so two events almost never hold a byte-identical burn. The production path for a shared mover is: one event selects the burn, every other affected event selects the waiting card.
  - `maneuvers.ts` `context()` finds the plan that lists a wait card's exact ref, so its plan-bound approvals count.
  - `scope()` treats wait parts as consent parts: they are re-checked but carry no entry. The burn must agree only among parts with an entry. The head is the first part with an entry, in plan order, so every entry point gives the same head and intent; `refs` lists the head first.
  - When the plan commits, the waiting event becomes `scheduled` like every other affected event. A wait card outside any plan still goes to `monitoring`.
  - The re-screen partner is the encounter's object that is not the mover, so a wait part screens the moved trajectory against its own encounter.
- **A disagreeing partner fails visibly.** A partner that selects a different burn fails `SHARED_TRAJECTORY_REQUIRED` with "every other affected incident must select the waiting card or the same burn". `requestPreview` writes that once per selection as a `schedule_failed` log row, instead of swallowing it. A partner with no selection yet is a normal wait and writes nothing.
- **A committed plan is history.** A `scheduled` plan that does not list this event no longer blocks a later single-event maneuver of the same spacecraft.
- **A waiting event in monitoring decides again.** When a new shared burn pulls in an event that already went to `monitoring` on its wait card, the plan's reset returns it to `proposal`, so it can sign the plan.
- **A wait card in a plan waits for the diff.** While the scheduler is configured, a wait card that a plan lists is approved only after the plan's diff exists (the diff is recorded on every part's revision).
- **A closing affected event leaves the plan.** An affected event with no selection and no approvals that expires or is retired from the feed now syncs the plan. Before, it stayed listed without a ref, so the plan could never authorize.
- **Revisions and summary edits use the burn horizon.** `revisions.ts` `sharedBurn` decides whether a maneuver card's mover is shared: a live plan lists this event, or another active, open event of the mover lies in [burn, burn + 72 h] (same demo run, pair duplicates excluded). Rooms no longer decide.
  - A host revision is refused (`TRAJECTORY_PLAN_REQUIRED`) only when a new card with a shared burn changes the burn of the current card with the same id. Text changes, wait cards, cards of an unshared mover and dropping or replacing a card are allowed; the plan then advances and resets the affected events.
  - A summary edit is refused (`SHARED_TRAJECTORY_REQUIRED`) only when it changes a shared burn; a note-only edit goes through. `summary.get` `canEdit` follows the same check.

## Files

- `convex/lib/approvalState.ts`: `invalidateEventApprovals` and `expireUndecidedApprovals` sync plans when there is nothing to reset (not for plan-originated resets).
- `convex/maneuvers.ts`: `context()` wait branch and scheduled-plan fallback, `scope()` consent parts and head, `requestPreview` logging through `auditOnce`, `startIntent` monitoring only without a plan, `jobInput` partner.
- `convex/trajectoryPlans.ts`: `resetEvent` reopens a `monitoring` event.
- `convex/approvals.ts`: `requirePreview` covers a wait card inside a plan.
- `convex/revisions.ts`: `sharedBurn`, `sameBurn`, the rewritten `requireUnshared` and `checkMovers` (now takes cards).
- `convex/summary.ts`: `singleTrajectory` compares the card before and after the edit.

## Tests

- `tests/planWaitCard.test.ts`, 9 tests: a waiting partner on either event schedules once (one prepare, one commit, both events `scheduled`); the waiting event asking first waits, then one write; a single wait still goes to monitoring; a partner moving its other spacecraft fails visibly and never commits; the waiting card or the same burn message is logged once per selection, and nothing is logged while a partner has not selected; a committed plan does not block a later single-event maneuver; a monitoring wait event returns to the decision and signs the plan; a wait approval waits for the plan's diff.
- `tests/planClosure.test.ts`, 2 tests: an affected event without a selection that expires, or is retired from the feed, drops the plan, and the selecting event previews on its own.
- `tests/sharedRevisions.test.ts`, 17 tests: revisions keeping the shared burn pass and advance the plan; changing it is refused with or without a plan; a plan listing only another pair, a room-linked event outside the horizon and a closed partner do not block; summary note edits pass, burn edits of a shared mover are refused, and unshared cases pass.
- `tests/revisions.test.ts`: three cases adapted from room links to the burn horizon. The "replace a plan-bound mover with wait" case now publishes, because dropping or replacing a card no longer changes a shared burn by itself.
- The new wait-card, closure and monitoring tests fail on the code before this change.
- `tsc --noEmit` clean; `vitest run`: 65 files, 1562 tests passed (main: 62 files, 1534 tests).

## Known limits

- **A revision may drop a shared card.** If the partner still selects that burn, scheduling stays blocked until the incidents agree again (visible as the waiting card or the same burn failure).
- **One preview per revision.** A revision keeps the first plan diff recorded on it; if a later plan version needs a different diff for the same revision, `recordPreview` refuses it and the event needs a new selection or revision.
- **A new event entering a horizon does not sync by itself**; the plan follows on the next selection change or approve in an affected event, or `internal.trajectoryPlans.sync({ eventId })`.
- **`advocates.linkedMovers` still uses room membership** for the shared-mover note on published cards. It only affects card text.
- **The horizon rule is defined in three places** (`trajectoryPlans.ts`, `maneuvers.ts`, `revisions.ts`) because of module cycles; change them together.
- **No public plan read.** The UI cannot show which plan version an approval signs or that the plan waits for the other incident.
