import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function requireOperator(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to access operator coordination." });
  const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  if (!user || user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "An operator account is required." });
  return user;
}

export async function requireParty(ctx: QueryCtx, eventId: Id<"events">) {
  const user = await requireOperator(ctx);
  const candidateSet = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  if (!candidateSet || ![candidateSet.companyAId, candidateSet.companyBId].includes(user.companyId)) {
    throw new ConvexError({ code: "FORBIDDEN", message: "You are not an operator in this incident." });
  }
  const side = candidateSet.companyAId === user.companyId ? "A" as const : "B" as const;
  const event = await ctx.db.get(eventId);
  const object = event && await ctx.db.get(side === "A" ? event.objectAId : event.objectBId);
  const assignment = object && await ctx.db.query("fleetAssignments").withIndex("by_user_object", q =>
    q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
  if (!assignment?.active) throw new ConvexError({ code: "FORBIDDEN", message: "A current fleet assignment is required for this incident." });
  return { user, candidateSet, side };
}
