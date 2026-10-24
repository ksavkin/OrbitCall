import type { Doc } from "../_generated/dataModel";
import type { EventFacts } from "./analyst";

export function factsFromEvent(event: Doc<"events">): EventFacts {
  return {
    objectA: event.objectA, objectB: event.objectB,
    tcaUtc: event.tcaUtc, missKm: event.missKm, relSpeedKmS: event.relSpeedKmS,
    pc: event.pc, sources: event.sources, spread: event.spread, simulated: event.simulated,
  };
}
