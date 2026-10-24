"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Check, Copy, Crosshair, Route, Satellite, Sun, Moon, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SatLive } from "@/components/globe/GlobeScene";
import { formatCospar, type SatObject } from "@/lib/catalog/client";
import { fmtAgo, fmtInt, fmtLat, fmtLon, fmtNum } from "@/lib/format";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { CATEGORY_META } from "@/lib/theme";
import { Tooltip } from "./Tooltip";

const OBJECT_TYPES: Record<string, string> = { PAY: "Payload", "R/B": "Rocket body", DEB: "Debris", UNK: "Unknown" };

export function SatellitePanel() {
  const selected = useOrbit((s) => s.selected);
  const obj = useOrbit((s) => (s.selected !== null ? s.catalog?.objects[s.selected] : undefined));
  const owners = useOrbit((s) => s.catalog?.owners);

  return (
    <div className="pointer-events-none absolute right-2.5 top-[58px] z-20">
      <AnimatePresence mode="wait">
        {obj && selected !== null && (
          <motion.aside
            key={obj.norad}
            initial={{ opacity: 0, x: 16, filter: "blur(8px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: 16, filter: "blur(8px)" }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="glass thin-scroll pointer-events-auto relative block max-h-[calc(100vh-58px-250px)] w-[296px] overflow-y-auto rounded-[14px]"
          >
            <Body obj={obj} owners={owners ?? {}} />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function Body({ obj, owners }: { obj: SatObject; owners: Record<string, string> }) {
  const meta = CATEGORY_META[obj.category];
  const following = useOrbit((s) => s.following);
  const groundTrack = useOrbit((s) => s.showGroundTrack);
  const set = useOrbit((s) => s.set);
  const [live, setLive] = useState<SatLive | null>(null);
  const [path, setPath] = useState<{ alts: Float32Array; periodMs: number; start: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => {
      setLive(sceneRef.get()?.liveState(obj.index) ?? null);
      setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [obj.index]);

  useEffect(() => {
    const scene = sceneRef.get();
    if (!scene) return;
    const fn = (i: number, alts: Float32Array, periodMs: number, start: number) => {
      if (i === obj.index) setPath({ alts, periodMs, start });
    };
    scene.pathListeners.add(fn);
    return () => {
      scene.pathListeners.delete(fn);
    };
  }, [obj.index]);

  const epochAge = now - obj.epoch.getTime();
  const owner = owners[obj.owner] ?? obj.owner;

  return (
    <>
      {/* header */}
      <div className="flex items-start gap-2.5 p-3 pb-2.5">
        <div
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
          style={{ color: meta.color }}
        >
          <Satellite size={16} strokeWidth={1.7} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em]">{obj.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted">
            <span className="mono text-fg-2">#{obj.norad}</span>
            <span>·</span>
            <span style={{ color: meta.color }}>{meta.label}</span>
            <span>·</span>
            <span>{obj.regime}</span>
          </div>
        </div>
        <Tooltip label="Close" hint="Esc">
          <button className="icon-btn -mr-1 -mt-1 h-6 w-6" onClick={() => set({ selected: null, following: false })} aria-label="Close">
            <X size={13} />
          </button>
        </Tooltip>
      </div>

      {/* status chips */}
      <div className="flex flex-wrap gap-1.5 px-3">
        {live && (
          <Chip
            color={live.sunlit ? "var(--amber)" : "var(--blue)"}
            icon={live.sunlit ? <Sun size={10} /> : <Moon size={10} />}
            label={live.sunlit ? "Sunlit" : "In Earth shadow"}
          />
        )}
        {following && <Chip color="var(--green)" dot label="Following" />}
        {epochAge > 7 * 86400_000 && <Chip color="var(--orange)" label={`Stale TLE · ${fmtAgo(epochAge)}`} />}
      </div>

      {/* live metrics */}
      <div className="mx-3 mt-2.5 grid grid-cols-2 overflow-hidden rounded-[10px] bg-white/[0.025] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
        <Metric label="Altitude" value={live ? fmtInt(Math.round(live.altKm)) : "—"} unit="km" big />
        <Metric label="Velocity" value={live ? fmtNum(live.speedKms, 3) : "—"} unit="km/s" big border />
        <Metric label="Latitude" value={live ? fmtLat(live.lat) : "—"} top />
        <Metric label="Longitude" value={live ? fmtLon(live.lon) : "—"} border top />
      </div>

      {/* altitude profile over one revolution */}
      <div className="px-3 pt-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Altitude · next orbit</span>
          <span className="mono text-[10px] text-muted">{fmtNum(obj.periodMin, 1)} min</span>
        </div>
        <AltitudeChart path={path} color={meta.color} />
      </div>

      {/* actions */}
      <div className="flex gap-1.5 px-3 pt-2.5">
        <button
          className={`btn flex-1 ${following ? "btn-ghost-line" : "btn-primary"}`}
          onClick={() => {
            sfx.whoosh();
            set({ following: !following });
          }}
        >
          <Crosshair size={12} />
          {following ? "Stop following" : "Follow"}
          <span className={`kbd ml-0.5 ${following ? "" : "!bg-black/10 !text-black/50 !shadow-none"}`}>F</span>
        </button>
        <Tooltip label={groundTrack ? "Hide ground track" : "Show ground track"} hint="G">
          <button
            className="icon-btn btn-ghost-line h-7 w-8"
            data-active={groundTrack}
            onClick={() => {
              sfx.toggle(!groundTrack);
              set({ showGroundTrack: !groundTrack });
            }}
            aria-label="Toggle ground track"
          >
            <Route size={13} />
          </button>
        </Tooltip>
        <Tooltip label={copied ? "Copied" : "Copy TLE"}>
          <button
            className="icon-btn btn-ghost-line h-7 w-8"
            onClick={() => {
              void navigator.clipboard.writeText(`${obj.name}\n${obj.line1}\n${obj.line2}`);
              sfx.click();
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            aria-label="Copy TLE"
          >
            {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />}
          </button>
        </Tooltip>
      </div>

      {/* orbit */}
      <Section title="Orbit">
        <Row k="Inclination" v={`${fmtNum(obj.inclination, 2)}°`} />
        <Row k="Apogee × perigee" v={`${fmtInt(Math.round(obj.apogeeKm))} × ${fmtInt(Math.round(obj.perigeeKm))} km`} />
        <Row k="Eccentricity" v={obj.eccentricity.toFixed(5)} />
        <Row k="Mean motion" v={`${fmtNum(obj.meanMotion, 4)} rev/d`} />
        <Row
          k="Element set epoch"
          v={`${obj.epoch.toISOString().slice(0, 16).replace("T", " ")}`}
          hint={`${fmtAgo(epochAge)} ago`}
          warn={epochAge > 7 * 86400_000}
        />
      </Section>

      {/* identity from SATCAT */}
      <Section title="Identity · SATCAT">
        <Row k="COSPAR ID" v={formatCospar(obj.cospar)} />
        <Row k="Owner" v={owner || "—"} wrap />
        <Row k="Launched" v={obj.launchDate || "—"} hint={obj.launchSite || undefined} />
        <Row k="Object type" v={OBJECT_TYPES[obj.objectType] ?? (obj.objectType || "—")} />
        <Row k="Radar cross-section" v={obj.rcs !== null ? `${fmtNum(obj.rcs, 2)} m²` : "not published"} />
      </Section>

      <div className="flex items-center justify-between px-3 pb-3 pt-1">
        <a
          href={`https://celestrak.org/satcat/records.php?CATNR=${obj.norad}`}
          target="_blank"
          rel="noreferrer"
          className="btn -ml-2 h-6 px-2 text-[11px] text-muted"
          onClick={() => sfx.click()}
        >
          CelesTrak record <ArrowUpRight size={11} />
        </a>
        <span className="mono text-[10px] text-faint">SGP4 · TEME</span>
      </div>
    </>
  );
}

function Chip({ color, label, icon, dot }: { color: string; label: string; icon?: React.ReactNode; dot?: boolean }) {
  return (
    <span
      className="flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[10.5px] font-medium"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      {dot && <span className="pulse-dot" style={{ width: 5, height: 5 }} />}
      {icon}
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  unit,
  big,
  border,
  top,
}: {
  label: string;
  value: string;
  unit?: string;
  big?: boolean;
  border?: boolean;
  top?: boolean;
}) {
  return (
    <div className={`px-2.5 py-2 ${border ? "border-l border-white/[0.055]" : ""} ${top ? "border-t border-white/[0.055]" : ""}`}>
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`tnum mt-0.5 font-semibold tracking-[-0.02em] ${big ? "text-[19px]" : "mono text-[12px] font-medium"}`}>
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-normal tracking-normal text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3.5">
      <div className="eyebrow mb-1">{title}</div>
      <div className="divide-y divide-white/[0.045]">{children}</div>
    </div>
  );
}

function Row({ k, v, hint, warn, wrap }: { k: string; v: string; hint?: string; warn?: boolean; wrap?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[6px]">
      <span className="shrink-0 text-[11px] text-muted">{k}</span>
      <span className={`mono tnum text-right text-[11px] ${warn ? "text-orange" : "text-fg"} ${wrap ? "" : "truncate"}`}>
        {v}
        {hint && <span className="ml-1.5 text-muted">{hint}</span>}
      </span>
    </div>
  );
}

/** Real altitude over the next revolution, from the worker's SGP4 path. */
function AltitudeChart({ path, color }: { path: { alts: Float32Array; periodMs: number; start: number } | null; color: string }) {
  const W = 270;
  const H = 64;
  if (!path || path.alts.length < 2) {
    return <div className="mt-2 h-[64px] animate-pulse rounded-[8px] bg-white/[0.03]" />;
  }
  const a = Array.from(path.alts);
  const min = Math.min(...a);
  const max = Math.max(...a);
  const span = Math.max(max - min, 1);
  const pts = a.map((v, i) => [(i / (a.length - 1)) * W, H - 8 - ((v - min) / span) * (H - 18)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const minI = a.indexOf(min);
  const maxI = a.indexOf(max);
  return (
    <div className="relative mt-1.5">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        <defs>
          <linearGradient id="altfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <filter id="glow" x="-10%" y="-50%" width="120%" height="200%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="white" strokeOpacity="0.04" />
        ))}
        <path d={`${d}L${W},${H}L0,${H}Z`} fill="url(#altfill)" />
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeOpacity="0.5" filter="url(#glow)" />
        <path d={d} fill="none" stroke={color} strokeWidth="1.4" />
        {/* now marker at the start of the path */}
        <circle cx={pts[0][0]} cy={pts[0][1]} r="3" fill="#fff" />
        <circle cx={pts[0][0]} cy={pts[0][1]} r="6" fill="none" stroke="#fff" strokeOpacity="0.35" />
        <text x={pts[maxI][0]} y={Math.max(pts[maxI][1] - 5, 8)} fill="white" fillOpacity="0.55" fontSize="8.5" textAnchor="middle" className="mono">
          {fmtInt(Math.round(max))}
        </text>
        <text x={pts[minI][0]} y={Math.min(pts[minI][1] + 12, H)} fill="white" fillOpacity="0.4" fontSize="8.5" textAnchor="middle" className="mono">
          {fmtInt(Math.round(min))}
        </text>
      </svg>
      <div className="mono mt-0.5 flex justify-between text-[9.5px] text-faint">
        <span>now</span>
        <span>+{fmtNum(path.periodMs / 120000, 0)}m</span>
        <span>+{fmtNum(path.periodMs / 60000, 0)}m</span>
      </div>
    </div>
  );
}
