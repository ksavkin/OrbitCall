"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { motion } from "motion/react";
import { Check, Clock, LogIn, MonitorUp, RotateCcw, ShieldX, X } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { observerRunRef, observerViewRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { fmtObjectId } from "@/lib/backend/format";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { DemoRunId, EventId, EventStatus, ManeuverStatus, ObserverCard, ObserverView, VerificationResult } from "@/lib/backend/types";
import { fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import type { EventStatus as SimStatus } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { STATUS_META } from "@/components/ops/meta";
import { Chip } from "@/components/ui/Chip";
import { Big, Note, RoomRecord, SimTag, Stepper, TopBar } from "./parts";

// Real mode of the large display (wiring map §8): the signed-in demo_observer's run from observer.myRun, then its
// public projection from observer.publicView. myRun is live, so a reset and a new grant move the screen to the new
// run without a reload. The projection carries counts, not people: approvals are approved / required with no side
// names, and there is no room record or message feed. This screen never calls approvals.*, rooms.* or messages.*;
// an observer gets FORBIDDEN from all of them.

type PublicEvent = ObserverView["events"][number];
type Job = PublicEvent["jobs"][number];
type Scan = ObserverView["scans"][number];
type Conn = { text: string; on: boolean };

const LIVE: Conn = { text: "Live", on: true };
const CONNECTING: Conn = { text: "Connecting", on: false };

export function LiveObserver({ now }: { now: number }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const [attempt, setAttempt] = useState(0);
  if (isLoading) {
    return (
      <Centered now={now} link={CONNECTING} k="auth">
        <Note title="Connecting to OrbitCall" />
      </Centered>
    );
  }
  if (!isAuthenticated) return <SignedOut now={now} />;
  return (
    <QueryBoundary key={attempt} fallback={(e) => <Failed now={now} error={e} stage="run" onRetry={() => setAttempt((n) => n + 1)} />}>
      <RunFollower now={now} />
    </QueryBoundary>
  );
}

/** observer.myRun: the open run granted to this observer, or none yet. */
function RunFollower({ now }: { now: number }) {
  const run = useQuery(observerRunRef, {});
  const [attempt, setAttempt] = useState(0);
  if (run === undefined) {
    return (
      <Centered now={now} link={CONNECTING} k="run">
        <Note title="Looking for the live session" />
      </Centered>
    );
  }
  if (run === null) {
    return (
      <Centered now={now} link={LIVE} k="no-run">
        <Note icon={<MonitorUp size={18} />} title="Waiting for the live session" body="No run is open for this observer yet. This screen follows the next one as soon as it starts." />
      </Centered>
    );
  }
  // a new run (after a reset) is a new subscription with its own boundary
  return (
    <QueryBoundary key={`${run.demoRunId}-${attempt}`} fallback={(e) => <Failed now={now} error={e} stage="view" onRetry={() => setAttempt((n) => n + 1)} />}>
      <RunView demoRunId={run.demoRunId} now={now} />
    </QueryBoundary>
  );
}

/** observer.publicView: the run's cases, plans, approval counts, schedule writes, results and scans. */
function RunView({ demoRunId, now }: { demoRunId: DemoRunId; now: number }) {
  const view = useQuery(observerViewRef, { demoRunId });
  // a case picked on the strip stays on screen; otherwise the screen follows the case that comes next
  const [picked, setPicked] = useState<EventId | null>(null);
  if (view === undefined) {
    return (
      <Centered now={now} link={CONNECTING} k="view">
        <Note title="Loading the live session" />
      </Centered>
    );
  }
  if (view.state === "closed") {
    return (
      <Centered now={now} link={LIVE} k="closed">
        <Note icon={<MonitorUp size={18} />} title="This session is closed" body="This screen follows the next run as soon as it starts." />
      </Centered>
    );
  }
  const e = view.events.find((x) => x.eventId === picked) ?? nextCase(view.events);
  if (!e) {
    return (
      <Centered now={now} link={LIVE} k="empty">
        <div className="w-[420px] max-w-full">
          <Note icon={<MonitorUp size={18} />} title="Waiting for a case" body="Cases of this session appear here as soon as a scan finds them." />
          {view.scans.length > 0 && <Scans scans={view.scans} />}
        </div>
      </Centered>
    );
  }
  const tca = Date.parse(e.tcaUtc);
  return (
    <Screen top={<TopBar head={<CaseNames e={e} />} tca={Number.isFinite(tca) ? tca : null} now={now} link={LIVE} />}>
      {view.events.length > 1 && <CaseStrip events={view.events} current={e.eventId} picked={picked} onPick={setPicked} />}
      <motion.div key={e.eventId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex min-h-0 flex-1 flex-col">
        <Stepper at={STAGE[e.status]} />
        {e.verification && <ResultBand v={e.verification} />}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)]">
          <CaseColumn e={e} truncated={view.truncated} />
          <div className="thin-scroll min-h-0 overflow-y-auto border-x border-white/[0.06] px-6 py-5">
            <Plans e={e} />
            {e.jobs.length > 0 && <Schedule jobs={e.jobs} />}
          </div>
          <div className="flex min-h-0 flex-col">
            {view.scans.length > 0 && (
              <div className="shrink-0 px-6">
                <Scans scans={view.scans} />
              </div>
            )}
            {/* observer.publicView has no room record: the answers list stays empty rather than guessed */}
            <RoomRecord cards={[]} empty="Not part of the public view. The plans, the approval count and the schedule show what was decided." />
          </div>
        </div>
      </motion.div>
    </Screen>
  );
}

/* ---------------------------------------------------------------- frame and states */

function Screen({ top, children }: { top: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-black text-neutral-200">
      {top}
      {children}
    </div>
  );
}

/** A screen with one message in the middle; `k` names the state so a change fades in. */
function Centered({ now, link, k, children }: { now: number; link: Conn; k: string; children: ReactNode }) {
  return (
    <Screen top={<TopBar now={now} link={link} />}>
      <motion.div key={k} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6">
        {children}
      </motion.div>
    </Screen>
  );
}

function SignedOut({ now }: { now: number }) {
  return (
    <Centered now={now} link={{ text: "Signed out", on: false }} k="signed-out">
      <Note
        icon={<LogIn size={18} />}
        title="Sign in to watch the live session"
        body="This screen shows the live session to its observer account. Sign in with that account, then open this page again."
        action={
          <Link href="/signin" className="btn h-9 gap-1.5 px-3.5 text-[13px] text-white" onClick={() => sfx.click()}>
            <LogIn size={13} /> Sign in
          </Link>
        }
      />
    </Centered>
  );
}

/** A thrown myRun (`run`) or publicView (`view`). The backend's message is written for people, so it is shown. */
function Failed({ now, error, stage, onRetry }: { now: number; error: Error; stage: "run" | "view"; onRetry: () => void }) {
  const { code, message } = backendError(error);
  if (code === "UNAUTHENTICATED") return <SignedOut now={now} />;
  const retry = (
    <button
      className="btn h-9 gap-1.5 px-3.5 text-[13px] text-white"
      onClick={() => {
        sfx.click();
        onRetry();
      }}
    >
      <RotateCcw size={13} /> Try again
    </button>
  );
  if (code === "FORBIDDEN" && stage === "run") {
    // anyone but a demo_observer: "Only a demonstration observer has a run to watch."
    return (
      <Centered now={now} link={{ text: "No run to watch", on: false }} k="forbidden">
        <Note
          icon={<ShieldX size={18} />}
          title="This screen is for the live-session observer"
          body={`${message} Operators work on their cases on the main screen.`}
          action={
            <Link href="/" className="btn h-9 gap-1.5 px-3.5 text-[13px] text-white" onClick={() => sfx.click()}>
              Open OrbitCall
            </Link>
          }
        />
      </Centered>
    );
  }
  // an unexpected error has no message for people: its first line, without Convex's bracketed request prefixes
  const body = code === "UNKNOWN" ? `The backend answered: ${briefError(error)}` : message;
  return (
    <Centered now={now} link={{ text: code === "FORBIDDEN" ? "Not authorized" : "Not connected", on: false }} k={`failed-${stage}`}>
      <Note
        icon={code === "FORBIDDEN" ? <ShieldX size={18} /> : undefined}
        title={code === "FORBIDDEN" ? "This run is not shared with this observer" : "Could not load the live session"}
        body={body}
        action={retry}
      />
    </Centered>
  );
}

/* ---------------------------------------------------------------- the case */

// Backend statuses on the simulator's labels and colors. "Verified" reads as evidence, never as an executed burn.
const SIM_STATUS: Record<EventStatus, SimStatus> = {
  new: "new",
  agents: "agents",
  proposal: "proposal",
  communication: "communication",
  approved: "approved",
  scheduled: "scheduled",
  monitoring: "monitoring",
  awaiting_verification_data: "awaiting_verification",
  verified: "verified",
  flagged: "flagged",
  no_action_needed: "no_action",
};

function statusMeta(s: EventStatus) {
  return s === "verified" ? { label: "Consistent with plan", color: "var(--green)" } : STATUS_META[SIM_STATUS[s]];
}

/** Step on the stepper, as `stepOf` places the same statuses in dev. */
const STAGE: Record<EventStatus, number> = {
  new: 0,
  agents: 1,
  proposal: 3,
  communication: 3,
  approved: 4,
  scheduled: 4,
  awaiting_verification_data: 5,
  verified: 6,
  flagged: 6,
  monitoring: 6,
  no_action_needed: 6,
};

const SETTLED = new Set<EventStatus>(["verified", "flagged", "monitoring", "no_action_needed"]);

/** The case that comes next: the earliest closest approach not yet settled, else the earliest of all. */
function nextCase(events: PublicEvent[]): PublicEvent | undefined {
  const byTca = [...events].sort((a, b) => Date.parse(a.tcaUtc) - Date.parse(b.tcaUtc));
  return byTca.find((x) => !SETTLED.has(x.status)) ?? byTca[0];
}

const nameOf = (o: PublicEvent["objects"][number]) => o?.name ?? "Unknown object";

/** Delta-v is at most 1 m/s: three decimals, trailing zeros dropped. */
const fmtDv = (v: number) => String(Number(v.toFixed(3)));

function CaseNames({ e }: { e: PublicEvent }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[14px] text-neutral-300">
      <span className="truncate">{nameOf(e.objects[0])}</span>
      <span className="text-neutral-600">×</span>
      <span className="truncate">{nameOf(e.objects[1])}</span>
      {e.simulated && <SimTag />}
    </span>
  );
}

