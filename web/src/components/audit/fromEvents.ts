import { fmtMiss, fmtWhen } from "@/lib/ops/format";
import type { ConjunctionEvent, Proposal, Reply } from "@/lib/ops/types";

// Shared audit rows derived from the cases already on screen. Agent traces are not copied in:
// those can mention a private policy read, and the shared log never carries policy values (LOG-1).

export type AuditAction =
  | "opened"
  | "proposal"
  | "selected"
  | "approved"
  | "vetoed"
  | "countered"
  | "reset"
  | "verified"
  | "mismatch";

export interface AuditEntry {
  id: string;
  at: number;
  eventId: string;
  eventLabel: string;
  actor: string;
  action: AuditAction;
  summary: string;
  before: string | null;
  after: string | null;
  simulated: boolean;
}

export const AUDIT_ACTION: Record<AuditAction, { label: string; color: string }> = {
  opened: { label: "Opened", color: "var(--muted)" },
  proposal: { label: "Proposal", color: "var(--amber)" },
  selected: { label: "Selected", color: "var(--blue)" },
  approved: { label: "Approved", color: "var(--green)" },
  vetoed: { label: "Vetoed", color: "var(--red)" },
  countered: { label: "Counter", color: "var(--orange)" },
  reset: { label: "Approvals reset", color: "var(--orange)" },
  verified: { label: "Verified", color: "var(--green)" },
  mismatch: { label: "Mismatch", color: "var(--red)" },
};

function sideName(e: ConjunctionEvent, side: "a" | "b") {
  const party = e.parties?.find((p) => p.role === side);
  const raw = party?.operator ?? (side === "a" ? e.a.operator : e.b.operator);
  return raw.replace(/\s*\(synthetic\)/i, "");
}

function labelOf(e: ConjunctionEvent) {
  return `${e.a.name} × ${e.b.name}`;
}

function simulated(e: ConjunctionEvent) {
  return e.a.synthetic || e.b.synthetic || !!e.scenario;
}

function planText(e: ConjunctionEvent, p: Proposal) {
  if (p.action === "wait") {
    return {
      summary: p.rationale || "Wait. No burn.",
      before: `miss ${fmtMiss(p.missBeforeM)}`,
      after: `miss ${fmtMiss(p.missAfterM)}`,
    };
  }
  const who = p.mover === "none" ? "Neither side" : sideName(e, p.mover);
  const verb = p.action === "raise" ? "raises" : "lowers";
  const when = p.burnAt ? ` at ${fmtWhen(p.burnAt)}` : "";
  return {
    summary: `${who} ${verb} ${p.dvMs} m/s${when}.`,
    before: `miss ${fmtMiss(p.missBeforeM)}`,
    after: `miss ${fmtMiss(p.missAfterM)}`,
  };
}

function replyAction(r: Reply): AuditAction {
  if (r.decision === "approved") return "approved";
  if (r.decision === "vetoed") return "vetoed";
  return "countered";
}

function replySummary(r: Reply) {
  const plan = r.label ? ` ${r.label}` : r.version ? ` v${r.version}` : "";
  if (r.via === "select") return `Selected${plan}${r.note ? `. ${r.note}` : ""}`;
  if (r.decision === "approved") return `Approved${plan}${r.note ? `. ${r.note}` : ""}`;
  if (r.decision === "vetoed") return r.note ? `Rejected${plan}. ${r.note}` : `Rejected${plan}.`;
  return r.note ? `Counter${plan}. ${r.note}` : `Sent a counter${plan}.`;
}

export function auditEntries(events: ConjunctionEvent[], replies: Reply[]): AuditEntry[] {
  const rows: AuditEntry[] = [];
  for (const e of events) {
    const eventLabel = labelOf(e);
    const sim = simulated(e);
    rows.push({
      id: `${e.id}:opened`,
      at: e.createdAt,
      eventId: e.id,
      eventLabel,
      actor: "System",
      action: "opened",
      summary: `Case opened. Miss ${fmtMiss(e.missM)}.`,
      before: null,
      after: e.risk === "red" ? "Red" : "Yellow",
      simulated: sim,
    });

    const plans = e.proposals?.length ? e.proposals : e.proposal ? [e.proposal] : [];
    for (const p of plans) {
      if (p.publishedAt == null) continue;
      const text = planText(e, p);
      const actor = p.by === "a" ? sideName(e, "a") : p.by === "b" ? sideName(e, "b") : "Agents";
      rows.push({
        id: `${e.id}:proposal:${p.version}:${p.publishedAt}`,
        at: p.publishedAt,
        eventId: e.id,
        eventLabel,
        actor,
        action: "proposal",
        summary: `${p.label ? `${p.label} · ` : ""}v${p.version}. ${text.summary}`,
        before: text.before,
        after: text.after,
        simulated: sim,
      });
    }

    if (e.selection) {
      const option = e.options?.find((o) => o.id === e.selection?.optionId);
      rows.push({
        id: `${e.id}:selected:${e.selection.generation}`,
        at: e.selection.at,
        eventId: e.id,
        eventLabel,
        actor: e.selection.by === "agents" ? "Agents" : sideName(e, e.selection.by),
        action: "selected",
        // people read plan labels (P1-P4), never internal option ids
        summary: option ? `Selected P${(e.options ?? []).indexOf(option) + 1} for review. Generation ${e.selection.generation}.` : `Selected a plan. Generation ${e.selection.generation}.`,
        before: null,
        after: "Approvals pending",
        simulated: sim,
      });
    }

    for (const r of replies) {
      if (r.eventId !== e.id || r.via === "select") continue;
      rows.push({
        id: `${e.id}:reply:${r.side}:${r.t}`,
        at: r.t,
        eventId: e.id,
        eventLabel,
        actor: sideName(e, r.side),
        action: replyAction(r),
        summary: replySummary(r),
        before: null,
        after: r.decision === "approved" ? "Approved" : r.decision === "vetoed" ? "Vetoed" : "Counter",
        simulated: sim,
      });
    }

    if (e.lastReset) {
      rows.push({
        id: `${e.id}:reset:${e.lastReset.at}`,
        at: e.lastReset.at,
        eventId: e.id,
        eventLabel,
        actor: "System",
        action: "reset",
        summary: e.lastReset.reason,
        before: "Approved",
        after: "Pending",
        simulated: sim,
      });
    }

    if (e.outcome?.resolvedAt != null) {
      const failed = e.outcome.checks.some((c) => !c.ok);
      rows.push({
        id: `${e.id}:outcome:${e.outcome.resolvedAt}`,
        at: e.outcome.resolvedAt,
        eventId: e.id,
        eventLabel,
        actor: "Verifier",
        action: failed ? "mismatch" : "verified",
        summary: e.outcome.checks.map((c) => c.label).join(" · ") || (failed ? "Observed evidence does not match the plan." : "Observed evidence is consistent with the plan."),
        before: "Promised plan",
        after: failed ? "Mismatch" : "Consistent",
        simulated: sim,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Inclusive UTC calendar period. Null when the dates are not a real range. */
export function periodBounds(start: string, end: string): { from: number; to: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T23:59:59.999Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  return { from, to };
}

export function defaultPeriod(now = Date.now()) {
  const end = new Date(now);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 6, end.getUTCDate()));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
