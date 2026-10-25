---
quick_id: 261025-czt
status: complete
completed: 2026-10-25
branch: kostya/room-call-membership (from main b3b3e66)
key-files:
  created:
    - convex/lib/roomCall.ts
  modified:
    - convex/rooms.ts
    - convex/call/core.ts
    - convex/lib/accounts.ts
    - tests/rooms.test.ts
---

# 261025-czt: room call membership follows current assignment

## Problem

- Only `rooms.startWorkflow` → `autoJoin` wrote `call_members`. An operator assigned to a party object after the room started could open the room (`rooms.join`), but `call/join` and `call/messages.list` returned FORBIDDEN. That operator also never got an inbox notice.
- `call_members` rows were never re-checked. A revoked operator could still mint LiveKit tokens and read captions.

## Change

- `convex/lib/roomCall.ts` holds the `call_members` upsert (`ensureCallMember`, the same row shape as before). `autoJoin` calls it.
- `rooms.join` and `setInCall(true)` (the `setPresence` path with `inRoom`) also call it.
- `isOpenRoom` and `notify` moved to the same lib file verbatim and are re-exported from `rooms.ts`, so the existing imports still work. `lib/accounts` cannot import `rooms.ts` because of a cycle.
- `call/core.ts memberBy` re-checks a member only when both of these hold:
  - `roomId` is a `rooms` id;
  - the row's `userId` is a `users` id.

  The check requires an operator with an active assignment on an object of a linked event. Demo seed members (`call/demo.ts`, `demo-…` user ids, dev tokens) are not re-checked, even when seeded into a `rooms` id.
- `setActiveAssignments` calls `notifyLateAssignment` for newly added objects. For each open room the operator has not joined and whose linked event touches an added object, it writes the startWorkflow notice, which is idempotent through `notify`'s upsert.

## Tests

The new tests are in `tests/rooms.test.ts`, under "rooms and the voice call", with an Auth0-shaped subject `auth0|carl`:

- A late-assigned operator gets a notice per linked event; a rerun leaves no second notice.
- Before the room join the call returns FORBIDDEN. After the join, `memberForJoin` and captions work, and the operator has one row.
- After a revoke, the call and captions return FORBIDDEN while the other operators keep access. Reassigning restores access.
- Assigning an object outside every room leaves no notice.

`npm run check`: 65 files, 1567 tests pass. The existing `startWorkflow`, demo-seed and hooks tests are unchanged.

## Known gap

`call/ingest.ts` resolves the speaker from `call_members` without the re-check. It is service-token gated, so it was left alone.
