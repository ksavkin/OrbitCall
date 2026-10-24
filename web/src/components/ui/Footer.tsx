"use client";

import { motion } from "motion/react";
import { Pause, Play, Radio } from "lucide-react";
import { useEffect, useRef } from "react";
import { fmtInt, fmtLat, fmtLon, fmtUtc } from "@/lib/format";
import { liveStats, sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { Tooltip } from "./Tooltip";

const SPEEDS = [1, 10, 60, 600, 3600];

export function Footer() {
  const speed = useOrbit((s) => s.speed);
  const paused = useOrbit((s) => s.paused);
  const set = useOrbit((s) => s.set);
  const count = useOrbit((s) => s.catalog?.objects.length ?? 0);

  const dateRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const offsetRef = useRef<HTMLSpanElement>(null);
  const liveRef = useRef<HTMLButtonElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const altRef = useRef<HTMLSpanElement>(null);
  const propRef = useRef<HTMLSpanElement>(null);
  const attrRef = useRef<HTMLSpanElement>(null);

  // Readouts update at 10 Hz straight into the DOM, no React re-render.
  useEffect(() => {
    const id = setInterval(() => {
      const scene = sceneRef.get();
      if (!scene) return;
      const sim = scene.clock.now();
      const t = fmtUtc(sim);
      if (dateRef.current) dateRef.current.textContent = t.date;
      if (timeRef.current) timeRef.current.textContent = t.time;
      const off = (sim - Date.now()) / 1000;
      if (offsetRef.current) {
        const live = Math.abs(off) < 2;
        offsetRef.current.textContent = live ? "" : `${off > 0 ? "+" : "−"}${fmtOffset(Math.abs(off))}`;
      }
      if (liveRef.current) liveRef.current.dataset.live = String(scene.clock.isLive());
      const c = liveStats.cursor;
      if (cursorRef.current) cursorRef.current.textContent = c ? `${fmtLat(c.lat)}  ${fmtLon(c.lon)}` : "—";
      if (altRef.current) altRef.current.textContent = `${fmtInt(Math.round(liveStats.altKm))} km`;
      if (propRef.current) propRef.current.textContent = `${liveStats.propagateMs.toFixed(0)} ms`;
      if (attrRef.current) attrRef.current.textContent = `Data CelesTrak · ${scene.tileAttribution ?? "Imagery NASA"}`;
    }, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <footer className="glass pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex h-[32px] items-center gap-3 rounded-none px-3 text-[11px] text-muted [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06)] before:hidden">
      {/* left: engine status */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Tooltip label="Positions computed in a Web Worker with SGP4 (satellite.js)" side="top">
          <span className="flex items-center gap-1.5">
            <span className="pulse-dot text-green" style={{ width: 5, height: 5 }} />
            <span className="text-fg-2">SGP4</span>
            <span className="mono tnum">{fmtInt(count)}</span>
            <span>objects</span>
            <span className="text-faint">·</span>
            <span ref={propRef} className="mono tnum">— ms</span>
          </span>
        </Tooltip>
      </div>

      {/* center: simulation clock */}
      <div className="flex items-center gap-1">
        <Tooltip label={paused ? "Resume" : "Pause"} hint="Space" side="top">
          <button
            className="icon-btn h-[24px] w-[26px] rounded-[7px]"
            onClick={() => {
              sfx.toggle(paused);
              set({ paused: !paused });
            }}
            aria-label={paused ? "Resume" : "Pause"}
          >
            {paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
          </button>
        </Tooltip>
        <div className="flex h-[24px] items-center rounded-[8px] bg-white/[0.035] p-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className="mono relative h-[20px] rounded-[6px] px-2 text-[10.5px] text-muted transition-colors hover:text-fg data-[active=true]:text-fg"
              data-active={speed === s}
              onClick={() => {
                sfx.click();
                set({ speed: s, paused: false });
              }}
            >
              {speed === s && (
                <motion.span layoutId="speed-pill" className="seg-pill !rounded-[6px]" transition={{ type: "spring", stiffness: 520, damping: 38 }} />
              )}
              <span className="relative">{s === 1 ? "1×" : s >= 3600 ? "1h/s" : s >= 60 ? `${s / 60}m/s` : `${s}×`}</span>
            </button>
          ))}
        </div>
        <span className="mono tnum ml-2 text-fg">
          <span ref={dateRef} className="text-fg-2" /> <span ref={timeRef} />
          <span className="ml-1 text-muted">UTC</span>
          <span ref={offsetRef} className="ml-1.5 text-orange" />
        </span>
        <Tooltip label="Jump to real time" side="top">
          <button
            ref={liveRef}
            className="group ml-1 flex h-[22px] items-center gap-1 rounded-full px-2 text-[10.5px] font-medium text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-colors hover:text-fg data-[live=true]:text-green data-[live=true]:shadow-[inset_0_0_0_1px_rgba(61,220,151,0.25)]"
            onClick={() => {
              sfx.click();
              set({ speed: 1, paused: false });
              sceneRef.get()?.clock.live();
            }}
          >
            <Radio size={11} />
            Live
          </button>
        </Tooltip>
      </div>

      {/* right: readouts + attribution */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        <span className="flex items-center gap-1.5">
          <span>Cursor</span>
          <span ref={cursorRef} className="mono tnum whitespace-pre text-fg-2">
            —
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span>Camera</span>
          <span ref={altRef} className="mono tnum text-fg-2">
            —
          </span>
        </span>
        <span ref={attrRef} className="hidden max-w-[300px] truncate text-faint xl:inline">
          Data CelesTrak · Imagery NASA
        </span>
      </div>
    </footer>
  );
}

function fmtOffset(s: number) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
