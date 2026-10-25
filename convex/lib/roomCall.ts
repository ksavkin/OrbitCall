import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// Room ↔ voice call glue shared by rooms.ts, call/core.ts and lib/accounts.ts. It lives in lib so that call/core and
// lib/accounts never import the rooms function module (lib/accounts → rooms → lib/decision → lib/approvalState →
// lib/accounts would be a cycle).

/** Open, not closed, and its demo run (if any) still open: the same rule as hostTriggers.isOpen. */
export async function isOpenRoom(ctx: QueryCtx, room: Doc<"rooms">): Promise<boolean> {
  if (room.state !== "open" || room.closedAt !== null) return false;
  if (room.demoRunId === null) return true;
  const demo = await ctx.db.get(room.demoRunId);
  return demo !== null && demo.state === "open" && demo.closedAt === null;
}

/** Leaves an unread inbox notice for one person on one event (the inbox row is the only personal state). */
export async function notify(ctx: MutationCtx, userId: Id<"users">, event: Doc<"events">, summary: string) {
  const existing = await ctx.db.query("inbox").withIndex("by_user_event", q => q.eq("userId", userId).eq("eventId", event._id)).unique();
  const fields = { unread: true, lastUpdateAt: Date.now(), lastUpdateSummary: summary };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("inbox", { userId, eventId: event._id, ...fields, demoRunId: event.demoRunId ?? null, simulated: event.simulated });
}

// The Convex identity subject inside a tokenIdentifier ("<issuer>|<subject>"; an issuer URL has no "|"). The call
// module (call/core.ts memberOf) finds call members by this subject.
const subjectOf = (tokenIdentifier: string) => tokenIdentifier.slice(tokenIdentifier.indexOf("|") + 1);

/** The operator's call_members row for a coordination room (keyed by the rooms id as a string); inserted once. */
export async function ensureCallMember(ctx: MutationCtx, room: Doc<"rooms">, user: Doc<"users">) {
  const subject = subjectOf(user.tokenIdentifier);
  const callMember = await ctx.db.query("call_members").withIndex("by_room", q => q.eq("roomId", String(room._id)).eq("subject", subject)).unique();
  if (callMember) return;
  const company = await ctx.db.get(user.companyId);
  await ctx.db.insert("call_members", {
    roomId: String(room._id), subject, userId: String(user._id), companyId: String(user.companyId),
    // A provisioned name, else the company's; the call needs a display name and a language.
    name: user.name ?? company?.name ?? "Operator", lang: user.language ?? company?.language ?? "en",
    role: "operator", simulated: company?.simulated ?? room.simulated,
  });
}

/** The object ids of every event linked to the room. */
async function roomObjectIds(ctx: QueryCtx, roomId: Id<"rooms">) {
  const ids = new Set<string>();
  for (const link of await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", roomId)).collect()) {
    const event = await ctx.db.get(link.eventId);
    if (!event) continue;
    for (const object of await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)])) if (object) ids.add(object.objectId);
  }
  return ids;
}

/**
 * Whether the call member of a coordination room is still responsible for it: an operator with an active assignment
 * on an object of a linked event, the operator half of rooms.requireMember. A revoked assignment ends call access.
 */
export async function stillResponsibleForCall(ctx: QueryCtx, roomId: Id<"rooms">, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "operator") return false;
  const objects = await roomObjectIds(ctx, roomId);
  const assignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect();
  return assignments.some(a => a.active && objects.has(a.objectId));
}

/**
 * Inbox notice for an operator newly assigned to `added` objects: each open room with a linked event on one of them,
 * which the operator has not joined yet, gets the notice startWorkflow leaves. Idempotent (notify upserts).
 */
export async function notifyLateAssignment(ctx: MutationCtx, user: Doc<"users">, added: Set<string>) {
  if (user.role !== "operator" || added.size === 0) return;
  for (const room of await ctx.db.query("rooms").withIndex("by_state", q => q.eq("state", "open")).collect()) {
    if (!await isOpenRoom(ctx, room)) continue;
    const member = await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", room._id).eq("userId", user._id)).first();
    if (member) continue;
    for (const link of await ctx.db.query("roomEvents").withIndex("by_room", q => q.eq("roomId", room._id)).collect()) {
      const event = await ctx.db.get(link.eventId);
      if (!event) continue;
      const [a, b] = await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]);
      if (a && b && (added.has(a.objectId) || added.has(b.objectId))) {
        await notify(ctx, user._id, event, `You were added to the coordination room for ${a.objectId} × ${b.objectId}.`);
      }
    }
  }
}
