import type { AgentId, LogLine, Span } from "@/lib/ops/types";
import type { AgentLog, InboxEntry, PublicSpan, Side } from "./types";

// spans.list and agentLogs.list in the simulator's Span / LogLine shape, so the agent graph, trace and log views
// render recorded backend runs (wiring map §4). The backend exposes metadata only: no prompt, reasoning, HTTP or cost.

/**
 * The graph node for an agent name this build does not know, and for an Operator Advocate whose side is not known.
 * Such a span keeps its node and edge here instead of being dropped. "other" is not an AgentId yet, so it rides in
 * the `agent` / `target` slot: anything that indexes AGENTS (or AGENT_HUE, TOOLS) by a span's agent or target must
 * check `isOther` first.
 */
export const OTHER = "other";
export type GraphAgent = AgentId | typeof OTHER;
export const isOther = (id: string): id is typeof OTHER => id === OTHER;

/** A backend span in simulator shape. `output` is the backend's own object (runStatus, stage, stalled, ...). */
export interface LiveSpan extends Span {
  output: PublicSpan["output"];
  provider?: PublicSpan["provider"];
  /** The name the backend gave, e.g. "advocate:<companyId>". */
  backendAgent: string;
}

export interface LiveLogLine extends LogLine {
  backendSource: string;
}

export const isLiveSpan = (s: Span): s is LiveSpan => "backendAgent" in s;
export const isLiveLog = (l: LogLine): l is LiveLogLine => "backendSource" in l;

/** companyId → side. Advocate spans name their company, not their side; the case's inbox entry has both. */
export type CompanySides = ReadonlyMap<string, Side>;

export function companySides(entry: InboxEntry | null | undefined): CompanySides {
  return new Map(entry?.sides.flatMap((s) => (s.owner ? [[s.owner.companyId, s.side] as const] : [])) ?? []);
}

export function sameSides(a: CompanySides | undefined, b: CompanySides): boolean {
  return !!a && a.size === b.size && [...b].every(([company, side]) => a.get(company) === side);
}

// convex/spans.ts emits "analyst", "advocate:<companyId>", "host" and "checker". Role names and our own ids are
// accepted too, so a renamed agent still lands on its node.
const NAMES = new Map<string, AgentId>([
  ["analyst", "analyst"],
  ["incident_analyst", "analyst"],
  ["host", "host"],
  ["coordination_host", "host"],
  ["checker", "checker"],
  ["second_model", "checker"],
  ["rationale_check", "checker"],
  ["monitor", "monitor"],
  ["risk_monitor", "monitor"],
  ["advocateA", "advocateA"],
  ["advocateB", "advocateB"],
  ["scheduler", "scheduler"],
  ["verifier", "verifier"],
]);

export function agentOf(name: string, sides: CompanySides): GraphAgent {
  const known = NAMES.get(name);
  if (known) return known;
  const company = name.startsWith("advocate:") ? name.slice("advocate:".length) : null;
  const side = company ? sides.get(company) : undefined;
  return side === "A" ? "advocateA" : side === "B" ? "advocateB" : OTHER;
}

/** Who a backend name is, for a tooltip: "Operator Advocate (side not known)" rather than a company id. */
export function backendName(name: string): string {
  return name.startsWith("advocate:") ? "Operator Advocate (side not known)" : name;
}

// Until AgentId has "other" (shared change), the generic node is written into the AgentId slot.
const slot = (id: GraphAgent) => id as string as AgentId;

/**
 * Oldest first, like the simulator's list. Every backend span names itself as its target, so most stay on their
 * own node; a checker span's parent is the run it checked, and that run's agent becomes its target (the edge).
 */
export function toSpans(rows: PublicSpan[], sides: CompanySides): LiveSpan[] {
  const agents = new Map(rows.map((p) => [p.id, agentOf(p.agent, sides)]));
  return rows
    .map((p): LiveSpan => {
      const agent = agents.get(p.id)!;
      const target = (p.parent && agents.get(p.parent)) || (p.target === p.agent ? agent : agentOf(p.target, sides));
      return {
        id: p.id,
        parent: p.parent,
        eventId: p.eventId,
        agent: slot(agent),
        target: slot(target),
        kind: p.kind,
        name: p.name,
        status: p.status,
        t0: p.t0,
        t1: p.t1,
        ms: p.ms,
        // no streamed progress: a running span has none yet, a finished one is whole
        progress: p.status === "running" ? 0 : 1,
        model: p.model,
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
        costUsd: null,
        output: p.output,
        provider: p.provider,
        error: p.error,
        backendAgent: p.agent,
      };
    })
    .sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
}

/** Oldest first. `source` maps like a span's agent. */
export function toLogLines(rows: AgentLog[], sides: CompanySides): LiveLogLine[] {
  return rows
    .map((l) => ({
      id: l.id,
      t: l.t,
      level: l.level,
      source: slot(agentOf(l.source, sides)),
      msg: l.msg,
      spanId: l.spanId,
      eventId: l.eventId,
      backendSource: l.source,
    }))
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

/** Short words for `output.stage`; an unknown stage is shown as written, without underscores. */
export function stageLabel(stage: string): string {
  switch (stage) {
    case "loading":
      return "Loading";
    case "calling_model":
      return "Model call";
    case "checking":
      return "Checking";
    case "candidate_rationale":
      return "Rationale";
    case "rationale_check":
      return "Check";
    default:
      return stage.replace(/_/g, " ");
  }
}

export type Vendor = "anthropic" | "google" | "xai";

/** The recorded provider, or the one a recorded model id names (Analyst and Advocate runs carry no provider). */
export function vendorOf(s: LiveSpan): Vendor | null {
  if (s.provider) return s.provider;
  const m = s.model?.toLowerCase() ?? "";
  return m.startsWith("claude") ? "anthropic" : m.startsWith("gemini") ? "google" : m.startsWith("grok") ? "xai" : null;
}

export const VENDOR_LABEL: Record<Vendor, string> = { anthropic: "Claude", google: "Gemini", xai: "Grok" };
