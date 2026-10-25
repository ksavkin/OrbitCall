"use client";

import { useQuery } from "convex/react";
import { Loader2, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useMe } from "@/components/auth/session";
import { Chip } from "@/components/ui/Chip";
import { logListRef, proposalsListRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { openCase, useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { EventId, LogEntry, ProposalId, VerificationResult } from "@/lib/backend/types";
import { fmtUtc } from "@/lib/format";
import { AGENTS } from "@/lib/ops/roster";
import { sfx } from "@/lib/sound";
import { Empty } from "./parts";

// Real mode (dev off): the shared record from log.list (wiring map §6.2). Selections, approvals and vetoes write no
// log rows yet (LOG-2), so none are listed.

function errorText(e: unknown): string {
  const b = backendError(e);
  return b.code === "UNKNOWN" && e instanceof Error ? briefError(e) : b.message;
}

/* ------------------------------------------------------------------- log */

const ACTION: Record<string, { label: string; color: string }> = {
  event_created: { label: "Opened", color: "var(--muted)" },
  status_changed: { label: "Status", color: "var(--muted)" },
  message: { label: "Message", color: "var(--muted)" },
  negotiation: { label: "Negotiation", color: "var(--blue)" },
  proposal_revised: { label: "Revision", color: "var(--amber)" },
  selected: { label: "Selected", color: "var(--blue)" },
  approved: { label: "Approved", color: "var(--green)" },
  vetoed: { label: "Vetoed", color: "var(--red)" },
  countered: { label: "Counter", color: "var(--orange)" },
  approvals_reset: { label: "Approvals reset", color: "var(--orange)" },
  rescreened: { label: "Re-screened", color: "var(--blue)" },
  refused: { label: "Refused", color: "var(--red)" },
  schedule_committed: { label: "Schedule committed", color: "var(--green)" },
  schedule_failed: { label: "Schedule failed", color: "var(--red)" },
  policy_changed: { label: "Policy changed", color: "var(--muted)" },
  no_action_needed: { label: "No action needed", color: "var(--green)" },
  agents_rerun: { label: "Agents re-run", color: "var(--blue)" },
  summary_posted: { label: "Summary", color: "var(--muted)" },
};

// A verification row carries its result: consistent is evidence, never "executed".
const VERIFIED: Record<VerificationResult, { label: string; color: string }> = {
  consistent: { label: "Consistent with plan", color: "var(--green)" },
  mismatch: { label: "Mismatch", color: "var(--red)" },
  awaiting_data: { label: "Awaiting data", color: "var(--muted)" },
};

const ROLE: Record<string, string> = {
  risk_monitor: AGENTS.monitor.name,
  incident_analyst: AGENTS.analyst.name,
  operator_advocate: "Operator Advocate",
  coordination_host: AGENTS.host.name,
  maneuver_scheduler: AGENTS.scheduler.name,
  maneuver_verifier: AGENTS.verifier.name,
  second_model: AGENTS.checker.name,
};

const humanize = (s: string) => s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function actionMeta(e: LogEntry) {
  const result = e.action === "verified" ? e.after?.result : undefined;
  if (typeof result === "string" && result in VERIFIED) return VERIFIED[result as VerificationResult];
  return ACTION[e.action] ?? { label: humanize(e.action), color: "var(--muted)" };
}

function actorName(a: LogEntry["actor"]) {
  if (a.kind === "system") return "System";
  const name = a.kind === "human" ? a.name : (ROLE[a.role] ?? humanize(a.role));
  return a.side ? `${name} · Side ${a.side}` : name;
}

/** log.list, newest first, 50 rows a page. An empty `eventId` lists every case of mine. */
export function LiveLog({ eventId }: { eventId: EventId }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <QueryBoundary
      key={`${eventId}:${attempt}`}
      fallback={(e) => (
        <Empty
          title="Couldn’t load the log"
          body={errorText(e)}
          action={
            <button
              className="btn btn-ghost-line mt-3 h-7 text-[11px]"
              onClick={() => {
                sfx.click();
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCw size={11} /> Retry
            </button>
          }
        />
      )}
    >
      <LogPages eventId={eventId} />
    </QueryBoundary>
  );
}

function LogPages({ eventId }: { eventId: EventId }) {
  // One subscription per page. Convex pins each page's end cursor while it is subscribed, so a new row only grows
  // the first page and older pages never skip or repeat a row.
  const [cursors, setCursors] = useState<string[]>([]);
  const lang = useMe()?.language ?? null;
  const pages = [null, ...cursors];
  return (
    <div>
      {pages.map((cursor, i) => (
        <LogPage
          key={cursor ?? "newest"}
          eventId={eventId}
          cursor={cursor}
          last={i === pages.length - 1}
          lang={lang}
          onMore={(next) => setCursors((c) => (c.includes(next) ? c : [...c, next]))}
        />
      ))}
    </div>
  );
}

function LogPage({
  eventId,
  cursor,
  last,
  lang,
  onMore,
}: {
  eventId: EventId;
  cursor: string | null;
  last: boolean;
  lang: string | null;
  onMore: (cursor: string) => void;
}) {
  const page = useQuery(logListRef, { ...(eventId ? { eventId } : {}), ...(cursor ? { cursor } : {}) });
  const first = cursor === null;

  if (page === undefined) return first ? <LoadingEntries /> : <OlderButton loading />;
  const next = last ? page.nextCursor : null;
  const older = next ? <OlderButton onClick={() => onMore(next)} /> : null;

  if (first && page.entries.length === 0) {
    // log.list pages through the whole log and keeps the rows shared with me, so a page can come back empty
    const more = page.nextCursor;
    if (more) {
      return last ? (
        <Empty
          title="Nothing recent for your cases"
          body="The newest log entries are not shared with your company. Older entries can include your cases."
          action={
            <button
              className="btn btn-ghost-line mt-3 h-7 text-[11px]"
              onClick={() => {
                sfx.click();
                onMore(more);
              }}
            >
              Older entries
            </button>
          }
        />
      ) : null;
    }
    return eventId ? (
      <Empty title="No entries for this case yet" body="Plan revisions, approval resets, schedule results and verification for this case are listed here as they happen." />
    ) : (
      <Empty title="Nothing shared yet" body="Plan revisions, approval resets, schedule results and verification for your cases are listed here as they happen. Policy numbers stay out of it." />
    );
  }
  return (
    <>
      {page.entries.length > 0 && (
        <ul className={`space-y-1.5 ${first ? "" : "mt-1.5"}`}>
          <AnimatePresence initial={false}>
            {page.entries.map((entry) => (
              <LogRow key={entry.logId} entry={entry} lang={lang} />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {older}
    </>
  );
}

function LogRow({ entry, lang }: { entry: LogEntry; lang: string | null }) {
  const meta = actionMeta(entry);
  const t = fmtUtc(Date.parse(entry.at));
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[12px] bg-white/[0.025] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
    >
      <div className="flex items-center gap-2">
        <span className="mono tnum text-[11px] text-neutral-500">
          {t.date} {t.time}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-300">{actorName(entry.actor)}</span>
        {entry.simulated && (
          <Chip color="var(--orange)" size="sm">
            Simulated
          </Chip>
        )}
        <Chip color={meta.color} size="sm">
          {meta.label}
        </Chip>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[1.45] text-white">{(lang && entry.texts?.[lang]) || entry.summary}</p>
      {entry.eventId && entry.proposalId && <PlanRef eventId={entry.eventId} proposalId={entry.proposalId} revision={entry.revision} />}
      {entry.eventId && <CaseLink eventId={entry.eventId} />}
    </motion.li>
  );
}

/** "P2 · revision 1". The label comes from the case's current plans; a plan no longer listed shows its revision only. */
function PlanRef({ eventId, proposalId, revision }: { eventId: EventId; proposalId: ProposalId; revision: number | null }) {
  return (
    <QueryBoundary fallback={() => <RefLine revision={revision} />}>
      <LabelledRef eventId={eventId} proposalId={proposalId} revision={revision} />
    </QueryBoundary>
  );
}

function LabelledRef({ eventId, proposalId, revision }: { eventId: EventId; proposalId: ProposalId; revision: number | null }) {
  const cards = useQuery(proposalsListRef, { eventId });
  return <RefLine label={cards?.find((c) => c.proposalId === proposalId)?.label} revision={revision} />;
}

function RefLine({ label, revision }: { label?: string; revision: number | null }) {
  const text = [label, revision !== null ? `revision ${revision}` : null].filter(Boolean).join(" · ");
  return text ? <p className="mono mt-1 text-[11px] text-neutral-500">{text}</p> : null;
}

function CaseLink({ eventId }: { eventId: EventId }) {
  const entry = useLive((s) => s.inbox?.find((e) => e.eventId === eventId));
  return (
    <button
      className="mt-1 max-w-full truncate text-left text-[11.5px] text-neutral-500 underline-offset-2 hover:text-white hover:underline"
      onClick={() => {
        sfx.click();
        openCase(eventId, entry?.room?.roomId);
      }}
    >
      {entry?.title ?? "Open the case"}
    </button>
  );
}

function OlderButton({ loading = false, onClick }: { loading?: boolean; onClick?: () => void }) {
  return (
    <button
      className="btn mt-2 h-8 w-full gap-1.5 text-[12px] disabled:pointer-events-none disabled:text-neutral-500"
      disabled={loading}
      onClick={() => {
        sfx.click();
        onClick?.();
      }}
    >
      {loading && <Loader2 size={12} className="animate-spin" />}
      {loading ? "Loading older entries" : "Older entries"}
    </button>
  );
}

function LoadingEntries() {
  return (
    <div className="space-y-1.5" role="status" aria-label="Loading the log">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-[12px] bg-white/[0.025] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
          style={{ animationDelay: `${i * 120}ms` }}
        >
          <div className="h-2 w-40 rounded bg-white/[0.07]" />
          <div className="mt-2.5 h-2.5 w-64 max-w-full rounded bg-white/[0.06]" />
          <div className="mt-2 h-2 w-28 rounded bg-white/[0.05]" />
        </div>
      ))}
    </div>
  );
}
