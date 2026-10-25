# Proposed changes for the voice hooks to the Coordination Host

Status: the doc edits below are applied on `kostya/r3-voice-hooks`. The issue #6 text and the note for Andrew are still for the team to post. The cron line stays a proposal.

Current product terms (docs/user-flow.md):
- **Run agents on this case** calls `rooms.startWorkflow` and opens the coordination channel of the case, with its call.
- The Decision Center hosts the call with the Voice and Text switch.
- While a decision is open, only the side in turn decides.

## Applied in docs/specification.md

1. **§3.4 `rooms.setInCall` row.** "Called on LiveKit connect/disconnect" becomes "Room-level presence (`roomMembers.inCall`). The call screen writes the call's own presence through `call.presence.setInCall` (Section 5)".
2. **§5 call, step 2.**
   - The client calls `call.presence.setInCall({ roomId, inCall: true })`, not `rooms.setInCall`, and repeats it every 30 s as a heartbeat.
   - Disconnect clears the user's call presence.
   - A member without a heartbeat for 75 s counts as having left.
3. **§5 call, step 6.** "When the last participant leaves the call, the Coordination Host posts…" becomes:
   - When the last operator leaves the call (disconnect, leaving the room, or no heartbeat for 75 s) and no operator returns within 15 s, the backend requests a `call_ended` Coordination Host run.
   - An observer still listening does not keep the call open.
   - The summary and the notification follow from that run. The rest of the step is unchanged.

## Applied in docs/functionality.md

1. **ROOM-13.** "When a call ends" becomes "When the last operator leaves the call".

## Applied in docs/master-roadmap.md

1. **§7 API families, Live media row.** `rooms.setInCall` becomes `call.presence.setInCall`, and "presence" becomes "call presence". That is the store the call screen writes and the call-end hook reads.

## Not applied

- **§5 call, step 5** could add: "A phrase's first final revision (rev ≥ 2 with no pending language) requests a `final_message` host run, once per phrase; the host context reads final voice phrases from `call_phrases`." It is left out because §5 steps 3-5 belong to the parallel host-speech branch. That branch, or a later pass, can add it.

## convex/crons.ts (team-owned, optional)

The feature does not depend on a cron: each heartbeat in the call schedules its room's expiry check. The line from the `presence.ts` comment is still useful as a global sweep. It clears presence rows whose room check was lost, and keeps the "in room" list honest for members who only joined (no call), whose rows are not scheduled:

```ts
crons.interval("expire stale call presence", { minutes: 1 }, internal.call.presence.expireStale, {});
```

## Issue #6, Round 3 (Kostya), text to add

> - [x] Voice hooks (`convex/call/ingest.ts`, `convex/call/presence.ts`, `tests/call/hooks.test.ts`):
>   - The first final revision of a phrase schedules `hostTriggers.request({ trigger: "final_message" })`, once per segId, whatever order the revisions arrive in.
>   - The last operator leaving the call schedules `call_ended` after a 15 s grace (`confirmCallEnded` checks again). That covers `leave`, `setInCall(false)` and expiry; observers never count.
>   - Each heartbeat in the call schedules the room's expiry check, so a dead tab ends the call without a cron.
>   - Only call rooms keyed by an existing `rooms` id (as `rooms.startWorkflow` provisions them) reach the host; demo call rooms are skipped. A hook failure never fails the phrase or presence write.
> - With PR #46 (`hostContext` reads final `call_phrases`), a voice-only discussion opens a `final_message` host run end to end; a test covers it.
> - Note: the cron line above is an optional global sweep.

## Open seams

- **Two presence stores.** The team's `rooms.setInCall` writes `roomMembers.inCall`, and nothing hooks it. The call UI writes `call_presence` through `call.presence.*`, which this branch hooks. If the UI switches to `rooms.setInCall`, that path needs its own `call_ended` hook with the same rule: last operator, stale rows absent.
- **Voice turn-gating on the backend is not part of this task.** Text is turn-gated in `convex/messages.ts`; voice is gated only by the UI. The host hooks fire whoever speaks, and gating the worker's phrases would be a separate change.
- **Repeated calls on unchanged inputs.** The host input version ignores `call_presence` and the trigger history. Since PR #46 the version includes final voice phrases, so a call with new speech gets its own `call_ended` run. A call that ends without new final phrases, text messages or other changes dedupes to the previous `call_ended` run. If every call end must produce its own summary, the context needs something per call.

## For Andrew (host)

- The hook's final rule (rev ≥ 2, no pending language) matches the core rule of `hostContext`'s voice filter from PR #46, so nothing more is needed from the host side.
