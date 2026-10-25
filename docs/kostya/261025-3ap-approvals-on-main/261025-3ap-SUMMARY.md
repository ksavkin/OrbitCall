---
quick_id: 261025-3ap
status: complete
completed: 2026-10-25
branch: claude/r2-approvals-on-main (stacked on claude/r2-rooms-on-main, PR #35)
key-files:
  created:
    - convex/lib/approvals.ts
    - convex/lib/proposals.ts
    - convex/proposals.ts
    - convex/approvals.ts
    - tests/decision.ts
    - tests/proposals.test.ts
    - tests/approvals.test.ts
  modified:
    - convex/candidates.ts
    - convex/lib/operatorAccess.ts
---

# 261025-3ap: plan cards, shared selection and approvals on main's tables

This port follows Adil's decision of October 25 (user-flow "App navigation and the decision flow"):
- The decision belongs to the event and is made in the Decision Center. The room is only a channel.
- The parties decide in turns: side A, then side B.
- Voice may select a card, but only an explicit Approve or Veto click decides.

The port replaces the old branch `claude/r2-approvals-chain-a21926`, which must not be merged.

**No schema edits.** Everything runs on main's Round 1.5 tables: `proposals`, `proposalRevisions`, `selections` and `approvals` in `schema/schedule.ts`, plus the stored `events.workflow`, `requiredApprovalSides`, `approvalRuleVersion` and `status`.

## What was built

- **Cards from candidates** (`lib/proposals.ts` `syncProposals`, called inside `candidates.publish`).
  - One `proposals` row per event and candidate, and one `proposalRevisions` row per immutable candidate revision.
  - Publishing classifies an unclassified event and moves `new` or `agents` to `proposal`.
  - A new revision of the selected card moves the selection to that revision and resets approvals (`revision_changed`). A withdrawn card clears the selection (`proposal_withdrawn`).
- **Classification** (`lib/approvals.ts` `classifyIfUnset`).
  - Writes the workflow, required sides and rule version 1 only when they are unset, from ownership: one company owning both objects is `internal_review`, anything else `bilateral`.
  - It never infers debris and never overwrites a stored value. Confirmed debris comes from a trusted classifier, which can be ingestion or the demo seed.
- **One reset path** (`advanceSelection`).
  - Every current approval row gets `current: false`, and the selection generation advances.
  - When rows were reset, or on a veto, it writes `selections.lastReset` and posts "Both approvals reset." (or "Approval reset." for debris) into the open room.
  - Switching back never revives an approval.
- **`proposals.list`** returns the cards of the current set, with `isSelected` and `revisionCount`.
- **`proposals.select`** is the spec's `rooms.select`, hosted in `proposals.ts` per the issue #6 precedent.
  - The card must be the latest revision and still offered.
  - `expectedGeneration` gives optimistic concurrency.
  - Re-selecting the current card is idempotent.
- **`approvals.approve`** runs spec §4.1 steps 1–5, then:
  - The turn comes from `decisionTurn` (`lib/decision.ts`, from the rooms port). An off-turn approve or veto returns INVALID_STATE "It is side A's turn to decide."
  - The last required approval sets the event to `approved` and calls `closeRoomIfResolved` in the same mutation.
  - Re-approving the same tick is idempotent.
- **`approvals.veto`** runs steps 1–4 plus the turn check.
  - It resets approvals and stores a `vetoed` history row with its reason.
  - The card stays selected at a new generation, and the event returns to `agents`. The next publish brings it back to `proposal`.
- **`approvals.status`** returns the event-keyed "P2 · R2 · A approved · waiting for B" view: the spec's `SideApproval` per required side, `turn`, `deciding`, `myTurn`, `canAct`, `lastReset`, `selected` and `selectionGeneration`.
  - Parties and the observer can read it. The observer gets `mySide: null` and no control.
- **`countingApprovals`** decides whether a row counts. It applies the same rules as `hostContext.recordedApprovals`: current, exact selection, rule version, demo run, a required side, the owner's operator, and an active assignment.
  - A test proves that the Coordination Host context reports an approval written here.

## Tests

- `tests/proposals.test.ts`: 6 tests.
- `tests/approvals.test.ts`: 11 tests.
- The seed is shared in `tests/decision.ts`.
- `npm run check` passes: 26 files, 899 tests (882 on the PR #35 tip + 17).

## Decisions and deviations

- **Turns versus spec §4.1.** The spec still says "independent Approve"; Adil's user flow says turns. Turns are implemented, and the spec sentence needs the doc fix.
- **Status gate.** Spec step 2 requires `proposal` or `communication`. `candidates.publish` is the writer of `proposal`. `communication` is left to `rooms.startWorkflow` as a seam; approving already works in `proposal`.
- **Spec name `rooms.select`** maps to `api.proposals.select`. Its arguments are the spec's (`proposalId`, `revision`, `expectedGeneration`), and it returns `null`.
- **`proposals.list` cards** carry the computed candidate fields. Feasibility, `recommendedBy` and rationale come from the Advocate and Host queries; they are not joined here yet.

## Known limits and seams

- **Revoke then re-assign.** Revoking an approver's assignment stops their row from counting. Re-assigning them makes it count again, because the row stores no assignment version. The scheduler's pinned `assignmentVersions` on `maneuvers` is the guard at commit time.
- **`decisionTurn`** uses the looser rule: current, exact selection and rule version. `countingApprovals` adds owner and assignment. If an approver loses their assignment, the turn moves to B while A is not counted. A newly assigned A operator can still approve, because a null turn is allowed.
- **Not wired yet:**
  - the `log` audit rows for select, approve, veto and reset;
  - scheduling the agents' revision after a veto;
  - `rooms.startWorkflow` setting `communication`;
  - the hand-copied `approvalStatus` and `proposalCard` types in `web/src/lib/backend/types.ts` for Adil.
