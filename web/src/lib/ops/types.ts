// Ops data contract shared by the dev simulator and the real backend.
// Names follow docs/functionality.md (§2 domain objects, §3 lifecycle) so the
// backend adapter only has to map fields, not concepts.

export type Risk = "red" | "yellow";

/** Event lifecycle, functionality.md §3, plus the inbox situations that keep it open. */
export type EventStatus =
  | "new"
  | "agents"
  | "proposal"
  | "communication"
  | "approved"
  | "scheduled"
  | "monitoring"
  | "awaiting_verification"
  | "verified"
  | "flagged"
  | "needs_decision"
  | "no_action";

export interface SpaceObjectRef {
  norad: number;
  name: string;
  /** SATCAT owner code (flag lookup), e.g. "US", "UK". */
  owner: string;
  /** Operator company as shown to people. */
  operator: string;
  kind: "payload" | "debris";
  /** Index into the live catalog when the object is real; null for synthetic objects. */
  catalogIndex: number | null;
  synthetic: boolean;
}

export interface PcPoint {
  t: number;
  pc: number;
}

export type Action = "raise" | "lower" | "wait";

/**
 * A person the event involves: the two deciding operators, plus operators whose
 * satellites the fix affects (DSP-3). Country is the dispatcher's, for the flag.
 */
export interface Party {
  id: HumanId;
  role: "a" | "b" | "affected";
  operator: string;
  /** SATCAT owner code of the operator's satellite. */
  owner: string;
  /** ISO 3166-1 alpha-2 of the dispatcher, lower case; null when unknown. */
  country: string | null;
  language: string | null;
}

export interface Proposal {
  version: number;
  mover: "a" | "b" | "none";
  action: Action;
  /** Burn time, ms epoch (null for wait). */
  burnAt: number | null;
  dvMs: number;
  fuelKg: number;
  missBeforeM: number;
  missAfterM: number;
  rationale: string;
  /** Message or rule that caused this revision. */
  reason?: string;
}

export type Approval = "pending" | "approved" | "vetoed" | "countered";

export interface ConjunctionEvent {
  id: string;
  a: SpaceObjectRef;
  b: SpaceObjectRef;
  /** Time of closest approach, ms epoch. */
  tca: number;
  missM: number;
  /** Miss distance difference between GP and SupGP solutions (uncertainty), m. */
  uncertaintyM: number;
  radialM: number;
  pc: number;
  pcSource: "SOCRATES" | "CDM" | "SOCRATES + CDM";
  relVelKms: number;
  risk: Risk;
  trend: "rising" | "falling" | "flat";
  pcHistory: PcPoint[];
  status: EventStatus;
  /** Agents are running on this event right now (Q-6). */
  agentsWorking: boolean;
  /** Where the encounter happens, for the globe and the summary. */
  where: { lat: number; lon: number; altKm: number };
  proposal: Proposal | null;
  approvals: { a: Approval; b: Approval };
  /** Five-line Incident Analyst summary (AGT-2). */
  summary: string[] | null;
  /** Everyone involved; length 2+ (A, B, then affected operators). Optional until the backend sends it. */
  parties?: Party[];
  createdAt: number;
  scenario?: string;
}

/* ------------------------------------------------------------------ agents */

export type AgentId = "monitor" | "analyst" | "advocateA" | "advocateB" | "host" | "checker" | "scheduler" | "verifier";

export type ToolId =
  | "sgp4"
  | "celestrak"
  | "socrates"
  | "spacetrack"
  | "keeptrack"
  | "policy"
  | "convex"
  | "room"
  | "schedule";

export type HumanId = "humanA" | "humanB" | "humanC" | "humanD";

export type NodeId = AgentId | ToolId | HumanId;

export type SpanKind = "llm" | "tool" | "http" | "handoff" | "human" | "check";

export type SpanStatus = "running" | "ok" | "error" | "waiting";

export interface Span {
  id: string;
  parent: string | null;
  eventId: string | null;
  agent: AgentId;
  /** What the span talks to: a tool, another agent or a person. */
  target: NodeId;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  /** Wall-clock start, ms epoch. */
  t0: number;
  /** Duration in ms once finished (virtual: what the step took at 1×). */
  ms?: number;
  /** Wall-clock end, ms epoch (for animations at any playback speed). */
  t1?: number;
  /** 0..1 while running (drives the streamed reasoning). */
  progress: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  /** Null when the model price is not known (shown as "—"). */
  costUsd?: number | null;
  reasoning?: string;
  input?: unknown;
  output?: unknown;
  http?: { method: string; url: string; status?: number; bytes?: number };
  error?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  id: string;
  t: number;
  level: LogLevel;
  source: AgentId | "system" | HumanId;
  msg: string;
  spanId?: string;
  eventId?: string;
}

export interface HumanPrompt {
  eventId: string;
  side: "a" | "b";
  proposalVersion: number;
}
