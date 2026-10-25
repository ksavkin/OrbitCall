"use client";

import { AnimatePresence, motion } from "motion/react";
import { FileDiff, Hourglass, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { diffForSelection, diffState, selectGate, selectionDiff, type DiffState } from "@/lib/backend/decision";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { ApprovalStatus, EventId, LogEntry, RoomProjection } from "@/lib/backend/types";

// The schedule diff under the selected maneuver card (wiring map §1.4). A selection asks the Factory worker to prepare
// the diff in the background; until it lands this shows that it is coming, slow or failed. After consensus the diff
// stays, read only: the scheduler's own states belong to SchedulerStatus.

export function ScheduleDiff({
  eventId,
  className = "pb-3.5 pl-21 pr-4",
}: {
  eventId: EventId;
  /** Spacing around the block. The default lines it up with a plan card's title (pl-12, the w-6 label, gap-3). */
  className?: string;
}) {
  const real = useRealMode();
  const flags = useLive((s) => s.flags);
  const status = useLive((s) => s.approvals);
  const cards = useLive((s) => s.proposals);
  const maneuver = useLive((s) => s.maneuver);
  const log = useLive((s) => s.log);
  const room = useLive((s) => s.room);

  const sel = real && status?.eventId === eventId ? status.selected : null;
  const selKey = sel ? `${sel.proposalId}:${sel.revision}` : null;
  const agreed = !!status?.allRequiredApproved;
  const failures = attemptFailures(log, status);
  const inputs = { flags, status, cards, maneuver, log: failures };
  // without a clock diffState never says "slow", so this asks only whether the selection still waits for its diff
  const waiting = !!sel && !agreed && diffState({ ...inputs, now: 0, waitingSince: null }) === "preparing";
  const clock = useWaitClock(selKey, waiting);
  const state: DiffState = sel ? diffState({ ...inputs, now: clock.now, waitingSince: clock.since }) : "not_needed";

  let body: ReactNode = null;
  if (status && state === "ready") {
    const diff = selectionDiff(status, cards, maneuver);
    if (diff) body = <DiffView diff={diff} filePath={diffForSelection(maneuver, status)?.filePath ?? pathOf(diff)} />;
  } else if (status && !agreed) {
    // after consensus only the agreed diff stays; waiting and failures there are the scheduler's to report
    if (state === "preparing") body = <Line icon={<Loader2 size={11} className="animate-spin text-blue" />}>Preparing the schedule diff…</Line>;
    else if (state === "stale") body = <Line icon={<RotateCcw size={11} className="text-orange" />}>Inputs changed; the diff will be prepared again</Line>;
    else if (state === "slow")
      body = (
        <Note tone="var(--orange)" icon={<Hourglass size={11} />} title="The schedule diff is taking longer than expected">
          {retryAdvice(status, room, eventId)}
        </Note>
      );
    else if (state === "failed") body = <Failed row={failures?.[0]} advice={retryAdvice(status, room, eventId)} />;
  }

  return (
    <AnimatePresence>
      {body && (
        <motion.div
          key={`${selKey}:${state}`}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className={className}>{body}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * When this screen first saw the selection waiting for its diff, and a clock that ticks only while it waits.
 * A new selection (proposal + revision) starts over; going from ready back to waiting on the same one does not.
 */
function useWaitClock(selKey: string | null, waiting: boolean) {
  const [clock, setClock] = useState<{ selKey: string | null; since: number | null; now: number }>({ selKey, since: null, now: 0 });
  if (clock.selKey !== selKey) setClock({ selKey, since: null, now: 0 });
  useEffect(() => {
    if (!waiting) return;
    const tick = () => {
      const now = Date.now();
      setClock((c) => ({ ...c, since: c.since ?? now, now }));
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [waiting, selKey]);
  return clock;
}

/**
 * The schedule_failed rows of the current selection's attempt, newest first. A retry (another plan, then this one) is a
 * new generation of the same revision, so an older failure must not show while the retry prepares. A per-incident row
 * names its generation in `after.intentKey`; a shared plan's key names the plan version instead, which the UI cannot
 * see, so those rows count until a diff arrives.
 */
function attemptFailures(log: LogEntry[] | undefined, status: ApprovalStatus | undefined): LogEntry[] | undefined {
  const sel = status?.selected;
  if (!log || !sel) return log;
  return log.filter((l) => {
    if (l.action !== "schedule_failed" || l.proposalId !== sel.proposalId || (l.revision !== null && l.revision !== sel.revision)) return false;
    const key = l.after?.intentKey;
    const gen = typeof key === "string" ? /:generation:(\d+)$/.exec(key)?.[1] : undefined;
    return gen === undefined || Number(gen) === sel.generation;
  });
}

/** Selecting the current card again is a no-op on the server, so a retry goes through another plan first. */
function retryAdvice(status: ApprovalStatus, room: RoomProjection | undefined, eventId: EventId): string {
  if (selectGate(status, room, eventId).ok) return "To retry, select another plan first, then this one again.";
  return `${status.turn ? `Side ${status.turn}` : "The deciding side"} can retry by selecting another plan first, then this one again.`;
}

/** `+++ b/<path>` of a unified diff, for a diff that came from the revision without its maneuver row. */
function pathOf(diff: string): string | null {
  return /^\+\+\+ b\/(.+)$/m.exec(diff)?.[1] ?? null;
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted">
      <span className="grid w-[11px] shrink-0 place-items-center">{icon}</span>
      {children}
    </div>
  );
}

/** A tinted note in the BackendQueue idiom: one color for the title, the fill and the rim. */
function Note({ tone, icon, title, children }: { tone: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div
      className="rounded-[10px] px-3 py-2 text-[11.5px] leading-[1.45] text-fg-2"
      style={{
        background: `color-mix(in srgb, ${tone} 7%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 20%, transparent)`,
      }}
    >
      <div className="mb-0.5 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: tone }}>
        <span className="shrink-0">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

/** The backend writes `CODE: message`; the code reads as an identifier, the message as text. */
function Failed({ row, advice }: { row: LogEntry | undefined; advice: string }) {
  const m = row && /^([A-Z][A-Z0-9_]*): ([\s\S]+)$/.exec(row.summary);
  return (
    <Note tone="var(--red)" icon={<TriangleAlert size={11} />} title="The schedule diff could not be prepared">
      {m ? (
        <span className="block">
          <span className="mono mr-1.5 text-[10.5px] text-red">{m[1]}</span>
          {m[2]}
        </span>
      ) : (
        row && <span className="block">{row.summary}</span>
      )}
      <span className="mt-0.5 block text-muted">{advice}</span>
    </Note>
  );
}

/** The unified diff of the operator's schedule file: header lines muted, additions green, removals red. */
function DiffView({ diff, filePath }: { diff: string; filePath: string | null }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  const head = (l: string) => l.startsWith("---") || l.startsWith("+++") || l.startsWith("@@");
  const added = lines.filter((l) => l.startsWith("+") && !head(l)).length;
  const removed = lines.filter((l) => l.startsWith("-") && !head(l)).length;
  return (
    <div className="overflow-hidden rounded-[10px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <div className="flex items-center gap-2 border-b border-white/[0.05] px-2.5 py-1.5">
        <FileDiff size={11} className="shrink-0 text-muted" />
        <span className="shrink-0 text-[11px] font-medium text-fg-2">Schedule diff</span>
        <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-muted" title={filePath ?? undefined}>
          {filePath}
        </span>
        <span className="mono tnum shrink-0 text-[10.5px]">
          <span className="text-green">+{added}</span> <span className="text-red">-{removed}</span>
        </span>
      </div>
      <div className="thin-scroll mono max-h-[152px] overflow-y-auto overscroll-contain py-1.5 text-[10.5px] leading-[1.6]">
        {lines.map((l, i) => {
          const tone = head(l) ? "text-muted" : l.startsWith("+") ? "bg-green/[0.08] text-green" : l.startsWith("-") ? "bg-red/[0.08] text-red" : "text-fg-2";
          return (
            <div key={i} className={`flex px-2.5 ${tone}`}>
              {/* the marker keeps its own column, so a wrapped JSON line hangs under its text, not under the + */}
              <span className="w-[1ch] shrink-0">{l.slice(0, 1)}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{l.slice(1)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
