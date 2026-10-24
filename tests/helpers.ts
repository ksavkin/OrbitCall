import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { summaryContract, type EventFacts } from "../convex/lib/analyst";
import { redEvent } from "../fixtures/events";
import { putFixture } from "../convex/lib/events";
import type { Id } from "../convex/_generated/dataModel";

export const modules = import.meta.glob("../convex/**/*.ts");
export const backend = () => convexTest(schema, modules);
export type Backend = ReturnType<typeof backend>;
export const draft = (facts: EventFacts = redEvent) => JSON.stringify({
  lines: summaryContract(facts).slots.map(slot => ({ kind: slot.kind, template: slot.templates[0] })),
});
export async function insertEvent(t: Backend, facts: EventFacts = redEvent) {
  return t.run(ctx => putFixture(ctx, "fixture:test", facts, "red"));
}
export async function insertSnapshot(t: Backend, facts: EventFacts = redEvent) {
  return t.run(ctx => ctx.db.insert("snapshots", { snapshotId: "fixture:test", sources: facts.sources }));
}
// Ingestion arguments for a fixture: only what the tables store.
export const ingestArgs = (snapshotId: Id<"snapshots">, facts: EventFacts = redEvent) => {
  const object = ({ objectId, name, country, launchDate }: EventFacts["objectA"]) => ({ objectId, name, country, launchDate });
  return {
    snapshotId, objectA: object(facts.objectA), objectB: object(facts.objectB), tcaUtc: facts.tcaUtc,
    missKm: facts.missKm, relSpeedKmS: facts.relSpeedKmS, pcValue: facts.pc.value, simulated: facts.simulated,
  };
};
