"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRightLeft, ArrowUp, Check, ChevronRight, Globe, Loader2, Radar, ShieldCheck, Sparkle, User, Wrench, X, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtMs, fmtTokens, fmtUsd } from "@/lib/ops/format";
import { AGENTS, MODELS, nodeLabel } from "@/lib/ops/roster";
import { isPatrolRoot } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { LogLine, Span, SpanKind } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
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

/* ------------------------------------------------------------ call feed */

type FeedItem = { id: string; span: Span; pass?: Span[] };

/**
 * Every call as a card, newest on top. Cards slide in and push the older ones down.
 * The list sticks to the top while you're there; scroll down to read and it stays put,
 * with a pill to jump back to the newest.
 */
export function CallFeed({ className = "", eventId }: { className?: string; eventId?: string }) {
  const spans = useOps((s) => s.spans);
  const focusAgent = useOps((s) => s.focusAgent);
  const focusSpan = useOps((s) => s.focusSpan);
  const now = useNow(200);

  const items = useMemo(() => {
    const out: FeedItem[] = [];
    const passes = new Map<string, FeedItem>();
    for (const s of spans) {
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
  }, [spans, focusAgent, eventId]);

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
    return <div className={`px-3 py-6 text-center text-[11px] text-muted ${className}`}>Agents are idle. They wake on red events only.</div>;
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
                  <CallCard s={it.span} now={now} open={focusSpan === it.id || it.span.status === "running" || k === firstCall} />
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

function CallCard({ s, now, open: wantOpen }: { s: Span; now: number; open: boolean }) {
  const open = useLingeringOpen(wantOpen);
  const agent = AGENTS[s.agent];
  const model = s.model ? MODELS[s.model] : null;
  const running = s.status === "running";
  const text = s.reasoning ?? "";
  // stream a little ahead of the clock so the text finishes as the call returns
  const shown = running ? text.slice(0, Math.ceil(text.length * Math.min(s.progress * 1.12, 1))) : text;
  const elapsed = running ? (now ? Math.max(now - s.t0, 0) : 0) : (s.ms ?? 0);
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
          <ModelGlyph model={s.kind === "llm" || s.kind === "human" ? (s.model ?? agent.model) : agent.model} size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[11.5px] font-medium">{agent.name}</span>
            {model && s.kind === "llm" && <span className="mono shrink-0 rounded-[4px] bg-white/[0.05] px-1 text-[9px] text-fg-2">{model.label}</span>}
          </span>
          <span className="flex items-center gap-1 truncate text-[10px] text-muted">
            <Icon size={9} className="shrink-0" />
            <span className="truncate">{s.name}</span>
            <span className="shrink-0 text-faint">→ {nodeLabel(s.target)}</span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <StatusIcon s={s} compact />
          <span className="mono tnum text-[9.5px] text-muted">
            {fmtMs(elapsed)}
            {s.costUsd !== undefined && !running && <span className="text-faint"> · {fmtUsd(s.costUsd)}</span>}
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
            <div className="px-2.5 pb-2">
              {s.http && (
                <div className="mono mb-1.5 flex items-center gap-1.5 break-all text-[9.5px]">
                  <span className="rounded-[4px] bg-[rgba(79,140,255,0.14)] px-1 text-blue">{s.http.method}</span>
                  <span className="text-fg-2">{s.http.url}</span>
                  {s.http.status && <span className="ml-auto shrink-0 text-green">{s.http.status}</span>}
                </div>
              )}
              {s.error && <div className="mb-1.5 rounded-[6px] bg-[rgba(255,90,79,0.08)] px-2 py-1 text-[10.5px] text-red">{s.error}</div>}
              {!text && s.output === undefined && (
                <p className="text-[10.5px] leading-[1.5] text-muted">
                  {s.kind === "handoff"
                    ? `Hands the event to ${nodeLabel(s.target)}.`
                    : s.kind === "human"
                      ? `Calling ${nodeLabel(s.target)} into the room.`
                      : `${KIND_LABEL[s.kind]} step on ${nodeLabel(s.target)}.`}
                  {s.input !== undefined && <span className="mono mt-1 block break-all text-[10px] text-fg-2">{JSON.stringify(s.input)}</span>}
                </p>
              )}
              {text ? (
                <>
                  <div className="eyebrow mb-1 flex items-center gap-1.5 !text-[9px]">
                    Thinking · summarized
                    {running && <span className="h-1 w-1 animate-pulse rounded-full bg-blue" />}
                  </div>
                  <StreamText full={text} shown={shown} running={running} className="text-[11px] leading-[1.55] text-fg-2" />
                </>
              ) : (
                s.output !== undefined && (
                  <pre className="thin-scroll mono max-h-[110px] overflow-auto rounded-[7px] bg-black/30 p-2 text-[10px] leading-[1.5] text-fg-2">
                    {JSON.stringify(s.output, null, 2)}
                  </pre>
                )
              )}
            </div>
            {s.tokensIn !== undefined && (
              <div className="grid grid-cols-4 border-t border-white/[0.05] text-[10px]">
                <Stat k="In" v={fmtTokens(s.tokensIn)} hint={s.cacheRead ? `${fmtTokens(s.cacheRead)} cached` : undefined} />
                <Stat k="Out" v={fmtTokens(Math.round((s.tokensOut ?? 0) * (running ? s.progress : 1)))} />
                <Stat k="Latency" v={fmtMs(elapsed)} />
                <Stat k="Cost" v={running ? "…" : fmtUsd(s.costUsd)} hint={s.costUsd === null ? "price not verified" : undefined} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
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

function StatusIcon({ s, compact }: { s: Span; compact?: boolean }) {
  const pad = compact ? "px-1.5 py-px text-[9.5px]" : "px-1.5 py-0.5 text-[10px]";
  if (s.status === "running")
    return (
      <span className={`flex items-center gap-1 rounded-full bg-[rgba(79,140,255,0.12)] font-medium text-blue ${pad}`}>
        <Loader2 size={9} className="animate-spin" /> Running
      </span>
    );
  if (s.status === "error")
    return (
      <span className={`flex items-center gap-1 rounded-full bg-[rgba(255,90,79,0.12)] font-medium text-red ${pad}`}>
        <X size={9} /> Failed
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
  const all = useOps((s) => s.spans);
  const focusAgent = useOps((s) => s.focusAgent);
  const focusSpan = useOps((s) => s.focusSpan);
  const spans = useMemo(() => (focusAgent ? all.filter((s) => s.agent === focusAgent || s.target === focusAgent) : all).slice(-120), [all, focusAgent]);
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

  if (!spans.length) return <Empty text="No steps yet. Run a scenario to see every call." />;
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
            <TraceRow s={it.s} start={start} range={range} now={now} open={focusSpan === it.s.id} />
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

function TraceRow({ s, start, range, now, open }: { s: Span; start: number; range: number; now: number; open: boolean }) {
  const Icon = KIND_ICON[s.kind];
  const end = s.t1 ?? now;
  const left = ((s.t0 - start) / range) * 100;
  const width = Math.max(((end - s.t0) / range) * 100, 0.8);
  const color = s.status === "running" ? EDGE.call : s.status === "error" ? EDGE.failed : s.kind === "human" ? EDGE.human : AGENT_HUE[s.agent];
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
          </span>
          <span className="flex items-center gap-1 text-[9.5px] text-muted">
            <span className="h-1 w-1 rounded-full" style={{ background: AGENT_HUE[s.agent] }} />
            {AGENTS[s.agent].short}
            <span className="text-faint">· {KIND_LABEL[s.kind]}</span>
            {s.model && s.kind === "llm" && <span className="text-faint">· {MODELS[s.model].label}</span>}
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
        <span className="mono tnum w-[40px] shrink-0 text-right text-[10px] text-fg-2">
          {fmtMs(s.status === "running" ? (now ? Math.max(now - s.t0, 0) : 0) : (s.ms ?? 0))}
        </span>
        <span className="mono tnum w-[46px] shrink-0 text-right text-[10px] text-muted">{s.costUsd !== undefined ? fmtUsd(s.costUsd) : ""}</span>
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
            <SpanDetail s={s} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SpanDetail({ s }: { s: Span }) {
  return (
    <div className="space-y-1.5 px-2.5 pb-2.5 pt-0.5 text-[10.5px]" style={{ paddingLeft: s.parent ? 22 : 10 }}>
      {s.http && (
        <div className="mono flex items-center gap-1.5 break-all text-[10px]">
          <span className="rounded-[4px] bg-[rgba(79,140,255,0.14)] px-1 text-blue">{s.http.method}</span>
          <span className="text-fg-2">{s.http.url}</span>
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
  const logs = useOps((s) => s.logs);
  const focusAgent = useOps((s) => s.focusAgent);
  const [filter, setFilter] = useState<LogFilter>("all");
  const rows = useMemo(
    () =>
      logs.filter(
        (l) =>
          (filter === "all" || (filter === "warn" ? l.level === "warn" || l.level === "error" : l.level === "error")) &&
          (!focusAgent || l.source === focusAgent),
      ),
    [logs, filter, focusAgent],
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
        {rows.length === 0 && <Empty text="Log is empty." />}
        {rows.map((l) => (
          <LogRow key={l.id} l={l} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ l }: { l: LogLine }) {
  const d = new Date(l.t);
  const p = (x: number, n = 2) => String(x).padStart(n, "0");
  const t = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
  const color = l.level === "error" ? "var(--red)" : l.level === "warn" ? "var(--orange)" : "var(--fg-2)";
  const src =
    l.source in AGENTS ? AGENTS[l.source as keyof typeof AGENTS].short : l.source === "system" ? "system" : `Operator ${l.source.slice(-1)}`;
  const hue = l.source in AGENTS ? AGENT_HUE[l.source as keyof typeof AGENT_HUE] : l.source === "system" ? "var(--muted)" : EDGE.human;
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

function Empty({ text }: { text: string }) {
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
