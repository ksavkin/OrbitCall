# Proposed changes for the Decision Center approvals

Status: the doc edits below are applied on `claude/r2-approvals-on-main`. The issue #6 text and the notes for Andrew and Adil are still for the team to post.

The accepted flow (Adil, October 25; user-flow "App navigation and the decision flow"):
- The decision belongs to the event, and it is made in the Decision Center. The room is only its channel.
- Parties decide in turns: side A, then side B.
- Voice may select a card. Only an explicit Approve or Veto click decides.

## Applied in docs/specification.md

1. **§3.4 `rooms.select` row.** Added: "While a decision is open only the side in turn may change it. Served as `api.proposals.select` (issue #6)."
2. **§3.4 `approvals.veto` row.** Added: "Only the side in turn."
3. **§3.4, new row `approvals.status`.** It is the event's decision state: workflow, required sides, selection, `SideApproval` per required side, `allRequiredApproved`, `deciding`, `turn`, `lastReset`, `mySide`, `canAct`, `myTurn`. Party operators and heads of operations read it. Observers use only the separately authorized `observer.publicView` projection.
4. **§4.1 UI contract.** "independent **Approve**" becomes Approve and Veto in turns. An off-turn call returns `INVALID_STATE`, and re-approving is idempotent.
5. **§4.1 step 2.** `ALREADY_DECIDED` once the event is `approved` or `scheduled`. Publishing candidates moves `new`/`agents` to `proposal`; starting the workflow sets `communication`.
   - The second half is a seam: `rooms.startWorkflow` does not set `communication` yet.

## Applied in docs/functionality.md

1. **ROOM-7.** Added: "Required sides decide in turns, side A then side B; only the side in turn can approve, veto or change the selection while the decision is open."

## Issue #6 (functions hosted outside their spec file), text to add

> The spec's names map to these API paths:
> - `rooms.select` → `api.proposals.select` (convex/proposals.ts). Same arguments, returns `null`.
> - `proposals.list` → `api.proposals.list`.
> - `approvals.approve`, `approvals.veto`, `approvals.status` → `api.approvals.*` (convex/approvals.ts).
>
> `fleetQuery.ts` set the precedent: decisions are event state, not room state, so they live next to the proposal and approval tables, not in `rooms.ts`. `api.d.ts` regenerates on main; until then the tests reference these functions by path.

## For Andrew (agents)

- **Proposal cards.** `candidates.publish` now writes `proposals` and `proposalRevisions` in the same transaction, and moves `new`/`agents` to `proposal`. An agent revision of the selected card moves the selection to the new revision and resets approvals. Withdrawing the card clears the selection.
- **Changed publication after consensus is refused** (INVALID_STATE) once the event is `approved` or later. An identical publication can backfill missing proposal records without resetting a decision. Material changes invalidate human approvals; prepared or committed artifacts remain flagged for review.
- **Veto.** It returns the event to `agents` with the reason on a `vetoed` approvals row. Nothing schedules the Advocates' revision yet; the veto path should trigger `negotiate`.
- **The Coordination Host context** reports the approvals these mutations write. A test proves it through `buildHostContext`.

## For Adil (web)

- Hand-copy `approvalStatus` (convex/approvals.ts) and `proposalCard` (convex/proposals.ts) into `web/src/lib/backend/types.ts`.
- Use `myTurn` to enable Approve, Veto and the card selection. Use `turn` to show who is deciding.
- Call `select` with the `selectionGeneration` from `approvals.status`. A voice "option B" should go through the same `select` after the dispatcher confirms.
