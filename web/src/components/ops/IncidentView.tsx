"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Check, Loader2, Maximize2, Minimize2, ShieldAlert } from "lucide-react";
import { fmtCountdown, fmtMiss, fmtChance, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { AGENTS, MODELS } from "@/lib/ops/roster";
import { engine } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentGraph, GraphLegend } from "./AgentGraph";
import { CallFeed } from "./AgentTrace";
import { PcTrend } from "./PcTrend";
import { Decide, Done, TheirReply, Waiting, optionText, useRoomState } from "./DecisionDock";
import { ObjectChip, RichLine } from "./Entity";
import { RoomCall } from "@/components/rooms/RoomsScreen";

// The incident command view: one near-full-screen place for the case being worked.
// Left: the case. Center: what is happening now, or the dispatcher's decision. Right: the agents.
// It collapses to a bar so the globe (and the cinematic camera) can be watched, and expands back.

export const STEPS = ["Detected", "Analysis", "Negotiation", "Decision", "Scheduling", "Verification"];

export function stepOf(e: ConjunctionEvent) {
  switch (e.status) {
    case "new":
      return 0;
    case "agents":
      return e.summary ? 2 : 1;
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
  const resolvedOpen = useOps((s) => s.resolved?.eventId === s.incident);
  const e = useOps((s) => s.events.find((x) => x.id === s.incident));
  const now = useNow(250);
  const room = useRoomState(e, now);
  const show = !!incident && !!e && (tab === "decision" || tab === "orbit") && !resolvedOpen;
  const view = tab === "decision" ? "expanded" : "collapsed";

  return (
    <AnimatePresence mode="wait">
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
            <PartiesBar e={e!} room={room} />
            <Stepper e={e!} />
          </div>
          {/* the case is narrow; the decision and the agents' run get the room */}
          <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_minmax(320px,380px)]">
            <CaseColumn e={e!} />
            <CenterColumn e={e!} now={now} room={room} />
            <AgentsColumn />
          </div>
        </motion.div>
      )}
      {show && view === "collapsed" && <CollapsedBar key="incident-bar" e={e!} now={now} decide={room.state?.mode === "decide"} />}
    </AnimatePresence>
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
function Stepper({ e }: { e: ConjunctionEvent }) {
  const cur = stepOf(e);
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

function CaseColumn({ e }: { e: ConjunctionEvent }) {
  const cross = engine.encounters.get(e.id)?.crossDeg;
  const lat = `${Math.abs(Math.round(e.where.lat))}°${e.where.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(Math.round(e.where.lon))}°${e.where.lon >= 0 ? "E" : "W"}`;
  const red = e.risk === "red";
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto border-r border-white/[0.06]">
      {/* four figures, one grid, thin dividers */}
      <div className="grid grid-cols-2 border-b border-white/[0.06]">
        <Fact label="Chance" value={fmtOdds(e.pc)} tone={red ? "#ff8a80" : "var(--amber)"} note={`${fmtChance(e.pc)} · ${e.pcSource}`} />
        <Fact label="Miss distance" value={fmtMiss(e.missM)} note={`±${fmtMiss(e.uncertaintyM)} between sources`} right />
        <Fact label="Relative speed" value={`${e.relVelKms.toFixed(1)} km/s`} note={cross ? `crossing at ${cross}°` : undefined} bottom />
        <Fact label="Where" value={`${Math.round(e.where.altKm)} km`} note={`over ${lat} ${lon}`} right bottom />
      </div>

      <div className="border-b border-white/[0.06] px-5 py-4">
        <PcTrend e={e} />
      </div>

      <Section title="Analyst notes" note={`${AGENTS.analyst.name} · ${MODELS[AGENTS.analyst.model].label}`}>
        {e.summary ? (
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
        return (
          <div
            key={p.id}
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
                <span className="max-w-[150px] truncate">{p.operator.replace(/\s*\(synthetic\)/i, "")}</span>
                {me && <span className="text-[11px] font-normal text-neutral-500">you</span>}
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
                <span className="text-neutral-500">{p.role === "affected" ? "Affected" : `Side ${p.role.toUpperCase()}`}</span>
                <span className="text-neutral-700">·</span>
                <span className="text-neutral-500">{where}</span>
              </span>
            </span>
          </div>
        );
      })}
      {e.b.kind === "debris" && <span className="shrink-0 text-[12px] text-neutral-500">Debris has no operator · single-operator avoidance</span>}
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

function CenterColumn({ e, now, room }: { e: ConjunctionEvent; now: number; room: ReturnType<typeof useRoomState> }) {
  const st = room.state;
  const due = st?.mode === "decide";
  // Decision and the agents' run share the main area; a decision that becomes due brings Decision forward
  const [view, setView] = useState<"decision" | "run">(st ? "decision" : "run");
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
              { id: "decision", label: "Decision" },
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
        <span className="ml-auto text-[12px] text-neutral-600">{view === "run" ? "Every model and tool call · newest first · with latency" : "Both sides approve the same selected plan"}</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {view === "run" ? (
            <motion.div key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="absolute inset-0 flex flex-col">
              <CallFeed className="min-h-0 flex-1 [&_.px-3]:px-6" eventId={e.id} />
            </motion.div>
          ) : (
            // the plans scroll here; the panel's Approve bar stays pinned to the bottom of this area
            <motion.div key={`decision-${st?.mode ?? "working"}-${e.proposal?.version ?? 0}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="thin-scroll absolute inset-0 overflow-y-auto px-6 pb-5">
              {st?.mode === "decide" ? (
                <div className="rounded-[16px] bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,159,64,0.32)]">
                  <Decide e={e} viewer={room.viewer} now={now} embedded />
                </div>
              ) : st?.mode === "waiting" ? (
                <Card>
                  <Waiting e={e} other={room.other} mine={st.mine!} now={now} />
                </Card>
              ) : st?.mode === "reply" ? (
                <Card>
                  <TheirReply e={e} r={st.theirs!} />
                </Card>
              ) : st?.mode === "done" ? (
                <Card>
                  <Done e={e} />
                </Card>
              ) : (
                <WorkingLine e={e} onRun={() => setView("run")} />
              )}
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

/** Nothing to decide yet: say what the agents are on, and offer their run. */
function WorkingLine({ e, onRun }: { e: ConjunctionEvent; onRun: () => void }) {
  const step = STEPS[Math.min(stepOf(e), STEPS.length - 1)];
  return (
    <div className="grid h-full min-h-[220px] place-items-center text-center">
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white/[0.04]">
          {e.agentsWorking ? <Loader2 size={18} className="animate-spin text-[#9cc2ff]" /> : <Check size={18} className="text-green" />}
        </div>
        <div className="mt-3 text-[16px] font-medium text-white">{e.agentsWorking ? "The agents are working" : "Waiting for the next step"}</div>
        <div className="mt-1 text-[13px] text-neutral-500">{step} · the plans appear here when they need your decision</div>
        <button className="btn btn-ghost-line mt-4 h-8 px-3 text-[12px]" onClick={onRun}>
          Watch the agent run
        </button>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-[14px] bg-white/[0.03] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">{children}</div>;
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

function CollapsedBar({ e, now, decide }: { e: ConjunctionEvent; now: number; decide: boolean }) {
  const step = STEPS[Math.min(stepOf(e), STEPS.length - 1)];
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
