"use client";

import { create } from "zustand";
import type { AgentId, ConjunctionEvent, HumanPrompt, LogLine, Reply, Span } from "./types";

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
  /** Camera follows the story while agents work. */
  cinematic: boolean;
  /** The side the person at this screen decides for; that side never autopilots. */
  actAs: "a" | "b" | null;
  replies: Reply[];
  /** Demo flow: Run scan, pick a case from the results, watch the run. */
  scan: { phase: "idle" | "scanning" | "results"; ids: string[]; stats: { objects: number; pairs: number; ms: number } | null };
  /** An incident just closed: green edge glow and the resolution summary. */
  resolved: { eventId: string; at: number } | null;
  /** High-priority alert: red edge glow, banner and alarm. */
  alert: { eventId: string; at: number } | null;
  humans: HumanPrompt[];
  /** Risk Monitor screening pass in progress (drives the globe sweep). */
  scanning: boolean;
  lastScan: { at: number; objects: number; pairs: number; flagged: number; ms: number } | null;
  /** Our screening vs SOCRATES top 50 (SCR-3/SCR-8); spec §5 `events.validation()`. */
  validation: { matchedWithin500m: number; of: number; at: number } | null;
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
  humans: [],
  scanning: false,
  lastScan: null,
  validation: null,
  set: (p) => set(p),
}));
