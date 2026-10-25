"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRightLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Globe,
  Loader2,
  Minus,
  Radar,
  RotateCw,
  ShieldCheck,
  Sparkle,
  TriangleAlert,
  User,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { advocatesRerunRef, agentsRerunRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { useLive, useRealMode } from "@/lib/backend/live";
import { mutate } from "@/lib/backend/run";
import type { PublicSpan, Side } from "@/lib/backend/types";
import { fmtMs, fmtTokens, fmtUsd } from "@/lib/ops/format";
import { AGENTS, MODELS, nodeLabel, type AgentInfo } from "@/lib/ops/roster";
import { isPatrolRoot } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { AgentId, LogLine, Span, SpanKind, SpanStatus } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Chip } from "@/components/ui/Chip";
import { ModelGlyph } from "./Glyphs";
import { AGENT_HUE, EDGE, KIND_LABEL } from "./meta";

const KIND_ICON: Record<SpanKind, LucideIcon> = {
  llm: Sparkle,
  tool: Wrench,
  http: Globe,
  handoff: ArrowRightLeft,
  human: User,
  check: ShieldCheck,
};

/* ------------------------------------------------------------ real mode */

// Real mode (wiring map §4): useOps.spans and useOps.logs hold backend spans adapted to the simulator shape. A real
// span keeps the backend's `output` metadata and has no reasoning, input, http or streamed progress, so nothing types.

type RealOutput = PublicSpan["output"];

/** The backend's run metadata on an adapted span, or null when the span doesn't carry it. */
function realOutput(s: Span): RealOutput | null {
  const o = s.output;
  if (typeof o !== "object" || o === null || !("details" in o) || o.details !== "not_exposed") return null;
  return "runStatus" in o && typeof o.runStatus === "string" ? (o as RealOutput) : null;
}

/** The roster entry for a span's agent; an adapted backend span may name one the roster doesn't know. */
const agentInfo = (id: string): AgentInfo | undefined => (id in AGENTS ? AGENTS[id as AgentId] : undefined);

/** Recorded model ids ("claude-sonnet-4-5-20250929") aren't all in the roster: show the id itself. */
const modelLabel = (model: string) => MODELS[model]?.label ?? model;

/** "summary_requested" → "Summary requested". */
const humanize = (v: string) => (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, " ");

/** The backend returns newest first; the views read oldest first, like the simulator writes them. */
const byStart = (spans: Span[]) => [...spans].sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));

/** The backend titles a run "Incident Analyst · failed"; the pill shows the status, so the title says what ran. */
function stepTitle(s: Span, out: RealOutput) {
  const title = s.name.replace(/ · (running|succeeded|failed|superseded|stalled)$/, "");
  const detail = out.trigger ?? out.stage;
  return detail && !title.toLowerCase().includes(humanize(detail).toLowerCase()) ? `${title} · ${humanize(detail)}` : title;
}

/** How long a step took, or has taken so far; null when a real run ended without a recorded end time. */
function elapsedOf(s: Span, now: number, out: RealOutput | null): number | null {
  if (s.status !== "running" && s.ms !== undefined) return s.ms;
  if (s.status === "running" || out?.runStatus === "running") return now ? Math.max(now - s.t0, 0) : 0;
  return out ? null : 0;
}

const fmtElapsed = (ms: number | null) => (ms === null ? "—" : fmtMs(ms));

/** Real mode with nothing to list: the case's runs are loading, failed to load, or none exist yet. */
function RealEmpty({ field, idle }: { field: "spans" | "agentLogs"; idle: string }) {
  const error = useLive((l) => l.errors.agents);
  const loaded = useLive((l) => l[field] !== undefined);
  const caseOpen = useOps((s) => s.incident !== null);
  if (error) {
    return (
      <div>
        <div className="font-sans text-[11.5px] font-medium text-fg-2">Couldn’t load agent runs</div>
        <p className="mono mt-1 break-words text-[10px] leading-[1.5] text-muted">{error}</p>
        <button
          className="btn btn-ghost-line mt-2.5 h-6 font-sans text-[11px]"
          onClick={() => {
            sfx.click();
            useLive.setState((l) => ({ epoch: l.epoch + 1 }));
          }}
        >
          <RotateCw size={11} /> Retry
        </button>
      </div>
    );
  }
  if (loaded) return <>{idle}</>;
  return <>{caseOpen ? "Loading agent runs" : "Open a case to see its agent runs."}</>;
}

/** A vendor mark only for a model its id names; Gemini and unrecorded models show the step's icon instead. */
function RealGlyph({ s }: { s: Span }) {
  const model = s.model ?? "";
  if (model.startsWith("claude")) return <ModelGlyph model={model} size={13} />;
  if (model.startsWith("grok")) return <ModelGlyph model="grok" size={13} />;
  const Icon = KIND_ICON[s.kind];
  return <Icon size={12} className="text-muted" />;
}

