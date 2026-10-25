"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Loader2, Lock, Play, Radar, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtChance, fmtCountdown, fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
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
import { useMe, useSession } from "@/components/auth/session";
import { Popover } from "@/components/ui/Popover";
import Link from "next/link";
import { PcChart } from "./PcChart";

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
  const me = useMe();
  const allowed = me?.access === "granted";
  const scanning = phase === "scanning";
  const [gate, setGate] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const closeGate = useCallback(() => setGate(false), []);
  // one case at a time: scanning again would pull the dispatcher away from it
  const busy = useOps((s) => {
    const ev = s.incident ? s.events.find((x) => x.id === s.incident) : undefined;
    return ev && !RESOLVED.includes(ev.status) ? ev.id : null;
  });
  // Without sign-in or access the button stays clickable and explains why it cannot scan, instead of sitting
  // greyed out with a tooltip nobody hovers. The server refuses these scans either way.
  const locked = !me || !allowed;
  const btn = (
    <button
      ref={anchor}
      className="btn btn-primary h-8 w-full gap-1.5 text-[12px]"
      disabled={!locked && (!dev || !ready || scanning || !!busy)}
      aria-haspopup={locked ? "dialog" : undefined}
      onClick={() => {
        if (locked) {
          sfx.click();
          setGate((g) => !g);
          return;
        }
        sfx.ping();
        runScan();
      }}
    >
      {scanning || busy ? <Loader2 size={13} className="animate-spin" /> : locked ? <Lock size={12} /> : <Radar size={13} />}
      {scanning ? "Scanning 18k objects…" : busy ? `Case in progress · ${busy}` : "Run scan"}
    </button>
  );
  if (locked)
    return (
      <>
        {btn}
        <Popover open={gate} onClose={closeGate} anchor={anchor} width={260} label="Scanning needs an account">
          <div className="p-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
              <Lock size={13} className="text-neutral-400" /> {me ? "No scan access yet" : "Sign in to scan"}
            </div>
            <p className="mt-1.5 text-[12px] leading-[1.55] text-neutral-400">
              {me
                ? "Scans run paid screening and analysis, so they open for accounts with a company and assigned satellites."
                : "A scan checks the satellites assigned to your account against the whole catalog. Sign in as a dispatcher to run one."}
            </p>
            {me ? (
              <button
                className="btn btn-primary mt-3 h-8 w-full text-[12px]"
                onClick={() => {
                  setGate(false);
                  useSession.getState().setProfileOpen(true);
                }}
              >
                Request access
              </button>
            ) : (
              <Link href="/signin" className="btn btn-primary mt-3 flex h-8 w-full items-center justify-center text-[12px]" onClick={() => sfx.click()}>
                Sign in
              </Link>
            )}
          </div>
        </Popover>
      </>
    );
  if (!dev) return <Tooltip label="Triggers the Risk Monitor once the backend is connected">{btn}</Tooltip>;
  if (busy) return <Tooltip label="Finish or close the current case before scanning again">{btn}</Tooltip>;
  return btn;
}

/** "in 21 h 59 m" / "in 1 d 3 h": the countdown as words. */
function fmtIn(ms: number) {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 24) return `in ${Math.floor(h / 24)} d ${h % 24} h`;
  return `in ${h} h ${String(m).padStart(2, "0")} m`;
}

/** Why a case sits where it does, in words (docs/user-flow.md §4). */
function whyRanked(e: ConjunctionEvent, rank: number, now: number) {
  const red = e.risk === "red";
  const when = fmtIn(e.tca - now).replace("in ", "");
  return red
    ? `Chance above the 1 in 10,000 action line and closest approach ${when} away, inside the 72 h window.${rank === 0 ? " Most urgent of this scan." : ""}`
    : `Below the action line: watch it, no action needed yet. Closest approach ${when} away.`;
}

