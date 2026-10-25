import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { fleetEvents, fleetIds, requireFleetScope, resolveFleet } from "./fleetQuery";
import { isoUtc } from "./lib/events";
import { catalogRow, eventRow } from "./lib/queue";
import { runFlags } from "./lib/runs";

// The personal queue (spec §3.2 events.myQueue, Q-1, Q-5) on the tables Round 1 already has. Issue #6 places it
// in this file, so the client calls api.myQueue.myQueue. Assigned-fleet events only, resolved on the server
// from the caller's fleet scope (fleetQuery.ts); an operator of either object sees the same canonical event.
// Ingestion stores one event per pair within ±60 s of TCA (lib/events.ts), so rows are already deduplicated.
//
// Sections from what is stored: an active event with a probability is "active"; an active event whose
// probability is unavailable is "data_review" (no Pc, nothing to rank it by); a retired event (TCA passed) is
// "history". "follow_up" needs maneuvers and verifications, which have no table yet, so it never occurs here.

const side = v.union(v.literal("A"), v.literal("B"));
const queueSection = v.union(v.literal("active"), v.literal("data_review"), v.literal("history"));
type Section = "active" | "data_review" | "history";

// The Phase 1 row plus the viewer-dependent fields of spec §2.2 EventRow.
export const myQueueRow = v.object({
  ...eventRow.fields,
  mySide: v.union(side, v.null()),
  myObjectIds: v.array(v.string()),
  workflow: v.union(v.literal("bilateral"), v.literal("internal_review")),
  requiredApprovalSides: v.array(side),
  canAct: v.boolean(),
  queueSection,
  rank: v.number(),
  priorityReason: v.string(),
});

type Ranked = Pick<Doc<"events">, "_id" | "color" | "pcValue" | "tcaMs" | "missKm" | "active">;
const severity = (e: Ranked) => e.color === "red" ? 0 : e.color === "yellow" ? 1 : 2;
const byId = (a: Ranked, b: Ranked) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0;

export function sectionOf(e: Ranked): Section {
  if (!e.active) return "history";
  return e.pcValue === null ? "data_review" : "active";
}

// Active order (spec §3.2): red, yellow, other usable Pc; within a severity the earliest TCA, then the emergency
// flag, then descending Pc, then event id. The CDM emergency flag is not stored in Phase 1 (always null), so it
// cannot separate two rows. No Pc/time score anywhere.
export function compareActive(a: Ranked, b: Ranked): number {
  return severity(a) - severity(b) || a.tcaMs - b.tcaMs || (b.pcValue ?? 0) - (a.pcValue ?? 0) || byId(a, b);
}
// Data review: TCA, miss, event id.
export function compareDataReview(a: Ranked, b: Ranked): number {
  return a.tcaMs - b.tcaMs || a.missKm - b.missKm || byId(a, b);
}
// History: the most recent approach first.
export function compareHistory(a: Ranked, b: Ranked): number {
  return b.tcaMs - a.tcaMs || byId(a, b);
}
const comparators: Record<Section, (a: Ranked, b: Ranked) => number> = {
  active: compareActive, data_review: compareDataReview, history: compareHistory,
};

// A factual line with the numbers the rank came from. English in this phase, like the Analyst summary.
function priorityReason(section: Section, e: Doc<"events">): string {
  const tca = isoUtc(e.tcaMs), miss = `${e.missKm} km`;
  if (section === "history") return `Closest approach passed at ${tca}.`;
  if (section === "data_review") return `Probability unavailable; closest approach ${tca}, miss ${miss}.`;
  const label = e.color === "red" ? "Red" : e.color === "yellow" ? "Yellow" : "Low probability";
  return `${label}: Pc ${e.pcValue!.toExponential(1)}, closest approach ${tca}, miss ${miss}.`;
}

// Each returned row costs up to three reads (its run flags and two objects), as in events.catalogPairs.
const MAX_ROWS = 1200;

/**
 * The caller's queue: every event in which one of their fleet objects is a party, in section order (active,
 * data review, history) and ranked within its section. `objectId` narrows the rows to one object, which must be
 * in the caller's scope; otherwise FORBIDDEN, whether or not the object exists. A head of ops reads the company's
 * queue with canAct false everywhere.
 */
export const myQueue = query({
  args: { objectId: v.optional(v.string()) },
  returns: v.array(myQueueRow),
  handler: async (ctx, { objectId }) => {
    const scope = await requireFleetScope(ctx);
    if (objectId !== undefined && !scope.objects.some(o => o.objectId === objectId)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "This object is not in your fleet." });
    }
    const fleet = await resolveFleet(ctx, scope.objects);
    const ids = fleetIds(fleet);
    const focus = objectId === undefined ? null : fleet.find(f => f.objectId === objectId)?.doc?._id ?? null;
    // A filter on an object that has no catalog row yet can match no event.
    if (objectId !== undefined && focus === null) return [];

    const events = [...await fleetEvents(ctx, ids, true), ...await fleetEvents(ctx, ids, false)]
      .filter(e => focus === null || e.objectAId === focus || e.objectBId === focus);
    const sections: Record<Section, Doc<"events">[]> = { active: [], data_review: [], history: [] };
    for (const event of events) sections[sectionOf(event)].push(event);
    const ordered: { event: Doc<"events">; section: Section; rank: number }[] = [];
    for (const section of ["active", "data_review", "history"] as const) {
      sections[section].sort(comparators[section]).forEach((event, i) => ordered.push({ event, section, rank: i + 1 }));
    }
    const top = ordered.slice(0, MAX_ROWS);

    // Join only the returned rows; objects and snapshots are read once each.
    const unique = <T>(items: T[]) => [...new Set(items)];
    const [snapshots, objects] = await Promise.all([
      Promise.all(unique(top.map(r => r.event.snapshotId)).map(async id => [id, await ctx.db.get(id)] as const)),
      Promise.all(unique(top.flatMap(r => [r.event.objectAId, r.event.objectBId])).map(async id => [id, await ctx.db.get(id)] as const)),
    ]);
    const snapshotById = new Map(snapshots), objectById = new Map(objects);
    const rows = await Promise.all(top.map(async ({ event, section, rank }) => {
      const [snapshot, a, b] = [snapshotById.get(event.snapshotId), objectById.get(event.objectAId), objectById.get(event.objectBId)];
      if (!snapshot || !a || !b) return null;
      const mineA = ids.get(event.objectAId), mineB = ids.get(event.objectBId);
      // Sides are canonical (spec §1): the viewer's side is whichever object is theirs. Both: an internal
      // review with no side, no approval sides and no action until an internal approval rule exists.
      const mySide = mineA !== undefined && mineB === undefined ? "A" as const : mineB !== undefined && mineA === undefined ? "B" as const : null;
      return {
        ...catalogRow(event, a, b, snapshot, await runFlags(ctx, event._id)),
        mySide,
        myObjectIds: unique([mineA, mineB].filter((id): id is string => id !== undefined)).sort(),
        workflow: mySide === null ? "internal_review" as const : "bilateral" as const,
        requiredApprovalSides: mySide === null ? [] : ["A" as const, "B" as const],
        canAct: scope.user.role === "operator" && mySide !== null && section === "active",
        queueSection: section, rank, priorityReason: priorityReason(section, event),
      };
    }));
    return rows.filter(row => row !== null);
  },
});
