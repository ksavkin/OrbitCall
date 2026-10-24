"use client";

import { useEffect, useRef } from "react";
import { fmtCountdown, fmtMiss } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sceneRef } from "@/lib/sceneRef";
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

  if (tab !== "conjunctions") return null;
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
          className="pointer-events-auto absolute left-[-11px] top-[-11px] grid h-[22px] w-[22px] place-items-center"
          onClick={() => {
            sfx.select();
            useOps.getState().set({ focusEvent: focused ? null : e.id });
          }}
          onPointerEnter={() => sfx.hover()}
          aria-label={`Focus ${e.id}`}
        >
          {!quiet && <span className="absolute inset-[-6px] rounded-full opacity-60" style={{ background: `radial-gradient(circle, ${c}40, transparent 70%)` }} />}
          <span
            className="relative h-[9px] w-[9px] rotate-45 rounded-[1.5px] transition-transform duration-300"
            style={{ background: focused ? "#fff" : c, boxShadow: `0 0 0 2px rgba(0,0,0,0.55), 0 0 12px ${c}`, transform: `rotate(45deg) scale(${focused ? 1.25 : 1})` }}
          />
          {!quiet && e.risk === "red" && (
            <span className="absolute inset-[1px] rounded-full border" style={{ borderColor: c, animation: "ping 1.8s var(--ease-out) infinite" }} />
          )}
        </button>
        {(focused || (e.risk === "red" && !quiet)) && (
          <span
            className="glass glass-strong absolute left-3.5 top-[-11px] flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-[10.5px]"
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
          <span className="absolute left-[22px] top-[10px] whitespace-nowrap text-[10px] text-muted [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
            TCA point · <span ref={(el) => bind("range", el)} className="mono tnum" />
          </span>
        )}
      </div>

      {/* synthetic object label (its dot is drawn on the GPU) */}
      <div ref={(el) => bind("b", el)} className="absolute left-0 top-0 transition-opacity duration-200" style={{ opacity: 0 }}>
        <span className="absolute left-3 top-[-8px] flex items-center gap-1 whitespace-nowrap rounded-full bg-black/55 px-1.5 py-px text-[10px] backdrop-blur-sm">
          <span style={{ color: c }}>{e.b.name}</span>
          <span className="mono text-[8.5px] uppercase tracking-[0.1em] text-orange">syn</span>
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
