"use client";

import { Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { fmtCountdown, fmtMiss } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sceneRef } from "@/lib/sceneRef";
import { useOrbit } from "@/lib/store";
import { sfx } from "@/lib/sound";
import { RESOLVED } from "./meta";

// HTML markers over the globe, positioned every frame from the scene's projections
// (no React renders in the loop). The TCA point is where both orbits cross.

const COLOR = { red: "#ff5a4f", yellow: "#f5c451" } as const;

export function ConjunctionMarkers() {
  const events = useOps((s) => s.events);
  const tab = useOps((s) => s.tab);
  const nodes = useRef(new Map<string, { tca: HTMLDivElement | null; b: HTMLDivElement | null; a: HTMLDivElement | null; cd: HTMLSpanElement | null; range: HTMLSpanElement | null }>());

  useEffect(() => {
    let raf = 0;
    const place = (el: HTMLElement | null, p: { x: number; y: number; visible: boolean } | null, show = true) => {
      if (!el) return;
      if (!p || !p.visible || !show) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const scene = sceneRef.get();
      if (!scene) return;
      const sim = scene.clock.now();
      for (const s of scene.conj.screen) {
        const n = nodes.current.get(s.id);
        if (!n) continue;
        place(n.tca, s.tca);
        place(n.b, s.b, s.focused);
        place(n.a, s.a, s.focused);
        if (n.cd) {
          const ev = useOps.getState().events.find((e) => e.id === s.id);
          if (ev) n.cd.textContent = fmtCountdown(ev.tca - sim);
        }
        if (n.range) n.range.textContent = s.rangeKm > 0 ? (s.rangeKm < 100 ? `${s.rangeKm.toFixed(1)} km apart` : `${Math.round(s.rangeKm).toLocaleString("en-US")} km apart`) : "";
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  if (tab !== "orbit") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-hidden">
      {events.map((e) => (
        <Marker
          key={e.id}
          e={e}
          bind={(k, el) => {
            const cur = nodes.current.get(e.id) ?? { tca: null, b: null, a: null, cd: null, range: null };
            cur[k] = el as never;
            nodes.current.set(e.id, cur);
          }}
        />
      ))}
    </div>
  );
}

function Marker({ e, bind }: { e: ConjunctionEvent; bind: (k: "tca" | "b" | "a" | "cd" | "range", el: HTMLElement | null) => void }) {
  const focused = useOps((s) => s.focusEvent === e.id);
  const quiet = RESOLVED.includes(e.status);
  const c = quiet ? "#9aa3ad" : COLOR[e.risk];
  return (
    <>
      <div ref={(el) => bind("tca", el)} className="absolute left-0 top-0 transition-opacity duration-200" style={{ opacity: 0 }}>
        <button
          className="pointer-events-auto absolute left-[-15px] top-[-15px] grid h-[30px] w-[30px] place-items-center transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] hover:scale-110"
          onClick={() => {
            sfx.select();
            useOps.getState().set({ focusEvent: focused ? null : e.id });
          }}
          onPointerEnter={() => sfx.hover()}
          aria-label={`Focus ${e.id}`}
          title={focused ? undefined : `${e.id} · click to draw both orbits`}
        >
          <ConjunctionIcon color={c} focused={focused} live={!quiet && e.risk === "red"} />
        </button>
        {(focused || (e.risk === "red" && !quiet)) && (
          <span
            className="glass glass-strong absolute left-[19px] top-[-11px] flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-[10.5px]"
            style={{ boxShadow: `inset 0 0 0 1px ${c}40` }}
          >
            <span className="mono text-muted">{e.id}</span>
            <span className="mono font-medium" style={{ color: c }}>
              {fmtMiss(e.missM)}
            </span>
            <span ref={(el) => bind("cd", el)} className="mono tnum text-fg-2" />
          </span>
        )}
        {focused && (
          // the drawn orbits follow the clock: each dot flies on its own line, and the lines cross at this ring
          <span className="absolute left-[26px] top-[10px] flex items-center gap-1.5 whitespace-nowrap text-[10px] text-muted [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
            <span>
              They meet here · now <span ref={(el) => bind("range", el)} className="mono tnum" />
            </span>
            <button
              className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-px text-fg-2 backdrop-blur-sm transition-colors hover:bg-white/15 hover:text-white"
              title="Jump the clock to 70 s before closest approach and watch both objects pass. Live in the footer returns to now."
              onClick={() => {
                sfx.whoosh();
                useOrbit.getState().set({ paused: false, speed: 1 });
                sceneRef.get()?.previewTca(e.id);
              }}
            >
              <Play size={8} fill="currentColor" /> Play to TCA
            </button>
          </span>
        )}
      </div>

      {/* synthetic object label (its dot is drawn on the GPU) */}
      <div ref={(el) => bind("b", el)} className="absolute left-0 top-0 transition-opacity duration-200" style={{ opacity: 0 }}>
        <span className="absolute left-3 top-[-8px] flex items-center gap-1 whitespace-nowrap rounded-full bg-black/55 px-1.5 py-px text-[10px] backdrop-blur-sm">
          <span style={{ color: c }}>{e.b.name}</span>
          {e.b.synthetic && <span className="mono text-[8.5px] uppercase tracking-[0.1em] text-orange">syn</span>}
        </span>
      </div>

      {/* real object ring */}
      <div ref={(el) => bind("a", el)} className="absolute left-0 top-0 transition-opacity duration-200" style={{ opacity: 0 }}>
        <span className="absolute left-[-9px] top-[-9px] h-[18px] w-[18px] rounded-full border-[1.5px] border-[#9cc2ff] shadow-[0_0_10px_rgba(156,194,255,0.6)]" />
        <span className="absolute left-3 top-[-8px] whitespace-nowrap rounded-full bg-black/55 px-1.5 py-px text-[10px] text-[#cfe0ff] backdrop-blur-sm">{e.a.name}</span>
      </div>
    </>
  );
}

/**
 * Conjunction mark: the TCA point, a slowly turning dashed range ring, and a ping when red. No stroke here may
 * look like a trajectory: the real orbits are drawn on the globe, for the focused event only.
 */
function ConjunctionIcon({ color, focused, live }: { color: string; focused: boolean; live: boolean }) {
  return (
    <span className="relative block h-[30px] w-[30px]" style={{ transform: `scale(${focused ? 1.18 : 1})`, transition: "transform .3s cubic-bezier(.34,1.56,.64,1)" }}>
      <span className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle, ${color}33, transparent 68%)` }} />
      {live && <span className="absolute inset-[5px] rounded-full border" style={{ borderColor: color, animation: "ping 1.8s var(--ease-out) infinite" }} />}
      <svg viewBox="0 0 30 30" className="absolute inset-0 overflow-visible">
        <g style={{ transformOrigin: "15px 15px", animation: "spin 9s linear infinite" }}>
          <circle cx="15" cy="15" r="10.5" fill="none" stroke={color} strokeOpacity="0.75" strokeWidth="1.1" strokeDasharray="3.2 2.3" />
        </g>
        <circle cx="15" cy="15" r="2.6" fill="#fff" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        {focused &&
          [0, 90, 180, 270].map((r) => (
            <path key={r} d="M3 8 V3 H8" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.2" transform={`rotate(${r} 15 15) translate(-4 -4)`} />
          ))}
      </svg>
    </span>
  );
}
