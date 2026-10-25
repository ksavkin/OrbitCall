---
quick_id: 261025-3vh
status: complete
completed: 2026-10-25
branch: kostya/r3-voice-hooks (from origin/main 6107f3b)
key-files:
  created:
    - tests/call/hooks.test.ts
  modified:
    - convex/call/ingest.ts
    - convex/call/presence.ts
    - docs/specification.md
    - docs/functionality.md
    - docs/master-roadmap.md
---

# 261025-3vh: voice hooks to the Coordination Host

This is issue #6, Round 3, Kostya. A final voice phrase asks the Coordination Host for a `final_message` run. The last operator leaving the call asks for a `call_ended` run, after a 15 s grace.

Review found these and they are fixed:
- The blocker: nothing scheduled `expireStale`, so a dead tab never ended the call.
- The missing reconnect grace.
- An unguarded operator count on the presence side.
- A missing test for rev 3 arriving first. The change edits only `convex/call/ingest.ts` and `convex/call/presence.ts`, with no schema edits.

Product terms follow `docs/user-flow.md`. **Run agents on this case** calls `rooms.startWorkflow`, which opens the coordination channel of the case and provisions its call. The Decision Center hosts the call with the Voice and Text switch.

## Behavior

- **Which rooms have a host.**
  - Call tables key on `roomId: string`. `rooms.startWorkflow` provisions a real channel's call as `String(room._id)`.
  - The hook resolves it with `ctx.db.normalizeId("rooms", roomId)` and `ctx.db.get`.
  - A demo call room (`demo-<hex>`, from `call/demo.ts`) is not a rooms id and is skipped silently, as is a rooms id whose row is gone. `hostTriggers.request` never receives a non-rooms id.
- **Final phrase (`final_message`).**
  - The worker posts rev 1 pending, rev 2 final, and rev 3 only when a voice failed afterwards. The posts run in the background and can arrive in any order.
  - A phrase is final when `rev >= 2` and no language in `translationStatus` is `pending`.
  - Only the applied write that first makes the phrase final asks the host: an insert of a final rev, or a patch over a stored row that was not final.
  - These never fire: a late rev 1, a repeated or older rev (not applied), and a rev 3 over a final rev 2.
  - Convex OCC serializes two concurrent posts of one segId, so the second sees the first.
  - A phrase with no listener languages (`translationStatus: {}`) is final at rev 2.
- **Last operator out (`call_ended`).**
  - The check runs when an operator whose stored row had `inCall: true` leaves the call, through `leave` or `setInCall(false)` (both go through `upsert`).
  - If no operator of the room is still in the call afterwards, `endIfLast` schedules the new internal `confirmCallEnded({ roomId })` after `CALL_END_GRACE_MS` (15 s).
  - `confirmCallEnded` checks again and requests the run only if still no operator is in the call. A LiveKit drop followed by a reconnect within the grace ends nothing.
  - "In the call" counts only `call_members.role === "operator"` rows with `inCall` and a heartbeat newer than `STALE_MS`. Observers never count, and an observer leaving never fires.
  - The leaver's own heartbeat age is ignored: its stored `inCall` is the call it leaves. A row that `expireStale` already cleared reads `inCall: false`, so it does not fire twice.
  - `expireStale` groups the expired rows that were in the call and belong to an operator, and checks each room once after patching. This applies to both the per-room form and the global form without a room id.
- **A tab that dies still ends the call, with no cron.**
  - Every `upsert` that writes an in-call row schedules a room-scoped expiry check: `runAfter(STALE_MS + 1 s, expireStale, { roomId })`. A write here is an insert or a patch that refreshes `updatedAt`. That covers the first entry and every heartbeat.
  - The web's beat is `join` + `setInCall(true)`, so each beat schedules two checks. A check per write is needed: a tab that dies between a beat's `join` and its `setInCall(true)` leaves a row the `join` refreshed, which only the `join`'s own check outlives.
  - While heartbeats continue, the checks find a fresh row and do nothing.
  - The check scheduled from the last heartbeat clears the row, and the `endIfLast` → `confirmCallEnded` path requests `call_ended`, about 91 s after the last heartbeat at the latest.
  - A team cron sweep (PROPOSALS) is optional.