/** Ranked results of a scan, drawn as if being written row by row; hover a row for its detail. */
export function ScanResults() {
  const scan = useOps((s) => s.scan);
  const tab = useOps((s) => s.tab);
  const events = useOps((s) => s.events);
  const now = useNow(1000);
  const open = scan.phase === "results" && tab === "conjunctions";
  const rows = useMemo(() => {
    return events.filter((e) => scan.ids.includes(e.id)).sort((a, b) => priority(b, now) - priority(a, now));
  }, [events, scan.ids, now]);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const chosen = sel && rows.some((r) => r.id === sel) ? sel : (rows[0]?.id ?? null);
  const shown = rows.find((r) => r.id === (hover ?? chosen)) ?? null;
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
        setHover(null);
        sfx.hover();
      } else if (e.key === "Enter") run(chosen);
      else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const ROW_DELAY = 0.16;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="scan-results"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-black/45 backdrop-blur-[3px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex h-[min(700px,calc(100vh-130px))] w-[min(1120px,calc(100vw-48px))] flex-col overflow-hidden rounded-[20px] bg-[rgba(4,4,5,0.96)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_40px_100px_-30px_rgba(0,0,0,0.95)]"
          >
            {/* header */}
            <div className="flex items-start gap-4 border-b border-white/[0.07] px-7 pb-4 pt-6">
              <div className="min-w-0 flex-1">
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-white">Screening complete</div>
                <div className="tnum mt-1 text-[13px] text-neutral-500">
                  {scan.stats?.objects.toLocaleString("en-US")} objects · {((scan.stats?.pairs ?? 0) / 1e6).toFixed(1)}M pairs checked · next 72 h ·{" "}
                  {((scan.stats?.ms ?? 0) / 1000).toFixed(1)} s
                </div>
              </div>
              {red > 0 && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: ROW_DELAY * rows.length + 0.2 }}
                  className="mt-1 flex items-center gap-1.5 rounded-full bg-[rgba(255,90,79,0.12)] px-3 py-1 text-[12.5px] font-semibold text-[#ff8a80] shadow-[inset_0_0_0_1px_rgba(255,90,79,0.35)]"
                >
                  <ShieldAlert size={13} /> {red} need action within 72 h
                </motion.span>
              )}
              <button className="icon-btn -mr-2 h-8 w-8" onClick={close} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              {/* the ranked list, written row by row */}
              <div className="thin-scroll min-h-0 overflow-y-auto border-r border-white/[0.07] px-4 py-3">
                <motion.div
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0, height: 0 }}
                  transition={{ delay: ROW_DELAY * rows.length + 0.1, duration: 0.3 }}
                  className="shimmer overflow-hidden px-3 pb-2 text-[12.5px] font-medium"
                >
                  Ranking {rows.length} candidates by severity, then closest approach…
                </motion.div>
                {rows.map((e, i) => {
                  const active = e.id === chosen;
                  const isRed = e.risk === "red";
                  return (
                    <motion.button
                      key={e.id}
                      initial={{ opacity: 0, y: -14, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: "auto" }}
                      transition={{ delay: 0.15 + i * ROW_DELAY, duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                      onAnimationStart={() => i > 0 && sfx.tick()}
                      className="relative block w-full overflow-hidden rounded-[14px] text-left"
                      onClick={() => {
                        sfx.click();
                        setSel(e.id);
                      }}
                      onDoubleClick={() => run(e.id)}
                      onPointerEnter={() => {
                        sfx.hover();
                        setHover(e.id);
                      }}
                      onPointerLeave={() => setHover(null)}
                    >
                      <div
                        className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-200"
                        style={{ background: active ? "rgba(255,255,255,0.07)" : hover === e.id ? "rgba(255,255,255,0.04)" : "transparent" }}
                      >
                        {/* one sweep of light as the row is "written" */}
                        <motion.span
                          className="pointer-events-none absolute inset-0 bg-[linear-gradient(100deg,transparent_30%,rgba(255,255,255,0.08)_50%,transparent_70%)]"
                          initial={{ x: "-100%" }}
                          animate={{ x: "100%" }}
                          transition={{ delay: 0.2 + i * ROW_DELAY, duration: 0.7, ease: "easeOut" }}
                        />
                        <span className="w-4 shrink-0 text-right text-[13px] text-neutral-600">{i + 1}</span>
                        <span className="h-9 w-[3px] shrink-0 rounded-full" style={{ background: isRed ? "var(--red)" : "var(--amber)" }} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-white">
                            <PairName e={e} />
                          </span>
                          <span className="tnum mt-1 block text-[12.5px] text-neutral-500">
                            Closest approach {now ? fmtIn(e.tca - now) : ""} · {fmtWhen(e.tca)}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="tnum block whitespace-nowrap text-[16px] font-semibold" style={{ color: isRed ? "#ff8a80" : "var(--amber)" }}>
                            {fmtOdds(e.pc)}
                          </span>
                          <span className="tnum mt-0.5 block text-[12px] text-neutral-500">{fmtMiss(e.missM)} apart</span>
                        </span>
                      </div>
                      {active && <motion.span layoutId="scan-sel" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white" />}
                    </motion.button>
                  );
                })}
              </div>

              {/* detail of the hovered (or chosen) case */}
              <div className="thin-scroll min-h-0 overflow-y-auto px-7 py-5">
                <AnimatePresence mode="wait">
                  {shown && (
                    <motion.div
                      key={shown.id}
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -6 }}
                      transition={{ duration: 0.2 }}
                    >
                      <CaseDetail e={shown} rank={rows.indexOf(shown)} now={now} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div className="flex items-center gap-3 border-t border-white/[0.07] px-7 py-4">
              <span className="text-[12px] text-neutral-500">
                <span className="kbd">↑</span> <span className="kbd">↓</span> choose · <span className="kbd">↵</span> run · hover a row for its detail
              </span>
              <button className="btn ml-auto h-10 px-4 text-[13px] text-neutral-300" onClick={close}>
                Later
              </button>
              <button className="btn btn-primary h-10 px-5 text-[14px]" disabled={!chosen} onClick={() => run(chosen)}>
                <Play size={13} /> Run agents on case {rows.findIndex((r) => r.id === chosen) + 1} <ArrowRight size={13} />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PairName({ e }: { e: ConjunctionEvent }) {
  const owners = useOrbit((s) => s.catalog?.owners ?? NO_OWNERS);
  const fa = ownerInfo(e.a.owner, owners);
  const fb = ownerInfo(e.b.owner, owners);
  return (
    <>
      {fa?.flags[0] && <Flag code={fa.flags[0]} h={11} />}
      <span className="truncate">{e.a.name}</span>
      <span className="shrink-0 font-normal text-neutral-600">×</span>
      {fb?.flags[0] && <Flag code={fb.flags[0]} h={11} />}
      <span className="truncate text-neutral-300">{e.b.name}</span>
    </>
  );
}

function CaseDetail({ e, rank, now }: { e: ConjunctionEvent; rank: number; now: number }) {
  const isRed = e.risk === "red";
  const lat = `${Math.abs(Math.round(e.where.lat))}°${e.where.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(Math.round(e.where.lon))}°${e.where.lon >= 0 ? "E" : "W"}`;
  const c = e.confidence ? CONF[e.confidence.level] : null;
  return (
    <div>
      <div className="text-[12px] font-medium" style={{ color: isRed ? "#ff8a80" : "var(--amber)" }}>
        #{rank + 1} · {isRed ? "Needs action" : "Watch"} · {e.id}
      </div>
      <h3 className="mt-1.5 text-[20px] font-semibold leading-[1.3] tracking-[-0.02em] text-white">
        {e.a.name} passes {fmtMiss(e.missM)} from {e.b.name}
      </h3>
      <p className="tnum mt-1.5 text-[13px] text-neutral-400">
        {fmtWhen(e.tca)} · {now ? fmtIn(e.tca - now) : ""} · over {lat} {lon} at {Math.round(e.where.altKm)} km
      </p>

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
        <DetailFact k="Chance of collision" v={fmtOdds(e.pc)} sub={`${fmtChance(e.pc)} · ${e.trend}`} tone={isRed ? "#ff8a80" : "var(--amber)"} />
        <DetailFact k="Miss distance" v={fmtMiss(e.missM)} sub={`±${fmtMiss(e.uncertaintyM)} between sources`} />
        <DetailFact k="Relative speed" v={`${e.relVelKms.toFixed(1)} km/s`} sub="how fast they pass each other" />
        <DetailFact k="Evidence" v={e.pcSource} sub={c ? `${c.label} confidence` : undefined} />
      </div>

      <div className="mt-5 space-y-2.5">
        <OperatorLine e={e} side="a" />
        <OperatorLine e={e} side="b" />
      </div>

      <div className="mt-5 rounded-[12px] bg-white/[0.03] px-4 py-3">
        <div className="text-[12px] font-semibold text-neutral-300">Why it&apos;s ranked here</div>
        <p className="mt-1 text-[13px] leading-[1.6] text-neutral-400">{whyRanked(e, rank, now)}</p>
        {e.confidence && <p className="mt-1 text-[13px] leading-[1.6] text-neutral-400">{e.confidence.why}.</p>}
      </div>

      <div className="mt-5">
        <PcChart e={e} />
      </div>
    </div>
  );
}

function DetailFact({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-neutral-500">{k}</div>
      <div className="tnum mt-1 text-[19px] font-semibold leading-tight tracking-[-0.02em]" style={{ color: tone ?? "#fff" }}>
        {v}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-neutral-500">{sub}</div>}
    </div>
  );
}

function OperatorLine({ e, side }: { e: ConjunctionEvent; side: "a" | "b" }) {
  const owners = useOrbit((s) => s.catalog?.owners ?? NO_OWNERS);
  const ref = side === "a" ? e.a : e.b;
  const info = ownerInfo(ref.owner, owners);
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
        {info?.flags[0] && <Flag code={info.flags[0]} h={28} square />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-white">{ref.name}</div>
        <div className="text-[12px] text-neutral-500">
          {ref.kind === "debris" ? "Debris · no operator, can't move" : ref.operator.replace(/\s*\(synthetic\)/i, "")}
          {ref.synthetic ? " · synthetic" : ""}
        </div>
      </div>
    </div>
  );
}

/** Red edge glow, urgency banner and alarm for a high-priority find. */
export function UrgencyOverlay() {
  const alert = useOps((s) => s.alert);
  const tab = useOps((s) => s.tab);
  const phase = useOps((s) => s.scan.phase);
  const ev = useOps((s) => (s.alert ? s.events.find((e) => e.id === s.alert!.eventId) : undefined));
  const now = useNow(200);
  const sounded = useRef<string | null>(null);
  // the glow is the alarm: it shows until a case is picked, not while the case runs
  const active = !!alert && !!ev && tab === "conjunctions" && phase === "results" && !RESOLVED.includes(ev.status);
  // alarm first (center warning), strong while the dispatcher picks a case, calm once the agents are on it
  // no alarm screen: the results list itself carries the urgency
  const warning = false;
  const strong = phase === "results";

  useEffect(() => {
    if (!alert || sounded.current === `${alert.eventId}:${alert.at}`) return;
    sounded.current = `${alert.eventId}:${alert.at}`;
    sfx.notice();
  }, [alert]);

  return (
    <AnimatePresence>
      {active && ev && (
        <motion.div key="urgency" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }} className="pointer-events-none absolute inset-0 z-[45]">
          <div className={`urgency-edge absolute inset-0 ${warning ? "urgency-alarm" : strong ? "urgency-calm" : "urgency-calm"}`} />
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
            <span className="relative tnum text-red">{fmtOdds(ev.pc)} chance</span>
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
