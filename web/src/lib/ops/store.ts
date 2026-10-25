"use client";

import { create } from "zustand";
import type { CatalogSnapshot, EventRow } from "@/lib/backend/types";
import type { AgentId, ConjunctionEvent, HumanPrompt, LogLine, Reply, Span } from "./types";

/** Orbit (globe, fleet, scan, agents), Decision Center (the case and its call), Policy, Inbox (audit + notices). */
export type Tab = "orbit" | "decision" | "policy" | "audit";
export type AgentView = "graph" | "trace" | "logs";

interface OpsState {
  /** Dev mode: synthetic scenarios over the live catalog. Off = backend data only. */
  dev: boolean;
  tab: Tab;
  events: ConjunctionEvent[];
  spans: Span[];
  logs: LogLine[];
  focusEvent: string | null;
  focusSpan: string | null;
  focusAgent: AgentId | null;
  agentView: AgentView;
  agentsExpanded: boolean;
  /** Playback of the simulator. */
  playing: boolean;
  speed: number;
  scenario: string | null;
  scenarioDone: boolean;
  /** Approve automatically after a short think so scenarios run hands-free. */
  autopilot: boolean;
  /** Camera follows the story while agents work. */
  cinematic: boolean;
  /** The side the person at this screen decides for; that side never autopilots. */
  actAs: "a" | "b" | null;
  replies: Reply[];
  /** Demo flow: Run scan, pick a case from the results, watch the run. */
  scan: { phase: "idle" | "scanning" | "results"; ids: string[]; stats: { objects: number; pairs: number; ms: number } | null };
  /** The case the dispatcher is working on (picked from scan results). */
  incident: string | null;
  /** The incident command view: full view, or collapsed to a bar so the globe is visible. */
  incidentView: "expanded" | "collapsed";
  /** An incident just closed: green edge glow and the resolution summary. */
  resolved: { eventId: string; at: number } | null;
  /** High-priority alert: red edge glow, banner and alarm. */
  alert: { eventId: string; at: number } | null;
  humans: HumanPrompt[];
  /** A plan named by voice in the case's call ("option B"); the plan panel asks for a click to confirm it. */
  voiceIntent: { eventId: string; label: string; said: string; at: number } | null;
  /** Risk Monitor screening pass in progress (drives the globe sweep). */
  scanning: boolean;
  lastScan: { at: number; objects: number; pairs: number; flagged: number; ms: number } | null;
  /** Our screening vs SOCRATES top 50 (SCR-3/SCR-8); spec §5 `events.validation()`. */
  validation: { matchedWithin500m: number; of: number; at: number } | null;
  /**
   * Backend data (dev off): `events.catalogPairs` rows in queue order. Kept apart from `events`,
   * which holds synthetic scenarios. `undefined` while loading or when not subscribed.
   */
  backendRows: EventRow[] | undefined;
  /** `catalog.snapshot`: undefined while loading, null before a first snapshot, "error" if the query failed. */
  backendSnapshot: CatalogSnapshot | null | undefined | "error";
  backendError: string | null;
  /** Bumped by Retry; remounts the subscriptions. */
  backendEpoch: number;
  set: (p: Partial<OpsState>) => void;
}

export const useOps = create<OpsState>((set) => ({
  dev: false,
  tab: "orbit",
  events: [],
  spans: [],
  logs: [],
  focusEvent: null,
  focusSpan: null,
  focusAgent: null,
  agentView: "graph",
  agentsExpanded: false,
  playing: true,
  speed: 1,
  scenario: null,
  scenarioDone: false,
  autopilot: true,
  cinematic: true,
  actAs: null,
  replies: [],
  scan: { phase: "idle", ids: [], stats: null },
  alert: null,
  resolved: null,
  incident: null,
  incidentView: "expanded",
  humans: [],
  voiceIntent: null,
  scanning: false,
  lastScan: null,
  validation: null,
  backendRows: undefined,
  backendSnapshot: undefined,
  backendError: null,
  backendEpoch: 0,
  set: (p) => set(p),
}));
