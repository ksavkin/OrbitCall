---
phase: quick-261025-3rm
plan: 01
subsystem: convex
tags: [convex, rooms, messages, inbox, workflow]
status: complete

requires:
  - "origin/main round 1.5 schema (e246f9f…): rooms, roomEvents, roomMembers, messages, inbox, proposals"
provides:
  - "convex/rooms.ts: startWorkflow, get, byId, listMine, join, leave, setInCall (public); closeIfResolved (internal); requireMember, requireActiveMember, roomOfEvent, linkedEvents, isOpenRoom, notify, closeRoomIfResolved (exported helpers)"
  - "convex/messages.ts: send, list, toMessage, messageView"
  - "convex/inbox.ts: list, get, markRead, inboxEntry"
  - "convex/lib/incident.ts: sectionOf, priorityReason, viewerSides (myQueue reuses them)"
affects: [convex/myQueue.ts]

key-files:
  created: [convex/rooms.ts, convex/messages.ts, convex/inbox.ts, convex/lib/incident.ts, tests/rooms.test.ts, tests/messages.test.ts, tests/inbox.test.ts]
  modified: [convex/myQueue.ts]

commits:
  - 89b44a7 Add rooms.startWorkflow with auto-join, room reads, presence and close on resolution
  - 6d775a1 Add messages.send and messages.list on the round 1.5 messages table
  - f6c03ea Move section, summary and side rules into lib/incident for myQueue and the inbox
  - 8042d4c Add the personal inbox on the round 1.5 inbox table with room presence and join notices
---

# 261025-3rm Summary: rooms, messages and inbox on main, with the Start workflow flow

## Why this exists

Items 261025-2r9/2ra/2rd were first built on `claude/r2-rooms-chain-d2875e`, which came from `kostya/r2-core` (`d3782a3`). That base forks from `33481df6`, before Andrew's Round 1.5 schema. That branch adds its own `rooms`, `roomEvents`, `messages` and `inboxReads` tables, which collide with main. By the user's decision, the same work was redone on `claude/r2-rooms-on-main`, branched from `origin/main`. This branch makes no schema edits and uses main's tables as they are. The old branch stays untouched and should not be merged.

## User flow implemented (Adil, 2026-10-25)

Rooms are an optional communication channel that connects automatically.
- **Start workflow.** On the conjunction, an operator presses "Start workflow", which calls `rooms.startWorkflow({ eventId })`. It creates or returns the encounter's open room. The room covers every pair row within ±60 s, in both object orders.
- **Auto-join.** Every operator currently assigned to a party object is joined: `roomMembers` gets `inRoom: true`, and `call_members` gets a row keyed by `String(roomId)` so `call.join` can mint a LiveKit token.
- **Notice.** Operators joined by someone else get an unread inbox notice, "You were added to the coordination room for A × B". Nobody is moved to the room screen.
- **Presence.** `rooms.byId` and `inbox` show who is in the room. `join`, `leave` and `setInCall` update `roomMembers` presence.
- **Head of ops.** Reads rooms and messages, and cannot start, join or post (user's decision).
- **Closing.** The room closes when every linked incident is resolved. Resolved means a stored status of approved or later, or no longer active. `closeRoomIfResolved(ctx, eventId)` closes the room idempotently and posts a system line. A closed room stays readable, refuses writes with INVALID_STATE, and a new Start workflow opens a fresh room.

## Decisions and deviations

- **Membership is current responsibility** for an object of a linked event: assignment for an operator, company ownership for a head of ops. It is checked on every call, so revoking an assignment ends membership. A `roomMembers` row carries presence, and its `companyId` is the user's own company, which `hostTriggers.listForRoom` requires.
- **Start workflow needs an active event only, not a red one.** A room may start from any open conjunction.
- **Event status is left unchanged** by Start workflow. Moving the event to `communication` belongs to the lifecycle owner.
- **Workflow and approval sides come from the stored `events` fields.** Unclassified events give `canAct: false`.
- **messages:** `author.name` is the provisioned name, else the company name. `originalLang` is the user's language, else the company's, else "en". Main's schema requires both fields, and these fallbacks are labeled in the code. Messages also validate `refs.proposalId` against the room's events.
- **inbox:** main's `inbox` table has no fingerprint, so an entry is unread in four cases:
  - it has no row;
  - its row is an unread notice;
  - `updatedAt` moved past `row.lastUpdateAt`;
  - the summary line read differs from the current one, which changes with color, the active flag and the section.
- **Recolor needs no write.** A color-only change re-flags an entry through the summary, so no inbox write is needed from recolor.
- **Old-branch features not ported:** `rooms.open`, the internal `openForEvent`, and the derived `inboxReads` table. The flow replaced them.
- **GSD:** this port ran inline under the user's direct instruction; no separate PLAN.md was written.

## Open seams

- **Approvals is not on main yet.** It should call `closeRoomIfResolved` in the mutation that records the last required approval, after setting the event status. Until then, `rooms:closeIfResolved` is internal only.
- **Two presence stores exist.** `roomMembers` is written by rooms and read by the inbox. The voice module's `call_presence` is written by `call.presence`. The web should call `rooms.join/leave/setInCall`.
- **The call identity needs a session identity.** `call_members.subject` is derived from `users.tokenIdentifier` ("<issuer>|<subject>"). The demo browser sends no Convex identity (`CONVEX_AUTH = false`), so `call.join` for a real room needs Auth0 sign-in, or devTokens issued for these rows.
- **demo.reset is not built.** A room carries `demoRunId`, and `isOpenRoom` treats a closed demo run as closing its room.

## Verification

- `npx vitest run tests/rooms.test.ts tests/messages.test.ts tests/inbox.test.ts tests/fleetQuery.test.ts`: 40 passed.
- `npm run check`: 24 files, 878 tests passed. The origin/main baseline was 851.
