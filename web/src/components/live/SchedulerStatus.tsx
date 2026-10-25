"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { CheckCheck, Hourglass, Loader2, Radar, TriangleAlert } from "lucide-react";
import { diffForSelection, selectedCard } from "@/lib/backend/decision";
import { fmtObjectId, fmtStamp } from "@/lib/backend/format";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { ApprovalStatus, EventId, EventStatus, LogEntry, Maneuver, ProposalCard, Rescreen, RoomProjection } from "@/lib/backend/types";
import { fmtMiss } from "@/lib/ops/format";

// After consensus (wiring map §1.5): what the scheduler does with the agreed plan. It reads maneuvers.get, the event's
// lifecycle status from the room (approvals.status has none) and the shared log. Before consensus it renders nothing.

type Stage =
  | { kind: "waiting" }
  | { kind: "not_started"; failure: string | null }
  | { kind: "rescreening" }
  | { kind: "refused"; reason: string | null; found: Rescreen["newConjunctions"]; horizonH: number }
  | { kind: "committing" }
  | { kind: "committed"; sha: string | null; review: boolean; note: string | null }
  | { kind: "failed"; error: string | null }
  | { kind: "monitoring" };

/** Statuses an event reaches only once every required side approved. */
const AGREED: EventStatus[] = ["approved", "scheduled", "monitoring", "awaiting_verification_data", "verified", "flagged"];
/** The re-screen horizon is fixed on the backend (convex/maneuvers.ts HORIZON_H). */
const HORIZON_H = 72;
const EASE = [0.22, 1, 0.36, 1] as const;

const sentence = (s: string) => s.replace(/[.\s]+$/, "");

/** When the last required side approved, or null while not every side has. */
function agreedAt(status: ApprovalStatus): number | null {
  if (!status.allRequiredApproved) return null;
  const at = status.requiredApprovalSides.map((s) => Date.parse(status.approvals[s]?.at ?? ""));
  return at.length && at.every(Number.isFinite) ? Math.max(...at) : null;
}

/** The newest schedule_failed for the selection since consensus: a scheduler that never started leaves only this. */
function failureSince(log: LogEntry[] | undefined, status: ApprovalStatus, since: number | null): string | null {
  const sel = status.selected;
  if (!log || !sel || since === null) return null;
  const row = log.find(
    (l) => l.action === "schedule_failed" && l.proposalId === sel.proposalId && (l.revision === null || l.revision === sel.revision) && Date.parse(l.at) >= since,
  );
  return row?.summary ?? null;
}

/**
 * maneuvers.get re-derives `reviewRequired` from the current authorization, so a committed row reads true once
 * verification moves the event past `scheduled` (convex/maneuvers.ts:164,794-795). The schedule_committed record keeps
 * what the commit itself decided (:762-763); the row's flag is the fallback while that record is not loaded.
 */
function needsReview(m: Maneuver, log: LogEntry[] | undefined): boolean {
  const rec = log?.find((l) => l.action === "schedule_committed" && l.after?.maneuverId === m.maneuverId);
  return rec ? rec.after?.reviewRequired === "true" : m.reviewRequired;
}

/** A row past preview is the scheduler's own record of the selection. */
function rowStage(m: Maneuver, log: LogEntry[] | undefined): Stage {
  switch (m.status) {
    case "rescreening":
      return { kind: "rescreening" };
    case "refused":
      return { kind: "refused", reason: m.error ?? m.rescreen?.refusalReason ?? null, found: m.rescreen?.newConjunctions ?? [], horizonH: m.rescreen?.horizonH ?? HORIZON_H };
    case "committing":
      return { kind: "committing" };
    case "committed":
      return { kind: "committed", sha: m.commitSha, review: needsReview(m, log), note: m.error };
    default:
      return { kind: "failed", error: m.error };
  }
}

function stageOf(a: {
  eventId: EventId;
  status: ApprovalStatus;
  cards: ProposalCard[] | undefined;
  maneuver: Maneuver | null;
  room: RoomProjection | undefined;
  log: LogEntry[] | undefined;
}): Stage | null {
  const { status } = a;
  if (!status.selected) return null;
  // Counted approvals mean consensus in this generation; the room's status still says so once they stop counting.
  const linked = a.room?.linkedEvents.find((e) => e.eventId === a.eventId)?.status;
  const agreed = status.allRequiredApproved || (!!linked && AGREED.includes(linked));
  const since = agreedAt(status);
  let m = diffForSelection(a.maneuver, status);
  // A refusal or a failure resets approvals; once everyone has agreed again, that row is the previous round's.
  if (m && (m.status === "refused" || m.status === "failed") && since !== null && Date.parse(m.updatedAt) < since) m = null;
  if (m && m.status !== "preview") return rowStage(m, a.log);
  if (!agreed) return null;
  const card = selectedCard(status, a.cards);
  if (!card) return null;
  const failure = failureSince(a.log, status, since);
  if (card.latest.kind === "wait") return failure && linked !== "monitoring" ? { kind: "not_started", failure } : { kind: "monitoring" };
  // Only a shared burn's row lists several incidents; it waits for all of their approvals and logs nothing
  // (convex/maneuvers.ts:373,466-474). A single incident's preview row after consensus has simply not started yet.
  if (m && m.refs.length > 1 && !failure) return { kind: "waiting" };
  return { kind: "not_started", failure };
}