/** Every case of the run; picking one keeps it on screen until "Follow the next case". */
function CaseStrip({ events, current, picked, onPick }: { events: PublicEvent[]; current: EventId; picked: EventId | null; onPick: (id: EventId | null) => void }) {
  return (
    <div className="thin-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-5 py-2">
      {events.map((x) => {
        const on = x.eventId === current;
        const st = statusMeta(x.status);
        return (
          <button
            key={x.eventId}
            className="btn relative h-8 gap-2 px-3"
            data-active={on}
            onClick={() => {
              if (picked === x.eventId) return;
              sfx.click();
              onPick(x.eventId);
            }}
          >
            {on && <motion.span layoutId="observer-case" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className={`relative max-w-[240px] truncate text-[13px] ${on ? "text-white" : "text-neutral-400"}`}>
              {nameOf(x.objects[0])} × {nameOf(x.objects[1])}
            </span>
            <span className="relative flex items-center gap-1.5 text-[12px]" style={{ color: st.color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
              {st.label}
            </span>
          </button>
        );
      })}
      {picked && (
        <button
          className="ml-auto shrink-0 px-2 text-[12px] text-neutral-500 transition-colors hover:text-white"
          onClick={() => {
            sfx.click();
            onPick(null);
          }}
        >
          Follow the next case
        </button>
      )}
    </div>
  );
}

function CaseColumn({ e, truncated }: { e: PublicEvent; truncated: boolean }) {
  const st = statusMeta(e.status);
  const tca = Date.parse(e.tcaUtc);
  const sel = e.selection;
  const { approved, required, allRequiredApproved } = e.approval;
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto px-6 py-5">
      <div className="text-[22px] font-semibold leading-snug tracking-[-0.02em] text-white">
        {nameOf(e.objects[0])} passes {fmtMiss(e.missKm * 1000)} from {nameOf(e.objects[1])}
      </div>
      <div className="mt-1 text-[13.5px] text-neutral-500">
        {Number.isFinite(tca) ? fmtWhen(tca) : "—"} · <span className="mono">{e.objects.map((o) => (o ? fmtObjectId(o.objectId) : "—")).join(" × ")}</span>
      </div>
      <div className="mt-3">
        <Chip color={st.color}>{st.label}</Chip>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
        <Big label="Chance of collision" value={e.probability === null ? "—" : fmtOdds(e.probability)} />
        <Big label="Miss distance" value={fmtMiss(e.missKm * 1000)} />
        <Big label="Plan on the table" value={!sel ? "—" : sel.kind === "wait" ? "Wait" : sel.deltaVMs === null ? sel.label : `${fmtDv(sel.deltaVMs)} m/s`} />
        <Big label="Approvals" value={required ? `${approved} / ${required}` : "—"} tone={allRequiredApproved ? "var(--green)" : undefined} />
      </div>
      {e.probability === null && <p className="mt-4 text-[12.5px] text-neutral-500">No probability is published for this pair.</p>}
      {truncated && (
        <p className="mt-6 border-t border-white/[0.06] pt-4 text-[12px] leading-[1.5] text-neutral-500">
          Some records of this session are over the public view&rsquo;s limits and are not shown.
        </p>
      )}
    </div>
  );
}

function Plans({ e }: { e: PublicEvent }) {
  const sel = e.selection;
  if (!e.candidates.length) {
    return <Note title={e.status === "agents" ? "The agents are working on plans" : "No plans yet"} body="Plans appear here as soon as both sides can review them." />;
  }
  return (
    <div className="overflow-hidden rounded-[16px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
      <div className="flex items-baseline gap-3 px-5 pb-3 pt-4">
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-white">Plans on the table</span>
        <span className="text-[12.5px] text-neutral-500">{sel ? `${sel.label} · R${sel.revision} selected` : "none selected yet"}</span>
      </div>
      <Approvals e={e} />
      <div className="mx-5 mt-3 overflow-hidden rounded-[14px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
        {e.candidates.map((c, i) => (
          <PlanRow key={c.proposalId} e={e} c={c} index={i} last={i === e.candidates.length - 1} />
        ))}
      </div>
      <div className="h-4" />
    </div>
  );
}

/** A count of valid approvals of the selected plan; who approved is not part of the public view. */
function Approvals({ e }: { e: PublicEvent }) {
  const { approved, required, allRequiredApproved } = e.approval;
  const sel = e.selection;
  const text = !required
    ? "No approvals are counted for this case"
    : !sel
      ? "Approvals start once a plan is selected"
      : allRequiredApproved
        ? `All required approvals for ${sel.label} · R${sel.revision}`
        : `${approved} of ${required} required approvals for ${sel.label} · R${sel.revision}`;
  return (
    <div className="mx-5 flex items-center gap-3 rounded-[12px] bg-white/[0.025] px-3.5 py-2.5">
      {required > 0 && (
        <span className="flex shrink-0 gap-1">
          {Array.from({ length: required }, (_, i) => (
            <span key={i} className="h-1.5 w-5 rounded-full transition-colors duration-300" style={{ background: i < approved ? "var(--green)" : "rgba(255,255,255,0.12)" }} />
          ))}
        </span>
      )}
      <span className={`text-[12.5px] ${allRequiredApproved ? "text-green" : "text-neutral-400"}`}>{text}</span>
    </div>
  );
}

/** One plan as the dispatchers see it, without controls: the filled circle is the shared selection. */
function PlanRow({ e, c, index, last }: { e: PublicEvent; c: ObserverCard; index: number; last: boolean }) {
  const checked = c.proposalId === e.selection?.proposalId && c.revision === e.selection.revision;
  const tca = Date.parse(e.tcaUtc);
  const burn = c.burnTimeUtc ? Date.parse(c.burnTimeUtc) : NaN;
  const lead = Number.isFinite(burn) && Number.isFinite(tca) ? Math.round((tca - burn) / 3600_000) : null;
  const who = e.objects.find((o) => o && o.objectId === c.movingObjectId)?.name ?? (c.movingObjectId ? fmtObjectId(c.movingObjectId) : "a spacecraft");
  const when = c.kind === "wait" ? "No burn" : Number.isFinite(burn) ? `Burn ${fmtWhen(burn)}${lead !== null ? `, ${lead} h before closest approach` : ""}` : "Burn time not set";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + index * 0.05, duration: 0.25 }}
      className={`relative flex items-start gap-3 py-3.5 pl-12 pr-4 transition-colors duration-200 ${last ? "" : "border-b border-white/[0.06]"} ${checked ? "bg-white/[0.06]" : ""}`}
    >
      <span
        aria-hidden
        className={`absolute left-4 top-[15px] grid h-5 w-5 place-items-center rounded-full transition-[box-shadow,background] duration-200 ${
          checked ? "bg-white" : "shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.14)]"
        }`}
      >
        {checked && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 26 }} className="h-2 w-2 rounded-full bg-black" />}
      </span>
      <span className="mono mt-[2px] w-6 shrink-0 text-[12px] font-semibold text-neutral-500">{c.label}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[14.5px] font-semibold leading-snug text-white">
          {c.kind === "wait" ? "Wait" : `Move ${who}`}
          {c.kind !== "wait" && c.deltaVMs !== null && (
            <span className="tnum font-normal text-neutral-400">
              by {fmtDv(c.deltaVMs)} m/s{c.direction ? ` ${c.direction}` : ""}
            </span>
          )}
          {c.simulated && !e.simulated && <SimTag />}
        </span>
        <span className="tnum mt-1 block text-[12.5px] text-neutral-400">
          {when} · R{c.revision}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-right">
        <span
          className="tnum block text-[18px] font-semibold leading-none tracking-[-0.02em]"
          style={{ color: c.missAfterKm === null ? "#737373" : c.kind === "wait" ? "var(--red)" : "#fff" }}
        >
          {c.missAfterKm === null ? "—" : fmtMiss(c.missAfterKm * 1000)}
        </span>
        <span className="tnum mt-1 block text-[11px] text-neutral-500">from {fmtMiss(e.missKm * 1000)}</span>
      </span>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- schedule, result, scans */

