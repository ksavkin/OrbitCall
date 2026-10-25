import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// Account vocabulary shared by the schema, provisioning and session functions.
export const lang = v.union(v.literal("en"), v.literal("ru"), v.literal("zh"));
export const userRole = v.union(v.literal("operator"), v.literal("head_of_ops"), v.literal("demo_observer"));
export type Lang = "en" | "ru" | "zh";

export const MAX_CONTACT = 200;
/** The version a pre-existing user row without assignmentVersion is taken to have (lib/accounts, operators.backfill). */
export const LEGACY_ASSIGNMENT_VERSION = 1;
export const MAX_PROFILE_TEXT = 100;

/** Trims a provisioned profile value. Blank clears it; longer than MAX_PROFILE_TEXT is rejected, never truncated. */
export function profileText(field: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROFILE_TEXT) throw new ConvexError({ code: "VALIDATION", message: `${field} must be at most ${MAX_PROFILE_TEXT} characters.` });
  return trimmed || undefined;
}

/**
 * Normalizes a contact value for a patch. undefined: leave the stored value alone.
 * Blank after trimming: clear it. Otherwise the trimmed text; longer than MAX_CONTACT is rejected, never truncated.
 */
export function contactPatch(contact: string | undefined): { contact?: string } | { clear: true } | null {
  if (contact === undefined) return null;
  const trimmed = contact.trim();
  if (!trimmed) return { clear: true };
  if (trimmed.length > MAX_CONTACT) throw new ConvexError({ code: "VALIDATION", message: `Contact must be at most ${MAX_CONTACT} characters.` });
  return { contact: trimmed };
}

/**
 * Makes `objectIds` the user's exact set of active assignments and keeps users.assignmentVersion honest.
 * The version is per user and increases by one only when the active set actually changes. Order,
 * duplicates and inactive history do not count as changes, and an identical rerun keeps the version.
 * - A user created in this call (`created`) starts at 1 for its first set.
 * - A legacy row without a version counts as version 1 for the set it already has, the same value
 *   backfillAssignmentVersions writes. So its first change yields 2, and a scan pinned to 1 goes stale.
 */
export async function setActiveAssignments(ctx: MutationCtx, user: Doc<"users">, objectIds: string[],
  { created = false }: { created?: boolean } = {}): Promise<number> {
  const wanted = new Set(objectIds);
  const rows = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect();
  const before = new Set(rows.filter(r => r.active).map(r => r.objectId));
  for (const row of rows) {
    const active = wanted.has(row.objectId);
    if (row.active !== active) await ctx.db.patch(row._id, { active });
  }
  for (const objectId of wanted) {
    if (!rows.some(r => r.objectId === objectId)) await ctx.db.insert("fleetAssignments", { userId: user._id, objectId, active: true });
  }
  const changed = before.size !== wanted.size || [...wanted].some(id => !before.has(id));
  const version = created ? 1 : (user.assignmentVersion ?? LEGACY_ASSIGNMENT_VERSION) + (changed ? 1 : 0);
  if (version !== user.assignmentVersion) await ctx.db.patch(user._id, { assignmentVersion: version });
  return version;
}

/** Adds one active assignment without touching the others (development fixtures). */
export async function ensureAssignment(ctx: MutationCtx, userId: Id<"users">, objectId: string, created = false) {
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError({ code: "NOT_FOUND", message: "User not found." });
  if (user.role === "demo_observer") throw new ConvexError({ code: "FORBIDDEN", message: "Observers cannot hold fleet assignments." });
  const rows = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", userId)).collect();
  const active = rows.filter(r => r.active).map(r => r.objectId);
  // An existing inactive row stays inactive, as before: a fixture rerun never reactivates a revoked assignment.
  const ids = rows.some(r => r.objectId === objectId) ? active : [...active, objectId];
  return setActiveAssignments(ctx, user, ids, { created });
}
