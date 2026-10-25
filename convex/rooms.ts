import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { fleetEvents, fleetIds, requireFleetScope, resolveFleet, type FleetScope } from "./fleetQuery";
import { isoUtc, TCA_MATCH_MS } from "./lib/events";
import { color, eventStatus, workflow } from "./lib/validators";
import { side } from "./lib/policyValidators";
import { decisionTurn, isResolved } from "./lib/decision";

// Coordination rooms (spec §3.4) on the round 1.5 tables in schema/rooms.ts. A room is the optional, automatically
// connected communication channel of one case (user-flow "App navigation and the decision flow"): an operator presses
// "Run agents on this case" (startWorkflow), the room is created for every linked pair row (same unordered pair within
// TCA_MATCH_MS, both object orders), the agents start for each of them, and every operator currently assigned to a
// party object is joined to it. The other side gets an inbox notice; nobody else is moved to the Decision Center. The room closes when every linked incident is resolved (closeRoomIfResolved).
// Membership is current responsibility for a linked event (an operator by assignment, a head of ops read-only by
// company ownership); roomMembers rows carry presence. Company policy, advocate context and negotiation prose are
// never read here (ROOM-3, ROOM-15).

/** Every event row of the same encounter as `event` (both object orders, ±TCA_MATCH_MS), the event included. */
export async function linkedEvents(ctx: QueryCtx, event: Doc<"events">): Promise<Doc<"events">[]> {
  const range = (a: Id<"spaceObjects">, b: Id<"spaceObjects">) => ctx.db.query("events").withIndex("by_pair_tca", q =>
    q.eq("objectAId", a).eq("objectBId", b).gte("tcaMs", event.tcaMs - TCA_MATCH_MS).lte("tcaMs", event.tcaMs + TCA_MATCH_MS)).collect();
  const [forward, reversed] = await Promise.all([range(event.objectAId, event.objectBId), range(event.objectBId, event.objectAId)]);
  // A demo run's rows never share a room with real rows or another run's (roadmap §14).
  const run = event.demoRunId ?? null;
  const all = new Map([...forward, ...reversed, event].filter(e => (e.demoRunId ?? null) === run).map(e => [e._id, e]));
  return [...all.values()].sort((x, y) => x.tcaMs - y.tcaMs || (x._id < y._id ? -1 : x._id > y._id ? 1 : 0));
}

/** Open, not closed, and its demo run (if any) still open: the same rule as hostTriggers.isOpen. */
export async function isOpenRoom(ctx: QueryCtx, room: Doc<"rooms">): Promise<boolean> {
  if (room.state !== "open" || room.closedAt !== null) return false;
  if (room.demoRunId === null) return true;
  const demo = await ctx.db.get(room.demoRunId);
  return demo !== null && demo.state === "open" && demo.closedAt === null;
}

// An event is in at most one open room; closed rooms stay linked as history, so a re-flare gets a fresh room.
async function openRoomLinkedTo(ctx: QueryCtx, eventId: Id<"events">): Promise<Doc<"rooms"> | null> {
  for (const link of await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", eventId)).collect()) {
    const room = await ctx.db.get(link.roomId);
    if (room && await isOpenRoom(ctx, room)) return room;
  }
  return null;
}

/** The open room of the event's encounter: its own link, else any linked row's. Null when none is open. */
export async function roomOfEvent(ctx: QueryCtx, event: Doc<"events">): Promise<Doc<"rooms"> | null> {
  const own = await openRoomLinkedTo(ctx, event._id);
  if (own) return own;
  for (const linked of await linkedEvents(ctx, event)) {
    if (linked._id === event._id) continue;
    const room = await openRoomLinkedTo(ctx, linked._id);
    if (room) return room;
  }
  return null;
}

type Pair = { event: Doc<"events">; a: string; b: string };

// The room's linked events with their object ids.
async function roomPairs(ctx: QueryCtx, roomId: Id<"rooms">): Promise<Pair[]> {
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", roomId)).collect();
  const pairs = await Promise.all([...new Set(links.map(l => l.eventId))].map(async id => {
    const event = await ctx.db.get(id);
    if (!event) return null;
    const [a, b] = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
    return a && b ? { event, a: a.objectId, b: b.objectId } : null;
  }));
  return pairs.filter((p): p is Pair => p !== null)
    .sort((x, y) => x.event.tcaMs - y.event.tcaMs || (x.event._id < y.event._id ? -1 : 1));
}