const JOB: Record<ManeuverStatus, { label: string; color: string; live?: boolean }> = {
  preview: { label: "Preview", color: "var(--muted)" },
  rescreening: { label: "Re-screening", color: "var(--blue)", live: true },
  refused: { label: "Refused by the re-screen", color: "var(--red)" },
  committing: { label: "Writing the schedule", color: "var(--blue)", live: true },
  committed: { label: "Committed", color: "var(--green)" },
  failed: { label: "Failed", color: "var(--red)" },
};

/** Schedule writes for this case, newest first (the index returns them oldest first). */
function Schedule({ jobs }: { jobs: Job[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-[16px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
      <div className="flex items-baseline gap-3 px-5 pb-3 pt-4">
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-white">Schedule</span>
        <span className="text-[12.5px] text-neutral-500">Not evidence of execution</span>
      </div>
      {[...jobs].reverse().map((j) => (
        <JobRow key={j.maneuverId} j={j} />
      ))}
    </div>
  );
}

function JobRow({ j }: { j: Job }) {
  const st = JOB[j.status];
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="border-t border-white/[0.06] px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip color={st.color} dot={st.live}>
          {st.label}
        </Chip>
        {j.reviewRequired && <Chip color="var(--orange)">Review required</Chip>}
        {j.commitSha && <span className="mono ml-auto text-[12px] text-neutral-400">commit {j.commitSha.slice(0, 7)}</span>}
      </div>
      {j.rescreen && (
        <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-neutral-400">
          {j.rescreen.passed ? <Check size={12} className="shrink-0 text-green" /> : <X size={12} className="shrink-0 text-[#ff8a80]" />}
          <span>
            Re-screen {j.rescreen.passed ? "passed" : "did not pass"} · <span className="tnum">{j.rescreen.objectsChecked.toLocaleString("en-US")}</span> objects ·{" "}
            <span className="tnum">{j.rescreen.horizonH}</span> h ahead
          </span>
        </div>
      )}
    </motion.div>
  );
}

const RESULT: Record<VerificationResult, { color: string; icon: ReactNode }> = {
  consistent: { color: "var(--green)", icon: <Check size={16} /> },
  mismatch: { color: "var(--red)", icon: <X size={16} /> },
  awaiting_data: { color: "var(--orange)", icon: <Clock size={16} /> },
};

/** The verification of the newest committed schedule, in the backend's words ("evidence consistent with plan"). */
function ResultBand({ v }: { v: NonNullable<PublicEvent["verification"]> }) {
  const r = RESULT[v.result];
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      className="shrink-0 overflow-hidden border-b"
      style={{ borderColor: `color-mix(in srgb, ${r.color} 25%, transparent)`, background: `color-mix(in srgb, ${r.color} 7%, transparent)` }}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: r.color }}>
          {r.icon} {v.label.charAt(0).toUpperCase() + v.label.slice(1)}
        </span>
        <span className="text-[13px] text-neutral-300">
          <span className="tnum">{v.elementSetCount}</span> element {v.elementSetCount === 1 ? "set" : "sets"}
        </span>
        {v.kind === "replay" && <span className="text-[13px] text-neutral-400">Replay</span>}
        {v.simulated && <SimTag />}
      </div>
    </motion.div>
  );
}

