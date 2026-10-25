"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, Maximize2, Minimize2, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { fmtCountdown, fmtMiss, fmtPc, fmtWhen } from "@/lib/ops/format";
import { AGENTS, MODELS, nodeLabel } from "@/lib/ops/roster";
import { engine } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party, Reply, Span } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentGraph } from "./AgentGraph";
import { CallFeed } from "./AgentTrace";
import { PcChart } from "./ConjunctionQueue";
import { Decide, Done, TheirReply, Waiting, optionText, useRoomState } from "./DecisionDock";
import { ObjectChip, RichLine } from "./Entity";
import { ModelGlyph } from "./Glyphs";

// The incident command view: one near-full-screen place for the case being worked.
// Left: the case. Center: what is happening now, or the dispatcher's decision. Right: the agents.
// It collapses to a bar so the globe (and the cinematic camera) can be watched, and expands back.

const STEPS = ["Detected", "Analysis", "Negotiation", "Decision", "Scheduling", "Verification"];

function stepOf(e: ConjunctionEvent) {
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

export function setIncidentView(v: "expanded" | "collapsed") {
  if (useOps.getState().incidentView === v) return;
  sfx.whoosh();
  useOps.setState({ incidentView: v });
}

export function IncidentView() {
  const incident = useOps((s) => s.incident);
  const view = useOps((s) => s.incidentView);
  const tab = useOps((s) => s.tab);
  const resolvedOpen = useOps((s) => s.resolved?.eventId === s.incident);
  const e = useOps((s) => s.events.find((x) => x.id === s.incident));
  const now = useNow(250);
  const room = useRoomState(e, now);
  const show = !!incident && !!e && tab === "conjunctions" && !resolvedOpen;

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
          <Header e={e!} now={now} decide={room.state?.mode === "decide"} />
          <Stepper e={e!} />
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(290px,1fr)_minmax(380px,1.4fr)_minmax(290px,0.95fr)]">
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

function Header({ e, now, decide }: { e: ConjunctionEvent; now: number; decide: boolean }) {
  const red = e.risk === "red";
  return (
    <div className="flex items-center gap-3 px-5 pb-3 pt-4">
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: red ? "#ff8a80" : "var(--amber)", background: red ? "rgba(255,90,79,0.12)" : "rgba(245,196,81,0.12)", boxShadow: `inset 0 0 0 1px ${red ? "rgba(255,90,79,0.35)" : "rgba(245,196,81,0.3)"}` }}
      >
        <ShieldAlert size={11} /> {red ? "High priority" : "Watch"}
      </span>
      <span className="mono shrink-0 text-[11px] text-muted">{e.id}</span>
      <div className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold">
        <ObjectChip e={e} side="a" />
        <span className="text-faint">×</span>
        <ObjectChip e={e} side="b" />
      </div>
      {decide && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[rgba(255,159,64,0.14)] px-2 py-0.5 text-[10.5px] font-semibold text-orange shadow-[inset_0_0_0_1px_rgba(255,159,64,0.35)]">
          <span className="pulse-dot" style={{ width: 5, height: 5 }} /> Your decision is needed
        </span>
      )}
      <div className="ml-auto text-right">
        <div className="mono tnum text-[18px] font-semibold leading-none tracking-[-0.02em]" style={{ color: e.tca - now < 24 * 3600_000 ? "var(--orange)" : "var(--fg)" }}>
          {now ? fmtCountdown(e.tca - now) : "—"}
        </div>
        <div className="mt-1 text-[10px] text-muted">to closest approach · {fmtWhen(e.tca)}</div>
      </div>
      <Tooltip label="Show the globe; the case keeps running" hint="E">
        <button className="btn btn-ghost-line h-8 gap-1.5 px-2.5 text-[11.5px]" onClick={() => setIncidentView("collapsed")}>
          <Minimize2 size={12} /> Globe view
        </button>
      </Tooltip>
    </div>
  );
}