const responsibleFor = (scope: FleetScope, pairs: Pair[]) =>
  pairs.some(p => scope.objects.some(o => o.objectId === p.a || o.objectId === p.b));

/**
 * The caller must currently be responsible for an object of one of the room's linked events: an operator by
 * assignment, a head of ops (read-only) by company ownership; observers are rejected by requireFleetScope. FORBIDDEN
 * for a missing room and a non-member alike. A revoked assignment ends membership on the next call. Messages and the
 * inbox reuse this guard.
 */
export async function requireMember(ctx: QueryCtx, roomId: Id<"rooms">) {
  const scope = await requireFleetScope(ctx);
  const room = await ctx.db.get(roomId);
  const pairs = room ? await roomPairs(ctx, room._id) : [];
  if (!room || !responsibleFor(scope, pairs)) throw new ConvexError({ code: "FORBIDDEN", message: "You are not a member of this room." });
  return { scope, room, pairs };
}

/** requireMember for a write: an operator, and the room still open. */
export async function requireActiveMember(ctx: QueryCtx, roomId: Id<"rooms">) {
  const member = await requireMember(ctx, roomId);
  if (member.scope.user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "Only operators act in a room." });
  if (!await isOpenRoom(ctx, member.room)) throw new ConvexError({ code: "INVALID_STATE", message: "This room is closed." });
  return member;
}

// The caller must be responsible for one of the event's objects. FORBIDDEN whether or not the event exists, as
// myQueue does for objects; this runs before any state check, so a non-party learns nothing.
async function requirePartyScope(ctx: QueryCtx, eventId: Id<"events">) {
  const scope = await requireFleetScope(ctx);
  const event = await ctx.db.get(eventId);
  const [a, b] = event ? await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]) : [null, null];
  if (!event || !a || !b || !scope.objects.some(o => o.objectId === a.objectId || o.objectId === b.objectId)) {
    throw new ConvexError({ code: "FORBIDDEN", message: "You are not part of this incident." });
  }
  return { scope, event, a, b };
}

const roomEvent = v.object({
  eventId: v.id("events"), objectIds: v.array(v.string()), tcaUtc: v.string(), color, active: v.boolean(),
  status: eventStatus, simulated: v.boolean(),
  mySide: v.union(side, v.null()),
  // Stored classification; null while unclassified, which authorizes nothing (schema/data.ts).
  workflow: v.union(workflow, v.null()),
  requiredApprovalSides: v.array(side),
  canAct: v.boolean(),
  // Decision turns: while a card is selected and approvals are outstanding, only the side in turn acts.
  deciding: v.boolean(),
  turn: v.union(side, v.null()),
  myTurn: v.boolean(),
});
const roomMember = v.object({
  userId: v.id("users"), companyId: v.id("companies"), name: v.union(v.string(), v.null()),
  inRoom: v.boolean(), inCall: v.boolean(), updatedAt: v.string(),
});

// Shared fields only: no language, contact or policy of any company.
export const roomProjection = v.object({
  roomId: v.id("rooms"),
  state: v.union(v.literal("open"), v.literal("closed")),
  createdAt: v.string(),
  closedAt: v.union(v.string(), v.null()),
  simulated: v.boolean(),
  companies: v.array(v.object({ companyId: v.id("companies"), name: v.string(), simulated: v.boolean() })),
  myCompanyId: v.id("companies"),
  members: v.array(roomMember),
  linkedEvents: v.array(roomEvent),
});

/**
 * The caller's view of each linked incident: side (as myQueue derives it, spec §1; the company's whole fleet decides
 * whether a pair is internal), stored classification, whether the caller may act, and the decision turn.
 */
