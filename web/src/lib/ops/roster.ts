import type { AgentId, HumanId, NodeId, ToolId } from "./types";

// Who does what, from docs/plan-v1.md §5 and §10: Claude reasons and calls tools,
// Grok Voice speaks for the Coordination Host, Grok text gives the second opinion.

export type Vendor = "anthropic" | "xai";

export interface ModelInfo {
  label: string;
  vendor: Vendor;
  /** USD per million tokens; null when not verified (cost shows as "—"). */
  inPerM: number | null;
  outPerM: number | null;
  cacheReadPerM: number | null;
}

// Anthropic prices: first-party API rates from the claude-api reference (cached 2026-10-06).
// xAI prices are not verified, so the UI never invents a number for them.
export const MODELS: Record<string, ModelInfo> = {
  "claude-haiku-5-5": { label: "Haiku 5.5", vendor: "anthropic", inPerM: 0.1, outPerM: 0.5, cacheReadPerM: null },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", vendor: "anthropic", inPerM: 2, outPerM: 10, cacheReadPerM: 0.2 },
  "claude-opus-5-5": { label: "Opus 5.5", vendor: "anthropic", inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 },
  // TODO(backend): confirm the xAI model ids and prices the team gets through the SpaceXAI track.
  "grok-voice": { label: "Grok Voice", vendor: "xai", inPerM: null, outPerM: null, cacheReadPerM: null },
  grok: { label: "Grok", vendor: "xai", inPerM: null, outPerM: null, cacheReadPerM: null },
};

export function costOf(model: string, tokensIn: number, tokensOut: number, cacheRead = 0): number | null {
  const m = MODELS[model];
  if (!m || m.inPerM === null || m.outPerM === null) return null;
  // Haiku's cache-read price isn't in the reference: bill those tokens at the input rate (an upper bound).
  const cr = m.cacheReadPerM ?? m.inPerM;
  return (tokensIn * m.inPerM + tokensOut * m.outPerM + cacheRead * cr) / 1e6;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  short: string;
  model: string;
  role: string;
  tools: ToolId[];
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  monitor: {
    id: "monitor",
    name: "Risk Monitor",
    short: "Monitor",
    model: "claude-haiku-5-5",
    role: "Screens every pair, ranks the queue, wakes the others on red",
    tools: ["sgp4", "celestrak", "socrates", "spacetrack", "convex"],
  },
  analyst: {
    id: "analyst",
    name: "Incident Analyst",
    short: "Analyst",
    model: "claude-sonnet-5-5",
    role: "Packs the pair into five lines and the raise / lower / wait options",
    tools: ["celestrak", "keeptrack", "sgp4", "convex"],
  },
  advocateA: {
    id: "advocateA",
    name: "Operator Advocate A",
    short: "Advocate A",
    model: "claude-sonnet-5-5",
    role: "Negotiates inside Operator A's written policy",
    tools: ["policy", "sgp4"],
  },
  advocateB: {
    id: "advocateB",
    name: "Operator Advocate B",
    short: "Advocate B",
    model: "claude-sonnet-5-5",
    role: "Negotiates inside Operator B's written policy",
    tools: ["policy", "sgp4"],
  },
  checker: {
    id: "checker",
    name: "Rationale Checker",
    short: "Checker",
    model: "grok",
    role: "Second vendor re-reads the rationale and flags disagreement",
    tools: [],
  },
  host: {
    id: "host",
    name: "Coordination Host",
    short: "Host",
    model: "grok-voice",
    role: "Opens the room, calls both owners, translates, logs",
    tools: ["room", "keeptrack", "convex"],
  },
  scheduler: {
    id: "scheduler",
    name: "Maneuver Scheduler",
    short: "Scheduler",
    model: "claude-sonnet-5-5",
    role: "After two approvals writes the burn and re-screens the catalog",
    tools: ["schedule", "sgp4", "convex"],
  },
  verifier: {
    id: "verifier",
    name: "Maneuver Verifier",
    short: "Verifier",
    model: "claude-sonnet-5-5",
    role: "Checks new orbit data against the agreed burn",
    tools: ["celestrak", "sgp4", "convex"],
  },
};

export const AGENT_ORDER: AgentId[] = ["monitor", "analyst", "advocateA", "advocateB", "checker", "host", "scheduler", "verifier"];

export interface ToolInfo {
  id: ToolId;
  name: string;
  detail: string;
  /** Deterministic code (no model). */
  local?: boolean;
}

// Endpoints the backend plans to call (docs/plan-v1.md §9). The hosts are real; exact
// query shapes for SOCRATES and KeepTrack are placeholders until the backend spec lands.
export const TOOLS: Record<ToolId, ToolInfo> = {
  sgp4: { id: "sgp4", name: "SGP4", detail: "Deterministic propagation and screening", local: true },
  celestrak: { id: "celestrak", name: "CelesTrak GP", detail: "celestrak.org/NORAD/elements/gp.php" },
  socrates: { id: "socrates", name: "SOCRATES", detail: "celestrak.org/SOCRATES" },
  spacetrack: { id: "spacetrack", name: "Space-Track", detail: "space-track.org · class/cdm_public" },
  keeptrack: { id: "keeptrack", name: "KeepTrack", detail: "KeepTrack API v4 · owners and contacts" },
  policy: { id: "policy", name: "Policy store", detail: "One policy per operator", local: true },
  convex: { id: "convex", name: "Convex", detail: "Shared state: events, rooms, log", local: true },
  room: { id: "room", name: "Room", detail: "Voice + text, live translation", local: true },
  schedule: { id: "schedule", name: "Schedule", detail: "Writes the maneuver file, nothing else", local: true },
};

export const HUMANS: Record<HumanId, { name: string; detail: string }> = {
  humanA: { name: "Operator A", detail: "Dispatcher, English" },
  humanB: { name: "Operator B", detail: "Dispatcher, Russian" },
};

export function nodeLabel(id: NodeId) {
  if (id in AGENTS) return AGENTS[id as AgentId].name;
  if (id in TOOLS) return TOOLS[id as ToolId].name;
  return HUMANS[id as HumanId].name;
}