const PHASE: Record<Scan["phase"], string> = {
  queued: "Queued",
  loading: "Loading the catalog",
  screening: "Screening",
  matching_sources: "Matching sources",
  publishing: "Publishing",
  done: "Done",
  failed: "Failed",
};

/** The run's scans, newest first (the index returns them oldest first). */
function Scans({ scans }: { scans: Scan[] }) {
  const list = [...scans].reverse();
  return (
    <div className="pt-5">
      <div className="text-[15px] font-semibold text-white">Scans</div>
      <div className="text-[12px] text-neutral-500">Close-approach screening in this session.</div>
      <div className="mt-3 space-y-2">
        {list.slice(0, 3).map((s) => (
          <ScanRow key={s.scanId} s={s} />
        ))}
      </div>
      {list.length > 3 && <div className="mt-2 text-[12px] text-neutral-600">and {list.length - 3} earlier</div>}
    </div>
  );
}

function ScanRow({ s }: { s: Scan }) {
  const running = s.status === "queued" || s.status === "running";
  const color = s.status === "failed" ? "var(--red)" : running ? "var(--blue)" : "var(--green)";
  const pct = s.progress === null ? null : Math.min(Math.max(s.progress, 0), 1);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-[11px] bg-white/[0.025] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]"
    >
      <div className="flex items-center gap-2 text-[13px]">
        {running ? <span className="pulse-dot" style={{ width: 5, height: 5, color }} /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
        <span className="text-neutral-200">{PHASE[s.phase]}</span>
        {pct !== null && <span className="tnum ml-auto text-[12px] text-neutral-400">{Math.round(pct * 100)}%</span>}
      </div>
      {/* no measured progress yet: the track sweeps instead of showing a made-up fraction */}
      <div className={`mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.07] ${running && pct === null ? "agent-sheen" : ""}`}>
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${(pct ?? 0) * 100}%`, background: color }} />
      </div>
      <div className="tnum mt-1.5 text-[12px] text-neutral-500">
        {s.counts.primariesCompleted}/{s.counts.primaryObjects} spacecraft · {s.counts.pairsChecked.toLocaleString("en-US")} pairs · {s.counts.eventsFound} found
      </div>
      {s.status === "completed" && (
        <div className="mt-0.5 text-[12px]" style={{ color: s.coverage.complete ? "var(--muted)" : "var(--orange)" }}>
          {s.coverage.complete ? s.coverage.catalogScope : `Partial coverage · ${s.coverage.excludedObjects.toLocaleString("en-US")} objects excluded`}
        </div>
      )}
    </motion.div>
  );
}
