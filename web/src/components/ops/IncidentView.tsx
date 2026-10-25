"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import { useCaseRow } from "@/lib/backend/adapt";
import { fmtStamp, pcSource } from "@/lib/backend/format";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { ApprovalStatus, Side } from "@/lib/backend/types";
import { fmtCountdown, fmtMiss, fmtChance, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { AGENTS, MODELS } from "@/lib/ops/roster";
import { engine } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { TurnStatus, WorkflowNote } from "@/components/live/DecisionStatus";
import { SchedulerStatus } from "@/components/live/SchedulerStatus";
import { AgentGraph, GraphLegend } from "./AgentGraph";
import { CallFeed } from "./AgentTrace";
import { SummaryView } from "./BackendQueue";
import { PcTrend } from "./PcTrend";
import { Meeting } from "./Meeting";
import { useRoomState } from "./DecisionDock";
import { ObjectChip, RichLine } from "./Entity";
import { RoomCall } from "@/components/rooms/RoomsScreen";

// The incident command view: one near-full-screen place for the case being worked.
// Left: the case. Center: what is happening now, or the dispatcher's decision. Right: the agents.
// It collapses to a bar so the globe (and the cinematic camera) can be watched, and expands back.

export const STEPS = ["Detected", "Analysis", "Negotiation", "Decision", "Scheduling", "Verification"];

/** `summarized`: the analyst's summary is out, so the agents moved on from Analysis. */
export function stepOf(e: ConjunctionEvent, summarized = !!e.summary) {
  switch (e.status) {
    case "new":
      return 0;
    case "agents":
      return summarized ? 2 : 1;
    case "proposal":
    case "communication":
    case "needs_decision":
      return 3;
    case "approved":
    case "scheduled":
      return 4;
    case "awaiting_verification":
      return 5;
    default:
      return 6;
  }
}

/** Expanded is the Decision Center tab; collapsed is Orbit with the case bar. The tab is the source of truth. */
export function setIncidentView(v: "expanded" | "collapsed") {
  const tab = v === "expanded" ? "decision" : "orbit";
  if (useOps.getState().tab === tab) return;
  sfx.whoosh();
  useOps.setState({ incidentView: v, tab });
}

export function IncidentView() {
  const incident = useOps((s) => s.incident);
  const tab = useOps((s) => s.tab);
  const e = useOps((s) => s.events.find((x) => x.id === s.incident));
  const now = useNow(250);
  const room = useRoomState(e, now);
  const step = useStep(e);
  const real = useRealMode();
  const caseError = useLive((s) => s.errors.case);
  const show = !!incident && !!e && (tab === "decision" || tab === "orbit");
  const view = tab === "decision" ? "expanded" : "collapsed";

  return (
    <AnimatePresence mode="wait">
      {real && !!incident && !e && !!caseError && tab === "decision" && <CaseUnavailable key="incident-error" message={caseError} />}
      {show && view === "expanded" && (
        <motion.div
          key="incident-full"
          initial={{ opacity: 0, scale: 0.985, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.985, filter: "blur(8px)" }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-auto absolute inset-x-2.5 bottom-[42px] top-[58px] z-[38] flex flex-col overflow-hidden rounded-[18px] bg-[rgba(4,4,5,0.94)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_40px_100px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
        >
          <Header e={e!} now={now} />
          {/* who is on the case, always in view, beside where the case stands */}
          <div className="flex items-center gap-6 border-b border-white/[0.06] px-7 pb-3">
            {real ? <LivePartiesBar e={e!} /> : <PartiesBar e={e!} room={room} />}
            <Stepper e={e!} step={step} />
          </div>
          {/* the case is narrow; the decision and the agents' run get the room */}
          <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_minmax(320px,380px)]">
            <CaseColumn e={e!} now={now} real={real} />
            <CenterColumn e={e!} now={now} room={room} real={real} />
            <AgentsColumn />
          </div>
        </motion.div>
      )}
      {show && view === "collapsed" && <CollapsedBar key="incident-bar" e={e!} now={now} step={step} decide={room.state?.mode === "decide"} />}
    </AnimatePresence>
  );
}

/** The stepper's position. In real mode the analyst's checked summary moves the case past Analysis, as in the simulator. */
function useStep(e: ConjunctionEvent | undefined) {
  const real = useRealMode();
  const summarized = useLive((s) => (s.summary?.summaryLines.length ?? 0) > 0);
  return e ? stepOf(e, real ? summarized : !!e.summary) : 0;
}

/** Real mode: the open case could not be read at all (inbox.get failed and no queue row has it). */
function CaseUnavailable({ message }: { message: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="glass pointer-events-auto absolute left-1/2 top-[58px] z-[38] w-[360px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[12px] px-4 py-3"
      role="alert"
    >
      <div className="text-[12px] font-medium">This case could not be opened</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{message}</p>
      <button className="btn btn-ghost-line mt-2.5 h-7 px-3 text-[11.5px]" onClick={() => useOps.setState({ incident: null, tab: "orbit" })}>
        Back to the globe
      </button>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- header */

function Header({ e, now }: { e: ConjunctionEvent; now: number }) {
  const red = e.risk === "red";
  return (
    <div className="flex items-end gap-6 px-7 pb-4 pt-5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
          <span>Decision Center</span>
          <span className="text-neutral-700">/</span>
          <span className="mono text-neutral-400">{e.id}</span>
          <span className="ml-1 h-1.5 w-1.5 rounded-full" style={{ background: red ? "var(--red)" : "var(--amber)" }} />
          <span>{red ? "High priority" : "Watch"}</span>
        </div>
        <h1 className="mt-1.5 flex min-w-0 items-center gap-2 text-[26px] font-semibold leading-tight tracking-[-0.025em] text-white">
          <ObjectChip e={e} side="a" />
          <span className="font-normal text-neutral-600">×</span>
          <ObjectChip e={e} side="b" />
        </h1>
        <div className="tnum mt-1.5 text-[13px] text-neutral-500">
          {fmtMiss(e.missM)} apart · closest approach {fmtWhen(e.tca)}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-5">
        <div className="text-right">
          <div className="mono tnum text-[22px] font-semibold leading-none tracking-[-0.02em]" style={{ color: e.tca - now < 24 * 3600_000 ? "var(--orange)" : "#fff" }}>
            {now ? fmtCountdown(e.tca - now).replace("T−", "") : "—"}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">until closest approach</div>
        </div>
        <Tooltip label="Back to the globe; the case keeps running" hint="E">
          <button className="btn btn-ghost-line h-9 gap-1.5 px-3 text-[12px]" onClick={() => setIncidentView("collapsed")}>
            <Minimize2 size={12} /> Globe view
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Six thin segments: done, current, ahead. Only the current step is named, so the line stays quiet. */
function Stepper({ e, step: cur }: { e: ConjunctionEvent; step: number }) {
  return (
    <div className="w-[280px] shrink-0">
      <div className="mb-2 text-right text-[12px] text-neutral-500">
        Step {Math.min(cur + 1, STEPS.length)} of {STEPS.length} · <span className="text-neutral-200">{STEPS[Math.min(cur, STEPS.length - 1)]}</span>
        {e.agentsWorking && <Loader2 size={11} className="ml-1.5 inline animate-spin text-[#9cc2ff]" />}
      </div>
      <div className="flex gap-1.5">
        {STEPS.map((label, i) => (
          <span key={label} title={label} className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: i < cur ? "var(--green)" : "#9cc2ff" }}
              initial={false}
              animate={{ width: i < cur ? "100%" : i === cur ? "50%" : "0%" }}
              transition={{ duration: 0.6 }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ case */

function CaseColumn({ e, now, real }: { e: ConjunctionEvent; now: number; real: boolean }) {
  const cross = engine.encounters.get(e.id)?.crossDeg;
  const lat = `${Math.abs(Math.round(e.where.lat))}°${e.where.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(Math.round(e.where.lon))}°${e.where.lon >= 0 ? "E" : "W"}`;
  const red = e.risk === "red";
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto border-r border-white/[0.06]">
      {/* four figures, one grid, thin dividers */}
      {real ? (
        <LiveFacts e={e} />
      ) : (
        <div className="grid grid-cols-2 border-b border-white/[0.06]">
          <Fact label="Chance" value={fmtOdds(e.pc)} tone={red ? "#ff8a80" : "var(--amber)"} note={`${fmtChance(e.pc)} · ${e.pcSource}`} />
          <Fact label="Miss distance" value={fmtMiss(e.missM)} note={`±${fmtMiss(e.uncertaintyM)} between sources`} right />
          <Fact label="Relative speed" value={`${e.relVelKms.toFixed(1)} km/s`} note={cross ? `crossing at ${cross}°` : undefined} bottom />
          <Fact label="Where" value={`${Math.round(e.where.altKm)} km`} note={`over ${lat} ${lon}`} right bottom />
        </div>
      )}

      {/* the backend sends no Pc history with the case, so real mode has no trend to draw */}
      {!real && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <PcTrend e={e} />
        </div>
      )}

      <Section title="Analyst notes" note={real ? AGENTS.analyst.name : `${AGENTS.analyst.name} · ${MODELS[AGENTS.analyst.model].label}`}>
        {real ? (
          <LiveSummary e={e} now={now} />
        ) : e.summary ? (
          <ol className="space-y-2.5">
            {e.summary.slice(1).map((l, i) => (
              <li key={i} className="flex gap-3 text-[13px] leading-[1.6] text-neutral-300">
                <span className="mono mt-[2px] w-3 shrink-0 text-[11px] text-neutral-600">{i + 1}</span>
                <span>
                  <RichLine e={e} text={l} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="shimmer text-[13px] font-medium">The Incident Analyst is reading both orbits…</div>
        )}
      </Section>
    </div>
  );
}

function Fact({ label, value, note, tone, right, bottom }: { label: string; value: string; note?: string; tone?: string; right?: boolean; bottom?: boolean }) {
  return (
    <div className={`px-5 py-4 ${right ? "border-l border-white/[0.06]" : ""} ${bottom ? "border-t border-white/[0.06]" : ""}`}>
      <div className="text-[11.5px] text-neutral-500">{label}</div>
      <div className="mono tnum mt-1.5 text-[22px] font-medium leading-none tracking-[-0.02em]" style={{ color: tone ?? "#fff" }}>
        {value}
      </div>
      {note && <div className="mt-1.5 truncate text-[11px] text-neutral-500">{note}</div>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-white/[0.06] px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-white">{title}</span>
        {note && <span className="text-[11px] text-neutral-600">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** Real mode: the case row's own figures. Nothing is shown that the backend did not send (no spread, no position). */
function LiveFacts({ e }: { e: ConjunctionEvent }) {
  const pc = useCaseRow((s) => (s.row?.eventId === e.id ? s.row.pc : null));
  const v = pc?.value ?? null;
  return (
    <div className="grid grid-cols-2 border-b border-white/[0.06]">
      <Fact
        label={pc?.metric === "max_prob" ? "Max probability" : "Chance"}
        value={v !== null ? fmtOdds(v) : "—"}
        tone={v === null ? "var(--muted)" : e.risk === "red" ? "#ff8a80" : "var(--amber)"}
        note={v !== null ? fmtChance(v) : "No source supplied it"}
      />
      <Fact label="Miss distance" value={fmtMiss(e.missM)} right />
      <Fact label="Relative speed" value={`${e.relVelKms.toFixed(1)} km/s`} bottom />
      <Fact label="Evidence" value={pc ? pcSource(pc) : "—"} note={pc?.epochUtc ? `epoch ${fmtStamp(pc.epochUtc)}` : "epoch not supplied"} right bottom />
    </div>
  );
}

/** Real mode: the Incident Analyst's checked five lines and run state (agentSummaries.get, wiring map §5.1). */
function LiveSummary({ e, now }: { e: ConjunctionEvent; now: number }) {
  const summary = useLive((s) => s.summary);
  const error = useLive((s) => s.errors.summary);
  const color = useCaseRow((s) => (s.row?.eventId === e.id ? s.row.color : null));
  if (summary === undefined && error) {
    return (
      <div className="text-[12px] leading-[1.5] text-neutral-500">
        Summary unavailable · <span className="mono text-[11px]">{error}</span>
      </div>
    );
  }
  return <SummaryView s={summary} color={color ?? (e.risk === "red" ? "red" : "yellow")} now={now} />;
}

type PartyState = { text: string; color: string; pulse?: boolean };

/**
 * Everyone on the case, always in view: who is in the call and speaking (from the call), whose turn it is and how
 * each side answered (from the case). Where a person is in the app is known only for this screen's own side.
 */
function PartiesBar({ e, room }: { e: ConjunctionEvent; room: ReturnType<typeof useRoomState> }) {
  const humans = useOps((s) => s.humans);
  const live = useOps((s) => (s.callLive?.eventId === e.id ? s.callLive : null));
  const parties: Party[] = e.parties ?? [];
  const deciding = humans.filter((h) => h.eventId === e.id).map((h) => h.side);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]" data-testid="parties-bar">
      {parties.map((p) => {
        const me = p.role === room.viewer;
        const inCall = live?.inCall.includes(p.id) ?? false;
        const speaking = live?.speaking.includes(p.id) ?? false;
        const answer = p.role === "affected" ? "notified" : e.approvals[p.role];
        // decisions go in turn (A, then B): B's prompt may already be open while A decides, so B waits
        const waitsTurn = p.role === "b" && deciding.includes("a");
        const turn = p.role !== "affected" && deciding.includes(p.role) && !waitsTurn;
        const st = turn
          ? { text: me ? "Your turn to decide" : "Deciding", color: "var(--orange)", pulse: true }
          : answer === "approved"
            ? { text: "Approved", color: "var(--green)" }
            : answer === "vetoed"
              ? { text: "Vetoed", color: "var(--red)" }
              : answer === "notified"
                ? { text: "Notified", color: "#a3a3a3" }
                : waitsTurn
                  ? { text: "Waits for side A", color: "#8a8a8a" }
                  : { text: e.agentsWorking ? "Agents working" : "Waiting", color: "#8a8a8a" };
        const where = me ? "Decision Center" : inCall ? "In the call" : "Not in the call";
        const side = p.role === "affected" ? "Affected" : `Side ${p.role.toUpperCase()}`;
        return <PartyChip key={p.id} id={p.id} name={p.operator} country={p.country} me={me} turn={turn} speaking={speaking} st={st} side={side} where={where} />;
      })}
      {e.b.kind === "debris" && <span className="shrink-0 text-[12px] text-neutral-500">Debris has no operator · single-operator avoidance</span>}
    </div>
  );
}

/**
 * Real mode: one chip per operator side of the case row. Presence comes from the room's members (rooms.byId) and the
 * call, the turn and each side's approval from approvals.status. Debris has no operator and no chip; WorkflowNote
 * says so beside the chips.
 */
function LivePartiesBar({ e }: { e: ConjunctionEvent }) {
  const row = useCaseRow((s) => (s.row?.eventId === e.id ? s.row : null));
  const status = useLive((s) => (s.approvals?.eventId === e.id ? s.approvals : undefined));
  const room = useLive((s) => s.room);
  const roomId = useLive((s) => s.roomId);
  const live = useOps((s) => (s.callLive?.eventId === e.id ? s.callLive : null));
  const mySide = status?.mySide ?? row?.mySide ?? null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]" data-testid="parties-bar">
      {(row?.sides ?? []).map((s) => {
        const role = s.side === "A" ? "a" : "b";
        if (e[role].kind === "debris") return null;
        const party = e.parties?.find((p) => p.role === role);
        const company = s.owner?.companyId;
        const members = company ? (room?.members ?? []).filter((m) => m.companyId === company) : [];
        const me = s.side === mySide;
        const speaking = members.some((m) => live?.speaking.includes(m.userId));
        const inCall = members.some((m) => m.inCall || live?.inCall.includes(m.userId));
        const where = me ? "Decision Center" : !roomId ? "No room yet" : !room ? null : inCall ? "In the call" : members.some((m) => m.inRoom) ? "In the room" : "Not in the room";
        return (
          <PartyChip
            key={s.side}
            id={party?.id ?? s.side}
            name={party?.operator ?? "Operator unknown"}
            country={party?.country ?? null}
            me={me}
            turn={!!status?.deciding && status.turn === s.side}
            speaking={speaking}
            st={liveAnswer(status, s.side, me, e.agentsWorking)}
            side={`Side ${s.side}`}
            where={where}
          />
        );
      })}
      <span className="flex shrink-0 items-center gap-3 empty:hidden">
        <TurnStatus eventId={e.id} />
        <WorkflowNote eventId={e.id} />
      </span>
    </div>
  );
}

/** A side's state from approvals.status: deciding now, approved, waiting for the side ahead, or not asked yet. */
function liveAnswer(s: ApprovalStatus | undefined, side: Side, me: boolean, working: boolean): PartyState {
  if (s?.deciding && s.turn === side) return { text: me && s.myTurn ? "Your turn to decide" : "Deciding", color: "var(--orange)", pulse: true };
  if (s?.approvals[side]?.status === "approved") return { text: "Approved", color: "var(--green)" };
  if (s?.deciding && s.turn && s.requiredApprovalSides.includes(side)) return { text: `Waits for side ${s.turn}`, color: "#8a8a8a" };
  return { text: working ? "Agents working" : "Waiting", color: "#8a8a8a" };
}

function PartyChip(p: { id: string; name: string; country: string | null; me: boolean; turn: boolean; speaking: boolean; st: PartyState; side: string; where: string | null }) {
  const { st, turn, speaking } = p;
  return (
    <div
      data-party={p.id}
      data-speaking={speaking}
      className="flex shrink-0 items-center gap-2.5 rounded-[12px] py-1.5 pl-1.5 pr-3.5 transition-colors"
      style={{ background: turn ? "rgba(255,159,64,0.07)" : "rgba(255,255,255,0.03)", boxShadow: turn ? "inset 0 0 0 1px rgba(255,159,64,0.35)" : "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
    >
      <span
        className="relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[8px] transition-shadow duration-200"
        style={{ boxShadow: speaking ? "0 0 0 2px var(--green), 0 0 16px -2px rgba(61,220,151,0.8)" : "0 0 0 1px rgba(255,255,255,0.14)" }}
      >
        {p.country && <Flag code={p.country} h={32} square />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-medium leading-tight text-white">
          <span className="max-w-[150px] truncate">{p.name.replace(/\s*\(synthetic\)/i, "")}</span>
          {p.me && <span className="text-[11px] font-normal text-neutral-500">you</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-tight">
          {speaking ? (
            <span className="flex items-center gap-1 font-medium text-green">
              <SpeakingBars /> Speaking
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-medium" style={{ color: st.color }}>
              {st.pulse ? <span className="pulse-dot" style={{ width: 5, height: 5 }} /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />}
              {st.text}
            </span>
          )}
          <span className="text-neutral-700">·</span>
          <span className="text-neutral-500">{p.side}</span>
          {p.where && (
            <>
              <span className="text-neutral-700">·</span>
              <span className="text-neutral-500">{p.where}</span>
            </>
          )}
        </span>
      </span>
    </div>
  );
}

function SpeakingBars() {
  return (
    <span className="flex h-2.5 items-end gap-[2px]">
      {[0, 0.2, 0.1].map((d, i) => (
        <span key={i} className="w-[2px] rounded-full bg-green" style={{ height: "100%", animation: `eq 0.9s ${d}s ease-in-out infinite` }} />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- center */

function CenterColumn({ e, now, room, real }: { e: ConjunctionEvent; now: number; room: ReturnType<typeof useRoomState>; real: boolean }) {
  const st = room.state;
  const due = st?.mode === "decide";
  // Decision and the agents' run share the main area; a decision that becomes due brings Decision forward
  const [view, setView] = useState<"decision" | "run">("decision");
  const [wasDue, setWasDue] = useState(due);
  if (due !== wasDue) {
    setWasDue(due);
    if (due) setView("decision");
  }
  const spans = useOps((s) => s.spans);
  const runCount = useMemo(() => spans.filter((x) => x.eventId === e.id).length, [spans, e.id]);
  return (
    <div className="flex min-h-0 flex-col border-r border-white/[0.06]">
      <div className="flex shrink-0 items-center gap-3 px-6 pb-3 pt-4">
        <div className="flex rounded-full bg-white/[0.05] p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" role="tablist">
          {(
            [
              { id: "decision", label: "Meeting" },
              { id: "run", label: "Agent run" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={view === t.id}
              className={`relative flex h-8 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors ${view === t.id ? "text-black" : "text-neutral-400 hover:text-white"}`}
              onClick={() => {
                sfx.click();
                setView(t.id);
              }}
            >
              {view === t.id && <motion.span layoutId={`center-tab-${e.id}`} className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <span className="relative flex items-center gap-2">
                {t.label}
                {t.id === "decision" && due && <span className="h-1.5 w-1.5 rounded-full bg-orange" />}
                {t.id === "run" && <span className={`tnum text-[11.5px] ${view === t.id ? "text-black/50" : "text-neutral-600"}`}>{runCount}</span>}
              </span>
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-neutral-600">{view === "run" ? "Every model and tool call · newest first · with latency" : "Shared record of the case · newest at the bottom"}</span>
      </div>

      {/* after consensus: waiting for linked incidents, re-screening, the schedule entry (wiring map §1.5) */}
      {real && (
        <div className="shrink-0 px-6 pb-3 empty:hidden">
          <SchedulerStatus eventId={e.id} />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {view === "run" ? (
            <motion.div key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="absolute inset-0 flex flex-col">
              <CallFeed className="min-h-0 flex-1 [&_.px-3]:px-6" eventId={e.id} />
            </motion.div>
          ) : (
            // the shared meeting: the agents' notes, what people said, every decision, the plans while open, the report
            <motion.div key="decision" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="absolute inset-0">
              <Meeting
                e={e}
                now={now}
                room={room}
                onRun={(agent) => {
                  useOps.getState().set({ focusAgent: agent });
                  setView("run");
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* the coordination channel, docked: the sphere is the talk button */}
      <div className="shrink-0 border-t border-white/[0.07] bg-black/25">
        <RoomCall e={e} compact />
      </div>
    </div>
  );
}







/* ---------------------------------------------------------------- agents */

/** The agents as a graph: who calls whom, live. Their calls are in the middle column for everyone. */
function AgentsColumn() {
  return (
    <div className="thin-scroll flex min-h-0 flex-col overflow-y-auto px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[12px] font-semibold text-neutral-200">Agents</span>
        <span className="text-[11px] text-neutral-600">click an agent to filter its calls</span>
      </div>
      {/* the graph spreads over the whole column height, so the nodes keep their room */}
      <div className="flex min-h-0 flex-1 items-start justify-center">
        <AgentGraph big fill />
      </div>
      <div className="pt-3">
        <GraphLegend />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- collapsed */

function CollapsedBar({ e, now, step: at, decide }: { e: ConjunctionEvent; now: number; step: number; decide: boolean }) {
  const step = STEPS[Math.min(at, STEPS.length - 1)];
  return (
    <motion.div
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.97 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      // top center, right under the navbar: the first place the eye goes back to
      className="pointer-events-auto absolute left-1/2 top-[58px] z-[38] -translate-x-1/2"
    >
      <div
        className="flex h-12 items-center gap-3 rounded-[14px] bg-[rgba(4,4,5,0.92)] pl-3.5 pr-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_40px_-12px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        style={decide ? { boxShadow: "0 0 0 1px rgba(255,159,64,0.55), 0 0 30px -8px rgba(255,159,64,0.6)" } : undefined}
      >
        <span className="flex items-center gap-2">
          <span className="pulse-dot" style={{ width: 6, height: 6, color: decide ? "var(--orange)" : "var(--blue)" }} />
          <span className="text-[12.5px] font-semibold text-white">{decide ? "Your decision is needed" : "Case in progress"}</span>
        </span>
        <span className="h-5 w-px bg-white/10" />
        <span className="flex items-center gap-1.5 text-[12.5px] text-neutral-300">
          <ObjectChip e={e} side="a" size="sm" />
          <span className="text-neutral-600">×</span>
          <ObjectChip e={e} side="b" size="sm" />
        </span>
        <span className="flex items-center gap-1.5 text-[12px] text-neutral-500">
          {e.agentsWorking && <Loader2 size={12} className="animate-spin text-blue" />}
          {step}
        </span>
        <span className="tnum text-[13px] font-semibold text-white">{now ? fmtCountdown(e.tca - now).replace("T−", "") : ""}</span>
        <button className="btn btn-primary h-9 gap-1.5 px-3.5 text-[13px]" onClick={() => setIncidentView("expanded")}>
          <Maximize2 size={13} /> Open case <span className="kbd !bg-black/10 !text-black/50 !shadow-none">E</span>
        </button>
      </div>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: [0, 1, 1, 0], y: 0 }}
        transition={{ duration: 5, times: [0, 0.08, 0.85, 1] }}
        className="pointer-events-none mt-2 text-center text-[12px] text-neutral-400 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]"
      >
        Your case keeps running here. Press <span className="text-white">E</span> or click Open case to go back.
      </motion.div>
    </motion.div>
  );
}
