"use client";

import { create } from "zustand";
import type { CatalogSnapshot, EventRow } from "@/lib/backend/types";
import type { AgentId, ConjunctionEvent, HumanPrompt, LogLine, Span } from "./types";

export type Tab = "orbit" | "conjunctions" | "rooms" | "policy" | "audit";
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
  humans: HumanPrompt[];
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
  humans: [],
  scanning: false,
  lastScan: null,
  validation: null,
  backendRows: undefined,
  backendSnapshot: undefined,
  backendError: null,
  backendEpoch: 0,
  set: (p) => set(p),
}));
