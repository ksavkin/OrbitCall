# Proposed changes for the Start workflow user flow (not applied)

The accepted flow (Adil, October 25):
- **Rooms are an optional communication channel that connects automatically.** On the conjunction, an operator presses **Start workflow**.
- **Who joins.** The coordination room is created, and every assigned operator of each involved company is joined to it automatically.
- **The joined side.** It gets a notice ("You were added…") and is not redirected. When they open Rooms, they see the other dispatcher there and can talk before deciding.
- **Head of ops** only reads.
- **Closing.** The room closes on resolution, when the required operators have all approved the same plan.

The backend for this is on `claude/r2-rooms-on-main` (summary: `261025-3rm-SUMMARY.md`). Nothing below has been edited yet.

## docs/specification.md

1. **§2.2 EventRow:** `roomOpen: boolean; // a room exists (created at red) [Q-3]` becomes `// an open room exists (created by Start workflow) [DSP-1]`.
2. **§2.5 InboxItem:** add `room: { roomId, joined, otherSideJoined, otherSidePresenceAt } | null` and `missing: string[]`. The notice text arrives in `lastUpdateSummary`.
3. **§3.4 table, add rows:**
   - `rooms.startWorkflow` | mutation | `{ eventId }` → `{ roomId, created, joined: Id<"users">[] }` | Operator of a party object, active incident. Creates or returns the encounter's open room and links every pair row within ±60 s. Joins every assigned operator of the involved companies and leaves an inbox notice for the others. Idempotent [DSP-1, DSP-5]
   - `rooms.listMine` | query | `{}` → room projections | Open rooms of the caller's incidents
4. **§3.4 table, edit rows:**
   - `rooms.get`: "`null` while no room exists (yellow, new)" becomes "`null` until someone starts the workflow, or after the room closed".
   - `rooms.join` / `rooms.leave`: add "Start workflow already joins; leave and join are presence only; operators only, head of ops reads".
5. **§3.4 intro, add a sentence:** "The room is an optional channel: deciding never requires opening it, and it closes when every linked incident is resolved (approved or later, or no longer active). A closed room stays readable and refuses new lines."
6. **§4.3:** "A room is created when an event turns red…" becomes "A room is created when an operator starts the workflow on an active incident. Every operator currently assigned to an involved object is joined; the others receive an inbox notice and stay on their screen. While no room exists, `rooms.get` returns `null`. The room closes when every linked incident is resolved."
7. **§6 errors:** `INVALID_STATE` on writes to a closed room.

## docs/functionality.md

1. **Q-3:** "On red, starts the agents and creates a room." becomes "On red, starts the agents. The room is created when an operator starts the workflow (DSP-1)."
2. **DSP-1:** "Opens a room for a red event." becomes "Starts the workflow on an incident. This creates the coordination room and joins every assigned operator of the involved companies. The joined operators are notified in their inbox and are not taken to the room."
3. **DSP-5:** "sees whether the other operator has joined" becomes "sees whether the other operator is in the room (they were joined automatically and may have left)".
4. **ROOM-1:** add "The room is an optional, automatically connected channel; it closes when every linked incident is resolved."
5. **Lifecycle §3, "proposal":** "the room, created when the event turned red (Q-3), is ready" becomes "the room, once an operator has started the workflow (DSP-1), is ready".
6. **INBOX-1:** add "…or they were added to a coordination room by another operator."
7. **ACC-4:** add "A head of operations reads the rooms of company incidents and cannot start, join or post."

## docs/user-flow.md

1. **§5, before "Two active spacecraft":** add a "Start workflow and the room" paragraph with the flow above (optional channel, automatic join, notice without a redirect, closes on agreement).
2. **§5, step 1:** "Open the incident from My Incidents or Inbox." becomes "Open the incident from My Incidents or Inbox and press Start workflow when you want the other operator involved."

## docs/master-roadmap.md

1. **§2 Main story, step 4:** "The other operators receive incident notifications and open the same coordination room." becomes "Starting the workflow joins the other operators to the same coordination room; they see a notice and open it when they want to talk."
2. **§7 API families, Group room:** add `rooms.startWorkflow`, `rooms.listMine`, `rooms.setInCall`.

## Issue #6, Round 2 (Kostya)

