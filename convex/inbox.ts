import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fleetEvents, fleetIds, requireFleetScope, resolveFleet, type FleetScope } from "./fleetQuery";
import { roomOfEvent } from "./rooms";
import { buildFacts, isoUtc } from "./lib/events";
import { priorityReason, sectionOf, viewerSides } from "./lib/incident";
import { color, eventStatus, probability, situation, sourceRef, spaceObject, workflow } from "./lib/validators";
import { side } from "./lib/policyValidators";
import { lang } from "./lib/accounts";

// The personal inbox (spec §3.3 inbox.list / inbox.get / inbox.markRead, INBOX-1..8, DSP-5, DSP-7). Entries are
// derived at read time from the caller's fleet events, so a subscribed list updates whenever an event, owner, room or
// presence row changes. The round 1.5 `inbox` row holds only what is personal: a notice someone left (rooms.notify,
// for example "You were added to the coordination room") and what the caller last read. An entry is unread when it
// has no row, when the row is an unread notice, when the evidence moved after the read (updatedAt), or when the
// summary line read then differs from the current one, which changes with color, the active flag and the section.

const inboxSection = v.union(v.literal("attention"), v.literal("watch"), v.literal("previous"));

// The shareable company fields session.me and session.getMySettings already expose (spec §3.5 POL-1).
const inboxOwner = v.object({
  companyId: v.id("companies"), name: v.string(), country: v.union(v.string(), v.null()),
  language: v.union(lang, v.null()), contact: v.union(v.string(), v.null()), simulated: v.boolean(),
});
const inboxSide = v.object({ side, mine: v.boolean(), object: spaceObject, owner: v.union(inboxOwner, v.null()) });
// joined: the caller is in the room; otherSideJoined: a member of another company is (DSP-5).
const inboxRoom = v.object({
  roomId: v.id("rooms"), joined: v.boolean(), otherSideJoined: v.boolean(), otherSidePresenceAt: v.union(v.string(), v.null()),
});

export const inboxEntry = v.object({
  eventId: v.id("events"),
  unread: v.boolean(),
  section: inboxSection,
  title: v.string(),
  color,
  status: eventStatus,
  situation,
  tcaUtc: v.string(),
  missKm: v.number(),
  relSpeedKmS: v.number(),
  pc: probability,
  sources: v.array(sourceRef),
  simulated: v.boolean(),
  mySide: v.union(side, v.null()),
  workflow: v.union(workflow, v.null()),
  lastUpdateAt: v.string(),
  lastUpdateSummary: v.string(),
  sides: v.array(inboxSide),
  missing: v.array(v.string()),
  room: v.union(inboxRoom, v.null()),
});

/**
 * Whether the caller and a member of another company are in the event's open room, from roomMembers presence (the
 * rooms module writes it; the inbox only reads). Staleness is the client's job: a query is not re-run by the clock.
 */
async function roomPresenceFor(ctx: QueryCtx, event: Doc<"events">, scope: FleetScope) {
  const room = await roomOfEvent(ctx, event);
  if (!room) return null;
  const members = await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect();
  const present = members.filter(m => m.companyId !== scope.company._id && m.inRoom).map(m => m.updatedAt).sort((x, y) => x - y);
  return {
    roomId: room._id, joined: members.some(m => m.userId === scope.user._id && m.inRoom),
    otherSideJoined: present.length > 0, otherSidePresenceAt: present.length ? isoUtc(present[present.length - 1]) : null,
  };
}

/** The personal read state of one entry against the live event (see the header). */
function readState(event: Doc<"events">, row: Doc<"inbox"> | null) {
  const current = priorityReason(sectionOf(event), event);
  if (!row) return { unread: true, lastUpdateAt: event.updatedAt, summary: current };
  const notice = row.unread && row.lastUpdateAt >= event.updatedAt;
  return {
    unread: row.unread || event.updatedAt > row.lastUpdateAt || row.lastUpdateSummary !== current,
    lastUpdateAt: Math.max(event.updatedAt, row.lastUpdateAt),
    summary: notice ? row.lastUpdateSummary : current,
  };
}

// Each entry costs about twelve reads: snapshot and two objects (deduplicated across the page), the inbox row, owner
// rows and companies (memoized), the room lookup through its linked rows, and the room's members and presence.
// 300 x 12 stays under the 4096 reads a query may issue.
const MAX_ENTRIES = 300;
const byId = (a: { _id: string }, b: { _id: string }) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0;

