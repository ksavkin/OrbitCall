import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./session";
import { findObject, isoUtc, toSpaceObject } from "./lib/events";
import { spaceObject } from "./lib/validators";

// The assigned-fleet dashboard (spec §3.2, FLEET-1, FLEET-2) on the tables Round 1 already has. The spec names
// the query fleet.listMine; issue #6 places it in this file, so the client calls api.fleetQuery.listMine.
// A value that no table stores reads as null or "unknown", never as a guess (spec §0): there is no scanRuns
// table yet, so lastScanId is null and scanCoverage is "not_scanned"; positions and element epochs are not
// stored per object, so position and orbitEpochUtc are null and freshness is "unknown".

/** One object in the caller's scope and when it entered it (the assignment or ownership row's creation). */
export type FleetObject = { objectId: string; since: number };
/** `objects`: what the caller is responsible for. `companyObjects`: everything the caller's company operates. */
export type FleetScope = { user: Doc<"users">; company: Doc<"companies">; objects: FleetObject[]; companyObjects: FleetObject[] };

function dedupe(rows: FleetObject[]): FleetObject[] {
  const earliest = new Map<string, number>();
  for (const { objectId, since } of rows) earliest.set(objectId, Math.min(since, earliest.get(objectId) ?? since));
  return [...earliest].map(([objectId, since]) => ({ objectId, since })).sort((a, b) => a.objectId < b.objectId ? -1 : 1);
}

/**
 * Resolves who the caller is responsible for, on the server (FLEET-1, spec §1 roles). An operator: the objects
 * currently assigned to them. A head of ops: every object their company operates, read-only. An observer has no
 * fleet. An empty scope stays empty; there is no global fallback. Objects are sorted by id; a duplicate row keeps
 * the earliest date. The company's whole fleet comes along for rules that depend on ownership, not assignment.
 */
export async function requireFleetScope(ctx: QueryCtx): Promise<FleetScope> {
  const { user, company } = await requireUser(ctx);
  if (user.role !== "operator" && user.role !== "head_of_ops") throw new ConvexError({ code: "FORBIDDEN", message: "Observers have no fleet." });
  const owned = await ctx.db.query("satelliteOwners").withIndex("by_company", q => q.eq("companyId", company._id)).collect();
  const companyObjects = dedupe(owned.map(o => ({ objectId: o.objectId, since: o._creationTime })));
  if (user.role === "head_of_ops") return { user, company, objects: companyObjects, companyObjects };
  const assignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id)).collect();
  const objects = dedupe(assignments.filter(a => a.active).map(a => ({ objectId: a.objectId, since: a._creationTime })));
  return { user, company, objects, companyObjects };
}

/** The stored metadata row of each object in scope; null when the id was assigned without being registered. */
export async function resolveFleet(ctx: QueryCtx, objects: FleetObject[]) {
  return Promise.all(objects.map(async object => ({ ...object, doc: await findObject(ctx, object.objectId) })));
}

/** spaceObjects row id → object id, for the objects in scope that have a row. */
export function fleetIds(fleet: Awaited<ReturnType<typeof resolveFleet>>): Map<Id<"spaceObjects">, string> {
  return new Map(fleet.flatMap(f => f.doc ? [[f.doc._id, f.objectId] as const] : []));
}

// Like events.catalogPairs: one index range over the active flag, at most MAX_SCAN rows, filtered in memory to
// the events that involve the fleet. A snapshot loads about a thousand events (plan D9), so the range is far
// from the limit; newest first so that a truncated history keeps its recent part.
const MAX_SCAN = 5000;

/** Events (active or retired) in which at least one of the fleet's objects is a party. */
export async function fleetEvents(ctx: QueryCtx, fleet: Map<Id<"spaceObjects">, string>, active: boolean) {
  if (!fleet.size) return [];
  const scanned = await ctx.db.query("events").withIndex("by_active", q => q.eq("active", active)).order("desc").take(MAX_SCAN);
  return scanned.filter(e => fleet.has(e.objectAId) || fleet.has(e.objectBId));
}

export const fleetSatellite = v.object({
  object: spaceObject,
  assignedAt: v.string(),
  position: v.null(),
  orbitEpochUtc: v.null(),
  freshness: v.literal("unknown"),
  unresolvedIncidentCount: v.number(),
  lastScanId: v.null(),
  scanCoverage: v.literal("not_scanned"),
});

/**
 * Every object in the caller's scope, including those with no incident (FLEET-2). unresolvedIncidentCount is
 * the number of distinct active events the object is a party to; an event between two fleet objects counts once
 * for each. assignmentVersion is the caller's own counter from users.me.
 */
export const listMine = query({
  args: {},
  returns: v.object({ assignmentVersion: v.union(v.number(), v.null()), satellites: v.array(fleetSatellite) }),
  handler: async ctx => {
    const scope = await requireFleetScope(ctx);
    const fleet = await resolveFleet(ctx, scope.objects);
    const ids = fleetIds(fleet);
    const counts = new Map<string, number>();
    for (const event of await fleetEvents(ctx, ids, true)) {
      for (const rowId of new Set([event.objectAId, event.objectBId])) {
        const objectId = ids.get(rowId);
        if (objectId !== undefined) counts.set(objectId, (counts.get(objectId) ?? 0) + 1);
      }
    }
    return {
      assignmentVersion: scope.user.assignmentVersion ?? null,
      satellites: fleet.map(({ objectId, since, doc }) => ({
        // An id assigned before its catalog row exists shows as itself; metadata is never invented.
        object: toSpaceObject(doc ?? { objectId, name: objectId, country: null, launchDate: null }),
        assignedAt: isoUtc(since),
        position: null, orbitEpochUtc: null, freshness: "unknown" as const,
        unresolvedIncidentCount: counts.get(objectId) ?? 0,
        lastScanId: null, scanCoverage: "not_scanned" as const,
      })),
    };
  },
});
