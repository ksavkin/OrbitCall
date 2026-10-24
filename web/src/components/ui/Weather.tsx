"use client";

import { AnimatePresence, motion } from "motion/react";
import { Activity, ArrowUpRight, ChevronDown, Cloud, CloudRainWind, Loader2, Orbit, Sparkles, Tornado, Wind, WavesHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { STORM_COLORS } from "@/components/globe/weather";
import { fmtAgo } from "@/lib/format";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit, type WxLayer, type WxStatus } from "@/lib/store";
import type { Storm } from "@/lib/weather/types";
import { Tooltip } from "./Tooltip";

export const WX_LAYERS: { id: WxLayer; label: string; icon: typeof Cloud; source: string }[] = [
  { id: "clouds", label: "Clouds", icon: Cloud, source: "EUMETSAT geostationary IR mosaic" },
  { id: "wind", label: "Wind", icon: Wind, source: "NOAA GFS 10 m wind" },
  { id: "currents", label: "Currents", icon: WavesHorizontal, source: "MeteoFrance SMOC via Open-Meteo" },
  { id: "storms", label: "Storms", icon: CloudRainWind, source: "NOAA NHC + GDACS" },
  { id: "tornado", label: "Tornadoes", icon: Tornado, source: "NWS warnings + SPC reports (US)" },
  { id: "aurora", label: "Aurora", icon: Sparkles, source: "NOAA SWPC OVATION" },
];

export const CONGESTION_LAYERS: typeof WX_LAYERS = [
  { id: "traffic", label: "Traffic", icon: Activity, source: "Objects overhead per region, from live positions" },
  { id: "debris", label: "Debris", icon: Orbit, source: "Debris overhead per region, from live positions" },
];

function stormLabel(s: Storm) {
  if (s.category > 0) return `Cat ${s.category}`;
  return s.kind.replace("Tropical ", "T. ");
}

