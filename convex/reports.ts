import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireFleetScope } from "./fleetQuery";
import { findObject, isoUtc } from "./lib/events";

const periodArgs = { periodStart: v.string(), periodEnd: v.string() };
const LIMIT = 1000;
function fail(code: string, message: string): never { throw new ConvexError({ code, message }); }
export function period(start: string, end: string) {
  const from = Date.parse(start), to = Date.parse(end);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(start) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(end) ||
      !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * 86400000)
    fail("VALIDATION", "Choose a UTC reporting period of at most one year, with end after start.");
  return { from, to };
}

// Canonical pair and +/-60 s encounter identity, rather than alerts/revisions, determine report counts.
export function canonicalGroups(rows: Doc<"events">[]) {
  const groups: Doc<"events">[][] = [];
  for (const row of [...rows].sort((a, b) => a.tcaMs - b.tcaMs || a._id.localeCompare(b._id))) {
    const pair = [row.objectAId, row.objectBId].sort().join("|");
    const existing = groups.find(g => [g[0].objectAId, g[0].objectBId].sort().join("|") === pair && row.tcaMs - g[0].tcaMs <= 60000);
    if (existing) existing.push(row); else groups.push([row]);
  }
  return groups;
}

async function report(ctx: QueryCtx, args: { periodStart: string; periodEnd: string }) {
  const { from, to } = period(args.periodStart, args.periodEnd);
  const scope = await requireFleetScope(ctx); // operator/head of ops only; company report, never an observer
  if (scope.companyObjects.length > 50) fail("LIMIT_EXCEEDED", "Narrow the company reporting scope before export.");
  const found = new Map<string, Doc<"events">>();
  for (const owned of scope.companyObjects) {
    const object = await findObject(ctx, owned.objectId);
    if (!object) continue;
    const a = await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", object._id)).take(LIMIT + 1);
    const b = await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", object._id).gte("tcaMs", from).lt("tcaMs", to)).take(LIMIT + 1);
    if (a.length > LIMIT || b.length > LIMIT) fail("LIMIT_EXCEEDED", "Report exceeds the supported scope; no partial totals were returned.");
    for (const e of [...a, ...b]) if (!e.simulated && !e.demoRunId && e.tcaMs >= from && e.tcaMs < to) found.set(e._id, e);
  }
  if (found.size > LIMIT) fail("LIMIT_EXCEEDED", "Report exceeds the supported scope; no partial totals were returned.");
  const missing = new Map<string, string>([
    ["sourceCoverage", "Stored incident records do not establish complete screening coverage for the period."],
    ["historicalOwnership", "Scope uses current company ownership; historical ownership changes need operator review."],
    ["executionConfirmation", "Consistent public observations are evidence, not independent confirmation of an executed burn."],
    ["fccApplicability", "FCC applicability, effective rules and required fields remain to verify; this is a draft, not a filing."],
  ]);
  const sources = new Map<string, { source: string; fromUtc: string | null; toUtc: string | null }>();
  const records = [];
  for (const group of canonicalGroups([...found.values()])) {
    const e = [...group].sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime)[0];
    const [a, b, snapshot] = await Promise.all([ctx.db.get(e.objectAId), ctx.db.get(e.objectBId), ctx.db.get(e.snapshotId)]);
    if (!a || !b || !snapshot) fail("NOT_READY", "An incident has incomplete source records; export was not produced.");
    if (a.objectId.startsWith("SIM-") || b.objectId.startsWith("SIM-")) continue;
    let coordinated = false, scheduled = false;
    const evidence: Doc<"verifications">[] = [];
    for (const member of group) {
      const approvals = await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", member._id)).take(101);
      const logs = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", member._id)).take(501);
      const links = await ctx.db.query("maneuverEvents").withIndex("by_event", q => q.eq("eventId", member._id)).take(51);
      const verifications = await ctx.db.query("verifications").withIndex("by_event", q => q.eq("eventId", member._id)).take(101);
      if (approvals.length > 100 || logs.length > 500 || links.length > 50 || verifications.length > 100)
        fail("LIMIT_EXCEEDED", "Incident history exceeds the report limit; no partial totals were returned.");
      coordinated ||= approvals.some(x => x.status === "approved" || x.status === "vetoed") ||
        logs.some(x => x.actor.kind === "human" && ["message", "countered", "approved", "vetoed"].includes(x.action));
      for (const link of links) {
        const m = await ctx.db.get(link.maneuverId);
        scheduled ||= !!m && m.status === "committed" && m.demoRunId === null;
      }
      evidence.push(...verifications.filter(x => x.kind === "live" && !x.simulated && x.demoRunId === null));
    }
    const latest = evidence.sort((x, y) => y.createdAt - x.createdAt)[0];
    for (const s of snapshot.sources) {
      if (s.name === "simulated") continue;
      const prior = sources.get(s.name) ?? { source: s.name, fromUtc: null, toUtc: null };
      const epoch = s.epochUtc;
      if (epoch && Number.isFinite(Date.parse(epoch))) {
        if (prior.fromUtc === null || epoch < prior.fromUtc) prior.fromUtc = epoch;
        if (prior.toUtc === null || epoch > prior.toUtc) prior.toUtc = epoch;
      }
      sources.set(s.name, prior);
    }
    if (e.pcValue === null) missing.set("probability", "Some incidents have no supplied probability; missing is not zero.");
    const status = e.status ?? "new";
    records.push({ eventId: e._id, supportingEventIds: group.map(x => x._id), objectA: a.objectId, objectB: b.objectId,
      tcaUtc: isoUtc(e.tcaMs), missKm: e.missKm, suppliedProbability: e.pcValue, status, coordinated, scheduled,
      verification: latest?.result ?? null, unresolved: !["verified", "no_action_needed"].includes(status) });
  }
  return { companyId: scope.company._id, companyName: scope.company.name, periodStart: isoUtc(from), periodEnd: isoUtc(to),
    periodBasis: "Encounter time in [periodStart, periodEnd); current stored lifecycle and evidence.",
    satellites: scope.companyObjects.map(x => x.objectId).filter(x => !x.startsWith("SIM-")),
    uniqueEvents: records.length, eventsWithCoordination: records.filter(x => x.coordinated).length,
    eventsWithScheduledManeuver: records.filter(x => x.scheduled).length,
    eventsWithObservedExecution: records.filter(x => x.verification === "consistent").length,
    observedExecutionLabel: "Events with observations consistent with plan; not confirmed execution",
    unresolvedEvents: records.filter(x => x.unresolved).length,
    coverage: [...sources.values()], missingFields: [...missing].map(([field, note]) => ({ field, note })),
    fccFields: "to_verify" as const, records };
}
export const preview = query({ args: periodArgs, handler: report });
export type Report = Awaited<ReturnType<typeof report>>;