async function entriesFor(ctx: QueryCtx, scope: FleetScope, events: Doc<"events">[]) {
  const assigned = fleetIds(await resolveFleet(ctx, scope.objects));
  const company = fleetIds(await resolveFleet(ctx, scope.companyObjects));
  // The page keeps the most recently updated events. A color-only change by the recolor cron has no stored time, so it
  // does not reorder; it still flags the entry unread through the summary line.
  const page = [...events].sort((x, y) => y.updatedAt - x.updatedAt || byId(x, y)).slice(0, MAX_ENTRIES);
  const unique = <T>(items: T[]) => [...new Set(items)];
  const [snapshots, objects] = await Promise.all([
    Promise.all(unique(page.map(e => e.snapshotId)).map(async id => [id, await ctx.db.get(id)] as const)),
    Promise.all(unique(page.flatMap(e => [e.objectAId, e.objectBId])).map(async id => [id, await ctx.db.get(id)] as const)),
  ]);
  const snapshotById = new Map(snapshots), objectById = new Map(objects);
  const owners = new Map<string, Promise<Doc<"companies"> | null>>();
  const ownerOf = (objectId: string) => {
    if (!owners.has(objectId)) {
      owners.set(objectId, ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique()
        .then(row => row ? ctx.db.get(row.companyId) : null));
    }
    return owners.get(objectId)!;
  };

  const entries = await Promise.all(page.map(async event => {
    const [snapshot, a, b] = [snapshotById.get(event.snapshotId), objectById.get(event.objectAId), objectById.get(event.objectBId)];
    if (!snapshot || !a || !b) return null;
    const facts = buildFacts(event, a, b, snapshot.sources);
    const sides = viewerSides(event, assigned, company);
    const [first, second] = sides.mySide === "B" ? [b, a] : [a, b];
    const room = await roomPresenceFor(ctx, event, scope);
    const row = await ctx.db.query("inbox").withIndex("by_user_event", q =>
      q.eq("userId", scope.user._id).eq("eventId", event._id)).unique();
    const read = readState(event, row);

    const missing: string[] = [];
    if (facts.pc.value === null) missing.push("pc");
    if (facts.pc.epochUtc === null) missing.push("pc.epochUtc");
    missing.push("spread");   // never computed in Phase 1; reported unavailable, never guessed (spec §0, INBOX-3)
    const sideRows = await Promise.all(([["A", facts.objectA], ["B", facts.objectB]] as const).map(async ([key, object]) => {
      const owner = await ownerOf(object.objectId);
      return {
        side: key, mine: sides.myObjectIds.includes(object.objectId), object,
        owner: owner && {
          companyId: owner._id, name: owner.name, country: owner.country ?? null,
          language: owner.language ?? null, contact: owner.contact ?? null, simulated: owner.simulated,
        },
      };
    }));
    for (const row of sideRows) if (!row.owner) missing.push(`owner:${row.side}`);
    for (const row of sideRows) if (row.owner && row.owner.contact === null) missing.push(`contact:${row.side}`);
    if (!room) missing.push("room");

    return {
      at: read.lastUpdateAt,
      eventId: event._id, unread: read.unread,
      // INBOX-6: needs attention / being watched / previous; unread is the orthogonal "new updates" signal.
      section: !event.active ? "previous" as const : event.color === "red" ? "attention" as const : "watch" as const,
      title: `${first.name} × ${second.name}`,
      color: event.color, status: event.status ?? "new" as const, situation: event.situation ?? null,
      tcaUtc: facts.tcaUtc, missKm: facts.missKm, relSpeedKmS: facts.relSpeedKmS, pc: facts.pc, sources: facts.sources,
      simulated: facts.simulated, mySide: sides.mySide,
      workflow: event.workflow ?? null,
      lastUpdateAt: isoUtc(read.lastUpdateAt), lastUpdateSummary: read.summary,
      sides: sideRows, missing, room,
    };
  }));
  // Newest update first, a notice included; the numeric time orders entries within one second.
  return entries.filter(entry => entry !== null).sort((x, y) => y.at - x.at || (x.eventId < y.eventId ? -1 : 1))
    .map(({ at: _at, ...entry }) => entry);
}

// NOT_FOUND whether the event is missing or outside the caller's fleet, so probing reveals nothing.
async function requireInboxEvent(ctx: QueryCtx, scope: FleetScope, eventId: Id<"events">) {
  const event = await ctx.db.get(eventId);
  const ids = fleetIds(await resolveFleet(ctx, scope.objects));
  if (!event || (!ids.has(event.objectAId) && !ids.has(event.objectBId))) {
    throw new ConvexError({ code: "NOT_FOUND", message: "This incident is not in your inbox." });
  }
  return event;
}

/** The caller's inbox: one entry per event involving their fleet (a head of ops: the company's), newest update first. */
export const list = query({
  args: {},
  returns: v.array(inboxEntry),
  handler: async ctx => {
    const scope = await requireFleetScope(ctx);
    const ids = fleetIds(await resolveFleet(ctx, scope.objects));
    const events = [...await fleetEvents(ctx, ids, true), ...await fleetEvents(ctx, ids, false)];
    return entriesFor(ctx, scope, events);
  },
});

/** One incident of the caller's inbox, in the same shape as a list row (INBOX-7). */
export const get = query({
  args: { eventId: v.id("events") },
  returns: inboxEntry,
  handler: async (ctx, { eventId }) => {
    const scope = await requireFleetScope(ctx);
    const event = await requireInboxEvent(ctx, scope, eventId);
    const [entry] = await entriesFor(ctx, scope, [event]);
    if (!entry) throw new ConvexError({ code: "NOT_FOUND", message: "This incident is not in your inbox." });
    return entry;
  },
});

/** Marks an entry read for the caller only. It writes only the caller's inbox row and never approves or resolves anything (INBOX-8). */
export const markRead = mutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const scope = await requireFleetScope(ctx);
    const event = await requireInboxEvent(ctx, scope, eventId);
    const row = await ctx.db.query("inbox").withIndex("by_user_event", q =>
      q.eq("userId", scope.user._id).eq("eventId", eventId)).unique();
    // What was read: the evidence time and the summary line it showed.
    const read = { unread: false, lastUpdateAt: Math.max(event.updatedAt, row?.lastUpdateAt ?? 0), lastUpdateSummary: priorityReason(sectionOf(event), event) };
    if (row) await ctx.db.patch(row._id, read);
    else await ctx.db.insert("inbox", { userId: scope.user._id, eventId, ...read, demoRunId: event.demoRunId ?? null, simulated: event.simulated });
    return null;
  },
});
