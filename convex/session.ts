import { ConvexError } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";

// Session reads over the tables that already exist (users, companies, fleetAssignments).
// The spec names these users.me and companies.getMySettings; issue #6 places them in this file,
// so the client calls api.session.me and api.session.getMySettings.
//
// Fields the current tables do not store come back as null, never as a guessed value
// (spec §0: unavailable is null). They are listed in UNSTORED so the schema task can add them.
export const UNSTORED = {
  me: ["language", "dispatcherCountry", "company.country", "assignmentVersion"],
  settings: ["language", "contact"],
} as const;

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
      name: identity.name ?? identity.nickname ?? identity.email ?? null,
      role: user.role,
      language: null,
      dispatcherCountry: null,
      company: { companyId: company._id, name: company.name, country: null, simulated: company.simulated },
      assignedObjectIds,
      assignmentVersion: null,
    };
  },
});

/** The caller's own company's shareable settings, kept apart from the policy (spec §3.5, POL-1). Operators only. */
export const getMySettings = query({
  args: {},
  handler: async ctx => {
    const { user } = await requireUser(ctx);
    if (user.role !== "operator") throw new ConvexError({ code: "FORBIDDEN", message: "Company settings are available to operators." });
    return { language: null, contact: null };
  },
});
