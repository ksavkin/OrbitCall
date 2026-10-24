"use client";

import { AnimatePresence, motion } from "motion/react";
import { Layers } from "lucide-react";
import { useRef, useState } from "react";
import { VIEW_MODES, type ViewMode } from "@/components/globe/shaders";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { CONGESTION_LAYERS, WeatherToggles } from "./Weather";

export const VIEW_LABELS: Record<ViewMode, { label: string; hint: string }> = {
  realistic: { label: "Realistic", hint: "Real sun, night lights, clouds" },
  imagery: { label: "Imagery", hint: "Evenly lit satellite mosaic" },
  night: { label: "Night", hint: "City lights (NASA Black Marble)" },
  terrain: { label: "Terrain", hint: "Shaded relief and contours" },
  tactical: { label: "Tactical", hint: "Dot-matrix ops view" },
};

function Thumb({ mode, size }: { mode: ViewMode; size: number }) {
  if (mode === "tactical") {
    return (
      <div
        className="h-full w-full"
        style={{
          background: `radial-gradient(circle, rgba(220,224,230,.55) 1px, transparent 1.4px) 0 0/${size / 12}px ${size / 12}px, #0a0b0d`,
        }}
      />
    );
  }
  return <div className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url(/thumbs/${mode}.jpg)` }} />;
}

/** Google Maps-style layer picker: a single tile that fans out on hover. */
export function ViewSwitcher() {
  const viewMode = useOrbit((s) => s.viewMode);
  const set = useOrbit((s) => s.set);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const choose = (m: ViewMode) => {
    if (m !== viewMode) sfx.click();
    set({ viewMode: m });
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-[42px] left-2.5 z-20 flex items-end gap-2"
      onPointerEnter={() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        if (!open) sfx.open();
        setOpen(true);
      }}
      onPointerLeave={() => {
        closeTimer.current = setTimeout(() => setOpen(false), 220);
      }}
    >
      <button
        className="glass group relative h-[62px] w-[62px] overflow-hidden rounded-[13px] p-[3px] transition-transform duration-300 hover:scale-[1.03] active:scale-95"
        onClick={() => {
          const i = VIEW_MODES.indexOf(viewMode);
          choose(VIEW_MODES[(i + 1) % VIEW_MODES.length]);
        }}
        aria-label="Change globe view"
      >
        <div className="relative h-full w-full overflow-hidden rounded-[10px]">
          <Thumb mode={viewMode} size={56} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-1 flex items-center justify-center gap-1 text-[10px] font-medium text-white">
            <Layers size={10} />
            Layers
          </div>
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: -8, scale: 0.97, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: -8, scale: 0.97, filter: "blur(6px)" }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="glass glass-strong relative flex flex-col gap-1.5 rounded-[13px] p-1.5"
          >
            <div className="flex gap-1">
            {VIEW_MODES.map((m, i) => {
              const active = m === viewMode;
              return (
                <motion.button
                  key={m}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.03 * i, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  onClick={() => choose(m)}
                  onPointerEnter={() => sfx.hover()}
                  className="group flex w-[60px] flex-col items-center gap-1 rounded-[9px] p-1 transition-colors hover:bg-white/[0.06]"
                  title={VIEW_LABELS[m].hint}
                >
                  <div
                    className={`h-[46px] w-[46px] overflow-hidden rounded-[8px] transition-all duration-300 ${
                      active
                        ? "shadow-[0_0_0_1.5px_#fff,0_0_14px_rgba(255,255,255,0.25)]"
                        : "opacity-80 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] group-hover:opacity-100"
                    }`}
                  >
                    <div className="h-full w-full transition-transform duration-500 group-hover:scale-110">
                      <Thumb mode={m} size={46} />
                    </div>
                  </div>
                  <span className={`text-[10px] ${active ? "font-medium text-fg" : "text-muted group-hover:text-fg-2"}`}>
                    {VIEW_LABELS[m].label}
                  </span>
                  <span className="kbd -mt-0.5 !h-[14px] !min-w-[14px] !text-[9px] opacity-60">{i + 1}</span>
                </motion.button>
              );
            })}
            </div>
            <div className="mx-1 h-px bg-white/[0.07]" />
            <div className="eyebrow px-1">Live weather</div>
            <WeatherToggles />
            <div className="eyebrow px-1 pt-0.5">Orbital congestion</div>
            <WeatherToggles layers={CONGESTION_LAYERS} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
