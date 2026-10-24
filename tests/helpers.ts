import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { summaryContract, type EventFacts } from "../convex/lib/analyst";
import { redEvent } from "../fixtures/events";

export const modules = import.meta.glob("../convex/**/*.ts");
export const backend = () => convexTest(schema, modules);
export type Backend = ReturnType<typeof backend>;
export const draft = (facts: EventFacts = redEvent) => JSON.stringify({
  lines: summaryContract(facts).slots.map(slot => ({ kind: slot.kind, template: slot.templates[0] })),
});
export async function insertEvent(t: Backend, facts: EventFacts = redEvent) {
  return t.run(ctx => ctx.db.insert("events", {
    ...facts, sourceKey: "test:event", color: "red", status: "new",
    agentsWorking: false, agentsStalled: false, updatedAt: "2026-10-24T12:00:00Z",
  }));
}
