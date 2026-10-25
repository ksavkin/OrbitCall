# Proposed changes for host speech

Status: the doc edits below are applied on `kostya/r3-host-speech`. The issue #6 text and the note for Andrew are still for the team to post. Code summary: `261025-3hs-SUMMARY.md`.

Current product terms (docs/user-flow.md):
- the tabs are Orbit, Decision Center, Policy and Inbox;
- the room is the coordination channel of the case;
- the call sits in the Decision Center with a Voice and Text switch;
- decision turns gate the dispatchers' voice and text, but the Coordination Host is not a party, so its voice plays regardless of turns.

## Applied in docs/specification.md

1. **§5 step 3, the subscription rule.** Not edited: the line sits next to step 2, which the voice-hooks branch rewrites; the rule is stated in the `host:<lang>` bullet instead ("whose tracks the worker never transcribes").
2. **§5 step 3, the `host:<lang>` bullet.** Added after "the Coordination Host's voice":
   - it comes from a second worker connection with identity `host`;
   - it speaks a checked English text of a succeeded host run (`call.hostSpeech.speak`);
   - English listeners hear it as is, the others a Claude translation with protected values, and a language whose translation fails its check is not voiced;
   - host speech plays regardless of decision turns and writes no phrase rows.
3. **§5 step 4.** "the `host:<myLang>` track;" became "the `host:<myLang>` track, only from the identity `host` or `host-*`;" (the rule of `web/src/call/tracks.ts`).
4. **§3.4 table, new row `call.hostSpeech.speak`** after `call.join`. Internal action `{ roomId, hostRunId, text }` → `{ status: "sent" | "failed" | "no_listeners" | "disabled" | "rejected", httpStatus?, id?, reason? }`. Server only. The text must be a summary or clarification of a succeeded host run of this open room. It is sent to the worker as a LiveKit server data packet (topic `orbit.host-speech`) only while someone is in the call. Writes no table and never approves.

Not applied, to stay clear of the parallel voice-hooks branch: §5 step 5 (captions; the host's captions are its own channel messages) and step 6. The earlier proposal for a separate §5 step on the entry was folded into item 2 and the §3.4 row.

## Applied in docs/functionality.md

1. **LANG-6.** Added: "The host speaks its checked English text in each listener's language, with the same value protection as human phrases, and is not held by decision turns."

## docs/master-roadmap.md

Not edited. The "Gemini Host contract" line ("Generate canonical host text, then use Claude translation and the selected Cartesia/Grok TTS routes for each listener. Host speech cannot create an approval.") matches the implementation.

## Applied in services/voice/README.md

A "Host speech" section, the subscription rule naming `host` / `host-*`, and the test count (175).

## Issue #6, Round 3 (Kostya)

1. Mark the bullet done once `kostya/r3-host-speech` is merged:
   - [x] Host speech entry in the voice path: `convex/call/hostSpeech.ts` (`speak`, internal) sends checked host text as a LiveKit server data packet (topic `orbit.host-speech`) to the translator. The worker translates it for every listener language and voices it on `host:<lang>` from a second connection with identity `host` (Claude translation, Cartesia EN/ZH, Grok RU). Tests: `tests/call/hostSpeech.test.ts`, `services/voice/tests/test_host_speech.py`, plus a live check on the local LiveKit.
2. **Round 4, Andrew, edit the item:** "checked host text from succeeded runs goes to the voice path's host entry" becomes "after `hostTriggers.finish` marks a run succeeded, schedule `speakRef` (`internal.call.hostSpeech.speak` after codegen) for each checked text the room should hear. Decide whether a summary the checker disagreed with (`check.result.agrees === false`) is spoken."

## Note for Andrew's agent

```text
Context: OrbitCall (Convex backend). Kostya's Round 3 branch kostya/r3-host-speech adds the voice path's host entry. Round 4 asks you to call it from hostTriggers.

Entry: convex/call/hostSpeech.ts
- internal action speak({ roomId: Id<"rooms">, hostRunId: Id<"hostRuns">, text: string }).
- Before codegen lists the module, use the exported reference `speakRef` (makeFunctionReference "call/hostSpeech:speak"). After codegen, internal.call.hostSpeech.speak works too.
- From a mutation (finish): await ctx.scheduler.runAfter(0, speakRef, { roomId: run.roomId, hostRunId, text }).
- Accepted text: exactly one of the run's output.summaries[].text or output.clarifications[].question (exported helper checkedTexts(output) lists them in that order). The run must be succeeded, of that room and of the room's current demo run, and the room must be open. Otherwise: { status: "rejected", reason }.
- Results: sent | failed (with httpStatus) | no_listeners (nobody in the call) | disabled (no LIVEKIT_* env) | rejected. It never throws (any internal error, including the query, hashing or signing, is failed with a reason), writes no table and never creates an approval.
- Captions: speak writes no message. The host's own room message remains the caption.
- Order: separate scheduled actions may arrive in any order. If several lines of one run must play in order, schedule them one after another or send them from one action in sequence.
- Decide in Round 4 whether a summary with check.result.agrees === false should be spoken. Clarification questions are not checked by the second model.
```