function Stepper({ e }: { e: ConjunctionEvent }) {
  const cur = stepOf(e);
  const working = e.agentsWorking;
  return (
    <div className="flex items-center gap-1 border-y border-white/[0.06] px-5 py-2.5">
      {STEPS.map((label, i) => {
        const done = i < cur;
        const active = i === cur;
        return (
          <div key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold transition-colors duration-500"
              style={{
                background: done ? "var(--green)" : active ? "rgba(79,140,255,0.18)" : "rgba(255,255,255,0.05)",
                color: done ? "#000" : active ? "var(--blue)" : "var(--faint)",
                boxShadow: active ? "inset 0 0 0 1.5px var(--blue), 0 0 14px -2px rgba(79,140,255,0.6)" : "inset 0 0 0 1px rgba(255,255,255,0.08)",
              }}
            >
              {done ? <Check size={11} strokeWidth={3} /> : active && working ? <Loader2 size={11} className="animate-spin" /> : i + 1}
            </span>
            <span className={`truncate text-[12px] ${done ? "text-neutral-400" : active ? "font-semibold text-white" : "text-neutral-600"}`}>{label}</span>
            {i < STEPS.length - 1 && (
              <span className="relative mx-1 h-px flex-1 overflow-hidden bg-white/[0.08]">
                <motion.span className="absolute inset-y-0 left-0 bg-green" initial={false} animate={{ width: done ? "100%" : "0%" }} transition={{ duration: 0.6 }} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ case */

function CaseColumn({ e }: { e: ConjunctionEvent }) {
  const now = useNow(1000);
  const cross = engine.encounters.get(e.id)?.crossDeg;
  const lat = `${Math.abs(Math.round(e.where.lat))}°${e.where.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(Math.round(e.where.lon))}°${e.where.lon >= 0 ? "E" : "W"}`;
  const red = e.risk === "red";
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto border-r border-white/[0.06] px-6 py-5">
      {/* the headline says the whole incident in one line */}
      <h2 className="text-[21px] font-semibold leading-[1.3] tracking-[-0.02em] text-white">
        <ObjectChip e={e} side="a" /> passes <span className="tnum">{fmtMiss(e.missM)}</span> from <ObjectChip e={e} side="b" />
      </h2>
      <p className="tnum mt-2 text-[13px] leading-relaxed text-neutral-400">
        {fmtWhen(e.tca)} · over {lat} {lon} at {Math.round(e.where.altKm)} km
      </p>

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
        <Fact label="Probability of collision" value={fmtPc(e.pc)} tone={red ? "var(--red)" : "var(--amber)"} note={`${e.pcSource} · ${e.trend}`} />
        <Fact label="Miss distance" value={fmtMiss(e.missM)} note={`±${fmtMiss(e.uncertaintyM)} between data sources`} />
        <Fact label="Relative speed" value={`${e.relVelKms.toFixed(1)} km/s`} note={cross ? `crossing at ${cross}°` : undefined} />
        <Fact label="Until closest approach" value={now ? fmtCountdown(e.tca - now).replace("T−", "") : "—"} note={red ? "inside the 72 h action window" : undefined} />
      </div>

      <div className="mt-6">
        <PcChart e={e} />
      </div>

      <Section title="Analyst notes" note={`${AGENTS.analyst.name} · ${MODELS[AGENTS.analyst.model].label}`}>
        {e.summary ? (
          <ul className="space-y-2.5">
            {e.summary.slice(1).map((l, i) => (
              <li key={i} className="flex gap-2.5 text-[13.5px] leading-[1.6] text-neutral-300">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
                <span>
                  <RichLine e={e} text={l} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="shimmer text-[13px] font-medium">The Incident Analyst is reading both orbits…</div>
        )}
      </Section>

      <Section title="Parties">
        <PartyList e={e} />
      </Section>

      {e.proposal && (
        <Section title={`Current plan · v${e.proposal.version}`}>
          <PlanSummary e={e} />
        </Section>
      )}
    </div>
  );
}

function Fact({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-neutral-500">{label}</div>
      <div className="tnum mt-1 text-[24px] font-semibold leading-none tracking-[-0.025em]" style={{ color: tone ?? "#fff" }}>
        {value}
      </div>
      {note && <div className="mt-1.5 text-[11.5px] text-neutral-500">{note}</div>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-baseline justify-between border-b border-white/[0.06] pb-2">
        <span className="text-[12px] font-semibold text-neutral-200">{title}</span>
        {note && <span className="text-[11px] text-neutral-600">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function PartyList({ e }: { e: ConjunctionEvent }) {
  const parties: Party[] = e.parties ?? [];
  return (
    <div className="space-y-3">
      {parties.map((p) => {
        const state = p.role === "affected" ? "notified" : e.approvals[p.role];
        const label = state === "vetoed" ? "Rejected" : state === "pending" ? "Waiting" : state.charAt(0).toUpperCase() + state.slice(1);
        const color = state === "approved" || state === "notified" ? "var(--green)" : state === "vetoed" ? "var(--red)" : state === "countered" ? "var(--orange)" : "#737373";
        return (
          <div key={p.id} className="flex items-center gap-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
              {p.country && <Flag code={p.country} h={28} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-white">{p.operator.replace(/\s*\(synthetic\)/i, "")}</div>
              <div className="text-[11.5px] text-neutral-500">
                {p.role === "affected" ? "Affected operator" : `Side ${p.role.toUpperCase()}`}
                {p.language ? ` · ${p.language}` : ""}
              </div>
            </div>
            <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
          </div>
        );
      })}
      {e.b.kind === "debris" && <div className="text-[12px] text-neutral-500">Debris has no operator. This is a single-operator avoidance.</div>}
    </div>
  );
}

function PlanSummary({ e }: { e: ConjunctionEvent }) {
  const p = e.proposal!;
  const t = optionText(e, p);
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-[15px] font-semibold text-white">
        {t.verb} {t.who ? <ObjectChip e={e} side={t.who} /> : "for the next CDM"}
        {p.action !== "wait" && <span className="tnum font-normal text-neutral-400">by {p.dvMs} m/s</span>}
      </div>
      <div className="tnum mt-2 flex items-baseline gap-2 text-[13px] text-neutral-400">
        Miss <span className="text-neutral-500 line-through decoration-neutral-600">{fmtMiss(p.missBeforeM)}</span>
        <span className="text-[18px] font-semibold text-white">{fmtMiss(p.missAfterM)}</span>
        {p.burnAt && <span className="ml-auto">burn {fmtWhen(p.burnAt)}</span>}
      </div>
      <p className="mt-2 text-[13px] leading-[1.6] text-neutral-400">{p.rationale}</p>
      {p.reason && <p className="mt-1.5 text-[12px] text-orange">Revised: {p.reason}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- center */

function CenterColumn({ e, now, room }: { e: ConjunctionEvent; now: number; room: ReturnType<typeof useRoomState> }) {
  const st = room.state;
  return (
    <div className="flex min-h-0 flex-col border-r border-white/[0.06]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={st?.mode ?? "live"}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {st?.mode === "decide" ? (
            <div className="overflow-hidden rounded-[14px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,159,64,0.35),0_0_40px_-12px_rgba(255,159,64,0.4)]">
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
            <Live e={e} />
          )}
          <Transcript e={e} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-[14px] bg-white/[0.03] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">{children}</div>;
}

const VERB: Record<Span["kind"], string> = {
  llm: "is thinking",
  tool: "is running a tool",
  http: "is fetching data",
  handoff: "is handing off",
  human: "is calling",
  check: "is checking the numbers",
};

/** What is happening right now, in one big readable line plus the streamed reasoning. */
function Live({ e }: { e: ConjunctionEvent }) {
  const spans = useOps((s) => s.spans);
  const span = useMemo(() => {
    const mine = spans.filter((s) => s.eventId === e.id);
    for (let i = mine.length - 1; i >= 0; i--) if (mine[i].status === "running") return mine[i];
    return mine[mine.length - 1] ?? null;
  }, [spans, e.id]);
  if (!span) {
    return <div className="shimmer py-6 text-center text-[13px] font-medium">Waking the agents…</div>;
  }
  const agent = AGENTS[span.agent];
  const running = span.status === "running";
  const text = span.reasoning ?? "";
  const shown = running ? text.slice(0, Math.ceil(text.length * Math.min(span.progress * 1.12, 1))) : text;
  return (
    <div>
      <div className="mb-3 text-[12px] font-semibold text-neutral-500">Now</div>
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#16171b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
          style={running ? { boxShadow: "inset 0 0 0 1px rgba(79,140,255,0.5), 0 0 22px -4px rgba(79,140,255,0.7)" } : undefined}
        >
          <ModelGlyph model={span.model ?? agent.model} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[18px] font-semibold leading-snug tracking-[-0.015em] text-white">
            {agent.name} <span className="font-normal text-neutral-400">{running ? VERB[span.kind] : "finished"}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-neutral-500">
            {running && <Loader2 size={11} className="animate-spin text-blue" />}
            {span.name} <span className="text-faint">→ {nodeLabel(span.target)}</span>
          </div>
        </div>
      </div>
      {text && (
        <p className={`mt-4 border-l-2 border-white/15 pl-4 text-[15px] leading-[1.7] text-neutral-200 ${running ? "caret" : ""}`}>
          <RichLine e={e} text={shown} />
        </p>
      )}
    </div>
  );
}

type Line = { t: number; side: "a" | "b" | "host"; who: string; text: string; human?: boolean; reply?: Reply };

/** The negotiation as a conversation: both advocates, the host, and the people's answers. */
function Transcript({ e }: { e: ConjunctionEvent }) {
  const spans = useOps((s) => s.spans);
  const replies = useOps((s) => s.replies);
  const lines = useMemo(() => {
    const out: Line[] = [];
    for (const s of spans) {
      if (s.eventId !== e.id || s.status === "running") continue;
      if ((s.agent === "advocateA" || s.agent === "advocateB") && s.kind === "llm" && s.reasoning) {
        out.push({ t: s.t0, side: s.agent === "advocateA" ? "a" : "b", who: AGENTS[s.agent].name, text: s.reasoning });
      }
    }
    for (const r of replies) {
      if (r.eventId !== e.id) continue;
      const verdict = r.decision === "approved" ? "Approved" : r.decision === "vetoed" ? "Rejected" : "Countered";
      out.push({ t: r.t, side: r.side, who: `Operator ${r.side.toUpperCase()}`, text: `${verdict} v${r.version ?? ""}${r.note ? `: “${r.note}”` : "."}`, human: true, reply: r });
    }
    return out.sort((x, y) => x.t - y.t);
  }, [spans, replies, e.id]);
  if (!lines.length) return null;
  const flag = (side: "a" | "b") => e.parties?.find((p) => p.role === side)?.country ?? null;
  return (
    <div className="mt-5">
      <div className="mb-3 border-b border-white/[0.06] pb-2 text-[12px] font-semibold text-neutral-200">Negotiation</div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const right = l.side === "b";
          const f = l.side === "host" ? null : flag(l.side);
          return (
            <motion.div
              key={`${l.t}-${i}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className={`flex items-end gap-2 ${right ? "flex-row-reverse" : ""}`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
                {f ? <Flag code={f} h={24} /> : null}
              </span>
              <div
                className={`max-w-[84%] rounded-[16px] px-3.5 py-2.5 ${right ? "rounded-br-[4px]" : "rounded-bl-[4px]"}`}
                style={{ background: l.human ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.035)" }}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-neutral-500">
                  {l.who}
                  {l.human && (
                    <span style={{ color: l.reply?.decision === "approved" ? "var(--green)" : l.reply?.decision === "vetoed" ? "var(--red)" : "var(--orange)" }}>
                      · {l.reply?.decision === "approved" ? "approved" : l.reply?.decision === "vetoed" ? "rejected" : "countered"}
                    </span>
                  )}
                </div>
                <div className="text-[13.5px] leading-[1.6] text-neutral-200">
                  <RichLine e={e} text={l.text} />
                </div>
                {l.reply?.original && (
                  <div className="mt-1.5 text-[12px] text-neutral-500">
                    {l.reply.lang}: “{l.reply.original}”
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- agents */

function AgentsColumn() {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-4">
        <div className="eyebrow mb-1">Agents</div>
        <AgentGraph />
      </div>
      <div className="mx-5 mb-1.5 mt-1 flex items-center gap-2">
        <span className="eyebrow">Calls</span>
        <span className="h-px flex-1 bg-white/[0.05]" />
      </div>
      <CallFeed className="flex-1" />
    </div>
  );
}

/* ------------------------------------------------------------- collapsed */

function CollapsedBar({ e, now, decide }: { e: ConjunctionEvent; now: number; decide: boolean }) {
  const step = STEPS[Math.min(stepOf(e), STEPS.length - 1)];
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.97 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="glass glass-strong pointer-events-auto absolute bottom-[98px] left-1/2 z-[38] flex h-12 -translate-x-1/2 items-center gap-3 rounded-[14px] pl-3 pr-1.5"
      style={decide ? { boxShadow: "0 0 0 1px rgba(255,159,64,0.45), 0 0 30px -8px rgba(255,159,64,0.6)" } : undefined}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.risk === "red" ? "var(--red)" : "var(--amber)", boxShadow: `0 0 8px ${e.risk === "red" ? "var(--red)" : "var(--amber)"}` }} />
      <span className="mono text-[10.5px] text-muted">{e.id}</span>
      <span className="flex items-center gap-1">
        <ObjectChip e={e} side="a" size="sm" />
        <span className="text-faint">×</span>
        <ObjectChip e={e} side="b" size="sm" />
      </span>
      <span className="h-4 w-px bg-white/10" />
      {decide ? (
        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-orange">
          <span className="pulse-dot" style={{ width: 5, height: 5 }} /> Your decision is needed
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
          {e.agentsWorking && <Loader2 size={11} className="animate-spin text-blue" />}
          {step}
        </span>
      )}
      <span className="mono tnum text-[11.5px] text-fg">{now ? fmtCountdown(e.tca - now) : ""}</span>
      <Tooltip label="Back to the case" hint="E">
        <button className={`btn h-8 gap-1.5 px-2.5 text-[11.5px] ${decide ? "btn-primary" : "btn-ghost-line"}`} onClick={() => setIncidentView("expanded")}>
          <Maximize2 size={12} /> Open case
        </button>
      </Tooltip>
    </motion.div>
  );
}
