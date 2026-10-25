import type { Doc, Id } from "../_generated/dataModel";
import { isoUtc } from "./events";

// Viewer-independent incident rules shared by the personal queue (myQueue.ts) and the inbox (inbox.ts).

export type Ranked = Pick<Doc<"events">, "_id" | "color" | "pcValue" | "tcaMs" | "missKm" | "active">;
export type Section = "active" | "data_review" | "history";

export function sectionOf(e: Ranked): Section {
  if (!e.active) return "history";
  return e.pcValue === null ? "data_review" : "active";
}

// A factual line with the numbers the rank came from. English in this phase, like the Analyst summary.
export function priorityReason(section: Section, e: Doc<"events">): string {
  const tca = isoUtc(e.tcaMs), miss = `${e.missKm} km`;
  if (section === "history") return `Closest approach passed at ${tca}.`;
  if (section === "data_review") return `Probability unavailable; closest approach ${tca}, miss ${miss}.`;
  const label = e.color === "red" ? "Red" : e.color === "yellow" ? "Yellow" : "Low probability";
  return `${label}: Pc ${e.pcValue!.toExponential(1)}, closest approach ${tca}, miss ${miss}.`;
}

type FleetIds = Map<Id<"spaceObjects">, string>;

/**
 * The viewer's side of an event. Sides are canonical (spec §1): the viewer's side is whichever object is theirs.
 * Both objects the company's, whoever in it is assigned to them: an internal review with both ids, no side, no
 * approval sides and no action until an internal approval rule exists. `assigned` and `company` are the fleetIds
 * of scope.objects and scope.companyObjects.
 */
export function viewerSides(event: Pick<Doc<"events">, "objectAId" | "objectBId">, assigned: FleetIds, company: FleetIds) {
  const ours = (id: Id<"spaceObjects">) => company.get(id) ?? assigned.get(id);
  const ownA = ours(event.objectAId), ownB = ours(event.objectBId);
  const internal = ownA !== undefined && ownB !== undefined;
  const mySide = internal ? null : ownA !== undefined ? "A" as const : "B" as const;
  return {
    mySide,
    myObjectIds: [...new Set([ownA, ownB].filter((id): id is string => id !== undefined))].sort(),
    internal,
    otherObjectId: internal ? null : mySide === "A" ? event.objectBId : event.objectAId,
  };
}