- **Scheduling, never inline.**
  - Both hooks call `ctx.scheduler.runAfter(0, hostTriggers:request, { roomId, trigger })` and return.
  - The phrase hook sits in a try/catch, so a phrase write never fails because of it. Validation errors of the phrase itself still throw as before.
  - On the presence side, the same holds for the room lookup and scheduling in `requestHost`, the operator count and grace scheduling in `endIfLast`, the re-check in `confirmCallEnded`, the expiry scheduling and the role lookup in `expireStale`: a failure never fails the presence write or the expiry.
  - `hostTriggers.request` dedupes by (room, input version, trigger) and returns null when there is nothing to do: a closed room, no linked events, or for `final_message` no message in the context.
  - Since PR #46, the context includes final voice phrases: `hostContext` reads `call_phrases` with rev ≥ 2 and no pending language, from an authorized operator speaker, matching the room's simulation flag, started after the room opened, and with `eventId` null or linked. A voice-only discussion therefore opens a host run, and PR #48 publishes the checked output to the room.
- **Turns are not consulted.** The host is asked whoever is speaking. Decision turns (side A, then B, then the others) gate text in `convex/messages.ts`, while voice is gated only by the UI.

## Files

- `convex/call/presence.ts`
  - `requestHost(ctx, roomId, trigger)` (exported): maps the room, schedules, and swallows failures. The reference is built with `makeFunctionReference("hostTriggers:request")`, like the call module's other references.
  - `operatorInCall` counts operators in the call. `endIfLast` schedules the grace confirmation. `CALL_END_GRACE_MS = 15_000` is exported.
  - New internal mutation `confirmCallEnded({ roomId })`.
  - `scheduleExpiry` schedules the room's expiry check on every write that refreshes an in-call row.
  - The `upsert` hook covers leave and `setInCall(false)`; the `expireStale` hook does one check per room.
- `convex/call/ingest.ts`
  - `isFinal`.
  - `upsertPhrase`: the insert and patch paths now fall through to one hook point. The return value (`applied`) and the HTTP response are unchanged.
- `tests/call/hooks.test.ts`: 21 tests. Phrases go through `POST /call/phrase` and presence through the public mutations.
  - The tests assert on `_scheduled_functions` rows named `hostTriggers:request`, under fake timers.
  - The grace confirmations and expiry checks run by advancing the fake clock and calling `finishInProgressScheduledFunctions`. Host requests themselves are never run. Team rooms are `rooms` rows with no linked events, seeded with `call/demo:seed({ roomId: String(id) })`.

## Shared docs

Per `261025-3vh-PROPOSALS.md` ("Applied in …"):
- `docs/specification.md`: the §3.4 `rooms.setInCall` row, §5 step 2 (call presence and heartbeat) and §5 step 6 (last operator, 15 s grace, `call_ended` run).
- `docs/functionality.md`: ROOM-13.
- `docs/master-roadmap.md`: the §7 Live media row.

§5 steps 3-5 and LANG-* are left to the parallel host-speech branch.

## Tests

- Final phrase:
  - rev 1 then rev 2 fires once; a repeated rev 2 and a later rev 3 do not.
  - rev 2 before rev 1 fires once, and the late rev 1 is ignored.
  - rev 3 arriving first fires once, and the late rev 2 and rev 1 are ignored.
  - With no listener languages, rev 2 fires; two phrases fire twice.
  - A rev 2 still marked pending does not fire.
  - A demo room stores the phrase and fires nothing.
  - A rooms id whose row was deleted stores the phrase and fires nothing.
