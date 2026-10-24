import { anyApi, type FunctionReference } from "convex/server";
import type { AgentSummary, CatalogSnapshot, EventId, EventRow } from "./types";

// References by name through anyApi: no import from the root convex/_generated package.
// Types are the ones declared in ./types.ts.
type Query<Args extends Record<string, unknown>, Result> = FunctionReference<"query", "public", Args, Result>;

/** Real catalog pairs, already in queue order (spec §3.2). */
export const catalogPairsRef = anyApi.events.catalogPairs as unknown as Query<{ limit?: number }, EventRow[]>;

/** Latest catalog snapshot, or null before the first one. */
export const catalogSnapshotRef = anyApi.catalog.snapshot as unknown as Query<Record<string, never>, CatalogSnapshot | null>;

/** Incident Analyst summary and run state for one event. Public in Phase 1. */
export const agentSummaryRef = anyApi.agentSummaries.get as unknown as Query<{ eventId: EventId }, AgentSummary>;

/** How many pairs the queue asks for (the backend default is 50). */
export const QUEUE_LIMIT = 50;
