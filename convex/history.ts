import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { exportFields, historyPoint, sameContent, toSeriesPoints, toTigerObservation } from "./lib/tigerExport";
import { sourceName } from "./lib/validators";
import { requireUser } from "./session";

// Observation history copied to Tiger Data and the versioned cache the chart reads (roadmap §10, spec §3.4).
// Tiger is an analytics copy: these functions write only observationExports and historySeries, and a failed
// export or read marks the chart stale without blocking or changing anything else. The Tiger calls themselves run
// in historyActions.ts, because `pg` needs the Node runtime and a "use node" file cannot hold mutations or queries.

export const MAX_EXPORT_ATTEMPTS = 3;
// A pending export not settled within this time is taken as lost (its action died) and may be queued again.
// One attempt is bounded by the Tiger client's connect and statement timeouts, far below this.
export const EXPORT_LEASE_MS = 5 * 60_000;
// Delay before the second and third attempt.
const RETRY_DELAYS_MS = [30_000, 120_000];
// Only these can succeed on a later attempt; configuration, access and rejected statements need a person.
const RETRYABLE = new Set(["UPSTREAM_UNAVAILABLE", "RATE_LIMITED"]);

// Stored as "CODE: message"; both parts come from safeTigerFailure, never from the driver.
const failureText = (code: string, message: string) => `${code}: ${message}`;
const retryPending = (row: Doc<"observationExports">) => row.exportState === "failed" && row.attempts < MAX_EXPORT_ATTEMPTS
  && RETRYABLE.has(row.lastError?.split(":")[0] ?? "");
// A new bounded round: retries ran out, the failure cannot be retried, or a pending export outlived its lease.
const canRequeue = (row: Doc<"observationExports">, now: number) =>
  (row.exportState === "failed" && !retryPending(row)) || (row.exportState === "pending" && now - row.updatedAt > EXPORT_LEASE_MS);

// Reset can close a run without deleting its history. New work and in-flight completions must both check it.
async function openEvent(ctx: QueryCtx, eventId: Id<"events">) {
  const event = await ctx.db.get(eventId);
  if (!event) return null;
  if (event.demoRunId) {
    const run = await ctx.db.get(event.demoRunId);
    if (!run || run.state !== "open" || run.closedAt !== null) return null;
  }
  return event;
}
const inScope = (row: Doc<"observationExports">, demoRunId: Id<"demoRuns"> | null) =>
  row.simulated ? row.demoRunId === demoRunId : row.demoRunId === null;
async function scopedExports(ctx: QueryCtx, eventId: Id<"events">, demoRunId: Id<"demoRuns"> | null) {
  return (await ctx.db.query("observationExports").withIndex("by_event", q => q.eq("eventId", eventId)).collect())
    .filter(row => inScope(row, demoRunId));
}
// The read token includes the cache state and immutable ledger rows. It changes when observations, export
// outcomes or cache failures change, including within the same millisecond. A delayed SQL result cannot clear
// newer missing data or failures; no extra schema writer is needed for this optimistic publication check.
const readVersion = (rows: Doc<"observationExports">[], cache: Doc<"historySeries"> | null) => JSON.stringify([
  cache === null ? null : [cache.seriesVersion, cache.fetchedAt, cache.stale, cache.error],
  rows.map(row => [row._id, row.exportState, row.attempts, row.updatedAt]),
]);
async function matchingScope(ctx: QueryCtx, eventId: Id<"events">, demoRunId: Id<"demoRuns"> | null, version: string) {
  const event = await openEvent(ctx, eventId);
  if (!event || (event.demoRunId ?? null) !== demoRunId) return null;
  const rows = await scopedExports(ctx, eventId, demoRunId);
  const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  return readVersion(rows, cache) === version ? rows : null;
}
async function activeExport(ctx: QueryCtx, exportId: Id<"observationExports">) {
  const row = await ctx.db.get(exportId);
  if (!row || row.exportState === "exported") return null;
  const event = await openEvent(ctx, row.eventId);
  return event && inScope(row, event.demoRunId ?? null) ? row : null;
}
const scopeArgs = { demoRunId: v.union(v.id("demoRuns"), v.null()), readVersion: v.string() };

