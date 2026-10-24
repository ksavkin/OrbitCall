import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { EventFacts } from "./analyst";
import type { objectInput, sourceRef } from "./validators";

type ObjectInput = Infer<typeof objectInput>;
type Measurements = Pick<Doc<"events">, "tcaMs" | "missKm" | "relSpeedKmS" | "pcValue" | "simulated">;

export const TCA_MATCH_MS = 60_000;
export const isSimulatedId = (objectId: string) => objectId.startsWith("SIM-");
export const isoUtc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

function spaceObject({ objectId, name, country, launchDate }: ObjectInput): EventFacts["objectA"] {
  const simulated = isSimulatedId(objectId);
  return {
    objectId, name, ownerName: null, ownerCompanyId: null, country, purpose: null, launchDate, simulated,
    celestrakUrl: simulated ? null : `https://celestrak.org/satcat/table-satcat.php?CATNR=${objectId}`,
  };
}

// The analyst input in spec shapes. Pc metric, source and epoch follow from the event's
// simulated flag and its snapshot's provenance; the GP/SupGP spread is not computed in Phase 1.
export function buildFacts(m: Measurements, a: ObjectInput, b: ObjectInput, sources: Infer<typeof sourceRef>[]): EventFacts {
  const source = m.simulated ? "simulated" as const : "socrates" as const;
  const evidence = sources.find(s => s.name === source);
  return {
    objectA: spaceObject(a), objectB: spaceObject(b),
    tcaUtc: isoUtc(m.tcaMs), missKm: m.missKm, relSpeedKmS: m.relSpeedKmS,
    pc: {
      value: m.pcValue, metric: m.simulated ? "pc" : "max_prob", source,
      epochUtc: evidence?.epochUtc ?? null, sourceUrl: evidence?.url ?? null, emergencyReportable: null,
    },
    sources, spread: null, simulated: m.simulated,
  };
}

export async function loadFacts(ctx: QueryCtx, event: Doc<"events">): Promise<EventFacts> {
  const [a, b, snapshot] = await Promise.all([
    ctx.db.get(event.objectAId), ctx.db.get(event.objectBId), ctx.db.get(event.snapshotId),
  ]);
  if (!a || !b || !snapshot) throw new ConvexError({ code: "NOT_FOUND", message: "Event data is incomplete." });
  return buildFacts(event, a, b, snapshot.sources);
}

export function findObject(ctx: QueryCtx, objectId: string) {
  return ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
}

// Real catalog metadata replaces what is stored; fixtures never overwrite an existing object.
export async function upsertObject(ctx: MutationCtx, input: ObjectInput, fixture: boolean): Promise<Id<"spaceObjects">> {
  const stored = await findObject(ctx, input.objectId);
  if (!stored) return ctx.db.insert("spaceObjects", input);
  if (!fixture && (stored.name !== input.name || stored.country !== input.country || stored.launchDate !== input.launchDate)) {
    await ctx.db.patch(stored._id, input);
  }
  return stored._id;
}

// The same pair within ±60 s of TCA is the same encounter; the nearest one wins.
export async function findEncounter(ctx: QueryCtx, objectAId: Id<"spaceObjects">, objectBId: Id<"spaceObjects">, tcaMs: number) {
  const near = await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", objectAId)
    .eq("objectBId", objectBId).gte("tcaMs", tcaMs - TCA_MATCH_MS).lte("tcaMs", tcaMs + TCA_MATCH_MS)).collect();
  return near.sort((x, y) => Math.abs(x.tcaMs - tcaMs) - Math.abs(y.tcaMs - tcaMs))[0] ?? null;
}

// Stores a fixture under its own provenance record. Its color is a fixture property, not a forecast.
export async function putFixture(ctx: MutationCtx, key: string, facts: EventFacts, color: Doc<"events">["color"]) {
  const snapshot = await ctx.db.query("snapshots").withIndex("by_snapshot_id", q => q.eq("snapshotId", key)).unique();
  const snapshotId = snapshot?._id ?? await ctx.db.insert("snapshots", { snapshotId: key, sources: facts.sources });
  if (snapshot) await ctx.db.patch(snapshot._id, { sources: facts.sources });
  const pick = ({ objectId, name, country, launchDate }: ObjectInput) => ({ objectId, name, country, launchDate });
  const objectAId = await upsertObject(ctx, pick(facts.objectA), true);
  const objectBId = await upsertObject(ctx, pick(facts.objectB), true);
  const tcaMs = Date.parse(facts.tcaUtc);
  const row = {
    objectAId, objectBId, snapshotId, tcaMs, missKm: facts.missKm, relSpeedKmS: facts.relSpeedKmS,
    pcValue: facts.pc.value, simulated: facts.simulated, color, active: true, updatedAt: Date.now(),
  };
  const existing = await findEncounter(ctx, objectAId, objectBId, tcaMs);
  if (!existing) return ctx.db.insert("events", row);
  await ctx.db.patch(existing._id, row);
  return existing._id;
}