export async function roomTurns(ctx: QueryCtx, scope: FleetScope, pairs: Pair[], open: boolean) {
  const own = (objectId: string) =>
    scope.companyObjects.some(o => o.objectId === objectId) || scope.objects.some(o => o.objectId === objectId);
  const assigned = (objectId: string) => scope.objects.some(o => o.objectId === objectId);
  return Promise.all(pairs.map(async ({ event, a, b }) => {
    const mySide = own(a) && own(b) ? null : own(a) ? "A" as const : own(b) ? "B" as const : null;
    const required = event.requiredApprovalSides ?? [];
    const canAct = open && scope.user.role === "operator" && event.active && event.workflow !== undefined &&
      event.workflow !== "internal_review" && mySide !== null && required.includes(mySide) && assigned(mySide === "A" ? a : b);
    const { deciding, turn } = await decisionTurn(ctx, event);
    return {
      eventId: event._id, objectIds: [a, b], tcaUtc: isoUtc(event.tcaMs), color: event.color, active: event.active,
      status: event.status ?? "new" as const, simulated: event.simulated, mySide,
      workflow: event.workflow ?? null, requiredApprovalSides: required, canAct,
      deciding, turn, myTurn: canAct && deciding && turn === mySide,
    };
  }));
}

async function project(ctx: QueryCtx, scope: FleetScope, room: Doc<"rooms">, pairs: Pair[]) {
  const open = await isOpenRoom(ctx, room);
  const companies = (await Promise.all(room.companyIds.map(id => ctx.db.get(id))))
    .flatMap(c => c ? [{ companyId: c._id, name: c.name, simulated: c.simulated }] : []);
  const rows = await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const members = await Promise.all(rows.map(async m => ({
    userId: m.userId, companyId: m.companyId, name: (await ctx.db.get(m.userId))?.name ?? null,
    inRoom: m.inRoom, inCall: m.inCall, updatedAt: isoUtc(m.updatedAt),
  })));
  const linked = await roomTurns(ctx, scope, pairs, open);
  return {
    roomId: room._id, state: open ? "open" as const : "closed" as const, createdAt: isoUtc(room.createdAt),
    closedAt: room.closedAt === null ? null : isoUtc(room.closedAt), simulated: room.simulated,
    companies, myCompanyId: scope.company._id, members, linkedEvents: linked,
  };
}

// The Convex identity subject inside a tokenIdentifier ("<issuer>|<subject>"; an issuer URL has no "|"). The call
// module (call/core.ts memberOf) finds call members by this subject.
const subjectOf = (tokenIdentifier: string) => tokenIdentifier.slice(tokenIdentifier.indexOf("|") + 1);

/** Joins every operator currently assigned to a party object; returns the users joined for the first time. */
async function autoJoin(ctx: MutationCtx, room: Doc<"rooms">, pairs: Pair[], starter: Id<"users">) {
  const objectIds = new Set(pairs.flatMap(p => [p.a, p.b]));
  // fleetAssignments has no index by object (the next schema widening can add one), so the whole table is read: a
  // truncated read would silently leave an assigned operator out of the room.
  const assignments: Doc<"fleetAssignments">[] = [];
  for await (const a of ctx.db.query("fleetAssignments")) if (a.active && objectIds.has(a.objectId)) assignments.push(a);
  const now = Date.now();
  const added: Doc<"users">[] = [];
  for (const userId of new Set(assignments.map(a => a.userId))) {
    const user = await ctx.db.get(userId);
    if (!user || user.role !== "operator") continue;
    const row = await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", room._id).eq("userId", userId)).first();
    if (!row) {
      await ctx.db.insert("roomMembers", { roomId: room._id, userId, companyId: user.companyId, inRoom: true, inCall: false, updatedAt: now });
      added.push(user);
    } else if (userId === starter && !row.inRoom) {
      await ctx.db.patch(row._id, { inRoom: true, updatedAt: now });
    }
    // The voice call authorizes through call_members (call/join.ts), keyed by the rooms id as a string.
    const subject = subjectOf(user.tokenIdentifier);
    const callMember = await ctx.db.query("call_members").withIndex("by_room", q => q.eq("roomId", String(room._id)).eq("subject", subject)).unique();
    if (!callMember) {
      const company = await ctx.db.get(user.companyId);
      await ctx.db.insert("call_members", {
        roomId: String(room._id), subject, userId: String(user._id), companyId: String(user.companyId),
        // A provisioned name, else the company's; the call needs a display name and a language.
        name: user.name ?? company?.name ?? "Operator", lang: user.language ?? company?.language ?? "en",
        role: "operator", simulated: company?.simulated ?? room.simulated,
      });
    }
  }
  return added;
}

const started = v.object({ roomId: v.id("rooms"), created: v.boolean(), joined: v.array(v.id("users")) });

