---
phase: quick-261025-3hs
plan: 01
subsystem: convex, services/voice
tags: [convex, livekit, voice, coordination-host, translation, tts]
status: complete

requires:
  - "origin/main 6107f3b: hostRuns with checked output (hostTriggers.finish), call_presence, roomMembers, the voice worker"
provides:
  - "convex/call/hostSpeech.ts: speak (internal action), prepare (internal query), speakRef, checkedTexts, roomAdminToken, speechId, httpBase, HOST_SPEECH_TOPIC"
  - "services/voice/orbit_voice/host.py: parse, HostSpeech, HostPublisher, host_token (topic orbit.host-speech, identity host)"
  - "services/voice/orbit_voice/player.py: host_track_name; TrackPlayer takes an optional track name"
  - "services/voice/orbit_voice/agent.py: listener_langs; the room job wires data_received to host speech"
affects: [services/voice/orbit_voice/agent.py, services/voice/orbit_voice/player.py, services/voice/README.md, docs/specification.md, docs/functionality.md]

key-files:
  created: [convex/call/hostSpeech.ts, tests/call/hostSpeech.test.ts, services/voice/orbit_voice/host.py, services/voice/tests/test_host_speech.py]
  modified: [services/voice/orbit_voice/agent.py, services/voice/orbit_voice/player.py, services/voice/README.md, docs/specification.md, docs/functionality.md]
---

# 261025-3hs Summary: host speech entry into the voice path

## What it does

Issue #6, Round 3 (Kostya): "Host speech entry in the voice path: an internal entry that takes checked host text for a room, and the worker publishes it per listener language (Claude translation, Cartesia EN/ZH, Grok RU) on `host:<lang>` tracks."

The flow:

1. **Convex.** A caller passes `internal.call.hostSpeech.speak({ roomId, hostRunId, text })`, one checked text of a succeeded Coordination Host run. Before codegen lists the module, `speakRef` is the reference to use.
2. **The checks.** `prepare` (internal query) accepts the text only when all of these hold:
   - the run exists, has `status === "succeeded"` and belongs to `roomId`;
   - the room is open: the same rule as `isOpen` in `hostTriggers.ts` (state open, `closedAt` null, demo run open);
   - the room's `demoRunId` equals the run's, so an old run never speaks into a new one (roadmap §14);
   - `text` is exactly one of the run's checked texts (`output.summaries[].text` or `output.clarifications[].question`) and at most 2000 characters (`MAX_TEXT` of `call/ingest.ts`).

   Anything else returns `{ status: "rejected", reason }` and makes no network call. `requestedRevisions` are never spoken.
3. **Nobody in the call.** Without a listener, `speak` returns `no_listeners` and makes no network call. A listener is either:
   - a fresh `call_presence` row with `inCall` (heartbeat within `STALE_MS`; this is what the web writes today), or
   - a `roomMembers` row with `inRoom` and `inCall` (`rooms.setInCall`, which spec §5 names), with no age limit because that table has no heartbeat.
