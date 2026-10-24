import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { summaryContract, type EventFacts } from "../convex/lib/analyst";
import { FIXTURE_NOW, redEvent } from "../fixtures/events";
import { putFixture } from "../convex/lib/events";
import { internal } from "../convex/_generated/api";
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
// Real catalog rows (numeric ids, SOCRATES evidence) in the shape of catalog-pairs.json.
export const catalogSources = [
  { name: "socrates" as const, url: "https://celestrak.org/SOCRATES/sort-minRange.csv", epochUtc: "2026-10-24T01:47:21Z", fetchedAt: "2026-10-24T08:00:00Z" },
  { name: "celestrak_gp" as const, url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json", epochUtc: "2026-10-24T07:00:00Z", fetchedAt: "2026-10-24T08:02:43Z" },
  { name: "celestrak_satcat" as const, url: "https://celestrak.org/pub/satcat.csv", epochUtc: null, fetchedAt: "2026-10-24T08:02:50Z" },
];
export const registerSnapshot = (t: Backend, snapshotId = "socrates-test", sources = catalogSources) =>
  t.mutation(internal.ingest.register, { snapshotId, sources });
export const catalogObject = (objectId: string) => ({ objectId, name: `SAT ${objectId}`, country: "US", launchDate: "2020-01-01" });
// A pair between catalog numbers a < b whose TCA is `hours` from the fixture clock.
export const pair = (a: number, b: number, hours: number, pcValue: number | null, missKm = 0.5) => ({
  objectA: catalogObject(String(a)), objectB: catalogObject(String(b)),
  tcaUtc: new Date(FIXTURE_NOW + hours * 3_600_000).toISOString().replace(".000Z", "Z"),
  missKm, relSpeedKmS: 10.5, pcValue,
});
export const scheduledAnalystStarts = (t: Backend) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").collect()).filter(f => f.name === "agents/analyst:start"));
// Ingestion arguments for a fixture: only what the tables store.
export const ingestArgs = (snapshotId: Id<"snapshots">, facts: EventFacts = redEvent) => {
  const object = ({ objectId, name, country, launchDate }: EventFacts["objectA"]) => ({ objectId, name, country, launchDate });
  return {
    snapshotId, objectA: object(facts.objectA), objectB: object(facts.objectB), tcaUtc: facts.tcaUtc,
    missKm: facts.missKm, relSpeedKmS: facts.relSpeedKmS, pcValue: facts.pc.value, simulated: facts.simulated,
  };
};
