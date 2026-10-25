---
quick_id: 261025-4dl
status: complete
completed: 2026-10-25
branch: kostya/r4-decision-log (from kostya/r4-trajectory-plans 677c4d3, merged with main 0418ed6)
key-files:
  created:
    - tests/decisionLog.test.ts
  modified:
    - convex/approvals.ts
    - convex/proposals.ts
---

# 261025-4dl: decision log rows

`proposals.select`, `approvals.approve` and `approvals.veto` left inbox notices but no `log` rows, so the shared audit record (`log.list`, spec §3.6) showed only the `approvals_reset` rows a decision caused. LOG-2 asks for "each candidate selection and approval / veto ... with identity, time and proposal ID/revision". Each of the three now writes one row in its own transaction. The branch starts from main after the trajectory plans (PR #76), because both edit `convex/approvals.ts`.

## Behavior

- **One helper, `logDecision`** in `convex/approvals.ts`: action `selected`, `approved` or `vetoed` (existing literals of the frozen `logAction` union); a human actor `{ kind: "human", userId, companyId, name, side }` with the caller's side in this event and the same name fallback (`"Operator"`) as the other human log rows; `proposalId`, `revision`; `roomId` of the event's open room (`rooms.roomOfEvent`), else null; the event's `demoRunId` and `simulated`; `texts: null` (not a spoken line). `log.list` already returns these rows to both parties and drops the company id from the actor.
- **Selection:** "Side A selected P2 revision 1.", `before: { generation }`, `after: { generation + 1 }`. Only a selection that advances the generation writes a row; re-clicking the current card writes nothing.
- **Approval:** "Side A approved P2 revision 1.", plus " The plan is agreed." when it completes consensus. `before: { status }`, `after: { status, selectionGeneration, approvalRuleVersion, trajectoryPlanVersion }`. Only a newly inserted approval writes a row; repeating the same approval writes nothing. The row is written before consensus closes the room, so it still names the room.
- **Veto:** "Side B vetoed P2 revision 1.", `before: { status, generation }`, `after: { status: "agents", generation + 1 }`. The veto reason is not in the row (see below).
- **Order:** the decision row is written before the reset it causes (`advanceSelection`'s `approvals_reset` row), so the record reads cause, then effect. Both rows carry the same `at`.
- A refused call (off turn, stale, already decided) throws before the insert, so it writes nothing.

## Veto reason

Kept out of the shared row; it stays only on the `approvals` row, as before.

- spec §4.1: `approvals.veto` "logs the veto, invalidates current approvals and returns the event to `agents` with the reason". The reason goes back to the agents, not into the shared record.
- LOG-2 asks for a veto's identity, time and proposal ID/revision, not its text.
- LOG-1 and POL-2: shared log entries never carry private policy records or values. A reason is free text that may quote a private limit, and `log.list` shows human rows to both companies.
- Counters belong in ordinary conversation (ROOM-7), which the log already records as messages.

## Tests

- `tests/decisionLog.test.ts` (new, 3 tests): pick, a re-click, approve A, a repeated approve A, approve B; both operators read the selected and two approved rows newest first, with the human actor (no company id), proposal ID and revision, and the numbers before and after. A veto with a reason, then a new selection: both operators see four decision rows, and neither page contains the reason. An off-turn approve writes no row, and the selection row names the open room.
- No existing test changed: none asserted the exact log contents of a decision.
- `tsc --noEmit` clean; `vitest run`: 62 files, 1532 tests passing (61 files, 1529 tests on main before).

## Known limits

- Conversational counters (`countered`) are still not logged as a separate action; ordinary messages carry them.
- The new rows count against the existing per-event read windows (500 rows in `reports`, `observer.publicView` and `hostPublish`), so a very long incident reaches those limits sooner.