4. **Not configured.** Without `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, `speak` returns `disabled` and does not throw.
5. **Sending.** Otherwise it sends one LiveKit server API call, `POST <https base of LIVEKIT_URL>/twirp/livekit.RoomService/SendData`:
   - auth: `Bearer` HS256 JWT signed with Web Crypto, claims `{ iss, nbf, exp: +120 s, video: { roomAdmin: true, room } }`;
   - body: `{ room: "coordination-<roomId>", data: base64(UTF-8 JSON), kind: "RELIABLE", destinationIdentities: ["translator"], topic: "orbit.host-speech" }`;
   - payload: `{ v: 1, id: "<hostRunId>:<first 16 hex of sha-256(text)>", roomId, hostRunId, lang: "en", text }`.

   It returns `sent` or `failed` with the HTTP status (`null` on a network error or the 10 s timeout) and a reason. It never throws: a failing query, hash or signature is `failed` too. The response body is released unread. It writes no table and creates no approval.
6. **The worker accepts.** The room job's `data_received` handler accepts a packet only when both hold:
   - `participant is None`, which LiveKit documents as "sent by a server SDK" (a human's packet always has a participant, and human tokens carry `canPublishData: false`);
   - the topic is `orbit.host-speech`.

   It then checks the version, `lang == "en"`, that the room is this job's room, the ids and a text of 1..2000 characters, and drops a repeated `id` (the last 256 ids are kept). Anything else gets a log line and is ignored.
7. **Listener languages.** These are the `lang` attributes of the `user-*` participants in the room. English listeners hear the canonical text as is, enqueued at once, before the translation call. Before each language is enqueued the listeners are read again: a language whose listeners left is skipped (`LISTENER_LEFT`), and once no human is left the line stops (`NO_LISTENERS`) without reconnecting `host`. The other languages get one Claude call through `translate.py`, with protected values and the per-language check and retry exactly as for phrases. A language whose translation fails is not voiced (no substitution, lesson R13). Over 64 values means English only, like phrases.
8. **Voice.** The same routes as phrases (`tts.py`: Cartesia en/zh, Grok ru) in `TTS_DEFAULT_VOICE`, because the host has no member gender.
9. **Playback.** It plays on `host:<lang>` from a second LiveKit connection with identity `host` (name "Coordination Host", attribute `role=host`), because `web/src/call/tracks.ts` accepts `host:<lang>` only from `host` / `host-*`. The connection:
   - is minted in the worker with the LiveKit key it already has (publish the microphone source only, `canSubscribe: false`, no data, no room configuration, not hidden);
   - connects on the first host line and is reused;
   - leaves when the last human leaves, so the empty room can close, and reconnects for a later line. Connecting and leaving are decided on the humans present at that moment, under one lock: it never connects for an empty room, leaves again if the last human left during the connect, and a late `idle()` never closes a connection a returning human's line uses;
   - is closed with the job.

   Lines are handled one at a time, so their order holds on every track, and playback never blocks the next line.
10. **Never transcribed.** The worker still subscribes only to `user-*` microphones. The `host` participant's tracks are never subscribed or transcribed (spec §5: "listens only to original human tracks").
11. **Not gated by turns.** Host speech ignores decision turns (side A, then B, then others). The Coordination Host is not a party, so its voice plays to every listener whatever the turn.

## Decisions and deviations from the brief

- **A `rejected` result instead of a throw.** Invalid input (not succeeded, another room, closed room or older demo run, unchecked or too long text) returns `{ status: "rejected", reason }`. A closed room after a successful run is a normal race, and a scheduled action that throws only adds log noise. The result types are `sent | failed | no_listeners | disabled | rejected`.
- **Presence reads both stores.** Spec §5 and the rooms work say the web should move to `rooms.setInCall` (`roomMembers.inCall`), while the web writes `call_presence` today. A `call_presence`-only check would return `no_listeners` forever after that move. A `roomMembers` row counts only with `inRoom`, `inCall` and `updatedAt` within `STALE_MS` (after review).
- **Own HS256 signer.** `mintLiveKitToken` fixes the call grant and its base64url helper is not exported, and `livekitToken.ts` was out of scope. `roomAdminToken` is a small Web Crypto signer in the default Convex runtime: no `"use node"`, no `livekit-server-sdk`.
- **`makeFunctionReference` for the internal query and `speakRef`**, as `call/join.ts` does: `convex/_generated/api.d.ts` lists modules explicitly and needs a deployment to regenerate. Tests address functions through `anyApi`.
- **The `host` connection leaves when the last human leaves.** This is not in the brief. A standard (non-agent) participant would keep the empty LiveKit room, and with it the translator job, alive.
- **`TrackPlayer`** got an optional `name` keyword. Existing `tr:<lang>:<identity>` names are unchanged (a test pins them).

## Docs

Applied in this branch: `docs/specification.md` §5 steps 3 and 4 and a §3.4 row for `call.hostSpeech.speak`, `docs/functionality.md` LANG-6, and `services/voice/README.md`. Each edit is listed in `261025-3hs-PROPOSALS.md`. `docs/master-roadmap.md` already matches and is not edited.

## Tests

- `tests/call/hostSpeech.test.ts`, 13 cases, convex-test in memory with a stubbed `fetch`:
  - URL, a valid HS256 roomAdmin JWT for that room (checked with `createHmac`), body and payload shape, and non-Latin-1 text through base64;
  - a stable id per run and text;
  - rejection of an unchecked or edited text, a requested-revision reason, a run that is not succeeded, another room, a too-long text, a closed room, a closed demo run and an older demo run;
  - `no_listeners`, including stale and `inCall: false` rows; a fresh `roomMembers` listener, and stale or not-in-room `roomMembers` rows that do not count;
  - a deleted run (`not_found`); a failing hash or key import is `failed`, never a throw;
  - `disabled` with the LiveKit env cleared explicitly, `ws://` to `http://`, `failed` on 404 and on a network error;
  - no table written.
