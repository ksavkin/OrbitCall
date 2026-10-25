import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Trusted account/ownership setup, not registration. No browser may claim a company or satellite.
export const provision = internalMutation({
  args: {
    key: v.string(), name: v.string(), simulated: v.boolean(), objectIds: v.array(v.string()),
    members: v.array(v.object({ tokenIdentifier: v.string(), role: v.union(v.literal("operator"), v.literal("head_of_ops")), assignedObjectIds: v.array(v.string()) })),
  },
  handler: async (ctx, { key, name, simulated, objectIds, members }) => {
    if (!key.trim() || !name.trim() || objectIds.length > 100 || members.length > 100) throw new ConvexError({ code: "VALIDATION", message: "Invalid company setup." });
    const existing = await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", key)).unique();
    const companyId = existing?._id ?? await ctx.db.insert("companies", { key, name, simulated });
    if (existing && (existing.name !== name || existing.simulated !== simulated)) throw new ConvexError({ code: "INVALID_STATE", message: "Company identity changes require a separate migration." });
    for (const objectId of objectIds) {
      const object = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
      if (!object) throw new ConvexError({ code: "NOT_FOUND", message: "Register the satellite before assigning its operator." });
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique();
      if (owner && owner.companyId !== companyId) throw new ConvexError({ code: "FORBIDDEN", message: "This satellite already has a different operator." });
      if (!owner) await ctx.db.insert("satelliteOwners", { objectId, companyId });
    }
    for (const member of members) {
      if (!member.tokenIdentifier.trim()) throw new ConvexError({ code: "VALIDATION", message: "A verified issuer and subject identifier is required." });
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", member.tokenIdentifier)).unique();
      if (user && user.companyId !== companyId) throw new ConvexError({ code: "FORBIDDEN", message: "This account already belongs to a different company." });
      if (member.assignedObjectIds.some(id => !objectIds.includes(id))) throw new ConvexError({ code: "FORBIDDEN", message: "Assignments must belong to the registered company." });
      if (user) await ctx.db.patch(user._id, { role: member.role });
      const userId = user?._id ?? await ctx.db.insert("users", { tokenIdentifier: member.tokenIdentifier, role: member.role, companyId });
      const existingAssignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", userId)).collect();
      for (const assignment of existingAssignments) await ctx.db.patch(assignment._id, { active: member.assignedObjectIds.includes(assignment.objectId) });
      for (const objectId of new Set(member.assignedObjectIds)) {
        if (!existingAssignments.some(a => a.objectId === objectId)) await ctx.db.insert("fleetAssignments", { userId, objectId, active: true });
      }
    }
    return { companyId };
  },
});