/** Toggle chips, shown in the Layers popover. */
export function WeatherToggles({ layers = WX_LAYERS }: { layers?: typeof WX_LAYERS }) {
  const wx = useOrbit((s) => s.wx);
  const status = useOrbit((s) => s.wxStatus);
  const setWx = useOrbit((s) => s.setWx);
  return (
    <div className="grid grid-cols-3 gap-1">
      {layers.map(({ id, label, icon: Icon, source }) => {
        const on = wx[id];
        const st = status[id];
        return (
          <Tooltip key={id} label={source} side="top" delay={500}>
            <button
              onClick={() => {
                sfx.toggle(!on);
                setWx(id, !on);
              }}
              className={`flex h-[30px] w-[96px] items-center gap-1.5 rounded-[8px] px-2 text-[11px] transition-all ${
                on
                  ? "bg-white/[0.1] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
                  : "text-muted hover:bg-white/[0.05] hover:text-fg-2"
              }`}
            >
              {on && st?.state === "loading" ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
              {label}
              {on && st?.state === "error" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-red" />}
              {on && st?.state === "ready" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-green" />}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Compact live-weather summary above the Layers button. */
export function WeatherCard() {
  const wx = useOrbit((s) => s.wx);
  const storms = useOrbit((s) => s.storms);
  const tornado = useOrbit((s) => s.tornado);
  const kp = useOrbit((s) => s.kp);
  const status = useOrbit((s) => s.wxStatus);
  const [open, setOpen] = useState(true);
  // 0 on the server: Date.now() during prerender would make the page non-deterministic
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const anyOn = Object.values(wx).some(Boolean);
  if (!anyOn) return null;
  const g = kp ? gScale(kp.now) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass pointer-events-auto relative w-[244px] shrink-0 rounded-[14px]"
    >
      <button className="flex w-full items-center justify-between px-3 pb-1.5 pt-2.5" onClick={() => setOpen(!open)}>
        <span className="eyebrow flex items-center gap-1.5">
          <span className="pulse-dot text-green" style={{ width: 5, height: 5 }} />
          Live weather
        </span>
        <ChevronDown size={13} className={`text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
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
            <div className="thin-scroll max-h-[30vh] overflow-y-auto px-1.5 pb-2">
              {wx.storms && (
                <Section title="Tropical cyclones" st={status.storms} now={now}>
                  {storms.length === 0 && status.storms?.state === "ready" && <Empty>No active tropical cyclones</Empty>}
                  {storms.map((s) => (
                    <button
                      key={s.id}
                      className="group flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left hover:bg-white/[0.05]"
                      onClick={() => {
                        sfx.whoosh();
                        sceneRef.get()?.flyToLatLon(s.lat, s.lon, 2.2);
                      }}
                    >
                      <span
                        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-black"
                        style={{ background: STORM_COLORS[Math.min(s.category, 5)] }}
                      >
                        {s.category || "TS"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] text-fg">{s.name}</span>
                        <span className="mono block truncate text-[10px] text-muted">
                          {s.windKt ? `${s.windKt} kt` : "—"}
                          {s.pressureMb ? ` · ${s.pressureMb} mb` : ""} · {fmtAgo(now - Date.parse(s.updated))} ago
                        </span>
                      </span>
                      <ArrowUpRight size={11} className="text-faint group-hover:text-fg-2" />
                    </button>
                  ))}
                </Section>
              )}
              {(wx.traffic || wx.debris) && <CongestionSection now={now} />}
              {wx.tornado && (
                <Section title="Tornadoes · US" st={status.tornado} now={now}>
                  {tornado && (
                    <div className="flex gap-3 px-1.5 py-1 text-[11px]">
                      <span className={tornado.warnings.length ? "text-red" : "text-fg-2"}>
                        <span className="mono">{tornado.warnings.filter((w) => w.event === "Tornado Warning").length}</span> warnings
                      </span>
                      <span className="text-fg-2">
                        <span className="mono">{tornado.warnings.filter((w) => w.event === "Tornado Watch").length}</span> watches
                      </span>
                      <span className="text-fg-2">
                        <span className="mono">{tornado.reports.length}</span> reports today
                      </span>
                    </div>
                  )}
                </Section>
              )}
              <Section title="Space weather" st={status.space} now={now}>
                {kp && g && (
                  <div className="px-1.5 py-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] text-muted">Kp</span>
                      <span className="tnum text-[17px] font-semibold leading-none" style={{ color: g.color }}>
                        {kp.now.toFixed(1)}
                      </span>
                      <span className="text-[10.5px]" style={{ color: g.color }}>
                        {g.label}
                      </span>
                    </div>
                    <div className="mt-1.5 flex h-6 items-end gap-[2px]">
                      {kp.history.map((h) => (
                        <Tooltip key={h.t} label={`Kp ${h.kp.toFixed(2)} · ${h.t.slice(5, 16).replace("T", " ")} UTC`} side="top">
                          <span
                            className="block w-[7px] rounded-[1.5px]"
                            style={{ height: `${Math.max((h.kp / 9) * 24, 2)}px`, background: gScale(h.kp).color, opacity: 0.85 }}
                          />
                        </Tooltip>
                      ))}
                    </div>
                    <div className="mt-1 text-[10px] leading-snug text-faint">
                      Geomagnetic storms heat the upper atmosphere and raise drag on LEO satellites.
                    </div>
                  </div>
                )}
              </Section>
              <div className="mt-1 space-y-0.5 px-1.5 text-[10px] text-faint">
                {(["clouds", "wind", "currents"] as const)
                  .filter((k) => wx[k])
                  .map((k) => (
                    <LayerTime key={k} label={WX_LAYERS.find((l) => l.id === k)!.label} st={status[k]} now={now} />
                  ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function gScale(kp: number) {
  if (kp >= 9) return { label: "G5 extreme storm", color: "#c084fc" };
  if (kp >= 8) return { label: "G4 severe storm", color: "#ff3d8b" };
  if (kp >= 7) return { label: "G3 strong storm", color: "#ff5a4f" };
  if (kp >= 6) return { label: "G2 moderate storm", color: "#ff9f40" };
  if (kp >= 5) return { label: "G1 minor storm", color: "#f5c451" };
  if (kp >= 4) return { label: "Active", color: "#e8e8a0" };
  return { label: "Quiet", color: "#3ddc97" };
}

function Section({ title, st, now, children }: { title: string; st?: WxStatus; now: number; children: React.ReactNode }) {
  return (
    <div className="mt-1">
      <div className="flex items-center justify-between px-1.5 pb-0.5">
        <span className="text-[10.5px] font-medium text-fg-2">{title}</span>
        <StatusText st={st} now={now} />
      </div>
      {children}
    </div>
  );
}

function StatusText({ st, now }: { st?: WxStatus; now: number }) {
  if (!st || st.state === "loading") return <span className="text-[10px] text-faint">loading…</span>;
  if (st.state === "error") return <span className="text-[10px] text-red">unavailable</span>;
  return <span className="mono text-[10px] text-faint">{st.validAt ? `${fmtAgo(now - Date.parse(st.validAt))} ago` : ""}</span>;
}

function LayerTime({ label, st, now }: { label: string; st?: WxStatus; now: number }) {
  if (!st) return null;
  const t = st.validAt ? Date.parse(st.validAt) : NaN;
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="mono">
        {st.state === "loading"
          ? "loading…"
          : st.state === "error"
            ? "unavailable"
            : Number.isNaN(t)
              ? "—"
              : `${new Date(t).toISOString().slice(11, 16)} UTC${t > now ? " (model)" : ` · ${fmtAgo(now - t)} ago`}`}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-1.5 py-1 text-[11px] text-muted">{children}</div>;
}

/** Name tags that ride on each storm marker. */
export function StormLabels() {
  const storms = useOrbit((s) => s.storms);
  const on = useOrbit((s) => s.wx.storms);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!on || storms.length === 0) return;
    let raf = 0;
    const tick = () => {
      const scene = sceneRef.get();
      storms.forEach((s, k) => {
        const el = refs.current[k];
        if (!el || !scene) return;
        const p = scene.projectLatLon(s.lat, s.lon, 1.012);
        el.style.opacity = p.visible ? "1" : "0";
        el.style.pointerEvents = p.visible ? "auto" : "none";
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [storms, on]);

  if (!on) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-hidden">
      {storms.map((s, k) => (
        <button
          key={s.id}
          ref={(el) => {
            refs.current[k] = el;
          }}
          className="absolute left-0 top-0 transition-opacity duration-200"
          style={{ opacity: 0 }}
          onClick={() => {
            sfx.whoosh();
            sceneRef.get()?.flyToLatLon(s.lat, s.lon, 2.2);
          }}
        >
          <StormMarker color={STORM_COLORS[Math.min(s.category, 5)]} />
          <span className="glass glass-strong absolute left-3.5 top-[-11px] flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-[10.5px]">
            <span className="font-medium text-fg">{s.name}</span>
            <span className="mono text-muted">
              {stormLabel(s)}
              {s.windKt ? ` · ${s.windKt} kt` : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Position marker in the ops-map style: a crisp dot, a soft halo and one slow pulse ring. */
function StormMarker({ color }: { color: string }) {
  return (
    <span className="absolute left-0 top-0">
      <span className="absolute left-[-14px] top-[-14px] h-7 w-7 rounded-full" style={{ background: `radial-gradient(circle, ${color}55, transparent 70%)` }} />
      <span
        className="absolute left-[-9px] top-[-9px] h-[18px] w-[18px] rounded-full"
        style={{ border: `1px solid ${color}`, opacity: 0.7, animation: "ping 2.6s cubic-bezier(0.22,1,0.36,1) infinite" }}
      />
      <span
        className="absolute left-[-4px] top-[-4px] h-2 w-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 0 2px rgba(0,0,0,0.55), 0 0 10px ${color}` }}
      />
    </span>
  );
}

/** Altitude histogram of the LEO band (payload vs debris) and the busiest shells. */
function CongestionSection({ now }: { now: number }) {
  const density = useOrbit((s) => s.density);
  const status: WxStatus | undefined = density ? { state: "ready", validAt: new Date(density.at).toISOString() } : undefined;
  if (!density) {
    return (
      <Section title="Orbital congestion" st={status} now={now}>
        <Empty>Computing from live positions…</Empty>
      </Section>
    );
  }
  const max = Math.max(...density.bins.map((b) => b.payload + b.debris), 1);
  const W = 216;
  const H = 46;
  const bw = W / ((2000 - 150) / 25);
  const x = (km: number) => ((km - 150) / (2000 - 150)) * W;
  return (
    <Section title="Orbital congestion" st={status} now={now}>
      <div className="px-1.5 py-1">
        <svg width={W} height={H + 12} className="overflow-visible">
          {density.bins.map((b) => {
            const hp = (b.payload / max) * H;
            const hd = (b.debris / max) * H;
            return (
              <g key={b.fromKm}>
                <rect x={x(b.fromKm)} y={H - hp - hd} width={Math.max(bw - 0.6, 0.6)} height={hp} fill="#8fb8ff" opacity={0.85} />
                <rect x={x(b.fromKm)} y={H - hd} width={Math.max(bw - 0.6, 0.6)} height={hd} fill="#ff6b5a" />
              </g>
            );
          })}
          {[200, 500, 1000, 1500, 2000].map((km) => (
            <text key={km} x={x(km)} y={H + 10} fill="white" fillOpacity={0.35} fontSize={8.5} textAnchor="middle" className="mono">
              {km}
            </text>
          ))}
        </svg>
        <div className="mt-1 flex gap-3 text-[10px] text-muted">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-[1px] bg-[#8fb8ff]" />
            payloads
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-[1px] bg-[#ff6b5a]" />
            debris
          </span>
          <span className="ml-auto">km altitude</span>
        </div>
        <div className="mt-1.5 space-y-0.5">
          {density.top.map((b) => (
            <div key={b.fromKm} className="mono flex justify-between text-[10.5px]">
              <span className="text-fg-2">
                {b.fromKm}–{b.toKm} km
              </span>
              <span className="text-muted">
                {(b.payload + b.debris).toLocaleString("en-US")} obj
                {b.debris > 0 && <span className="text-[#ff8a7a]"> · {Math.round((b.debris / (b.payload + b.debris)) * 100)}% debris</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