/** The scheduler's state for the open case's agreed plan (wiring map §1.5). Renders nothing before consensus. */
export function SchedulerStatus({ eventId }: { eventId: EventId }) {
  const real = useRealMode();
  const status = useLive((s) => s.approvals);
  const cards = useLive((s) => s.proposals);
  const maneuver = useLive((s) => s.maneuver);
  const room = useLive((s) => s.room);
  const log = useLive((s) => s.log);
  // while maneuvers.get loads, an agreed maneuver would read as "not started"
  const stage = real && status?.eventId === eventId && maneuver !== undefined ? stageOf({ eventId, status, cards, maneuver, room, log }) : null;
  const sel = status?.selected;

  return (
    <AnimatePresence initial={false}>
      {stage && sel && (
        <motion.div
          key="scheduler"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="overflow-hidden"
          data-testid="scheduler-status"
        >
          <div role="status" className="rounded-[12px] bg-white/[0.025] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={stage.kind} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                <StageView stage={stage} plan={`${sel.label} · R${sel.revision}`} />
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StageView({ stage, plan }: { stage: Stage; plan: string }) {
  switch (stage.kind) {
    case "waiting":
      return (
        <Line icon={<Hourglass size={11} />} tone="#9cc2ff" plan={plan}>
          Agreed. Waiting for the other linked incidents to approve the shared maneuver.
        </Line>
      );
    case "not_started":
      return (
        <Line
          icon={stage.failure ? <TriangleAlert size={11} /> : <Hourglass size={11} />}
          tone={stage.failure ? "var(--orange)" : "var(--muted)"}
          plan={plan}
          detail={stage.failure && <Coded text={stage.failure} />}
        >
          Agreed. Scheduling has not started.
        </Line>
      );
    case "rescreening":
      return (
        <Line icon={<Loader2 size={11} className="animate-spin" />} tone="var(--blue)" plan={plan}>
          <span className="shimmer">
            Re-screening against the catalog (<span className="tnum">{HORIZON_H} h</span>)
          </span>
        </Line>
      );
    case "refused":
      return (
        <Line icon={<TriangleAlert size={11} />} tone="var(--orange)" plan={plan} detail={stage.found.length > 0 && <Found list={stage.found} horizonH={stage.horizonH} />}>
          {stage.reason ? `Re-screen refused: ${sentence(stage.reason)}. Approvals were reset.` : "Re-screen refused. Approvals were reset."}
        </Line>
      );
    case "committing":
      return (
        <Line icon={<Loader2 size={11} className="animate-spin" />} tone="var(--blue)" plan={plan}>
          <span className="shimmer">Writing the schedule entry</span>
        </Line>
      );
    case "committed": {
      const sha = stage.sha && <span className="mono text-[11.5px]">{stage.sha.slice(0, 8)}</span>;
      if (stage.review) {
        return (
          <Line
            icon={<TriangleAlert size={11} />}
            tone="var(--orange)"
            plan={plan}
            detail={
              <>
                {sha && <>Commit {sha}. </>}
                {stage.note && `${sentence(stage.note)}. `}
                Not evidence of execution
              </>
            }
          >
            Scheduled artifact needs review
          </Line>
        );
      }
      return (
        <Line icon={<CheckCheck size={11} />} tone="var(--green)" plan={plan}>
          {sha ? <>Scheduled (commit {sha}).</> : "Scheduled."} <span className="text-neutral-500">Not evidence of execution</span>
        </Line>
      );
    }
    case "failed":
      return (
        <Line icon={<TriangleAlert size={11} />} tone="var(--red)" plan={plan}>
          {stage.error ? (
            <>
              Scheduling failed: <Coded text={stage.error} />
            </>
          ) : (
            "Scheduling failed"
          )}
        </Line>
      );
    case "monitoring":
      return (
        <Line icon={<Radar size={11} />} tone="var(--green)" plan={plan}>
          Agreed to wait; monitoring continues
        </Line>
      );
  }
}

/** One state: a tinted mark, the sentence, the plan it is about, and any detail under it. */
function Line({ icon, tone, plan, detail, children }: { icon: ReactNode; tone: string; plan: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full" style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-[18px] text-neutral-200 [overflow-wrap:anywhere]">{children}</div>
        {detail && <div className="mt-1 text-[12px] leading-[1.5] text-neutral-500 [overflow-wrap:anywhere]">{detail}</div>}
      </div>
      <span className="mono tnum shrink-0 text-[11px] leading-[18px] text-neutral-600">{plan}</span>
    </div>
  );
}

/** The conjunctions the moved orbit would create, as the re-screen found them. */
function Found({ list, horizonH }: { list: Rescreen["newConjunctions"]; horizonH: number }) {
  return (
    <div className="pt-0.5">
      <div>
        <span className="tnum">{list.length}</span> new {list.length === 1 ? "conjunction" : "conjunctions"} within <span className="tnum">{horizonH} h</span>
      </div>
      <ul className="mt-1 space-y-1">
        {list.map((c, i) => (
          <li key={`${i}-${c.objectId}`} className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-neutral-300">{c.name}</span>
            <span className="mono shrink-0 text-[11px] text-neutral-600">{fmtObjectId(c.objectId)}</span>
            <span className="mono tnum ml-auto shrink-0 text-[11px] text-neutral-500">{fmtStamp(c.tcaUtc)}</span>
            <span className="mono tnum shrink-0 text-[11px] text-orange">{fmtMiss(c.missKm * 1000)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "CODE: message" from the backend, the code set in mono like every other identifier. */
function Coded({ text }: { text: string }) {
  const m = /^([A-Z][A-Z0-9_]+)(: [\s\S]*)$/.exec(text);
  return m ? (
    <>
      <span className="mono text-[11px]">{m[1]}</span>
      {m[2]}
    </>
  ) : (
    <>{text}</>
  );
}