/**
 * Queues one committed observation for export. The key is built from the event, demo run, source, metric, evidence
 * version and canonical time. Simulated evidence must carry the event's current demo run (null outside a run) and
 * real evidence no run, so old runs never reappear and one real observation has one key. The same observation
 * again is a no-op; different content under an existing key is rejected and never overwrites the stored row.
 * A failed export that will not be retried, or a pending one past its lease, is queued again for a new bounded round.
 */
export const recordObservation = internalMutation({
  args: {
    eventId: v.id("events"),
    observation: v.object({
      observedAt: v.string(), source: sourceName, metric: v.string(), value: v.union(v.number(), v.null()),
      evidenceVersion: v.string(), simulated: v.boolean(), runId: v.union(v.id("demoRuns"), v.null()),
    }),
  },
  returns: v.object({
    observationKey: v.string(), status: v.union(v.literal("queued"), v.literal("unchanged"), v.literal("retried")),
  }),
  handler: async (ctx, { eventId, observation }) => {
    const event = await ctx.db.get(eventId);
    if (!event) throw new ConvexError({ code: "NOT_FOUND", message: "Event not found." });
    if (!await openEvent(ctx, eventId)) throw new ConvexError({ code: "INVALID_STATE", message: "This incident belongs to a closed or missing demo run." });
    const fields = exportFields(eventId, observation);
    const expectedRun = observation.simulated ? event.demoRunId ?? null : null;
    if (observation.runId !== expectedRun) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: observation.simulated ? "Simulated evidence must carry the event's current demo run." : "Real evidence carries no demo run.",
      });
    }
    const { observationKey } = fields;
    const existing = await ctx.db.query("observationExports").withIndex("by_key", q => q.eq("observationKey", observationKey)).unique();
    if (existing) {
      if (!sameContent(existing, fields)) {
        throw new ConvexError({ code: "INVALID_STATE", message: "This observation is already recorded with different content. Record it under a new evidence version." });
      }
      const now = Date.now();
      if (!canRequeue(existing, now)) return { observationKey, status: "unchanged" as const };
      await ctx.db.patch(existing._id, { exportState: "pending", attempts: 0, updatedAt: now });
      await markStale(ctx, eventId, existing.lastError);
      await ctx.scheduler.runAfter(0, internal.historyActions.exportObservation, { exportId: existing._id });
      return { observationKey, status: "retried" as const };
    }
    const exportId = await ctx.db.insert("observationExports", {
      ...fields, exportState: "pending", attempts: 0, lastError: null, updatedAt: Date.now(),
    });
    await markStale(ctx, eventId, null);
    await ctx.scheduler.runAfter(0, internal.historyActions.exportObservation, { exportId });
    return { observationKey, status: "queued" as const };
  },
});

// Claim before opening a database connection. Concurrent or duplicate deliveries cannot spend extra attempts.
// Pending attempts > 0 hold the lease; recordObservation explicitly requeues one only after it expires.
export const claimExport = internalMutation({
  args: { exportId: v.id("observationExports") },
  handler: async (ctx, { exportId }) => {
    const row = await activeExport(ctx, exportId);
    if (!row || (row.exportState === "pending" && row.attempts > 0)
      || (row.exportState === "failed" && !retryPending(row))) return null;
    const patch = { exportState: "pending" as const, attempts: row.attempts + 1, updatedAt: Date.now() };
    await ctx.db.patch(exportId, patch);
    return { ...row, ...patch };
  },
});

const attemptArgs = { attempts: v.number(), claimedAt: v.number() };
const ownsAttempt = (row: Doc<"observationExports">, attempts: number, claimedAt: number) =>
  row.exportState === "pending" && row.attempts === attempts && row.updatedAt === claimedAt;

// Simulated points are read for the event's current demo run only, so an old run cannot look like fresh history.
// `baseVersion` is the cache version the read starts from; with the start time it orders reads (see isOlderRead).
export const seriesScope = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await openEvent(ctx, eventId);
    if (!event) return null;
    const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const demoRunId = event.demoRunId ?? null;
    return { demoRunId, baseVersion: cache?.seriesVersion ?? 0, readVersion: readVersion(await scopedExports(ctx, eventId, demoRunId), cache) };
  },
});

