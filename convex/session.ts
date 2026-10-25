import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { contactPatch, lang } from "./lib/accounts";

// Session reads and company settings. The spec names these users.me, companies.getMySettings and
// companies.updateMySettings; issue #6 places them in this file, so the client calls
// api.session.me, api.session.getMySettings and api.session.updateMySettings.
// A value that is not stored reads as null, never as a guess (spec §0).

/** Resolves the signed-in caller. No identity: UNAUTHENTICATED. No provisioned row: FORBIDDEN. */
export async function requireUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
  const user = await ctx.db.query("users")
    .withIndex("by_token_identifier", q => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  // Sign-ups are disabled: a valid Auth0 login without a provisioned row has no access at all.
  if (!user) throw new ConvexError({ code: "FORBIDDEN", message: "This account is not set up for OrbitCall." });
  const company = await ctx.db.get(user.companyId);
  if (!company) throw new ConvexError({ code: "FORBIDDEN", message: "This account has no company." });
  return { identity, user, company };
}

async function requireSettingsOperator(ctx: QueryCtx) {
  const session = await requireUser(ctx);
  if (session.user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "Company settings are available to operators." });
  return session;
}

export const me = query({
  args: {},
  handler: async ctx => {
    const { identity, user, company } = await requireUser(ctx);
    const assignments = await ctx.db.query("fleetAssignments")
      .withIndex("by_user_object", q => q.eq("userId", user._id)).collect();
    // Only current assignments grant responsibility; inactive rows are history.
    const assignedObjectIds = assignments.filter(a => a.active).map(a => a.objectId).sort();
    return {
      userId: user._id,
      // Stored display name first, then the Auth0 profile name, else unavailable.
      name: user.name ?? (identity.name?.trim() || null),
      role: user.role,
      language: user.language ?? null,
      dispatcherCountry: user.dispatcherCountry ?? null,
      company: { companyId: company._id, name: company.name, country: company.country ?? null, simulated: company.simulated },
      assignedObjectIds,
      // Per-user counter; null for a legacy row that provisioning has not touched since the field was added.
      assignmentVersion: user.assignmentVersion ?? null,
    };
  },
});

/** The caller's own company's shareable settings, kept apart from the policy (spec §3.5, POL-1). Operators only. */
export const getMySettings = query({
  args: {},
  handler: async ctx => {
    const { company } = await requireSettingsOperator(ctx);
    return { language: company.language ?? null, contact: company.contact ?? null };
  },
});

/** Partial update of the caller's own company settings. Omitted: unchanged. Blank contact: cleared. */
export const updateMySettings = mutation({
  args: { language: v.optional(lang), contact: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { language, contact }) => {
    const { company } = await requireSettingsOperator(ctx);
    const contactChange = contactPatch(contact);
    const patch = {
      ...(language === undefined ? {} : { language }),
      ...(contactChange === null ? {} : { contact: "clear" in contactChange ? undefined : contactChange.contact }),
    };
    if (Object.keys(patch).length) await ctx.db.patch(company._id, patch);
    return null;
  },
});
