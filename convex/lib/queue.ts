import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { buildFacts, isoUtc } from "./events";
import { probability, sourceRef, spaceObject } from "./validators";

// Queue order (spec §3.2): red, yellow, the rest with Pc, then Pc unavailable. The first three groups
// sort by Pc descending, then TCA; the unavailable group by TCA, then miss. The stored color decides.
type Ranked = Pick<Doc<"events">, "_id" | "color" | "pcValue" | "tcaMs" | "missKm">;
const group = (e: Ranked) => e.color === "red" ? 0 : e.color === "yellow" ? 1 : e.pcValue !== null ? 2 : 3;

export function compareQueue(a: Ranked, b: Ranked): number {
  const byGroup = group(a) - group(b);
  if (byGroup) return byGroup;
  if (a.pcValue !== null && b.pcValue !== null && a.pcValue !== b.pcValue) return b.pcValue - a.pcValue;
  return a.tcaMs - b.tcaMs || a.missKm - b.missKm || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

// Phase 1 catalog rows: no viewer company, no room, status "new" (see schema/data.ts).
export const eventRow = v.object({
  eventId: v.id("events"), objectA: spaceObject, objectB: spaceObject, mySide: v.null(),
  tcaUtc: v.string(), missKm: v.number(), relSpeedKmS: v.number(), pc: probability,
  color: v.union(v.literal("red"), v.literal("yellow"), v.literal("none")),
  status: v.literal("new"), situation: v.null(),
  agentsWorking: v.boolean(), agentsStalled: v.boolean(),
  selected: v.null(), outcome: v.null(), reviewRequired: v.boolean(), roomOpen: v.boolean(),
  sources: v.array(sourceRef), simulated: v.boolean(), updatedAt: v.string(),
});

export function catalogRow(
  event: Doc<"events">, a: Doc<"spaceObjects">, b: Doc<"spaceObjects">, snapshot: Doc<"snapshots">,
  flags: { agentsWorking: boolean; agentsStalled: boolean },
): Infer<typeof eventRow> {
  const facts = buildFacts(event, a, b, snapshot.sources);
  return {
    eventId: event._id, objectA: facts.objectA, objectB: facts.objectB, mySide: null,
    tcaUtc: facts.tcaUtc, missKm: facts.missKm, relSpeedKmS: facts.relSpeedKmS, pc: facts.pc,
    color: event.color, status: "new", situation: null, ...flags,
    selected: null, outcome: null, reviewRequired: false, roomOpen: false,
    sources: facts.sources, simulated: facts.simulated, updatedAt: isoUtc(event.updatedAt),
  };
}