/** What a real span exposes: its run state and metadata. The backend keeps the model's output out of the trace. */
function RealBody({ s, out }: { s: Span; out: RealOutput | null }) {
  const retry = useRetry(s, out);
  return (
    <>
      {s.error && <div className="mb-1.5 rounded-[6px] bg-[rgba(255,90,79,0.08)] px-2 py-1 text-red">{s.error}</div>}
      {out && <RunFacts out={out} />}
      <p className="leading-[1.5] text-muted">Detailed output is not exposed in the trace.</p>
      {retry && <RetryRun key={s.id} target={retry} />}
    </>
  );
}

/* ---------------------------------------------------------------- retry */

type RetryTarget = { kind: "analyst" | "host" | "advocate"; eventId: string };

/** The run a span belongs to, for a retry: the Analyst's summary run, the Host, or an Advocate. Rationale steps have none. */
function runKind(s: Span, out: RealOutput): RetryTarget["kind"] | null {
  if (s.agent === "host" && out.trigger !== undefined) return "host";
  // candidate explanations also run as the Analyst, but always carry an attempt; agents.rerun doesn't restart them
  if (s.agent === "analyst" && out.attempt === undefined) return "analyst";
  if (s.agent === "advocateA" || s.agent === "advocateB") return "advocate";
  return null;
}

/** The caller's side in an incident, from whichever real-mode read has it. */
function useMySide(eventId: string | null): Side | null {
  const approvals = useLive((l) => l.approvals);
  const inbox = useLive((l) => l.inbox);
  const queue = useLive((l) => l.myQueue);
  if (!eventId) return null;
  if (approvals?.eventId === eventId && approvals.mySide) return approvals.mySide;
  return inbox?.find((e) => e.eventId === eventId)?.mySide ?? queue?.find((r) => r.eventId === eventId)?.mySide ?? null;
}

/**
 * Retry is offered on the newest run of its kind when that run failed or stalled: the Analyst or the Host
 * (agents.rerun), or this side's own Advocate (advocates.rerun). An older failed run has nothing left to retry.
 */
function useRetry(s: Span, out: RealOutput | null): RetryTarget | null {
  const spans = useOps((st) => st.spans);
  const mySide = useMySide(s.eventId);
  return useMemo(() => {
    const kind = out ? runKind(s, out) : null;
    if (!kind || !out || !s.eventId) return null;
    if (out.runStatus !== "failed" && !(out.runStatus === "running" && out.stalled)) return null;
    if (kind === "advocate" && s.agent !== (mySide === "A" ? "advocateA" : mySide === "B" ? "advocateB" : null)) return null;
    const newer = spans.some((o) => {
      const oo = o.id !== s.id && o.eventId === s.eventId && o.agent === s.agent && o.t0 > s.t0 ? realOutput(o) : null;
      return oo !== null && runKind(o, oo) === kind;
    });
    return newer ? null : { kind, eventId: s.eventId };
  }, [s, out, spans, mySide]);
}

function RetryRun({ target }: { target: RetryTarget }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (state !== "idle") return;
    sfx.click();
    setState("busy");
    setError(null);
    try {
      if (target.kind === "advocate") await mutate(advocatesRerunRef, { eventId: target.eventId });
      else await mutate(agentsRerunRef, { eventId: target.eventId, role: target.kind === "host" ? "coordination_host" : "incident_analyst" });
      setState("sent");
    } catch (e) {
      // INVALID_STATE (still running, already queued, inputs changed), FORBIDDEN, RETRY_LIMIT: the message says which
      setError(backendError(e).message);
      setState("idle");
    }
  };
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <button className="btn btn-ghost-line h-6 shrink-0 px-2 text-[11px] disabled:opacity-40" disabled={state !== "idle"} onClick={() => void run()}>
        {state === "busy" ? <Loader2 size={11} className="animate-spin" /> : state === "sent" ? <Check size={11} /> : <RotateCw size={11} />}
        {state === "sent" ? "Retry requested" : "Retry"}
      </button>
      {error && <span className="min-w-0 text-[11px] leading-[1.4] text-orange">{error}</span>}
    </div>
  );
}

