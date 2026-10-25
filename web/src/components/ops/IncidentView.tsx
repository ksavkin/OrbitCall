"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, Maximize2, Minimize2, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { fmtCountdown, fmtMiss, fmtPc, fmtWhen } from "@/lib/ops/format";
import { AGENTS, MODELS, nodeLabel } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party, Reply, Span } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentGraph } from "./AgentGraph";
import { CallFeed } from "./AgentTrace";
import { PcChart, ProposalCard } from "./ConjunctionQueue";
import { Decide, Done, TheirReply, Waiting, useRoomState } from "./DecisionDock";
import { Brief, ObjectChip, RichLine } from "./Entity";
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
          className="glass glass-strong pointer-events-auto absolute inset-x-2.5 bottom-[42px] top-[58px] z-[38] flex flex-col overflow-hidden rounded-[18px]"
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
            <span className={`truncate text-[11px] ${done ? "text-fg-2" : active ? "font-semibold text-fg" : "text-faint"}`}>{label}</span>
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
  return (
    <div className="thin-scroll min-h-0 space-y-4 overflow-y-auto border-r border-white/[0.06] px-5 py-4">
      <Block title="Incident brief" note={`${AGENTS.analyst.name} · ${MODELS[AGENTS.analyst.model].label}`}>
        {e.summary ? (
          <Brief e={e} lines={e.summary} skipOptions />
        ) : (
          <div className="shimmer py-2 text-[12px] font-medium">The Incident Analyst is reading both orbits…</div>
        )}
      </Block>

      <div className="grid grid-cols-4 overflow-hidden rounded-[10px] bg-white/[0.025] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
        <Metric k="Miss" v={fmtMiss(e.missM)} sub={`±${fmtMiss(e.uncertaintyM)}`} />
        <Metric k="Pc" v={fmtPc(e.pc)} sub={e.pcSource} tone={e.risk === "red" ? "var(--red)" : "var(--amber)"} />
        <Metric k="Speed" v={`${e.relVelKms.toFixed(1)}`} sub="km/s" />
        <Metric k="Altitude" v={`${Math.round(e.where.altKm)}`} sub="km" />
      </div>

      <PcChart e={e} />

      <Block title="Parties">
        <PartyList e={e} />
      </Block>

      {e.proposal && (
        <div>
          <ProposalCard e={e} p={e.proposal} />
        </div>
      )}
    </div>
  );
}

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">{title}</span>
        {note && <span className="text-[9.5px] text-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Metric({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div className="border-l border-white/[0.055] px-2.5 py-2 first:border-l-0">
      <div className="text-[9.5px] text-muted">{k}</div>
      <div className="mono tnum mt-0.5 text-[14px] font-semibold" style={{ color: tone }}>
        {v}
      </div>
      {sub && <div className="mono truncate text-[9px] text-faint">{sub}</div>}
    </div>
  );
}

function PartyList({ e }: { e: ConjunctionEvent }) {
  const parties: Party[] = e.parties ?? [];
  return (
    <div className="space-y-1.5">
      {parties.map((p) => {
        const state = p.role === "affected" ? "notified" : e.approvals[p.role];
        const color = state === "approved" || state === "notified" ? "var(--green)" : state === "vetoed" ? "var(--red)" : state === "countered" ? "var(--orange)" : "var(--muted)";
        return (
          <div key={p.id} className="flex items-center gap-2.5 rounded-[9px] bg-white/[0.03] px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
            <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-[6px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
              {p.country && <Flag code={p.country} h={24} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium">{p.operator.replace(/\s*\(synthetic\)/i, "")}</div>
              <div className="text-[10px] text-muted">
                {p.role === "affected" ? "Affected operator" : `Side ${p.role.toUpperCase()}`}
                {p.language ? ` · ${p.language}` : ""}
              </div>
            </div>
            <span className="text-[10.5px] font-medium capitalize" style={{ color }}>
              {state === "vetoed" ? "rejected" : state}
            </span>
          </div>
        );
      })}
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
      <div className="eyebrow mb-2">Now</div>
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#16171b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
          style={running ? { boxShadow: "inset 0 0 0 1px rgba(79,140,255,0.5), 0 0 22px -4px rgba(79,140,255,0.7)" } : undefined}
        >
          <ModelGlyph model={span.model ?? agent.model} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold leading-snug tracking-[-0.01em]">
            {agent.name} <span className="font-normal text-fg-2">{running ? VERB[span.kind] : "finished"}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
            {running && <Loader2 size={11} className="animate-spin text-blue" />}
            {span.name} <span className="text-faint">→ {nodeLabel(span.target)}</span>
          </div>
        </div>
      </div>
      {text && (
        <p className={`mt-3 rounded-[12px] bg-white/[0.03] p-3.5 text-[13px] leading-[1.65] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] ${running ? "caret" : ""}`}>
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
      <div className="eyebrow mb-2">Negotiation</div>
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
                className={`max-w-[82%] rounded-[12px] px-3 py-2 ${right ? "rounded-br-[4px]" : "rounded-bl-[4px]"}`}
                style={{
                  background: l.human ? (l.reply?.decision === "approved" ? "rgba(61,220,151,0.1)" : "rgba(255,90,79,0.1)") : right ? "rgba(255,159,64,0.07)" : "rgba(79,140,255,0.08)",
                  boxShadow: `inset 0 0 0 1px ${l.human ? (l.reply?.decision === "approved" ? "rgba(61,220,151,0.3)" : "rgba(255,90,79,0.3)") : "rgba(255,255,255,0.07)"}`,
                }}
              >
                <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">
                  {l.who}
                  {l.human && " · person"}
                </div>
                <div className="text-[12px] leading-[1.55] text-fg-2">
                  <RichLine e={e} text={l.text} />
                </div>
                {l.reply?.original && (
                  <div className="mt-1 text-[10.5px] italic text-muted">
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