- Call end:
  - With two operators, the first leaving does not fire and the last leaving fires once after the grace, not before; later leaves do not fire again.
  - The last operator reconnecting within the grace does not fire (the confirmation runs and finds them back). Leaving again with nobody returning fires exactly once.
  - Each write of the in-call row (`join` + `setInCall(true)` per beat) schedules a room expiry check at STALE_MS + 1 s. After the tab dies, the check from the last heartbeat clears the row and the call ends exactly once; later checks fire nothing.
  - A tab that dies after a beat's `join` but before its `setInCall(true)`: the first check finds the row the `join` refreshed and clears nothing; the `join`'s own check clears it; exactly one `call_ended` follows after the grace.
  - Checks running while heartbeats continue clear nothing and schedule no confirmation.
  - `setInCall(false)` of the last operator fires while an observer is still listening.
  - An observer leaving or expiring never fires.
  - A member who was never in the call does not fire.
  - A stale operator does not keep the call open for the one leaving.
  - `expireStale` of the last operator fires once, with and without a room id; a second run does not.
  - `expireStale` of two operators at once fires once; a stale row in the room but not the call does not fire.
  - A demo room never fires.
  - The scheduled arguments are accepted by `hostTriggers.request` (null: no linked events).
- End to end (seeded like `tests/hostContext.test.ts`):
  - A team room with one linked event whose object A is owned by and assigned to the speaking operator.
  - Rev 1 then rev 2 posted through `upsertPhrase`; the due `hostTriggers:request` is run.
  - Result: a `running` `final_message` host run exists, so the voice phrase reached the host context.
  - The `hostTriggers:run` it schedules stays pending: no host action runs and no provider is called; `GEMINI_API_KEY` is stubbed empty as well.
- `npm run check` in the container: typecheck clean; **1253 tests passed**: the origin/main d07f9e5 baseline is 1232, and this branch adds the 21 tests of `tests/call/hooks.test.ts`. The original baseline was 1044 at 6107f3b.

## Known limits

- **The hook's final rule is broader than the context's.** The hook fires on rev ≥ 2 with no pending language, the same core rule as `hostContext`. The context also drops phrases that are empty, mismatched, unauthorized, from before the room opened, or about an unlinked event. For such a phrase the request runs on the inputs as they were and dedupes to the existing run, or returns null if no message remains.
- **A dead tab's call ends late.** It ends up to about STALE_MS + 1 s + the grace (≈ 91 s) after the last heartbeat. The per-heartbeat checks make this independent of a cron. They cost two scheduled jobs per web beat (`join` + `setInCall`, every 30 s) per member in the call, about four a minute, each a single indexed room read when nothing is stale. This load is accepted to keep the end correct.
- **`call_ended` is not bound to the leave-time input version.** The request carries no `inputVersion`, so the host answers whatever the room's inputs are when it runs, after the grace.
- **Scheduling failures are swallowed.** A failure inside `requestHost` (or the grace and expiry scheduling) is dropped: at most once, by design, so a phrase or presence write never fails because of the host.
- **A second call with no new speech gets no new run.** The input version hashes the context messages, which now include final voice phrases, but neither `call_presence` nor the trigger history. A second call with new final speech (or new text) gets a new input version and its own `call_ended` run. A call that ends with no new final phrase, no new text message and no other change dedupes to the existing `call_ended` run. A later rev that only reports a voice failure does not change the version.
- **Duplicate requests are possible and harmless.** For example, an operator leaves while another's stale row is still marked in the call, and an expiry check later clears that row. Leaving and rejoining twice within one grace has the same effect: two confirmations can both find nobody. The host dedupes them per input version.
- **Only the `call_presence` path is hooked.** The team's second presence store, `rooms.setInCall` → `roomMembers.inCall`, is not. The web call (`web/src/call/useCoordinationCall.ts`) uses `call.presence.*` today.
- **A late heartbeat after an explicit leave.** If a `setInCall(true)` sent before the leave lands after it, the row reads `inCall` again. The call then ends through that beat's expiry check, about 91 s later instead of 15 s.

## Considered and not changed

- **"A reconnect longer than 15 s fires call_ended."** During LiveKit auto-reconnect the client stays in "reconnecting" and keeps heartbeating (`web/src/call/useCoordinationCall.ts:315-317, 479`). `setInCall(false)` is sent only on a real Disconnected, so ending 15 s after a real disconnect is the intended behavior.