function RunFacts({ out }: { out: RealOutput }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Fact k="Run" v={humanize(out.runStatus)} />
      {out.callStatus && out.callStatus !== out.runStatus && <Fact k="Call" v={humanize(out.callStatus)} />}
      {out.stage && <Fact k="Stage" v={humanize(out.stage)} />}
      {out.trigger && <Fact k="Trigger" v={humanize(out.trigger)} />}
      {out.attempt !== undefined && <Fact k="Attempt" v={String(out.attempt)} mono />}
      {out.candidateId && <Fact k="Candidate" v={out.candidateId} mono />}
      {out.stalled && (
        <Chip color="var(--orange)" size="sm" icon={<TriangleAlert size={9} />}>
          Stalled
        </Chip>
      )}
      {out.numbersChecked && (
        <Chip color="var(--green)" size="sm" icon={<ShieldCheck size={9} />}>
          Numbers checked
        </Chip>
      )}
      {out.simulated && (
        <Chip color="var(--orange)" size="sm">
          Simulated
        </Chip>
      )}
    </div>
  );
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <span className="min-w-0 truncate">
      <span className="text-muted">{k}</span> <span className={`text-fg-2 ${mono ? "mono tnum" : ""}`}>{v}</span>
    </span>
  );
}

/* ------------------------------------------------------------ call feed */

type FeedItem = { id: string; span: Span; pass?: Span[] };

/**
 * Every call as a card, newest on top. Cards slide in and push the older ones down.
 * The list sticks to the top while you're there; scroll down to read and it stays put,
 * with a pill to jump back to the newest.
 */
