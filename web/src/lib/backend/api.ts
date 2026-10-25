import { anyApi, type FunctionReference } from "convex/server";
import type { AgentSummary, CatalogSnapshot, CompanyLang, CompanySettings, EventId, EventRow, PolicyMine, PolicySatellite } from "./types";

// References by name through anyApi: no import from the root convex/_generated package.
// Types are the ones declared in ./types.ts.
type Query<Args extends Record<string, unknown>, Result> = FunctionReference<"query", "public", Args, Result>;
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<"mutation", "public", Args, Result>;

/** Every active real catalog pair, already in queue order (spec §3.2); the UI filters. */
export const catalogPairsRef = anyApi.events.catalogPairs as unknown as Query<{ limit?: number }, EventRow[]>;

/** Latest catalog snapshot, or null before the first one. */
export const catalogSnapshotRef = anyApi.catalog.snapshot as unknown as Query<Record<string, never>, CatalogSnapshot | null>;

/** Incident Analyst summary and run state for one event. Public in Phase 1. */
export const agentSummaryRef = anyApi.agentSummaries.get as unknown as Query<{ eventId: EventId }, AgentSummary>;

/** The caller's company policy. Operators only; raw values never leave the company (POL-1, POL-2). */
export const policyMineRef = anyApi.policies.getMine as unknown as Query<Record<string, never>, PolicyMine>;
export const policyUpdateRef = anyApi.policies.update as unknown as Mutation<{ satellites: PolicySatellite[] }, null>;

/** Shareable company language and contact, stored apart from the policy. */
export const settingsMineRef = anyApi.session.getMySettings as unknown as Query<Record<string, never>, CompanySettings>;
export const settingsUpdateRef = anyApi.session.updateMySettings as unknown as Mutation<{ language?: CompanyLang; contact?: string }, null>;

/** Shared LiveKit room for the product recording (stable en/ru/zh tokens). */
export const smokeCallEnsureRef = anyApi.smokeCall.ensureRoom as unknown as Mutation<
  { who: "en" | "ru" | "zh" },
  { roomId: string; devToken: string; lang: "en" | "ru" | "zh" }
>;

export type SmokeInviteRemote = {
  eventId: string;
  pair: string;
  hostUserId: string;
  eventJson: string;
  openedAt: number;
};

/** Cross-laptop invite: host publishes, guests subscribe. */
export const smokeInvitePublishRef = anyApi.smokeCall.publishInvite as unknown as Mutation<
  { eventId: string; pair: string; hostUserId: string; eventJson: string },
  SmokeInviteRemote
>;
export const smokeInviteActiveRef = anyApi.smokeCall.activeInvite as unknown as Query<Record<string, never>, SmokeInviteRemote | null>;
