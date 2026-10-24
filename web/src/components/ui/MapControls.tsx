"use client";

import { motion } from "motion/react";
import { Minus, Plus, Rotate3d, LocateFixed } from "lucide-react";
import { useState } from "react";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { Tooltip } from "./Tooltip";

const PRESETS = [
  { id: "leo", label: "LEO", hint: "Low Earth orbit shell" },
  { id: "meo", label: "MEO", hint: "Navigation constellations, ~20,000 km" },
  { id: "geo", label: "GEO", hint: "Geostationary belt, 35,786 km" },
] as const;

export function MapControls() {
  const autoRotate = useOrbit((s) => s.autoRotate);
  const set = useOrbit((s) => s.set);
  const [preset, setPreset] = useState<string>("leo");

  return (
    <div className="pointer-events-auto absolute bottom-[42px] right-2.5 z-20 flex flex-col items-end gap-2">
      {/* zoom presets: the Esri-style "zoom out to GEO" move */}
      <div className="glass relative flex flex-col gap-0.5 rounded-[12px] p-1">
        {PRESETS.map((p) => (
          <Tooltip key={p.id} label={p.hint} side="left">
            <button
              className="btn relative h-7 w-10 px-0 text-[10.5px] font-semibold tracking-[0.04em]"
              data-active={preset === p.id}
              onClick={() => {
                sfx.whoosh();
                setPreset(p.id);
                sceneRef.get()?.zoomTo(p.id);
              }}
            >
              {preset === p.id && (
                <motion.span layoutId="preset-pill" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 36 }} />
              )}
              <span className="relative">{p.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="glass relative flex flex-col gap-0.5 rounded-[12px] p-1">
        <Tooltip label="Zoom in" hint="+" side="left">
          <button className="icon-btn h-7 w-10" onClick={() => sceneRef.get()?.zoomBy(0.7)} aria-label="Zoom in">
            <Plus size={14} />
          </button>
        </Tooltip>
        <div className="mx-2 h-px bg-white/[0.07]" />
        <Tooltip label="Zoom out" hint="−" side="left">
          <button className="icon-btn h-7 w-10" onClick={() => sceneRef.get()?.zoomBy(1.45)} aria-label="Zoom out">
            <Minus size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="glass relative flex flex-col gap-0.5 rounded-[12px] p-1">
        <Tooltip label="Reset view" hint="R" side="left">
          <button
            className="icon-btn h-7 w-10"
            onClick={() => {
              sfx.whoosh();
              setPreset("leo");
              set({ following: false });
              sceneRef.get()?.resetView();
            }}
            aria-label="Reset view"
          >
            <LocateFixed size={14} />
          </button>
        </Tooltip>
        <Tooltip label={autoRotate ? "Stop rotation" : "Auto-rotate"} hint="A" side="left">
          <button
            className="icon-btn h-7 w-10"
            data-active={autoRotate}
            onClick={() => {
              sfx.toggle(!autoRotate);
              set({ autoRotate: !autoRotate });
            }}
            aria-label="Auto-rotate"
          >
            <Rotate3d size={14} className={autoRotate ? "animate-[spin_6s_linear_infinite]" : ""} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