/**
 * "Start workflow" on a conjunction: opens the encounter's room (or returns the open one), links every row of the
 * encounter, joins every operator assigned to a party object, and leaves an unread inbox notice for each operator
 * joined by someone else. Idempotent: repeating it adds only newly assigned operators.
 */
export const startWorkflow = mutation({
  args: { eventId: v.id("events") },
  returns: started,
  handler: async (ctx, { eventId }) => {
    const { scope, event } = await requirePartyScope(ctx, eventId);
    if (scope.user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "Operators start a workflow." });
    if (isResolved(event)) throw new ConvexError({ code: "INVALID_STATE", message: "This incident is already resolved." });
    const linked = await linkedEvents(ctx, event);
    const existing = await roomOfEvent(ctx, event);
    const now = Date.now();
    let room = existing;
    if (!room) {
      const objects = await Promise.all(linked.flatMap(e => [e.objectAId, e.objectBId]).map(id => ctx.db.get(id)));
      const owners = await Promise.all([...new Set(objects.flatMap(o => o ? [o.objectId] : []))].map(objectId =>
        ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique()));
      const roomId = await ctx.db.insert("rooms", {
        state: "open", companyIds: [...new Set(owners.flatMap(o => o ? [o.companyId] : []))].sort(),
        demoRunId: event.demoRunId ?? null, simulated: linked.some(e => e.simulated), createdAt: now, closedAt: null,
      });
      room = (await ctx.db.get(roomId))!;
    }
    for (const e of linked) {
      if (await openRoomLinkedTo(ctx, e._id)) continue;
      await ctx.db.insert("roomEvents", { roomId: room._id, eventId: e._id, linkedAt: now });
      // "Run agents on this case": the Analyst and the candidate grid start for each newly linked incident. Both
      // deduplicate on their own (agentRuns.begin claims one run per input; candidates.publish checks the version).
      await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId: e._id });
      await ctx.scheduler.runAfter(0, internal.advocates.publishFromOrbit, { eventId: e._id });
    }
    const pairs = await roomPairs(ctx, room._id);
    const joined = await autoJoin(ctx, room, pairs, scope.user._id);
    for (const user of joined) {
      if (user._id === scope.user._id) continue;
      const assignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect();
      const theirs = new Set(assignments.filter(a => a.active).map(a => a.objectId));
      for (const { event: e, a, b } of pairs) {
        if (theirs.has(a) || theirs.has(b)) await notify(ctx, user._id, e, `You were added to the coordination room for ${a} × ${b}.`);
      }
    }
    return { roomId: room._id, created: existing === null, joined: joined.map(u => u._id) };
  },
});

/** Leaves an unread inbox notice for one person on one event (the inbox row is the only personal state). */
export async function notify(ctx: MutationCtx, userId: Id<"users">, event: Doc<"events">, summary: string) {
  const existing = await ctx.db.query("inbox").withIndex("by_user_event", q => q.eq("userId", userId).eq("eventId", event._id)).unique();
  const fields = { unread: true, lastUpdateAt: Date.now(), lastUpdateSummary: summary };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("inbox", { userId, eventId: event._id, ...fields, demoRunId: event.demoRunId ?? null, simulated: event.simulated });
}

/** The open room of an event the caller is party to; null while none exists. */
export const get = query({
  args: { eventId: v.id("events") },
  returns: v.union(roomProjection, v.null()),
  handler: async (ctx, { eventId }) => {
    const { scope, event } = await requirePartyScope(ctx, eventId);
    const room = await roomOfEvent(ctx, event);
    return room ? project(ctx, scope, room, await roomPairs(ctx, room._id)) : null;
  },
});

/** A room the caller is a member of, open or closed (history stays readable, INBOX-5). */
export const byId = query({
  args: { roomId: v.id("rooms") },
  returns: roomProjection,
  handler: async (ctx, { roomId }) => {
    const { scope, room, pairs } = await requireMember(ctx, roomId);
    return project(ctx, scope, room, pairs);
  },
});

