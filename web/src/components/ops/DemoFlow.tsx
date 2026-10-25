"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Loader2, Play, Radar, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtCountdown, fmtMiss, fmtPc } from "@/lib/ops/format";
import { runIncident, runScan } from "@/lib/ops/scenarios";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { ownerInfo } from "@/lib/owners";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { RESOLVED } from "./meta";

/** Stable fallback: a new {} per render would loop the store subscription. */
const NO_OWNERS: Record<string, string> = {};

// The demo path: Run scan, a ranked list of what the scan found, pick a case, watch the run.
// A high-priority find turns the screen edges red, shows an urgency banner and sounds an alarm.

const CONF = {
  high: { label: "High", color: "var(--green)" },
  medium: { label: "Medium", color: "var(--amber)" },
  low: { label: "Low", color: "var(--orange)" },
} as const;

/** How long the center warning holds before the results list opens. */
export const WARN_MS = 3400;

const priority = (e: ConjunctionEvent, now: number) => e.pc / Math.max((e.tca - now) / 3600_000, 1);

/** Primary action on the queue: one full screening pass. */
export function ScanButton() {
  const dev = useOps((s) => s.dev);
  const phase = useOps((s) => s.scan.phase);
  const ready = useOrbit((s) => !!s.catalog);
  const scanning = phase === "scanning";
  // one case at a time: scanning again would pull the dispatcher away from it
  const busy = useOps((s) => {
    const ev = s.incident ? s.events.find((x) => x.id === s.incident) : undefined;
    return ev && !RESOLVED.includes(ev.status) ? ev.id : null;
  });
  const btn = (
    <button
      className="btn btn-primary h-8 w-full gap-1.5 text-[12px]"
      disabled={!dev || !ready || scanning || !!busy}
      onClick={() => {
        sfx.ping();
        runScan();
      }}
    >
      {scanning || busy ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
      {scanning ? "Scanning 18k objects…" : busy ? `Case in progress · ${busy}` : "Run scan"}
    </button>
  );
  if (!dev) return <Tooltip label="Triggers the Risk Monitor once the backend is connected">{btn}</Tooltip>;
  if (busy) return <Tooltip label="Finish or close the current case before scanning again">{btn}</Tooltip>;
  return btn;
}

/** Ranked results of a scan; pick one to run the agents on it. */
export function ScanResults() {
  const scan = useOps((s) => s.scan);
  const tab = useOps((s) => s.tab);
  const events = useOps((s) => s.events);
  const alert = useOps((s) => s.alert);
  const owners = useOrbit((s) => s.catalog?.owners ?? NO_OWNERS);
  const now = useNow(1000);
  const fast = useNow(200);
  // a red find shows the center warning first; the list opens after it
  const warned = !alert || (fast > 0 && fast - alert.at > WARN_MS);
  const open = scan.phase === "results" && tab === "conjunctions" && warned;
  const rows = useMemo(() => {
    const t = now;
    return events.filter((e) => scan.ids.includes(e.id)).sort((a, b) => priority(b, t) - priority(a, t));
  }, [events, scan.ids, now]);
  const [sel, setSel] = useState<string | null>(null);
  const chosen = sel && rows.some((r) => r.id === sel) ? sel : (rows[0]?.id ?? null);
  const maxP = rows.length ? priority(rows[0], now) : 1;
  const red = rows.filter((r) => r.risk === "red").length;

  const close = () => {
    sfx.close();
    useOps.setState((s) => ({ scan: { ...s.scan, phase: "idle" } }));
  };
  const run = (id: string | null) => {
    if (!id) return;
    sfx.whoosh();
    setSel(null);
    runIncident(id);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const i = rows.findIndex((r) => r.id === chosen);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const j = Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
        setSel(rows[j]?.id ?? null);
        sfx.hover();
      } else if (e.key === "Enter") run(chosen);
      else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="scan-results"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-black/30 backdrop-blur-[2px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="glass glass-strong relative w-[660px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px]"
            style={red ? { boxShadow: "0 0 0 1px rgba(255,90,79,0.35), 0 24px 60px -12px rgba(255,60,50,0.35)" } : undefined}
          >
            {alert && red > 0 && (
              <div className="relative flex items-center gap-2 overflow-hidden bg-[rgba(255,90,79,0.12)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-red">
                <span className="urgent-sheen pointer-events-none absolute inset-0" />
                <ShieldAlert size={13} />
                {red} high-priority {red === 1 ? "conjunction" : "conjunctions"} · action needed within 72 h
              </div>
            )}
            <div className="flex items-start gap-3 px-4 pb-2 pt-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold tracking-[-0.01em]">Screening complete</div>
                <div className="mono mt-0.5 text-[10.5px] text-muted">
                  {scan.stats?.objects.toLocaleString("en-US")} objects · {((scan.stats?.pairs ?? 0) / 1e6).toFixed(1)}M pairs · 72 h horizon ·{" "}
                  {rows.length} candidates · {((scan.stats?.ms ?? 0) / 1000).toFixed(1)} s
                </div>
              </div>
              <button className="icon-btn -mr-1 h-7 w-7" onClick={close} aria-label="Close">
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-[22px_minmax(0,1fr)_64px_62px_86px_96px] items-center gap-2 border-y border-white/[0.06] px-4 py-1.5 text-[9.5px] uppercase tracking-[0.1em] text-muted">
              <span>#</span>
              <span>Pair</span>
              <span className="text-right">Miss</span>
              <span className="text-right">Pc</span>
              <span className="text-right">TCA</span>
              <span>Confidence</span>
            </div>
            <div className="thin-scroll max-h-[min(52vh,440px)] overflow-y-auto py-1">
              {rows.map((e, i) => {
                const active = e.id === chosen;
                const fa = ownerInfo(e.a.owner, owners);
                const fb = ownerInfo(e.b.owner, owners);
                const c = e.confidence ? CONF[e.confidence.level] : null;
                const pr = priority(e, now) / maxP;
                return (
                  <motion.button
                    key={e.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.08 + i * 0.05, duration: 0.28 }}
                    className="relative grid w-full grid-cols-[22px_minmax(0,1fr)_64px_62px_86px_96px] items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-white/[0.04]"
                    style={active ? { background: "rgba(255,255,255,0.06)" } : undefined}
                    onClick={() => {
                      sfx.click();
                      setSel(e.id);
                    }}
                    onDoubleClick={() => run(e.id)}
                    onPointerEnter={() => sfx.hover()}
                  >
                    {active && <motion.span layoutId="scan-sel" className="absolute inset-y-1 left-1.5 w-[2px] rounded-full bg-white" />}
                    <span className="mono text-[11px] text-muted">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: e.risk === "red" ? "var(--red)" : "var(--amber)", boxShadow: e.risk === "red" ? "0 0 8px var(--red)" : undefined }}
                        />
                        {fa?.flags[0] && <Flag code={fa.flags[0]} h={10} />}
                        <span className="truncate">{e.a.name}</span>
                        <span className="text-faint">×</span>
                        {fb?.flags[0] && <Flag code={fb.flags[0]} h={10} />}
                        <span className="truncate text-fg-2">{e.b.name}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-2">
                        <span className="relative h-[3px] w-[90px] overflow-hidden rounded-full bg-white/[0.06]">
                          <motion.span
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ background: e.risk === "red" ? "var(--red)" : "var(--amber)" }}
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.max(pr * 100, 4)}%` }}
                            transition={{ delay: 0.2 + i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                          />
                        </span>
                        <span className="text-[9.5px] text-muted">priority</span>
                      </span>
                    </span>
                    <span className="mono tnum text-right text-[11px] text-fg-2">{fmtMiss(e.missM)}</span>
                    <span className="mono tnum text-right text-[11px]" style={{ color: e.risk === "red" ? "var(--red)" : "var(--amber)" }}>
                      {fmtPc(e.pc)}
                    </span>
                    <span className="mono tnum text-right text-[10.5px]" style={{ color: e.tca - now < 24 * 3600_000 ? "var(--orange)" : "var(--fg-2)" }}>
                      {now ? fmtCountdown(e.tca - now) : "—"}
                    </span>
                    <span className="min-w-0">
                      {c && (
                        <Tooltip label={e.confidence!.why}>
                          <span className="flex items-center gap-1.5 text-[10.5px] font-medium" style={{ color: c.color }}>
                            <ConfidenceBars level={e.confidence!.level} color={c.color} />
                            {c.label}
                          </span>
                        </Tooltip>
                      )}
                      {e.confidence && <span className="block truncate text-[9.5px] text-muted">{e.confidence.why}</span>}
                    </span>
                  </motion.button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
              <span className="text-[10.5px] text-muted">
                <span className="kbd">↑</span> <span className="kbd">↓</span> to choose · <span className="kbd">↵</span> to run
              </span>
              <button className="btn btn-ghost-line ml-auto h-8 px-3 text-[11.5px]" onClick={close}>
                Later
              </button>
              <button className="btn btn-primary h-8 px-3.5 text-[12px]" disabled={!chosen} onClick={() => run(chosen)}>
                <Play size={12} /> Run agents on this case <ArrowRight size={12} />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ConfidenceBars({ level, color }: { level: "high" | "medium" | "low"; color: string }) {
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="flex items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[3px] rounded-[1px]" style={{ height: 5 + i * 2.5, background: i < n ? color : "rgba(255,255,255,0.14)" }} />
      ))}
    </span>
  );
}

/** Red edge glow, urgency banner and alarm for a high-priority find. */
export function UrgencyOverlay() {
  const alert = useOps((s) => s.alert);
  const tab = useOps((s) => s.tab);
  const phase = useOps((s) => s.scan.phase);
  const ev = useOps((s) => (s.alert ? s.events.find((e) => e.id === s.alert!.eventId) : undefined));
  const now = useNow(200);
  const redCount = useOps((s) => s.events.filter((e) => s.scan.ids.includes(e.id) && e.risk === "red").length);
  const sounded = useRef<string | null>(null);
  // the glow is the alarm: it shows until a case is picked, not while the case runs
  const active = !!alert && !!ev && tab === "conjunctions" && phase === "results" && !RESOLVED.includes(ev.status);
  // alarm first (center warning), strong while the dispatcher picks a case, calm once the agents are on it
  const warning = active && phase === "results" && now > 0 && now - alert!.at < WARN_MS;
  const strong = phase === "results";

  useEffect(() => {
    if (!alert || sounded.current === `${alert.eventId}:${alert.at}`) return;
    sounded.current = `${alert.eventId}:${alert.at}`;
    if (useOps.getState().scan.phase === "results") sfx.siren();
    else sfx.alarm();
  }, [alert]);

  return (
    <AnimatePresence>
      {active && ev && (
        <motion.div key="urgency" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }} className="pointer-events-none absolute inset-0 z-[45]">
          <div className={`urgency-edge absolute inset-0 ${warning ? "urgency-alarm" : strong ? "urgency-strong" : "urgency-calm"}`} />
          <AnimatePresence>{warning && <CenterWarning key="warn" ev={ev} red={redCount} now={now} />}</AnimatePresence>
          {!warning && (
          <motion.div
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto absolute left-1/2 top-[60px] flex -translate-x-1/2 items-center gap-2.5 overflow-hidden rounded-full py-1.5 pl-2 pr-1.5 text-[11px] shadow-[0_8px_30px_-6px_rgba(255,60,50,0.55)]"
            style={{ background: "rgba(40,8,8,0.82)", boxShadow: "inset 0 0 0 1px rgba(255,90,79,0.45), 0 8px 30px -6px rgba(255,60,50,0.55)", backdropFilter: "blur(14px)" }}
          >
            <span className="urgent-sheen pointer-events-none absolute inset-0" />
            <span className="relative flex items-center gap-1.5 rounded-full bg-red px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-black">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black" /> High priority
            </span>
            <span className="relative mono text-[#ffb3ad]">{ev.id}</span>
            <span className="relative max-w-[260px] truncate text-fg">
              {ev.a.name} × {ev.b.name}
            </span>
            <span className="relative mono text-red">Pc {fmtPc(ev.pc)}</span>
            <span className="relative mono tnum text-fg">{now ? fmtCountdown(ev.tca - now) : ""}</span>
            <button
              className="relative grid h-5 w-5 place-items-center rounded-full text-[#ffb3ad] transition-colors hover:bg-white/10"
              onClick={() => {
                sfx.close();
                useOps.setState({ alert: null });
              }}
              aria-label="Acknowledge"
            >
              <X size={11} />
            </button>
          </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Full-screen alarm moment for a high-priority find: flash, hazard stripes, the worst case up front. */
function CenterWarning({ ev, red, now }: { ev: ConjunctionEvent; red: number; now: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.45 } }}
      className="absolute inset-0 grid place-items-center"
    >
      {/* one hard red flash, then a dim red wash */}
      <motion.div
        className="absolute inset-0"
        initial={{ background: "rgba(255,40,30,0.38)" }}
        animate={{ background: ["rgba(255,40,30,0.38)", "rgba(120,10,8,0.18)", "rgba(255,40,30,0.24)", "rgba(80,6,6,0.16)"] }}
        transition={{ duration: 1.6, times: [0, 0.3, 0.55, 1] }}
      />
      <motion.div
        initial={{ scale: 0.6, opacity: 0, filter: "blur(10px)" }}
        animate={{ scale: [0.6, 1.06, 1], opacity: 1, filter: "blur(0px)" }}
        exit={{ scale: 0.85, y: -220, opacity: 0, filter: "blur(6px)", transition: { duration: 0.5, ease: [0.55, 0, 0.6, 1] } }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px]"
        style={{ background: "rgba(28,6,6,0.88)", backdropFilter: "blur(18px)", boxShadow: "inset 0 0 0 1.5px rgba(255,90,79,0.7), 0 0 80px -10px rgba(255,40,30,0.7)" }}
      >
        <div className="hazard-stripes h-2.5 w-full" />
        <div className="flex flex-col items-center px-6 pb-5 pt-5 text-center">
          <span className="relative grid h-16 w-16 place-items-center">
            <span className="absolute inset-0 rounded-full border-2 border-red" style={{ animation: "ping 1s var(--ease-out) infinite" }} />
            <span className="absolute inset-2 rounded-full bg-[rgba(255,90,79,0.18)]" />
            <motion.svg
              viewBox="0 0 24 24"
              width="34"
              height="34"
              animate={{ scale: [1, 1.12, 1] }}
              transition={{ duration: 0.75, repeat: Infinity }}
              className="relative drop-shadow-[0_0_10px_rgba(255,90,79,0.9)]"
            >
              <path d="M12 3 L22 20 H2 Z" fill="none" stroke="#ff5a4f" strokeWidth="2" strokeLinejoin="round" />
              <path d="M12 9.5 V14" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="12" cy="17" r="1.25" fill="#fff" />
            </motion.svg>
          </span>
          <div className="mt-3 text-[11px] font-bold uppercase tracking-[0.22em] text-red">High-priority conjunction</div>
          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-white">
            {red} {red === 1 ? "event needs" : "events need"} action within 72 h
          </div>
          <div className="mt-3 w-full rounded-[12px] bg-black/35 px-3.5 py-2.5 text-left shadow-[inset_0_0_0_1px_rgba(255,90,79,0.3)]">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[#ffb3ad]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red" /> Most urgent · {ev.id}
            </div>
            <div className="mt-1 truncate text-[14px] font-semibold text-white">
              {ev.a.name} <span className="text-[#ffb3ad]">×</span> {ev.b.name}
            </div>
            <div className="mono mt-1 flex items-center gap-3 text-[12px]">
              <span className="text-red">Pc {fmtPc(ev.pc)}</span>
              <span className="text-fg">{fmtMiss(ev.missM)}</span>
              <span className="tnum text-fg">{now ? fmtCountdown(ev.tca - now) : ""}</span>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-[#ffb3ad]">Opening the ranked list…</div>
        </div>
        <div className="hazard-stripes h-2.5 w-full" />
      </motion.div>
    </motion.div>
  );
}