1. Mark three bullets done once `claude/r2-rooms-on-main` is merged:
   - [x] `convex/rooms.ts` and `tests/rooms.test.ts`. Start workflow opens one room per linked encounter. It joins every assigned operator (`roomMembers` + `call_members`) and notifies the joined side, and the room closes on resolution through `closeRoomIfResolved`.
   - [x] `convex/messages.ts` and `tests/messages.test.ts`. Text only. Call phrases stay in `call_phrases`, and the module does not call the host.
   - [x] `convex/inbox.ts` and `tests/inbox.test.ts`. Derived entries, a personal read state on the `inbox` table, room presence and join notices.
2. **Under approvals:** "`approvals.approve` sets the resolved status and calls `closeRoomIfResolved(ctx, eventId)` in the same mutation."
3. **Note:** "`kostya/r2-core` (d3782a3) predates the Round 1.5 schema. The branches `claude/r2-rooms-chain-d2875e` and `claude/r2-approvals-chain-a21926` collide with main's tables and must not be merged. Approvals needs the same port onto main's `proposals`, `selections` and `approvals` tables."
4. **Round 3, Adil, add:**
   - a Start workflow button on the conjunction;
   - the renamed Rooms nav;
   - the room screen calls `rooms.join/leave/setInCall`, not `call.presence.*`;
   - `call.join` for a real room needs a Convex identity (Auth0, `CONVEX_AUTH`), or devTokens issued for the auto-joined `call_members` rows.

## Prompt for Andrew's agent

```text
Context: OrbitCall (Convex backend, Cal Hacks 13.0, deadline today). Adil, Kostya and Freya accepted a user-flow change for coordination rooms. Please align your agent work and any docs or code you own with it.

The flow:
1. Rooms are an optional communication channel that connects automatically, not a mandatory step. Deciding never requires opening the room.
2. On the conjunction screen, an operator presses "Start workflow". That creates the coordination room for the encounter: every pair-event row of the same unordered object pair within ±60 s of TCA, in both object orders. It also joins every operator currently assigned to an involved object, from every involved company.
3. Operators joined by someone else get an inbox notice ("You were added to the coordination room for A × B"). They are not redirected. When they open Rooms they are already in it, see the other dispatcher there, and can talk by text or voice before approving.
4. The room closes when every linked incident is resolved: the required operators approved the same plan (status approved or later), or the incident no longer needs action. A closed room stays readable and refuses new lines. A later Start workflow opens a fresh room.
5. A head of ops reads rooms and messages and cannot start, join or post. Observers never reach a room.

Backend now on branch claude/r2-rooms-on-main, cut from origin/main. It uses your Round 1.5 tables with no schema edits:
- convex/rooms.ts:
  - rooms.startWorkflow({eventId}), rooms.get, rooms.byId, rooms.listMine, rooms.join, rooms.leave, rooms.setInCall.
  - internal rooms.closeIfResolved.
  - Exported helpers requireMember, roomOfEvent, closeRoomIfResolved(ctx, eventId) and notify(ctx, userId, event, summary).
- Membership is current responsibility for an object of a linked event. It is checked on every call. roomMembers rows hold presence, and companyId is the user's own company, which hostTriggers.listForRoom requires.
- Auto-join also writes call_members, with roomId equal to String(roomId) and subject taken from users.tokenIdentifier, so call.join works for real rooms.
- convex/messages.ts: messages.send / messages.list. It schedules nothing and does not call the host yet.
- convex/inbox.ts: inbox.list / get / markRead on your inbox table.

What we need from your side:
- The Coordination Host trigger (hostTriggers): rooms now exist from Start workflow, not from the red transition. A room may hold events whose workflow is still unclassified.
- Approvals: whoever ports approvals onto main's proposals/selections/approvals tables should set the event's resolved status and call closeRoomIfResolved(ctx, eventId) in the same mutation that records the last required approval.
- Warning: kostya/r2-core (d3782a3) predates your Round 1.5 schema. The branches claude/r2-rooms-chain-d2875e and claude/r2-approvals-chain-a21926 define their own rooms/messages/approval tables and must not be merged.
- If your docs mention "a room is created when an event turns red", replace it with "a room is created when an operator starts the workflow".
```