- `services/voice/tests/test_host_speech.py`, 47 cases, with fakes:
  - packet authenticity: a participant-sent packet and other topics are ignored;
  - `/health` is degraded only by faults, as for phrases, not by a missing voice id or a rejected translation;
  - 16 validation cases;
  - dedupe and its memory bound;
  - listener languages (only `user-*`) and English without a translation call;
  - one failed language, a translator crash (English still spoken), no voice, failed TTS and too many values;
  - English playing before the translation returns; a line stopped without reconnecting when the last human leaves mid-line; a language whose listener left during the translation not played;
  - line order;
  - track names `host:<lang>` and unchanged `tr:` names;
  - the host token's identity and grants;
  - lazy connect, reuse, reconnect after a drop, no connect for an empty room, a human leaving during a slow connect (no `host` left behind), a late `idle()` while a human is back (connection kept), idle and close;
  - the room job: host tracks never subscribed or transcribed, `data_received` wired, `on_gone` of the last human releases `host` (real publisher, fake room).
- `npm run check` (r3-node-speech): 1044 → 1055 passed on 6107f3b; on the PR #59 base after the review fixes, 1245 passed (13 of them in `tests/call/hostSpeech.test.ts`), typecheck clean.
- `python -m pytest -q` (r3-py-speech): 130 → 177 passed.

## Live check (local LiveKit v1.12.0, livekit python 1.1.21)

`r3-worker` compose service (profile `r3`, in the `voice2-backend` network namespace, worktree mounted read-only), started with `up -d --no-deps` so no `voice2-*` service was touched. The script:

- connects fake listeners `user-live-ru` and `user-live-en`;
- runs this worktree's `RoomTranslator` on a plain `rtc.Room` with identity `translator` (no dispatch, so the voice2 worker registered on the same server is never involved);
- replaces only the translator and TTS with fakes (a tagged copy of the text, a 1 s 440 Hz tone);
- sends the same SendData request the Convex code builds.

16 of 16 checks passed:

- **Rejected packets.** A packet from `user-live-ru` on the host topic reached the job and was ignored. A server packet on another topic was ignored.
- **Delivery.** SendData answered 200. The server packet arrived with `participant=None`. A repeated id was dropped, with one translation call (en → ru).
- **Tracks.** Participant `host` ("Coordination Host", `role=host`) published `host:en` and `host:ru`. Each listener subscribed only to its own language and received about 103 non-silent frames of the 1 s tone.
- **Not subscribed.** The job subscribed to none of the host's tracks.
- **Leaving.** `host` stayed while one human remained and left after the last one, leaving only `translator`.

The script and its output were run locally and are not in the repo.

## Review findings considered and not changed

- **"Checked text ignores `run.check`."** Refuted: `hostTriggers.finish` sets `succeeded` only when the host output is checked (`convex/hostTriggers.ts:195-201`), and a successful checker disagreement is by team design a separate result that Round 4 publishes beside the summary.
- **"Demo reset between prepare and send"** and **"lossy delivery, no retry"**: accepted as known limits below.

## Known limits and open seams

- **Wiring the call is Andrew's Round 4.** `hostTriggers.ts` should schedule `speakRef` (`internal.call.hostSpeech.speak` after codegen) for the checked texts of a run it has just marked succeeded. Nothing calls the entry yet.
- **Captions** of host text come from Andrew's agent messages in the room, not from this path. Host speech writes no `call_phrases` row (that ingest requires a `user-*` speaker).
- **Delivery is fire and forget.** SendData answers 200 even when `translator` is not in the room yet (for example, in the seconds after the first member joined). Such a line is lost, and `speak` cannot see it.
- **Order across scheduled actions.** Several lines of one run, scheduled as separate actions, may reach the worker in any order. The worker keeps arrival order. A caller that needs strict order should schedule the lines one after another, or send them from one action in sequence.
- **A run can be `succeeded` while the checker disagrees** (`check.result.agrees === false`), and clarification questions are not checked by the second model. Both are voiced as "checked host text". Whether to skip a disagreeing summary is Andrew's call in Round 4.
- **Lossy delivery, no retry.** Besides the not-yet-joined translator above, a failed SendData is returned as `failed` and not retried here; Round 4 may add one retry.
- **Demo reset between check and send.** `prepare` reads the room and run in a query and the packet is sent after it; a reset within those milliseconds is not seen. The worker still only voices for the humans present.
- **`roomMembers` has no heartbeat.** A `roomMembers` row in the call counts whatever its age, so a row left behind by a closed tab can send a packet nobody hears; the worker drops it (an extra packet is cheaper than a lost host line).
- **Joined mid-line.** A listener who joins after a line was queued hears only the rest of it. Lines are not replayed.
- **`host` and `host-*` identities.** Only one `host` connection per room is made. `host-*` stays reserved by the client rule.