// Quote every field and neutralize spreadsheet formulas, including leading whitespace/control characters.
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function reportCsv(r: Report): string {
  const keys = ["eventId", "objectA", "objectB", "tcaUtc", "missKm", "suppliedProbability", "status", "coordinated", "scheduled", "verification", "unresolved"] as const;
  const metadata = [
    ["Report", "OrbitCall draft; not a regulatory filing"], ["Company", r.companyName],
    ["Period start", r.periodStart], ["Period end (exclusive)", r.periodEnd], ["Basis", r.periodBasis],
    ["Unique events", r.uniqueEvents], ["Events with coordination", r.eventsWithCoordination],
    ["Events with scheduled maneuver", r.eventsWithScheduledManeuver],
    [r.observedExecutionLabel, r.eventsWithObservedExecution], ["Unresolved events", r.unresolvedEvents],
    ...r.missingFields.map(x => [x.field, x.note]),
    ...r.coverage.map(x => ["Source epochs (not continuous coverage)", x.source, x.fromUtc, x.toUtc]),
  ];
  return [...metadata.map(row => row.map(csvCell).join(",")), "", keys.map(csvCell).join(","),
    ...r.records.map(row => keys.map(k => csvCell(row[k])).join(","))].join("\r\n") + "\r\n";
}
const previewRef = makeFunctionReference<"query", { periodStart: string; periodEnd: string }, Report>("reports:preview");
export const exportCsv = action({
  args: periodArgs,
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const checked = await ctx.runQuery(previewRef, args);
    const id = await ctx.storage.store(new Blob([reportCsv(checked)], { type: "text/csv;charset=utf-8" }));
    const url = await ctx.storage.getUrl(id);
    if (!url) fail("UPSTREAM_UNAVAILABLE", "The report download could not be prepared.");
    return { url, filename: `orbitcall-draft-${checked.periodStart.slice(0, 10)}-${checked.periodEnd.slice(0, 10)}.csv` };
  },
});