export function CallFeed({ className = "", eventId }: { className?: string; eventId?: string }) {
  const real = useRealMode();
  const spans = useOps((s) => s.spans);
  const focusAgent = useOps((s) => s.focusAgent);
  const focusSpan = useOps((s) => s.focusSpan);
  const now = useNow(200);

  const items = useMemo(() => {
    const out: FeedItem[] = [];
    const passes = new Map<string, FeedItem>();
    for (const s of real ? byStart(spans) : spans) {
      if (focusAgent && s.agent !== focusAgent && s.target !== focusAgent) continue;
      // inside a case: only that case's calls, no background passes
      if (eventId && s.eventId !== eventId) continue;
      // a background screening pass is one card, not five
      if (isPatrolRoot(s)) {
        const it: FeedItem = { id: s.id, span: s, pass: [s] };
        passes.set(s.id, it);
        out.push(it);
        continue;
      }
      if (s.parent && passes.has(s.parent)) {
        passes.get(s.parent)!.pass!.push(s);
        continue;
      }
      out.push({ id: s.id, span: s });
    }
    return out.slice(-80).reverse();
  }, [spans, real, focusAgent, eventId]);

  const box = useRef<HTMLDivElement>(null);
  const atTop = useRef(true);
  const seen = useRef(items[0]?.id);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      atTop.current = el.scrollTop < 24;
      if (atTop.current) setUnseen(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const newest = items[0]?.id;
  useEffect(() => {
    if (!newest || newest === seen.current) return;
    const idx = items.findIndex((i) => i.id === seen.current);
    seen.current = newest;
    const el = box.current;
    if (!el) return;
    if (atTop.current) el.scrollTo({ top: 0, behavior: "smooth" });
    else setUnseen((n) => n + (idx < 0 ? 1 : idx));
  }, [newest, items]);

  // the newest real call stays open; background passes don't count
  const firstCall = items.findIndex((i) => !i.pass);

  if (!items.length) {
    return (
      <div className={`px-3 py-6 text-center text-[11px] text-muted ${className}`}>
        {real ? <RealEmpty field="spans" idle={eventId ? "No agent runs for this case yet." : "No agent runs yet."} /> : "Agents are idle. They wake on red events only."}
      </div>
    );
  }

  return (
    <div className={`relative min-h-0 ${className}`}>
      <AnimatePresence>
        {unseen > 0 && (
          <motion.button
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="absolute left-1/2 top-1.5 z-10 flex h-[22px] -translate-x-1/2 items-center gap-1 rounded-full bg-blue px-2.5 text-[10.5px] font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,140,255,0.6)]"
            onClick={() => {
              box.current?.scrollTo({ top: 0, behavior: "smooth" });
              setUnseen(0);
            }}
          >
            <ArrowUp size={10} /> {unseen} new {unseen === 1 ? "call" : "calls"}
          </motion.button>
        )}
      </AnimatePresence>
      <div ref={box} className="thin-scroll h-full overflow-y-auto px-3 pb-3 pt-0.5 [overflow-anchor:none]">
        <AnimatePresence initial={false}>
          {items.map((it, k) => (
            <motion.div
              key={it.id}
              // grow in from zero height so older cards slide down instead of jumping
              initial={{ opacity: 0, height: 0, y: -10 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="pb-1.5">
                {it.pass ? (
                  <PassCard steps={it.pass} now={now} />
                ) : (
                  <CallCard s={it.span} now={now} real={real} open={focusSpan === it.id || it.span.status === "running" || k === firstCall} />
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Streamed text that never changes the box height: the full text reserves the space
 * invisibly and the visible part is drawn on top of it.
 */
export function StreamText({ full, shown, running, className = "" }: { full: string; shown: string; running: boolean; className?: string }) {
  return (
    <p className={`relative ${className}`}>
      <span aria-hidden className="invisible">
        {full}
      </span>
      <span className={`absolute inset-0 ${running ? "caret" : ""}`}>{shown}</span>
    </p>
  );
}

/** Stay open a moment after losing "newest", so the new card slides in before the old one folds. */
function useLingeringOpen(open: boolean) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening is immediate, closing waits for the incoming card
    if (open) setShown(true);
    else {
      const t = setTimeout(() => setShown(false), 420);
      return () => clearTimeout(t);
    }
  }, [open]);
  return shown;
}

function CallCard({ s, now, real, open: wantOpen }: { s: Span; now: number; real: boolean; open: boolean }) {
  const open = useLingeringOpen(wantOpen);
  const out = real ? realOutput(s) : null;
  const agent = agentInfo(s.agent);
  const model = s.model ? MODELS[s.model] : null;
  const running = s.status === "running";
  const elapsed = elapsedOf(s, now, out);
  const Icon = KIND_ICON[s.kind];
  return (
    <div
      className="overflow-hidden rounded-[11px] bg-white/[0.03] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-shadow duration-300"
      style={
        running
          ? {
              boxShadow: `inset 0 0 0 1px rgba(79,140,255,0.35), 0 0 18px -8px ${EDGE.call}`,
            }
          : s.status === "error"
            ? { boxShadow: "inset 0 0 0 1px rgba(255,90,79,0.35)" }
            : undefined
      }
    >
      <button
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.03]"
        onClick={() => {
          sfx.click();
          const st = useOps.getState();
          st.set({ focusSpan: st.focusSpan === s.id ? null : s.id });
        }}
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[#16171b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
          {real ? <RealGlyph s={s} /> : <ModelGlyph model={s.kind === "llm" || s.kind === "human" ? (s.model ?? agent?.model) : agent?.model} size={13} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium">{agent?.name ?? s.agent}</span>
            {real
              ? s.model && (
                  <span className="mono min-w-0 max-w-[140px] truncate rounded-[4px] bg-white/[0.05] px-1 text-[10px] text-fg-2" title={s.model}>
                    {modelLabel(s.model)}
                  </span>
                )
              : model && s.kind === "llm" && <span className="mono shrink-0 rounded-[4px] bg-white/[0.05] px-1 text-[10px] text-fg-2">{model.label}</span>}
          </span>
          <span className="flex items-center gap-1 truncate text-[11px] text-muted">
            <Icon size={9} className="shrink-0" />
            <span className="truncate">{out ? stepTitle(s, out) : s.name}</span>
            {!real && <span className="shrink-0 text-faint">→ {nodeLabel(s.target)}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <StatusIcon status={s.status} stalled={out?.stalled} compact />
          <span className="mono tnum text-[9.5px] text-muted">
            {fmtElapsed(elapsed)}
            {!real && s.costUsd !== undefined && !running && <span className="text-faint"> · {fmtUsd(s.costUsd)}</span>}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {real ? (
              <div className="px-2.5 pb-2 text-[11.5px]">
                <RealBody s={s} out={out} />
              </div>
            ) : (
              <SimBody s={s} running={running} />
            )}
            {s.tokensIn !== undefined &&
              (real ? (
                // the backend exposes no price (costUsd is always null), so there is no cost column
                <div className="grid grid-cols-3 border-t border-white/[0.05] text-[11px]">
                  <Stat k="In" v={fmtTokens(s.tokensIn)} />
                  <Stat k="Out" v={s.tokensOut === undefined ? "—" : fmtTokens(s.tokensOut)} />
                  <Stat k="Latency" v={fmtElapsed(elapsed)} />
                </div>
              ) : (
                <div className="grid grid-cols-4 border-t border-white/[0.05] text-[11px]">
                  <Stat k="In" v={fmtTokens(s.tokensIn)} hint={s.cacheRead ? `${fmtTokens(s.cacheRead)} cached` : undefined} />
                  <Stat k="Out" v={fmtTokens(Math.round((s.tokensOut ?? 0) * (running ? s.progress : 1)))} />
                  <Stat k="Latency" v={fmtElapsed(elapsed)} />
                  <Stat k="Cost" v={running ? "…" : fmtUsd(s.costUsd)} hint={s.costUsd === null ? "price not verified" : undefined} />
                </div>
              ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The simulator's call: the request, then the reasoning streamed as the call runs, or the output. */
function SimBody({ s, running }: { s: Span; running: boolean }) {
  const text = s.reasoning ?? "";
  // stream a little ahead of the clock so the text finishes as the call returns
  const shown = running ? text.slice(0, Math.ceil(text.length * Math.min(s.progress * 1.12, 1))) : text;
  return (
    <div className="px-2.5 pb-2">
      {s.http && (
        <div className="mono mb-1.5 flex min-w-0 items-center gap-1.5 text-[9.5px]">
          <span className="shrink-0 whitespace-nowrap rounded-[4px] bg-[rgba(79,140,255,0.14)] px-1 text-blue">{s.http.method}</span>
          <span className="min-w-0 truncate text-fg-2" title={s.http.url}>{s.http.url}</span>
          {s.http.status && <span className="ml-auto shrink-0 text-green">{s.http.status}</span>}
        </div>
      )}
      {s.error && <div className="mb-1.5 rounded-[6px] bg-[rgba(255,90,79,0.08)] px-2 py-1 text-[11.5px] text-red">{s.error}</div>}
      {!text && s.output === undefined && (
        <p className="text-[11.5px] leading-[1.5] text-muted">
          {s.kind === "handoff"
            ? `Hands the event to ${nodeLabel(s.target)}.`
            : s.kind === "human"
              ? `Calling ${nodeLabel(s.target)} into the room.`
              : `${KIND_LABEL[s.kind]} step on ${nodeLabel(s.target)}.`}
          {s.input !== undefined && <span className="mono mt-1 block break-all text-[11px] text-fg-2">{JSON.stringify(s.input)}</span>}
        </p>
      )}
      {text ? (
        <>
          <div className="eyebrow mb-1 flex items-center gap-1.5 !text-[10px]">
            Thinking · summarized
            {running && <span className="h-1 w-1 animate-pulse rounded-full bg-blue" />}
          </div>
          <StreamText full={text} shown={shown} running={running} className="text-[12px] leading-[1.55] text-fg-2" />
        </>
      ) : (
        s.output !== undefined && (
          <pre className="thin-scroll mono max-h-[110px] overflow-auto rounded-[7px] bg-black/30 p-2 text-[11px] leading-[1.5] text-fg-2">
            {JSON.stringify(s.output, null, 2)}
          </pre>
        )
      )}
    </div>
  );
}

function PassCard({ steps, now }: { steps: Span[]; now: number }) {
  const running = steps.some((s) => s.status === "running");
  const t0 = steps[0].t0;
  const t1 = running ? now : Math.max(...steps.map((s) => s.t1 ?? s.t0));
  const cost = steps.reduce((a, s) => a + (s.costUsd ?? 0), 0);
  const current = steps.filter((s) => s.status === "running").pop();
  return (
    <div className="flex items-center gap-2 rounded-[11px] bg-white/[0.02] px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[#16171b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <Radar size={12} className={running ? "text-[#7fd8ff]" : "text-muted"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-fg-2">Screening pass</span>
        <span className="block truncate text-[10px] text-muted">{current ? current.name : `Risk Monitor · ${steps.length} steps · background`}</span>
      </span>
      <span className="mono tnum shrink-0 text-right text-[9.5px] text-muted">
        {running ? <Loader2 size={10} className="ml-auto animate-spin text-blue" /> : <Check size={10} className="ml-auto text-green" />}
        {fmtMs(Math.max(t1 - t0, 0))} · {fmtUsd(cost)}
      </span>
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="border-l border-white/[0.05] px-2 py-1.5 first:border-l-0">
      <div className="text-muted">{k}</div>
      <div className="mono tnum truncate text-[11px] text-fg">{v}</div>
      {hint && <div className="truncate text-[9px] text-faint">{hint}</div>}
    </div>
  );
}

/** `waiting` comes only from the backend: a stalled run, or one a newer run superseded. */
function StatusIcon({ status, stalled, compact }: { status: SpanStatus; stalled?: boolean; compact?: boolean }) {
  const pad = compact ? "px-1.5 py-px text-[9.5px]" : "px-1.5 py-0.5 text-[10px]";
  if (status === "running")
    return (
      <span className={`flex items-center gap-1 rounded-full bg-[rgba(79,140,255,0.12)] font-medium text-blue ${pad}`}>
        <Loader2 size={9} className="animate-spin" /> Running
      </span>
    );
  if (status === "error")
    return (
      <span className={`flex items-center gap-1 rounded-full bg-[rgba(255,90,79,0.12)] font-medium text-red ${pad}`}>
        <X size={9} /> Failed
      </span>
    );
  if (status === "waiting")
    return stalled ? (
      <span className={`flex items-center gap-1 rounded-full bg-[rgba(255,159,64,0.12)] font-medium text-orange ${pad}`}>
        <TriangleAlert size={9} /> Stalled
      </span>
    ) : (
      <span className={`flex items-center gap-1 rounded-full bg-white/[0.06] font-medium text-muted ${pad}`}>
        <Minus size={9} /> Superseded
      </span>
    );
  return (
    <span className={`flex items-center gap-1 rounded-full bg-[rgba(61,220,151,0.1)] font-medium text-green ${pad}`}>
      <Check size={9} /> Done
    </span>
  );
}

/* ---------------------------------------------------------------- trace */

/** Every step as a waterfall row; click for the request, response and numbers. */
export function TraceList({ big = false }: { big?: boolean }) {
  const real = useRealMode();
  const all = useOps((s) => s.spans);
  const focusAgent = useOps((s) => s.focusAgent);
  const focusSpan = useOps((s) => s.focusSpan);
  const spans = useMemo(() => {
    const ordered = real ? byStart(all) : all;
    return (focusAgent ? ordered.filter((s) => s.agent === focusAgent || s.target === focusAgent) : ordered).slice(-120);
  }, [all, real, focusAgent]);
  const now = useNow(250);
  const box = useStickToBottom(spans.length);
  const start = spans[0]?.t0 ?? 0;
  const end = Math.max(now, ...spans.map((s) => s.t1 ?? s.t0));
  const range = Math.max(end - start, 1);

  // background screening passes collapse into one row each; incident steps stay flat
  const items = useMemo(() => {
    const out: ({ type: "span"; s: Span; divider: boolean } | { type: "pass"; root: Span; children: Span[] })[] = [];
    const passes = new Map<string, { type: "pass"; root: Span; children: Span[] }>();
    let last: string | null = null;
    for (const s of spans) {
      if (isPatrolRoot(s)) {
        const g = { type: "pass" as const, root: s, children: [] as Span[] };
        passes.set(s.id, g);
        out.push(g);
        continue;
      }
      if (s.parent && passes.has(s.parent)) {
        passes.get(s.parent)!.children.push(s);
        continue;
      }
      out.push({ type: "span", s, divider: !!s.eventId && s.eventId !== last });
      last = s.eventId ?? last;
    }
    return out;
  }, [spans]);

  if (!spans.length) return <Empty text={real ? <RealEmpty field="spans" idle="No agent runs yet." /> : "No steps yet. Run a scenario to see every call."} />;
  return (
    <div ref={box} className={`thin-scroll h-full overflow-y-auto ${big ? "text-[11.5px]" : ""}`}>
      {items.map((it) =>
        it.type === "pass" ? (
          <PassGroup key={it.root.id} root={it.root} steps={it.children} start={start} range={range} now={now} focusSpan={focusSpan} />
        ) : (
          <div key={it.s.id}>
            {it.divider && (
              <div className="sticky top-0 z-[1] flex items-center gap-2 bg-[rgba(14,15,17,0.92)] px-2.5 py-1 backdrop-blur">
                <span className="mono text-[9.5px] text-muted">{it.s.eventId}</span>
                <span className="h-px flex-1 bg-white/[0.05]" />
              </div>
            )}
            <TraceRow s={it.s} start={start} range={range} now={now} real={real} open={focusSpan === it.s.id} />
          </div>
        ),
      )}
    </div>
  );
}

function PassGroup({
  root,
  steps,
  start,
  range,
  now,
  focusSpan,
}: {
  root: Span;
  steps: Span[];
  start: number;
  range: number;
  now: number;
  focusSpan: string | null;
}) {
  const [open, setOpen] = useState(false);
  const all = [root, ...steps];
  const running = all.some((s) => s.status === "running");
  const t1 = running ? now : Math.max(...all.map((s) => s.t1 ?? s.t0));
  const cost = all.reduce((a, s) => a + (s.costUsd ?? 0), 0);
  const left = ((root.t0 - start) / range) * 100;
  const width = Math.max(((t1 - root.t0) / range) * 100, 0.8);
  return (
    <div className="border-b border-white/[0.035]">
      <button className="flex w-full items-center gap-2 px-2.5 py-[5px] text-left transition-colors hover:bg-white/[0.03]" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={10} className={`shrink-0 text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        <Radar size={11} className={`shrink-0 ${running ? "text-[#7fd8ff]" : "text-muted"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] text-fg">
            Screening pass
            {running && <Loader2 size={9} className="animate-spin text-blue" />}
          </span>
          <span className="text-[9.5px] text-muted">
            Monitor · {all.length} steps <span className="text-faint">· background</span>
          </span>
        </span>
        <span className="relative h-[3px] w-[64px] shrink-0 overflow-hidden rounded-full bg-white/[0.05]">
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: running ? EDGE.call : AGENT_HUE.monitor,
            }}
          />
        </span>
        <span className="mono tnum w-[40px] shrink-0 text-right text-[10px] text-fg-2">{fmtMs(t1 - root.t0)}</span>
        <span className="mono tnum w-[46px] shrink-0 text-right text-[10px] text-muted">{fmtUsd(cost)}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            {all.map((s) => (
              <TraceRow key={s.id} s={{ ...s, parent: s.parent ?? "pass" }} start={start} range={range} now={now} open={focusSpan === s.id} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TraceRow({ s, start, range, now, real = false, open }: { s: Span; start: number; range: number; now: number; real?: boolean; open: boolean }) {
  const Icon = KIND_ICON[s.kind];
  const out = real ? realOutput(s) : null;
  // a real run that ended without a recorded end time has no length to draw
  const end = s.t1 ?? (out && out.runStatus !== "running" ? s.t0 : now);
  const left = ((s.t0 - start) / range) * 100;
  const width = Math.max(((end - s.t0) / range) * 100, 0.8);
  const hue = AGENT_HUE[s.agent] ?? "var(--muted)";
  const color = s.status === "running" ? EDGE.call : s.status === "error" ? EDGE.failed : s.kind === "human" ? EDGE.human : hue;
  return (
    <div className={`border-b border-white/[0.035] ${open ? "bg-white/[0.035]" : ""}`}>
      <button
        className="group flex w-full items-center gap-2 px-2.5 py-[5px] text-left transition-colors hover:bg-white/[0.03]"
        style={{ paddingLeft: s.parent ? 22 : 10 }}
        onClick={() => {
          sfx.click();
          const st = useOps.getState();
          st.set({ focusSpan: st.focusSpan === s.id ? null : s.id });
        }}
      >
        <Icon size={11} className="shrink-0" style={{ color: s.status === "error" ? EDGE.failed : "var(--muted)" }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`truncate text-[11px] ${s.status === "error" ? "text-red" : "text-fg"}`}>{s.name}</span>
            {s.status === "running" && <Loader2 size={9} className="shrink-0 animate-spin text-blue" />}
            {out?.stalled && <TriangleAlert size={9} className="shrink-0 text-orange" />}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[9.5px] text-muted">
            <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: hue }} />
            <span className="shrink-0">{agentInfo(s.agent)?.short ?? s.agent}</span>
            <span className="shrink-0 text-faint">· {KIND_LABEL[s.kind]}</span>
            {s.model && (real || s.kind === "llm") && <span className="truncate text-faint">· {modelLabel(s.model)}</span>}
          </span>
        </span>
        <span className="relative h-[3px] w-[64px] shrink-0 overflow-hidden rounded-full bg-white/[0.05]">
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: color,
              transition: "width .25s linear",
            }}
          />
        </span>
        <span className="mono tnum w-[40px] shrink-0 text-right text-[10px] text-fg-2">{fmtElapsed(elapsedOf(s, now, out))}</span>
        {/* the backend exposes no price, so real rows have no cost column */}
        {!real && <span className="mono tnum w-[46px] shrink-0 text-right text-[10px] text-muted">{s.costUsd !== undefined ? fmtUsd(s.costUsd) : ""}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {real ? <RealSpanDetail s={s} out={out} /> : <SpanDetail s={s} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RealSpanDetail({ s, out }: { s: Span; out: RealOutput | null }) {
  return (
    <div className="px-2.5 pb-2.5 pt-0.5 text-[10.5px]" style={{ paddingLeft: s.parent ? 22 : 10 }}>
      {s.model && (
        <div className="mono mb-1.5 truncate text-[10px] text-muted" title={s.model}>
          model {s.model}
          {s.tokensIn !== undefined && ` · ${s.tokensIn.toLocaleString("en-US")} in`}
          {s.tokensOut !== undefined && ` / ${s.tokensOut.toLocaleString("en-US")} out`}
        </div>
      )}
      <RealBody s={s} out={out} />
    </div>
  );
}

function SpanDetail({ s }: { s: Span }) {
  return (
    <div className="space-y-1.5 px-2.5 pb-2.5 pt-0.5 text-[10.5px]" style={{ paddingLeft: s.parent ? 22 : 10 }}>
      {s.http && (
        <div className="mono flex min-w-0 items-center gap-1.5 text-[10px]">
          <span className="shrink-0 whitespace-nowrap rounded-[4px] bg-[rgba(79,140,255,0.14)] px-1 text-blue">{s.http.method}</span>
          <span className="min-w-0 truncate text-fg-2" title={s.http.url}>{s.http.url}</span>
          {s.http.status && <span className="ml-auto shrink-0 text-green">{s.http.status}</span>}
        </div>
      )}
      {s.kind === "llm" && s.model && (
        <div className="mono text-[10px] text-muted">
          {MODELS[s.model].vendor === "anthropic" ? "POST https://api.anthropic.com/v1/messages" : "xAI API"} · model {s.model}
          {s.tokensIn !== undefined && ` · ${s.tokensIn.toLocaleString("en-US")} in / ${(s.tokensOut ?? 0).toLocaleString("en-US")} out`}
          {s.cacheRead ? ` · ${s.cacheRead.toLocaleString("en-US")} cache read` : ""}
        </div>
      )}
      {s.error && <div className="rounded-[6px] bg-[rgba(255,90,79,0.08)] px-2 py-1 text-red">{s.error}</div>}
      {s.reasoning && <p className="leading-[1.5] text-fg-2">{s.reasoning}</p>}
      {s.input !== undefined && <Json label="input" v={s.input} />}
      {s.output !== undefined && <Json label="output" v={s.output} />}
    </div>
  );
}

function Json({ label, v }: { label: string; v: unknown }) {
  return (
    <div>
      <div className="mono mb-0.5 text-[9px] uppercase tracking-[0.1em] text-faint">{label}</div>
      <pre className="thin-scroll mono max-h-[140px] overflow-auto rounded-[6px] bg-black/35 p-1.5 text-[10px] leading-[1.5] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
        {JSON.stringify(v, null, 2)}
      </pre>
    </div>
  );
}

/* ----------------------------------------------------------------- logs */

type LogFilter = "all" | "warn" | "error";

export function LogStream() {
  const real = useRealMode();
  const logs = useOps((s) => s.logs);
  const focusAgent = useOps((s) => s.focusAgent);
  const [filter, setFilter] = useState<LogFilter>("all");
  const rows = useMemo(
    () =>
      // the backend returns newest first; the stream reads oldest first and sticks to the bottom
      (real ? [...logs].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)) : logs).filter(
        (l) =>
          (filter === "all" || (filter === "warn" ? l.level === "warn" || l.level === "error" : l.level === "error")) &&
          (!focusAgent || l.source === focusAgent),
      ),
    [logs, real, filter, focusAgent],
  );
  const box = useStickToBottom(rows.length);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-2 pb-1">
        {(["all", "warn", "error"] as LogFilter[]).map((f) => (
          <button key={f} className="btn relative h-[22px] px-2 text-[10.5px]" data-active={filter === f} onClick={() => setFilter(f)}>
            {filter === f && <motion.span layoutId="log-filter" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className="relative">{f === "all" ? "All" : f === "warn" ? "Warnings" : "Errors"}</span>
          </button>
        ))}
        <span className="mono ml-auto pr-1 text-[9.5px] text-faint">{rows.length} lines</span>
      </div>
      <div ref={box} className="thin-scroll mono min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 text-[10px] leading-[1.65]">
        {rows.length === 0 && <Empty text={real ? <RealEmpty field="agentLogs" idle="Log is empty." /> : "Log is empty."} />}
        {rows.map((l) => (
          <LogRow key={l.id} l={l} real={real} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ l, real }: { l: LogLine; real: boolean }) {
  const d = new Date(l.t);
  const p = (x: number, n = 2) => String(x).padStart(n, "0");
  const t = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
  const color = l.level === "error" ? "var(--red)" : l.level === "warn" ? "var(--orange)" : "var(--fg-2)";
  // every real line comes from an agent run; a source the roster doesn't know shows as the backend names it
  const known = l.source in AGENTS;
  const src = known ? AGENTS[l.source as AgentId].short : l.source === "system" ? "system" : real ? l.source : `Operator ${l.source.slice(-1)}`;
  const hue = known ? AGENT_HUE[l.source as AgentId] : l.source === "system" || real ? "var(--muted)" : EDGE.human;
  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
      className="flex gap-2 whitespace-pre-wrap break-words"
    >
      <span className="shrink-0 text-faint">{t}</span>
      <span className="w-[64px] shrink-0 truncate" style={{ color: hue }}>
        {src}
      </span>
      <span className="min-w-0" style={{ color }}>
        {l.msg}
      </span>
    </motion.div>
  );
}

function Empty({ text }: { text: ReactNode }) {
  return <div className="px-3 py-8 text-center text-[11px] text-muted">{text}</div>;
}

/** Keep a scroll box pinned to the bottom while new rows arrive, unless the user scrolled up. */
function useStickToBottom(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  return ref;
}
