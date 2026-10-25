import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// Room ↔ voice call glue shared by rooms.ts and call/core.ts; in lib so call/core never imports the rooms module.

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
