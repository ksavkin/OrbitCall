import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function requireEventReader(ctx: QueryCtx | MutationCtx, eventId: Id<"events">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to view an incident." });
  const user = await ctx.db.query("users").withIndex("by_auth_subject", q => q.eq("authSubject", identity.subject)).unique();
  if (!user) throw new ConvexError({ code: "FORBIDDEN", message: "No operator account is configured." });
  const event = await ctx.db.get(eventId);
  if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
  const owns = [event.objectA.ownerCompanyId, event.objectB.ownerCompanyId].includes(user.companyId);
  const publicCatalog = !event.simulated && event.objectA.ownerCompanyId === null && event.objectB.ownerCompanyId === null;
  if (!owns && !publicCatalog) throw new ConvexError({ code: "FORBIDDEN", message: "You are not part of this incident." });
  return { event, user, owns };
}