// A read is older than the cache when it started earlier, or in the same millisecond but before the cached version
// was published. Such a read can neither replace the points nor mark them stale.
const isOlderRead = (cache: Doc<"historySeries"> | null, fetchedAt: number, baseVersion: number) =>
  cache !== null && (cache.fetchedAt > fetchedAt || (cache.fetchedAt === fetchedAt && cache.seriesVersion > baseVersion));

export const markExported = internalMutation({
  args: { exportId: v.id("observationExports"), ...attemptArgs },
  returns: v.null(),
  handler: async (ctx, { exportId, attempts, claimedAt }) => {
    const row = await activeExport(ctx, exportId);
    if (!row || !ownsAttempt(row, attempts, claimedAt)) return null;
    await ctx.db.patch(exportId, { exportState: "exported", lastError: null, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.historyActions.refreshSeries, { eventId: row.eventId });
    return null;
  },
});

export const markFailed = internalMutation({
  args: { exportId: v.id("observationExports"), code: v.string(), message: v.string(), ...attemptArgs },
  returns: v.object({ retryScheduled: v.boolean() }),
  handler: async (ctx, { exportId, code, message, attempts, claimedAt }) => {
    const row = await activeExport(ctx, exportId);
    if (!row || !ownsAttempt(row, attempts, claimedAt)) return { retryScheduled: false };
    const lastError = failureText(code, message);
    await ctx.db.patch(exportId, { exportState: "failed", attempts, lastError, updatedAt: Date.now() });
    await markStale(ctx, row.eventId, lastError);
    const retryScheduled = RETRYABLE.has(code) && attempts < MAX_EXPORT_ATTEMPTS;
    if (retryScheduled) await ctx.scheduler.runAfter(RETRY_DELAYS_MS[attempts - 1], internal.historyActions.exportObservation, { exportId });
    return { retryScheduled };
  },
});

export const markSeriesFailed = internalMutation({
  args: { eventId: v.id("events"), code: v.string(), message: v.string(), fetchedAt: v.number(), baseVersion: v.number(), ...scopeArgs },
  returns: v.object({ marked: v.boolean() }),
  handler: async (ctx, { eventId, code, message, fetchedAt, baseVersion, demoRunId, readVersion }) => {
    if (!await matchingScope(ctx, eventId, demoRunId, readVersion)) return { marked: false };
    const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    if (isOlderRead(cache, fetchedAt, baseVersion)) return { marked: false };
    await markStale(ctx, eventId, failureText(code, message));
    return { marked: true };
  },
});

// Keeps the last good points. Before any successful read the row is a placeholder at version 0.
async function markStale(ctx: MutationCtx, eventId: Id<"events">, error: string | null) {
  const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
  if (cache) await ctx.db.patch(cache._id, { stale: true, error });
  else await ctx.db.insert("historySeries", { eventId, seriesVersion: 0, points: [], stale: true, error, fetchedAt: 0 });
}

/**
 * Publishes one Tiger read as the next cache version, unless it is older than the cached read (isOlderRead).
 * The cache stays stale while any current-scope export is failed or still pending, because Tiger may then lack
 * an observation that Convex holds; the chart never shows fresh while a point is missing.
 */
export const storeSeries = internalMutation({
  args: { eventId: v.id("events"), points: v.array(historyPoint), fetchedAt: v.number(), baseVersion: v.number(), ...scopeArgs },
  returns: v.object({ stored: v.boolean() }),
  handler: async (ctx, { eventId, points, fetchedAt, baseVersion, demoRunId, readVersion }) => {
    const rows = await matchingScope(ctx, eventId, demoRunId, readVersion);
    if (!rows) return { stored: false };
    const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    if (isOlderRead(cache, fetchedAt, baseVersion)) return { stored: false };
    const failed = rows.find(row => row.exportState === "failed");
    const pending = rows.find(row => row.exportState === "pending");
    const row = {
      seriesVersion: (cache?.seriesVersion ?? 0) + 1, points, stale: failed !== undefined || pending !== undefined,
      error: failed?.lastError ?? null, fetchedAt,
    };
    if (cache) await ctx.db.patch(cache._id, row);
    else await ctx.db.insert("historySeries", { eventId, ...row });
    return { stored: true };
  },
});

// Spec §1 read scope: an operator with an active assignment on either object of the event, or the head of ops of a
// company that owns one of them. No candidate set is needed, so the chart is available as soon as the event exists.
async function requireHistoryReader(ctx: QueryCtx, eventId: Id<"events">) {
  const { user } = await requireUser(ctx);
  const event = await ctx.db.get(eventId);
  const objects = event ? await Promise.all([ctx.db.get(event.objectAId), ctx.db.get(event.objectBId)]) : [];
  for (const object of objects) {
    if (!object) continue;
    if (user.role === "operator") {
      const assignment = await ctx.db.query("fleetAssignments")
        .withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
      if (assignment?.active) return event!;
    } else if (user.role === "head_of_ops") {
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
      if (owner?.companyId === user.companyId) return event!;
    }
  }
  throw new ConvexError({ code: "FORBIDDEN", message: "You are not assigned to this incident." });
}

const seriesPoint = v.object({ atUtc: v.string(), pc: v.union(v.number(), v.null()), missKm: v.union(v.number(), v.null()), source: sourceName });

/**
 * The cached Tiger history of one incident (read scope: requireHistoryReader).
 * Returns { real: Point[], simulated: Point[], stale, error, fetchedAt, seriesVersion } where
 * Point = { atUtc, pc: number | null, missKm: number | null, source: SourceName }, oldest first.
 * This intentionally differs from the flat array in spec §3.4: real and simulated evidence are separate series and
 * are never merged, and the chart needs the cache state. Simulated holds the event's current open demo run only;
 * closing or replacing the run hides old simulated cache values immediately. Archived real values remain visible.
 * - Observations only: no forecast or interpolation. A metric that was not observed is null.
 * - Points are per instant, source, evidence version and run, so two points may share atUtc and source when the
 *   evidence version differs. The cache schema has no evidenceVersion field, so the point cannot name it.
 * - stale: an observation is not yet (or failed to be) in Tiger, or the last read failed; the points are the last
 *   good copy and `error` is the sanitized failure, if any. fetchedAt and seriesVersion are null before the first
 *   successful read.
 */
export const series = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    real: v.array(seriesPoint), simulated: v.array(seriesPoint), stale: v.boolean(), error: v.union(v.string(), v.null()),
    fetchedAt: v.union(v.number(), v.null()), seriesVersion: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, { eventId }) => {
    const event = await requireHistoryReader(ctx, eventId);
    const cache = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const points = cache?.points ?? [];
    const live = await openEvent(ctx, eventId);
    // The frozen cache schema has no run ID. Until it is widened, the export ledger proves which cached
    // simulated values belong to the current run. This never manufactures chart data from queued observations.
    const rows = live ? await scopedExports(ctx, eventId, event.demoRunId ?? null) : [];
    const pointKey = (point: typeof points[number]) => JSON.stringify([point.atUtc, point.source, point.pc, point.missKm]);
    const allowed = new Set(toSeriesPoints(rows.filter(row => row.simulated && row.exportState === "exported")
      .map(toTigerObservation)).map(pointKey));
    const simulated = points.filter(point => point.simulated && allowed.has(pointKey(point)));
    const hidden = simulated.length !== points.filter(point => point.simulated).length;
    // Only Tiger rows that passed the client's source check reach the cache.
    const shape = ({ atUtc, pc, missKm, source }: typeof points[number]) => ({ atUtc, pc, missKm, source: source as Infer<typeof sourceName> });
    const fetched = cache !== null && cache.seriesVersion > 0;
    return {
      real: points.filter(point => !point.simulated).map(shape),
      simulated: simulated.map(shape),
      stale: !live || hidden || (cache?.stale ?? false) || rows.some(row => row.exportState !== "exported"), error: cache?.error ?? null,
      fetchedAt: fetched ? cache.fetchedAt : null, seriesVersion: fetched ? cache.seriesVersion : null,
    };
  },
});