/** The open rooms the caller is a member of, by earliest linked TCA. An empty scope lists nothing. */
export const listMine = query({
  args: {},
  returns: v.array(roomProjection),
  handler: async ctx => {
    const scope = await requireFleetScope(ctx);
    // Rooms are found through the caller's own active incidents, not by scanning every open room.
    const ids = fleetIds(await resolveFleet(ctx, scope.objects));
    const roomIds = new Set<Id<"rooms">>();
    for (const event of await fleetEvents(ctx, ids, true)) {
      for (const link of await ctx.db.query("roomEvents").withIndex("by_event", q => q.eq("eventId", event._id)).collect()) roomIds.add(link.roomId);
    }
    const mine = [];
    for (const roomId of roomIds) {
      const room = await ctx.db.get(roomId);
      if (!room || !await isOpenRoom(ctx, room)) continue;
      const pairs = await roomPairs(ctx, room._id);
      if (pairs.length && responsibleFor(scope, pairs)) mine.push(await project(ctx, scope, room, pairs));
    }
    const first = (r: { linkedEvents: { tcaUtc: string }[] }) => r.linkedEvents[0]?.tcaUtc ?? "";
    return mine.sort((x, y) => first(x) < first(y) ? -1 : first(x) > first(y) ? 1 : x.roomId < y.roomId ? -1 : 1);
  },
});

async function setPresence(ctx: MutationCtx, roomId: Id<"rooms">, patch: { inRoom?: boolean; inCall?: boolean }) {
  const { scope, room } = await requireActiveMember(ctx, roomId);
  const row = await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", room._id).eq("userId", scope.user._id)).first();
  const next = { inRoom: patch.inRoom ?? row?.inRoom ?? false, inCall: patch.inCall ?? row?.inCall ?? false };
  if (next.inCall) next.inRoom = true;   // being in the call means being in the room
  // companyId is the member's own company: hostTriggers.listForRoom rejects any other.
  if (row) await ctx.db.patch(row._id, { ...next, companyId: scope.user.companyId, updatedAt: Date.now() });
  else await ctx.db.insert("roomMembers", { roomId: room._id, userId: scope.user._id, companyId: scope.user.companyId, ...next, updatedAt: Date.now() });
  return null;
}

/** Presence for "has the other side joined" (DSP-5). Operators only; a head of ops reads the room. */
export const join = mutation({ args: { roomId: v.id("rooms") }, returns: v.null(), handler: (ctx, { roomId }) => setPresence(ctx, roomId, { inRoom: true }) });
/** Leaving the room also leaves the call. */
export const leave = mutation({ args: { roomId: v.id("rooms") }, returns: v.null(), handler: (ctx, { roomId }) => setPresence(ctx, roomId, { inRoom: false, inCall: false }) });
/** Called on LiveKit connect / disconnect. */
export const setInCall = mutation({
  args: { roomId: v.id("rooms"), inCall: v.boolean() }, returns: v.null(),
  handler: (ctx, { roomId, inCall }) => setPresence(ctx, roomId, { inCall }),
});


/**
 * Closes the event's open room once every linked incident is resolved: its stored status is past agreement, or it
 * is no longer active. Idempotent; returns the closed room id or null. The approvals module calls this in the same
 * mutation that records the last required approval, so the room closes on consensus.
 */
export async function closeRoomIfResolved(ctx: MutationCtx, eventId: Id<"events">): Promise<Id<"rooms"> | null> {
  const event = await ctx.db.get(eventId);
  const room = event && await roomOfEvent(ctx, event);
  if (!room) return null;
  // Every linked row counts, including one whose objects can no longer be read.
  const links = await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const linked = await Promise.all(links.map(l => ctx.db.get(l.eventId)));
  if (!linked.every(e => e !== null && isResolved(e))) return null;
  const now = Date.now();
  await ctx.db.patch(room._id, { state: "closed", closedAt: now });
  await ctx.db.insert("messages", {
    roomId: room._id, eventId: null, author: { kind: "system" }, kind: "system",
    originalText: "Every linked incident is resolved; the room is closed.", originalLang: "en",
    translations: {}, translationStatus: {}, values: [], refs: {}, form: null,
    demoRunId: room.demoRunId, simulated: room.simulated, createdAt: now,
  });
  return room._id;
}

/** The system entry point for closeRoomIfResolved (scheduler, CLI or the approvals module). */
export const closeIfResolved = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.union(v.id("rooms"), v.null()),
  handler: (ctx, { eventId }) => closeRoomIfResolved(ctx, eventId),
});
