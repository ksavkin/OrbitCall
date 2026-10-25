import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { contactPatch, lang, setActiveAssignments, userRole } from "./lib/accounts";

// Trusted account/ownership setup, not registration. No browser may claim a company or satellite.
// Optional profile and settings fields: omitted keeps the stored value; provided overwrites it.
export const provision = internalMutation({
  args: {
    key: v.string(), name: v.string(), simulated: v.boolean(), objectIds: v.array(v.string()),
    country: v.optional(v.string()), language: v.optional(lang), contact: v.optional(v.string()),
    members: v.array(v.object({
      tokenIdentifier: v.string(), role: userRole, assignedObjectIds: v.array(v.string()),
      name: v.optional(v.string()), language: v.optional(lang), dispatcherCountry: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { key, name, simulated, objectIds, country, language, contact, members }) => {
    if (!key.trim() || !name.trim() || objectIds.length > 100 || members.length > 100) throw new ConvexError({ code: "VALIDATION", message: "Invalid company setup." });
    if (new Set(members.map(m => m.tokenIdentifier)).size !== members.length) throw new ConvexError({ code: "VALIDATION", message: "Each account may appear only once." });
    const existing = await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", key)).unique();
    if (existing && (existing.name !== name || existing.simulated !== simulated)) throw new ConvexError({ code: "INVALID_STATE", message: "Company identity changes require a separate migration." });
    const companyId = existing?._id ?? await ctx.db.insert("companies", { key, name, simulated });
    const contactChange = contactPatch(contact);
    const companyPatch = {
      ...(country === undefined ? {} : { country: country.trim() || undefined }),
      ...(language === undefined ? {} : { language }),
      ...(contactChange === null ? {} : { contact: "clear" in contactChange ? undefined : contactChange.contact }),
    };
    if (Object.keys(companyPatch).length) await ctx.db.patch(companyId, companyPatch);
    for (const objectId of objectIds) {
      const object = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
      if (!object) throw new ConvexError({ code: "NOT_FOUND", message: "Register the satellite before assigning its operator." });
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", objectId)).unique();
      if (owner && owner.companyId !== companyId) throw new ConvexError({ code: "FORBIDDEN", message: "This satellite already has a different operator." });
      if (!owner) await ctx.db.insert("satelliteOwners", { objectId, companyId });
    }
    for (const member of members) {
      // Auth0 never emits padding, so a padded identifier could never sign in; refuse it instead of storing an orphan.
      if (!member.tokenIdentifier.trim() || member.tokenIdentifier !== member.tokenIdentifier.trim()) throw new ConvexError({ code: "VALIDATION", message: "A verified issuer and subject identifier is required." });
      if (member.role === "demo_observer" && member.assignedObjectIds.length) throw new ConvexError({ code: "VALIDATION", message: "Observers cannot hold fleet assignments." });
      if (member.assignedObjectIds.some(id => !objectIds.includes(id))) throw new ConvexError({ code: "FORBIDDEN", message: "Assignments must belong to the registered company." });
      const user = await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", member.tokenIdentifier)).unique();
      if (user && user.companyId !== companyId) throw new ConvexError({ code: "FORBIDDEN", message: "This account already belongs to a different company." });
      const profile = {
        role: member.role,
        ...(member.name === undefined ? {} : { name: member.name.trim() || undefined }),
        ...(member.language === undefined ? {} : { language: member.language }),
        ...(member.dispatcherCountry === undefined ? {} : { dispatcherCountry: member.dispatcherCountry.trim() || undefined }),
      };
      if (user) await ctx.db.patch(user._id, profile);
      const userId = user?._id ?? await ctx.db.insert("users", { tokenIdentifier: member.tokenIdentifier, companyId, ...profile });
      await setActiveAssignments(ctx, (await ctx.db.get(userId))!, member.assignedObjectIds);
    }
    return { companyId };
  },
});
