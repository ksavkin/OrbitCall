"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Clock, ListChecks, Loader2, Lock, Play, Radar, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scanStartRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { fmtAge, fmtObjectId, fmtStamp, pcMetric, pcSource, SOURCE_LABEL } from "@/lib/backend/format";
import { setLiveError, useLive, useRealMode } from "@/lib/backend/live";
import { mutate } from "@/lib/backend/run";
import type { MyQueueRow, Pc, ScanRun, SpaceObject } from "@/lib/backend/types";
import { runAgentsOn } from "@/lib/backend/workflow";
import { fmtChance, fmtCountdown, fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { runIncident, runScan } from "@/lib/ops/scenarios";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { OWNER_FLAGS, ownerInfo } from "@/lib/owners";
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

/** Queue order (user-flow §4): red before yellow, then the earliest closest approach, then the higher chance. */
const byPriority = (a: ConjunctionEvent, b: ConjunctionEvent) => (a.risk === b.risk ? 0 : a.risk === "red" ? -1 : 1) || a.tca - b.tca || b.pc - a.pc;

/** Primary action on the queue: one full screening pass (the simulator in dev, `scans.startMine` in real mode). */
export function ScanButton() {
  const dev = useOps((s) => s.dev);
  const real = useRealMode();
  const live = useLiveScan();
  const fleetSize = useLive((s) => s.fleet?.satellites.length);
  // user-flow §2: in real mode the button names the scope it scans
  const idle = !real ? "Run scan" : fleetSize === undefined ? "Scan my fleet" : `Scan my fleet (${fleetSize})`;
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
      className={`btn h-8 w-full gap-1.5 text-[12px] ${locked ? "bg-white/[0.06] text-neutral-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:text-neutral-300" : "btn-primary"}`}
      disabled={!locked && (real ? live.waiting || !!live.running : !dev || !ready || scanning || !!busy)}
      aria-haspopup={locked ? "dialog" : undefined}
      onClick={() => {
        if (locked) {
          sfx.click();
          setGate((g) => !g);
          return;
        }
        sfx.ping();
        if (real) void live.start();
        else runScan();
      }}
    >
      {real && !locked ? (
        <>
          {live.waiting || live.running ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
          {live.waiting ? "Starting scan…" : live.running ? phaseLabel(live.running) : idle}
        </>
      ) : (
        <>
          {scanning || busy ? <Loader2 size={13} className="animate-spin" /> : locked ? <Lock size={12} /> : <Radar size={13} />}
          {scanning ? "Scanning 18k objects…" : busy ? `Case in progress · ${busy}` : idle}
        </>
      )}
    </button>
  );
  if (locked)
    return (
      <>
        <Tooltip label={me ? "Your account has no scan access yet. Click to request it." : "Sign in as a dispatcher to scan your fleet"}>{btn}</Tooltip>
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
  if (real)
    return (
      <>
        {btn}
        <LiveScanStatus scan={live.scan} error={live.error} />
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

/** Ranked results of a scan: the simulator's in dev, the backend queue after a run in real mode. */
export function ScanResults() {
  const real = useRealMode();
  useLiveScanPhase(real);
  return real ? <LiveScanResults /> : <SimScanResults />;
}

/** Ranked results of a scan, drawn as if being written row by row; hover a row for its detail. */
function SimScanResults() {
  const scan = useOps((s) => s.scan);
  const tab = useOps((s) => s.tab);
  const events = useOps((s) => s.events);
  const now = useNow(1000);
  const open = scan.phase === "results" && tab === "orbit";
  const rows = useMemo(() => {
    return events.filter((e) => scan.ids.includes(e.id)).sort(byPriority);
  }, [events, scan.ids]);
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
                          <span className="tnum mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-neutral-500">
                            <span>
                              Closest approach {now ? fmtIn(e.tca - now) : ""} · {fmtWhen(e.tca)}
                            </span>
                            {e.reference && <ReferenceTag e={e} />}
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

const REF = {
  matched: { label: "Matched in SOCRATES", color: "var(--green)" },
  data_differs: { label: "SOCRATES: data differs", color: "var(--amber)" },
  not_listed: { label: "Not in SOCRATES", color: "#9aa3ad" },
} as const;

/** The SOCRATES check of a row, with what SOCRATES is and their numbers on hover. */
function ReferenceTag({ e }: { e: ConjunctionEvent }) {
  const r = e.reference!;
  const m = REF[r.status];
  const now = useNow(60_000);
  const hrs = now ? Math.max(1, Math.round((now - r.runAt) / 3600_000)) : null;
  return (
    <Tooltip
      side="bottom"
      label={
        <span className="block max-w-[300px] whitespace-normal text-left leading-[1.5]">
          <span className="block font-semibold text-white">SOCRATES check</span>
          <span className="mt-0.5 block text-neutral-300">
            SOCRATES is CelesTrak&rsquo;s public list of close approaches. It runs on its own schedule from older element sets, so it lags our scan{hrs ? ` (its last run was about ${hrs} h ago)` : ""}. We compare each pair our orbital service found with it.
          </span>
          {r.status === "matched" && (
            <span className="mt-1 block text-neutral-300">
              Same pair and time. Theirs: {fmtMiss(r.missM!)} apart, max probability {fmtOdds(r.maxProb!)}. Ours: {fmtMiss(e.missM)}, {fmtOdds(e.pc)}.
            </span>
          )}
          {r.status === "data_differs" && (
            <span className="mt-1 block text-neutral-300">
              They list this pair, but from different element sets, so the numbers are not comparable: theirs {fmtMiss(r.missM!)}, ours {fmtMiss(e.missM)}.
            </span>
          )}
          {r.status === "not_listed" && <span className="mt-1 block text-neutral-300">Their last run does not include this pair yet. That is not an error: their data may be older than ours.</span>}
          <span className="mt-1 block text-neutral-500">Provenance, not a confidence score.</span>
        </span>
      }
    >
      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[11px] font-medium" style={{ color: m.color, boxShadow: `inset 0 0 0 1px ${m.color}55` }}>
        {r.status === "matched" ? "✓" : r.status === "data_differs" ? "≈" : "○"} {m.label}
      </span>
    </Tooltip>
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
  const active = !!alert && !!ev && tab === "orbit" && phase === "results" && !RESOLVED.includes(ev.status);
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

/* ------------------------------------------------------------------ real mode: scans.startMine, getMine, myQueue */

// Wiring map §7.2. Run scan starts the caller's fleet scan; ScanSync (components/live/sync) puts the run in
// useLive.scan. While it runs it drives the same scan phase as the simulator (sweep, camera); when a run this
// screen watched finishes, the results list the caller's queue as the backend ranked it.

/** The run while it is queued or running, else null. */
const pendingRun = (r: ScanRun | null | undefined) => (r && (r.status === "queued" || r.status === "running") ? r : null);
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const windowHours = (r: ScanRun) => Math.round((r.toMs - r.fromMs) / 3600_000);

/** 950 / 112k / 1.2M: counters that fit the fleet panel. */
function fmtCount(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

const PHASE: Record<ScanRun["phase"], string> = {
  queued: "Scan queued",
  loading: "Loading the catalog",
  screening: "Screening",
  matching_sources: "Matching sources",
  publishing: "Publishing results",
  done: "Scan complete",
  failed: "Scan failed",
};

function phaseLabel(r: ScanRun) {
  const c = r.counts;
  return r.phase === "screening" ? `Screening ${c.primariesCompleted} of ${plural(c.primaryObjects, "satellite")}` : PHASE[r.phase];
}

/** Run scan in real mode: one requestId per click; the run it returns is the one ScanSync follows. */
function useLiveScan() {
  const scanId = useLive((s) => s.scanId);
  const scan = useLive((s) => s.scan);
  const syncError = useLive((s) => s.errors.scan);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // RATE_LIMITED and the like are advice for now, not a lasting state: they go once the 30 s wait is over
  useEffect(() => {
    if (!startError) return;
    const t = setTimeout(() => setStartError(null), 30_000);
    return () => clearTimeout(t);
  }, [startError]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { scanId: id } = await mutate(scanStartRef, { requestId: crypto.randomUUID() });
      const s = useLive.getState();
      if (s.scanId !== id) {
        // a reused run that is already on screen keeps its data; any other starts empty
        useLive.setState({ scanId: id, ...(s.scan?.scanId === id ? {} : { scan: undefined }) });
        setLiveError("scan", null);
      }
    } catch (e) {
      const b = backendError(e);
      setStartError(b.code === "UNKNOWN" ? "The scan could not start. Try again." : b.message);
    } finally {
      setStarting(false);
    }
  };

  return {
    scan,
    // from the click until getMine answers for the new run
    waiting: starting || (scanId !== null && scan === undefined && !syncError),
    running: pendingRun(scan),
    error: startError ?? syncError ?? null,
    start,
  };
}

/**
 * The backend run drives the scan phase the sweep, the camera (Director) and the results read, as runScan does in
 * dev. The results open when a run this screen saw pending completes, never for an old run found on load.
 */
function useLiveScanPhase(real: boolean) {
  useEffect(() => {
    if (!real) return;
    const apply = (scan: ScanRun | null | undefined, failed: boolean, prev: ScanRun | null | undefined) => {
      // loading: keep what is on screen until the run answers
      if (scan === undefined && !failed) return;
      const running = !failed && !!pendingRun(scan);
      const finished = !failed && scan?.status === "completed" && pendingRun(prev)?.scanId === scan.scanId;
      const ops = useOps.getState();
      const phase = running ? "scanning" : finished ? "results" : ops.scan.phase === "scanning" ? "idle" : ops.scan.phase;
      if (ops.scanning !== running || ops.scan.phase !== phase) useOps.setState({ scanning: running, scan: { phase, ids: [], stats: null } });
    };
    const now = useLive.getState();
    apply(now.scan, !!now.errors.scan, undefined);
    const unsub = useLive.subscribe((s, p) => {
      if (s.scan !== p.scan || s.errors.scan !== p.errors.scan) apply(s.scan, !!s.errors.scan, p.scan);
    });
    return () => {
      unsub();
      useOps.setState({ scanning: false, scan: { phase: "idle", ids: [], stats: null } });
    };
  }, [real]);
}

/** Under Run scan: the run's progress, then how it ended, or why it could not start. */
function LiveScanStatus({ scan, error }: { scan: ScanRun | null | undefined; error: string | null }) {
  const now = useNow(30_000);
  const running = pendingRun(scan);
  let view: { key: string; node: ReactNode } | null = null;
  if (error) view = { key: "error", node: <StatusLine icon={<TriangleAlert size={11} className="text-orange" />}>{error}</StatusLine> };
  else if (running) view = { key: "running", node: <LiveScanProgress scan={running} /> };
  else if (scan?.status === "failed")
    view = { key: "failed", node: <StatusLine icon={<TriangleAlert size={11} className="text-red" />}>Scan failed · {scan.error?.message ?? "No reason was given."}</StatusLine> };
  else if (scan?.status === "completed") view = { key: "done", node: <LastScanLine scan={scan} now={now} /> };
  return (
    <AnimatePresence initial={false} mode="wait">
      {view && (
        <motion.div
          key={view.key}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          {view.node}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StatusLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-2 text-[10.5px] leading-[1.45] text-fg-2">
      <span className="mt-[2px] shrink-0">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Measured progress from the orbit service; an indeterminate bar while it has no fraction yet. */
function LiveScanProgress({ scan }: { scan: ScanRun }) {
  const c = scan.counts;
  const pct = scan.progress === null ? null : Math.round(Math.min(Math.max(scan.progress, 0), 1) * 100);
  const early = scan.phase === "queued" || scan.phase === "loading";
  return (
    <div className="mt-2">
      <div
        className="h-[2px] overflow-hidden rounded-full bg-white/[0.08]"
        role="progressbar"
        aria-label="Scan progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        {pct === null ? (
          <motion.div
            className="h-full w-1/3 rounded-full bg-blue"
            initial={{ x: "-100%" }}
            animate={{ x: "300%" }}
            transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
          />
        ) : (
          <motion.div className="h-full rounded-full bg-blue" initial={false} animate={{ width: `${Math.max(pct, 3)}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} />
        )}
      </div>
      <div className="mono tnum mt-1.5 flex items-center gap-2 text-[10px] text-muted">
        <span className="min-w-0 truncate">
          {early ? `${plural(c.primaryObjects, "satellite")} · next ${windowHours(scan)} h` : `${fmtCount(c.pairsChecked)} pairs checked · ${c.eventsFound} found`}
        </span>
        {pct !== null && <span className="ml-auto shrink-0 text-fg-2">{pct}%</span>}
      </div>
    </div>
  );
}

function LastScanLine({ scan, now }: { scan: ScanRun; now: number }) {
  const at = scan.finishedAt ?? scan.updatedAt;
  const partial = !scan.coverage.complete;
  return (
    <div className="mt-2 flex items-center gap-2 text-[10.5px] text-muted">
      {partial ? <TriangleAlert size={11} className="shrink-0 text-amber" /> : <Clock size={11} className="shrink-0" />}
      <span className="min-w-0 truncate">
        {partial ? <span className="text-amber">Partial</span> : "Scanned"}
        {now > 0 && ` ${partial ? "· " : ""}${fmtAge(now - at)}`} · <span className="text-fg-2">{scan.counts.eventsFound}</span> found
      </span>
      <button
        className="ml-auto flex shrink-0 items-center gap-1 text-fg-2 hover:text-white"
        onClick={() => {
          sfx.click();
          useOps.setState((s) => ({ scan: { ...s.scan, phase: "results" } }));
        }}
      >
        <ListChecks size={11} /> Show
      </button>
    </div>
  );
}

const LIVE_TONE: Record<MyQueueRow["color"], string> = { red: "#ff8a80", yellow: "var(--amber)", none: "var(--fg-2)" };
const LIVE_RAIL: Record<MyQueueRow["color"], string> = { red: "var(--red)", yellow: "var(--amber)", none: "rgba(255,255,255,0.18)" };

const hasPc = (pc: Pc): pc is Pc & { value: number } => pc.value !== null && Number.isFinite(pc.value);
const reviewing = (r: MyQueueRow) => r.queueSection === "data_review";
const toneOf = (r: MyQueueRow) => (reviewing(r) ? "var(--muted)" : LIVE_TONE[r.color]);
const missOf = (r: MyQueueRow) => (Number.isFinite(r.missKm) ? fmtMiss(r.missKm * 1000) : "unknown");
const flagOf = (o: SpaceObject) => (o.country ? (OWNER_FLAGS[o.country]?.[0] ?? null) : null);
/** "publication_excluded_conflicting_encounters" → "Publication excluded conflicting encounters". */
const reasonText = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Why a backend row sits where it does, in words; red and yellow follow the backend's colorOf / isRed rules. */
function whyQueued(r: MyQueueRow, now: number) {
  const left = Date.parse(r.tcaUtc) - now;
  const when = now && left > 0 ? `${fmtIn(left).replace("in ", "")} away` : "passed or unknown";
  if (reviewing(r)) return `No source supplied a probability for this pair, so it waits in Data needs review. That is not zero risk. Closest approach ${when}.`;
  if (r.color === "red") return `Chance above the 1 in 10,000 action line and closest approach ${when}, inside the 72 h window.`;
  if (r.color === "yellow" && hasPc(r.pc) && r.pc.value > 1e-4) return `Chance above the action line, but closest approach is ${when}, beyond the 72 h window.`;
  if (r.color === "yellow") return `Below the action line: watch it, no action needed yet. Closest approach ${when}.`;
  return `Chance below 1 in 100,000. Closest approach ${when}.`;
}

/** Real mode: the run that just finished, then the caller's queue after it (`myQueue`, active before data review). */
function LiveScanResults() {
  const scan = useLive((s) => s.scan);
  const queue = useLive((s) => s.myQueue);
  const queueError = useLive((s) => s.errors.queue);
  const phase = useOps((s) => s.scan.phase);
  const tab = useOps((s) => s.tab);
  const now = useNow(1000);
  const run = scan?.status === "completed" ? scan : null;
  const open = phase === "results" && tab === "orbit" && !!run;
  // history is past its closest approach: nothing a scan of the next 72 h found
  const rows = useMemo(() => queue?.filter((r) => r.queueSection !== "history") ?? [], [queue]);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const chosen = sel && rows.some((r) => r.eventId === sel) ? sel : (rows[0]?.eventId ?? null);
  const shown = rows.find((r) => r.eventId === (hover ?? chosen)) ?? null;
  const red = rows.filter((r) => !reviewing(r) && r.color === "red").length;

  const close = () => {
    sfx.close();
    setRunError(null);
    useOps.setState((s) => ({ scan: { ...s.scan, phase: "idle" } }));
  };
  const runAgents = async (id: string | null) => {
    if (!id || starting) return;
    sfx.click();
    setStarting(id);
    setRunError(null);
    const error = await runAgentsOn(id);
    setStarting(null);
    if (error) {
      setRunError(error.message);
      return;
    }
    sfx.whoosh();
    setSel(null);
    useOps.setState((s) => ({ scan: { ...s.scan, phase: "idle" } }));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const i = rows.findIndex((r) => r.eventId === chosen);
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length) {
        e.preventDefault();
        const j = Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
        setSel(rows[j]?.eventId ?? null);
        setHover(null);
        sfx.hover();
      } else if (e.key === "Enter") void runAgents(chosen);
      else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const ROW_DELAY = 0.16;
  // long queues must not take seconds to write out: the first rows animate, the rest arrive with them
  const delayOf = (i: number) => 0.15 + Math.min(i, 10) * ROW_DELAY;
  const firstReview = rows.findIndex(reviewing);
  const index = rows.findIndex((r) => r.eventId === chosen);

  return (
    <AnimatePresence>
      {open && run && (
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
            <div className="flex items-start gap-4 border-b border-white/[0.07] px-7 pb-4 pt-6">
              <div className="min-w-0 flex-1">
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-white">{run.coverage.complete ? "Screening complete" : "Screening incomplete"}</div>
                <div className="tnum mt-1 text-[13px] text-neutral-500">
                  {plural(run.counts.primaryObjects, "satellite")} · {run.counts.catalogObjects.toLocaleString("en-US")} objects ·{" "}
                  {run.counts.pairsChecked.toLocaleString("en-US")} pairs checked · {run.counts.eventsFound} found · next {windowHours(run)} h
                  {run.startedAt !== null && run.finishedAt !== null && ` · ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s`}
                </div>
                <ScopeLine run={run} />
              </div>
              {red > 0 && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: delayOf(rows.length) + 0.05 }}
                  className="mt-1 flex items-center gap-1.5 rounded-full bg-[rgba(255,90,79,0.12)] px-3 py-1 text-[12.5px] font-semibold text-[#ff8a80] shadow-[inset_0_0_0_1px_rgba(255,90,79,0.35)]"
                >
                  <ShieldAlert size={13} /> {red} need action within 72 h
                </motion.span>
              )}
              <button className="icon-btn -mr-2 h-8 w-8" onClick={close} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            {!run.coverage.complete && <CoverageNotice run={run} />}

            {rows.length > 0 ? (
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                <div className="thin-scroll min-h-0 overflow-y-auto border-r border-white/[0.07] px-4 py-3">
                  {run.counts.eventsFound === 0 && (
                    <p className="px-3 pb-2 text-[12.5px] text-neutral-500">
                      No close approaches found within this scan&apos;s scope and {windowHours(run)}-hour window. Your open incidents:
                    </p>
                  )}
                  {rows.map((r, i) => (
                    <div key={r.eventId}>
                      {i === firstReview && (
                        <div className="px-3 pb-1.5 pt-3">
                          <span className="eyebrow">Data needs review</span>
                          <p className="mt-1 text-[12px] text-neutral-500">No source supplied a probability for these pairs. That is not zero risk.</p>
                        </div>
                      )}
                      <LiveRow
                        row={r}
                        n={i + 1}
                        now={now}
                        active={r.eventId === chosen}
                        hovered={hover === r.eventId}
                        delay={delayOf(i)}
                        tick={i > 0 && i <= 10}
                        onSelect={() => {
                          sfx.click();
                          setSel(r.eventId);
                        }}
                        onRun={() => void runAgents(r.eventId)}
                        onHover={(on) => {
                          if (on) sfx.hover();
                          setHover(on ? r.eventId : null);
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="thin-scroll min-h-0 overflow-y-auto px-7 py-5">
                  <AnimatePresence mode="wait">
                    {shown && (
                      <motion.div key={shown.eventId} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.2 }}>
                        <LiveCaseDetail row={shown} n={rows.indexOf(shown) + 1} now={now} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center px-7">
                <QueueState run={run} loading={queue === undefined} error={queueError ?? null} />
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-white/[0.07] px-7 py-4">
              {runError ? (
                <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-orange" role="alert">
                  <TriangleAlert size={12} className="shrink-0" />
                  <span className="truncate">{runError}</span>
                </span>
              ) : rows.length > 0 ? (
                <span className="text-[12px] text-neutral-500">
                  <span className="kbd">↑</span> <span className="kbd">↓</span> choose · <span className="kbd">↵</span> run · hover a row for its detail
                </span>
              ) : null}
              <button className="btn ml-auto h-10 px-4 text-[13px] text-neutral-300" onClick={close}>
                {rows.length > 0 ? "Later" : "Close"}
              </button>
              {rows.length > 0 && (
                <button className="btn btn-primary h-10 px-5 text-[14px]" disabled={!chosen || !!starting} onClick={() => void runAgents(chosen)}>
                  {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run agents on case {index + 1} <ArrowRight size={13} />
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** What the run screened against: the service's own scope line, with exclusions; the reasons on hover. */
function ScopeLine({ run }: { run: ScanRun }) {
  const { catalogScope, excludedObjects, reasons } = run.coverage;
  const full = [catalogScope, ...reasons.map((r) => `${reasonText(r.reason)}: ${r.count}`)].join("\n");
  return (
    <div className="mt-1 truncate text-[12px] text-neutral-600" title={full}>
      {catalogScope}
      {excludedObjects > 0 && ` · ${plural(excludedObjects, "object")} excluded`}
    </div>
  );
}

/** A partial scan never reads as clear: what was not screened, and why. */
function CoverageNotice({ run }: { run: ScanRun }) {
  const { missingPrimaryIds, reasons } = run.coverage;
  return (
    <div
      className="flex items-start gap-3 border-b border-white/[0.07] px-7 py-3 text-[12.5px] leading-[1.55]"
      style={{ background: "color-mix(in srgb, var(--amber) 6%, transparent)" }}
    >
      <TriangleAlert size={14} className="mt-[3px] shrink-0 text-amber" />
      <div className="min-w-0 text-neutral-400">
        <span className="font-semibold text-amber">Partial coverage.</span> Part of the fleet or catalog was not screened, so this is not a clear result.
        {missingPrimaryIds.length > 0 && (
          <>
            {" "}
            Not screened: <span className="mono text-neutral-300">{missingPrimaryIds.map(fmtObjectId).join(", ")}</span>.
          </>
        )}
        {reasons.length > 0 && <span className="block text-neutral-500">{reasons.map((r) => `${reasonText(r.reason)} (${r.count})`).join(" · ")}</span>}
      </div>
    </div>
  );
}

/** The list area with no rows: loading, an error, or a zero result (never a clear badge for a partial scan). */
function QueueState({ run, loading, error }: { run: ScanRun; loading: boolean; error: string | null }) {
  if (error || loading) {
    return (
      <div className="max-w-[440px] text-center" role="status">
        {error ? <TriangleAlert size={18} className="mx-auto text-orange" /> : <Loader2 size={18} className="mx-auto animate-spin text-neutral-500" />}
        <div className="mt-3 text-[15px] font-semibold text-white">{error ? "Couldn’t load your queue" : "Loading your queue…"}</div>
        {error && <p className="mono mt-1.5 break-words text-[11.5px] leading-[1.6] text-neutral-500">{error}</p>}
      </div>
    );
  }
  const found = run.counts.eventsFound;
  const text = !run.coverage.complete
    ? "None in the part of the fleet that was screened. Coverage is partial, so this is not a clear result."
    : found > 0
      ? `The scan reported ${found} close approach${found === 1 ? "" : "es"}, but none is in your queue.`
      : `No close approaches found within this scan's scope and ${windowHours(run)}-hour window.`;
  return (
    <div className="max-w-[440px] text-center">
      <Radar size={18} className="mx-auto text-neutral-500" />
      <div className="mt-3 text-[15px] font-semibold text-white">No close approaches in your queue</div>
      <p className="mt-1.5 text-[13px] leading-[1.6] text-neutral-400">{text}</p>
    </div>
  );
}

function LiveRow({
  row,
  n,
  now,
  active,
  hovered,
  delay,
  tick,
  onSelect,
  onRun,
  onHover,
}: {
  row: MyQueueRow;
  n: number;
  now: number;
  active: boolean;
  hovered: boolean;
  delay: number;
  tick: boolean;
  onSelect: () => void;
  onRun: () => void;
  onHover: (on: boolean) => void;
}) {
  const tca = Date.parse(row.tcaUtc);
  const tone = toneOf(row);
  return (
    <motion.button
      initial={{ opacity: 0, y: -14, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      transition={{ delay, duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      onAnimationStart={() => tick && sfx.tick()}
      className="relative block w-full overflow-hidden rounded-[14px] text-left"
      onClick={onSelect}
      onDoubleClick={onRun}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <div
        className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-200"
        style={{ background: active ? "rgba(255,255,255,0.07)" : hovered ? "rgba(255,255,255,0.04)" : "transparent" }}
      >
        <motion.span
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(100deg,transparent_30%,rgba(255,255,255,0.08)_50%,transparent_70%)]"
          initial={{ x: "-100%" }}
          animate={{ x: "100%" }}
          transition={{ delay: delay + 0.05, duration: 0.7, ease: "easeOut" }}
        />
        <span className="w-4 shrink-0 text-right text-[13px] text-neutral-600">{n}</span>
        <span className="h-9 w-[3px] shrink-0 rounded-full" style={{ background: reviewing(row) ? "rgba(255,255,255,0.18)" : LIVE_RAIL[row.color] }} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-white">
            <LivePairName row={row} />
          </span>
          <span className="tnum mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-neutral-500">
            <span>
              Closest approach {now && Number.isFinite(tca) ? fmtIn(tca - now) : ""} · {Number.isFinite(tca) ? fmtWhen(tca) : "time unknown"}
            </span>
            {row.simulated && <span className="mono text-[10px] uppercase tracking-[0.1em] text-orange">sim</span>}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="tnum block whitespace-nowrap text-[16px] font-semibold" style={{ color: tone }}>
            {hasPc(row.pc) ? fmtOdds(row.pc.value) : "Pc unavailable"}
            {hasPc(row.pc) && row.pc.metric === "max_prob" && <span className="ml-1 text-[10px] font-medium uppercase tracking-[0.08em] opacity-70">max</span>}
          </span>
          <span className="tnum mt-0.5 block text-[12px] text-neutral-500">{missOf(row)} apart</span>
        </span>
      </div>
      {active && <motion.span layoutId="scan-sel" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white" />}
    </motion.button>
  );
}

function LivePairName({ row }: { row: MyQueueRow }) {
  const fa = flagOf(row.objectA);
  const fb = flagOf(row.objectB);
  return (
    <>
      {fa && <Flag code={fa} h={11} />}
      <span className="truncate">{row.objectA.name}</span>
      <span className="shrink-0 font-normal text-neutral-600">×</span>
      {fb && <Flag code={fb} h={11} />}
      <span className="truncate text-neutral-300">{row.objectB.name}</span>
    </>
  );
}

function LiveCaseDetail({ row, n, now }: { row: MyQueueRow; n: number; now: number }) {
  const tca = Date.parse(row.tcaUtc);
  const tone = toneOf(row);
  const pc = row.pc;
  const level = reviewing(row) ? "Data needs review" : row.color === "red" ? "Needs action" : row.color === "yellow" ? "Watch" : "Low probability";
  const sources = row.sources.map((s) => SOURCE_LABEL[s.name] ?? s.name).join(" · ");
  return (
    <div>
      <div className="text-[12px] font-medium" style={{ color: tone }}>
        #{n} · {level}
        {row.simulated && " · Simulated"}
      </div>
      <h3 className="mt-1.5 text-[20px] font-semibold leading-[1.3] tracking-[-0.02em] text-white">
        {row.objectA.name} passes {missOf(row)} from {row.objectB.name}
      </h3>
      <p className="tnum mt-1.5 text-[13px] text-neutral-400">
        {fmtStamp(row.tcaUtc)}
        {now > 0 && Number.isFinite(tca) && ` · ${fmtIn(tca - now)}`}
      </p>

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
        {hasPc(pc) ? (
          <DetailFact k={pcMetric(pc).long} v={fmtOdds(pc.value)} sub={`${fmtChance(pc.value)} · ${pcSource(pc)}`} tone={tone} />
        ) : (
          <DetailFact k="Chance of collision" v="Unavailable" sub="No source supplied one" tone="var(--muted)" />
        )}
        <DetailFact k="Miss distance" v={missOf(row)} sub="at closest approach" />
        <DetailFact k="Relative speed" v={Number.isFinite(row.relSpeedKmS) ? `${row.relSpeedKmS.toFixed(1)} km/s` : "unknown"} sub="how fast they pass each other" />
        <DetailFact k="Evidence" v={hasPc(pc) ? pcSource(pc) : "No probability"} sub={sources || undefined} />
      </div>

      <div className="mt-5 space-y-2.5">
        <LiveObjectLine o={row.objectA} mine={row.myObjectIds.includes(row.objectA.objectId)} />
        <LiveObjectLine o={row.objectB} mine={row.myObjectIds.includes(row.objectB.objectId)} />
      </div>

      <div className="mt-5 rounded-[12px] bg-white/[0.03] px-4 py-3">
        <div className="text-[12px] font-semibold text-neutral-300">Why it&apos;s ranked here</div>
        <p className="mt-1 text-[13px] leading-[1.6] text-neutral-400">{whyQueued(row, now)}</p>
      </div>
    </div>
  );
}

function LiveObjectLine({ o, mine }: { o: SpaceObject; mine: boolean }) {
  const flag = flagOf(o);
  const meta = [o.ownerName ?? "Owner unknown", mine ? "your satellite" : null, o.simulated ? "simulated" : null].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
        {flag && <Flag code={flag} h={28} square />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13.5px] font-medium text-white">{o.name}</span>
          <span className="mono shrink-0 text-[11.5px] text-neutral-500">{fmtObjectId(o.objectId)}</span>
        </div>
        <div className="truncate text-[12px] text-neutral-500">{meta}</div>
      </div>
    </div>
  );
}
