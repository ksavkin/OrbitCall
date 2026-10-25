import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { AnalystError, inputKey, isRed, validateFacts, type EventFacts } from "./analyst";
import { supersede } from "./runs";
import type { objectInput, sourceRef } from "./validators";

type ObjectInput = Infer<typeof objectInput>;
type Measurements = Pick<Doc<"events">, "tcaMs" | "missKm" | "relSpeedKmS" | "pcValue" | "simulated">;

export type Encounter = Omit<Measurements, "tcaMs"> & { snapshotId: Id<"snapshots">; objectA: ObjectInput; objectB: ObjectInput; tcaUtc: string };

export const TCA_MATCH_MS = 60_000;
export const isSimulatedId = (objectId: string) => objectId.startsWith("SIM-");
export const isoUtc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function toSpaceObject({ objectId, name, country, launchDate }: ObjectInput): EventFacts["objectA"] {
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
    objectA: toSpaceObject(a), objectB: toSpaceObject(b),
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

// The one color rule, shared by ingestion and the recolor cron. isRed reads only tcaUtc and pc.value.
export function colorOf({ pcValue, tcaMs }: Pick<Measurements, "pcValue" | "tcaMs">, now: number): Doc<"events">["color"] {
  if (isRed({ tcaUtc: isoUtc(tcaMs), pc: { value: pcValue } } as EventFacts, now)) return "red";
  return pcValue !== null && pcValue >= 1e-5 ? "yellow" : "none";
}

// Stores one encounter from a registered snapshot. `start` says the Analyst should be scheduled;
// the caller decides (bulk loads never start it, the recolor cron does).
export async function ingestEncounter(ctx: MutationCtx, { snapshotId, objectA, objectB, tcaUtc, ...measured }: Encounter) {
  const snapshot = await ctx.db.get(snapshotId);
  if (!snapshot) throw new ConvexError({ code: "NOT_FOUND", message: "Snapshot not found." });
  const tcaMs = Date.parse(tcaUtc);
  if (!Number.isFinite(tcaMs)) throw new AnalystError("INVALID_INPUT", "Encounter time or units are invalid.");
  validateFacts({ ...buildFacts({ ...measured, tcaMs }, objectA, objectB, snapshot.sources), tcaUtc });

  // Read the previous evidence before object metadata changes underneath it.
  const [knownA, knownB] = await Promise.all([findObject(ctx, objectA.objectId), findObject(ctx, objectB.objectId)]);
  const previous = knownA && knownB ? await findEncounter(ctx, knownA._id, knownB._id, tcaMs) : null;
  const before = previous && inputKey(await loadFacts(ctx, previous));
  const objectAId = await upsertObject(ctx, objectA, measured.simulated);
  const objectBId = await upsertObject(ctx, objectB, measured.simulated);
  const [a, b] = await Promise.all([ctx.db.get(objectAId), ctx.db.get(objectBId)]);
  const facts = buildFacts({ ...measured, tcaMs }, a!, b!, snapshot.sources);
  const changed = before !== inputKey(facts);

  const now = Date.now();
  const color = colorOf({ pcValue: measured.pcValue, tcaMs }, now);
  const row = { objectAId, objectBId, snapshotId, tcaMs, ...measured, color, active: tcaMs > now };
  // updatedAt moves only when the evidence does; an identical reload keeps it and writes nothing.
  let outcome: "inserted" | "updated" | "unchanged" = "inserted";
  let eventId: Id<"events">;
  if (!previous) eventId = await ctx.db.insert("events", { ...row, updatedAt: now });
  else {
    eventId = previous._id;
    const same = (Object.keys(row) as (keyof typeof row)[]).every(key => previous[key] === row[key]);
    outcome = changed || !same ? "updated" : "unchanged";
    if (changed) await ctx.db.patch(eventId, { ...row, updatedAt: now });
    else if (!same) await ctx.db.patch(eventId, row);
  }
  // Publishing a changed input also invalidates any result still being computed for it.
  if (changed && previous) {
    const running = await ctx.db.query("agentRuns").withIndex("by_event_status", q =>
      q.eq("eventId", eventId).eq("status", "running")).collect();
    for (const run of running) await supersede(ctx, run._id);
  }
  return { eventId, outcome, start: color === "red" && (changed || previous?.color !== "red") };
}
