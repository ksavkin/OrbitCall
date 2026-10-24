import type { AgentId, EventStatus, SpanKind } from "@/lib/ops/types";

export const STATUS_META: Record<EventStatus, { label: string; color: string }> = {
  new: { label: "New", color: "var(--muted)" },
  agents: { label: "Agents working", color: "var(--blue)" },
  proposal: { label: "Proposal ready", color: "var(--amber)" },
  communication: { label: "In room", color: "#a594ff" },
  approved: { label: "Approved", color: "var(--green)" },
  scheduled: { label: "Scheduled", color: "var(--green)" },
  monitoring: { label: "Monitoring", color: "var(--fg-2)" },
  awaiting_verification: { label: "Awaiting data", color: "var(--orange)" },
  verified: { label: "Maneuver confirmed", color: "var(--green)" },
  flagged: { label: "Mismatch", color: "var(--red)" },
  needs_decision: { label: "Needs decision", color: "var(--orange)" },
  no_action: { label: "No action needed", color: "var(--muted)" },
};

export const RESOLVED: EventStatus[] = ["verified", "no_action", "monitoring"];

export const RISK_COLOR = { red: "var(--red)", yellow: "var(--amber)" } as const;

/** Edge colors from the agent-graph reference: call, answer, needs you, failed. */
export const EDGE = {
  call: "#4f8cff",
  answer: "#3ddc97",
  human: "#ff9f40",
  failed: "#ff5a4f",
} as const;

export const KIND_LABEL: Record<SpanKind, string> = {
  llm: "Model",
  tool: "Tool",
  http: "HTTP",
  handoff: "Handoff",
  human: "Human",
  check: "Check",
};

export const AGENT_HUE: Record<AgentId, string> = {
  monitor: "#5ad1e6",
  analyst: "#d97757",
  advocateA: "#9cc2ff",
  advocateB: "#ff9f40",
  checker: "#e6e8eb",
  host: "#a594ff",
  scheduler: "#3ddc97",
  verifier: "#b5e655",
};
