import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { TigerObservation, TigerSource } from "./tiger";
import { sourceName } from "./validators";

// Pure mapping between Convex observation rows, Tiger rows and chart points. This file runs in the default
// runtime, so it must not load ./tiger (which loads `pg`); only its types are imported.

// The metrics a chart point carries. Other metrics are exported to Tiger but not charted.
export const SERIES_METRICS = { pc: "pc", missKm: "missKm" } as const;

const SOURCES = sourceName.members.map(member => member.value) as readonly string[];
const METRIC = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const keyPart = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n\u0000-\u001f\u007f]/.test(value) && !value.includes("|");
const invalid = (message: string) => new ConvexError({ code: "INVALID_INPUT", message });

function canonicalUtc(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(value).toISOString().replace(/\.000Z$/, "Z");
}
const utcOf = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

type KeyInput = Pick<TigerObservation, "eventId" | "runId" | "source" | "metric" | "evidenceVersion" | "observedAt">;

// Must produce exactly what tiger.observationKey() produces: a mutation cannot import the Node-only Tiger module.
// tests/history.test.ts compares the two, and writeObservations() rejects any row whose key differs.
export function exportKey({ eventId, runId, observedAt, source, metric, evidenceVersion }: KeyInput): string {
  if (!keyPart(eventId, 128)) throw invalid("An observation needs its event ID, without \"|\".");
  if (runId !== null && !keyPart(runId, 128)) throw invalid("A demo run ID must be null or a single-line value without \"|\".");
  const time = canonicalUtc(observedAt);
  if (time === null) throw invalid("Observation times must be UTC ISO strings with at most millisecond precision.");
  if (!SOURCES.includes(source)) throw invalid("An observation needs a known source name.");
  if (!METRIC.test(metric)) throw invalid("An observation metric must be a short identifier.");
  if (!keyPart(evidenceVersion, 128)) throw invalid("An observation needs its evidence version, without \"|\".");
  return [eventId, runId ?? "", source, metric, evidenceVersion, time].join("|");
}

export type ExportFields = Pick<Doc<"observationExports">,
  "observationKey" | "eventId" | "demoRunId" | "observedAtMs" | "source" | "metric" | "value" | "evidenceVersion" | "simulated">;

// Checks one observation for recordObservation and returns the fields stored on its export row.
export function exportFields(eventId: Doc<"observationExports">["eventId"], input: {
  observedAt: string; source: TigerSource; metric: string; value: number | null; evidenceVersion: string; simulated: boolean;
  runId: Doc<"observationExports">["demoRunId"];
}): ExportFields {
  if (input.value !== null && !Number.isFinite(input.value)) throw invalid("An observation value must be null or a finite number.");
  if (input.source === "simulated" && !input.simulated) throw invalid("Simulated evidence must be labeled simulated.");
  const observationKey = exportKey({ ...input, eventId });
  return {
    observationKey, eventId, demoRunId: input.runId, observedAtMs: Date.parse(input.observedAt), source: input.source,
    metric: input.metric, value: input.value, evidenceVersion: input.evidenceVersion, simulated: input.simulated,
  };
}

// The key fixes everything but the value and the simulated label, so those decide whether a repeat is the same observation.
export const sameContent = (row: ExportFields, fields: ExportFields) =>
  row.value === fields.value && row.simulated === fields.simulated && row.demoRunId === fields.demoRunId;

// Not validated here: writeObservations() validates the row, key included, before anything is sent.
export function toTigerObservation(row: Doc<"observationExports">): TigerObservation {
  return {
    observationKey: row.observationKey, eventId: row.eventId, runId: row.demoRunId, observedAt: utcOf(row.observedAtMs),
    source: row.source as TigerSource, metric: row.metric, value: row.value, evidenceVersion: row.evidenceVersion, simulated: row.simulated,
  };
}

export const historyPoint = v.object({
  atUtc: v.string(), pc: v.union(v.number(), v.null()), missKm: v.union(v.number(), v.null()), source: v.string(), simulated: v.boolean(),
});
export type HistoryPoint = Infer<typeof historyPoint>;

// One point per instant, source, evidence version and run, holding that observation's pc and missKm. Observations
// are never merged across sources, versions or runs, so a source change stays visible. A metric that was not
// observed, or was observed without a value, stays null. Input order (oldest first) is kept.
export function toSeriesPoints(observations: readonly TigerObservation[]): HistoryPoint[] {
  const points = new Map<string, HistoryPoint>();
  for (const observation of observations) {
    const field = observation.metric === SERIES_METRICS.pc ? "pc" : observation.metric === SERIES_METRICS.missKm ? "missKm" : null;
    if (field === null) continue;
    const key = [observation.observedAt, observation.source, observation.evidenceVersion, observation.runId ?? "", observation.simulated].join("|");
    const point = points.get(key) ?? { atUtc: observation.observedAt, pc: null, missKm: null, source: observation.source, simulated: observation.simulated };
    point[field] = observation.value;
    points.set(key, point);
  }
  return [...points.values()];
}
