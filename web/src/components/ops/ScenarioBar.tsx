"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronUp, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { engine } from "@/lib/ops/engine";
import { runScenario, SCENARIOS } from "@/lib/ops/scenarios";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { Tooltip } from "@/components/ui/Tooltip";

const SPEEDS = [1, 2, 4];

/** Dev-only controls for the simulator: pick a user story, run it, pace it. */
export function ScenarioBar() {
  const scenario = useOps((s) => s.scenario);
  const done = useOps((s) => s.scenarioDone);
  const playing = useOps((s) => s.playing);
  const speed = useOps((s) => s.speed);
  const autopilot = useOps((s) => s.autopilot);
  const catalogReady = useOrbit((s) => !!s.catalog);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(SCENARIOS[0].id);
  const box = useRef<HTMLDivElement>(null);
  const current = SCENARIOS.find((s) => s.id === (scenario ?? pick)) ?? SCENARIOS[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const start = (id: string) => {
    sfx.whoosh();
    setPick(id);
    setOpen(false);
    useOps.getState().set({ agentView: "graph", focusAgent: null, focusSpan: null });
    runScenario(id);
  };

  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-auto absolute bottom-[48px] left-1/2 z-30 -translate-x-1/2"
    >
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="glass glass-strong absolute bottom-[calc(100%+8px)] left-0 w-[340px] overflow-hidden rounded-[13px] p-1"
          >
            <div className="eyebrow px-2.5 pb-1 pt-2">User stories</div>
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                className="group flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
                onClick={() => start(s.id)}
                onPointerEnter={() => sfx.hover()}
              >
                <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center">
                  {scenario === s.id ? <Check size={12} className="text-green" /> : <Play size={10} className="text-faint transition-colors group-hover:text-fg" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium">{s.title}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-[1.45] text-muted">{s.story}</span>
                  <span className="mono mt-1 block text-[9.5px] text-faint">{s.refs}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="glass relative flex h-10 items-center gap-1 rounded-[13px] px-1">
        <span className="mono ml-1.5 mr-1 rounded-[4px] px-1 py-px text-[9px] font-medium uppercase tracking-[0.12em] text-orange shadow-[inset_0_0_0_1px_rgba(255,159,64,0.28)]">
          Dev
        </span>
        <button
          className="btn h-7 max-w-[220px] gap-1.5 px-2 text-[11.5px]"
          onClick={() => {
            sfx.click();
            setOpen((o) => !o);
          }}
          aria-expanded={open}
        >
          <span className="truncate">{current.title}</span>
          <ChevronUp size={12} className={`shrink-0 text-muted transition-transform duration-200 ${open ? "" : "rotate-180"}`} />
        </button>
        <Tooltip label={!catalogReady ? "Waiting for the catalog" : scenario ? "Restart this story" : "Run this story"}>
          <button className="btn btn-primary h-7 px-2.5 text-[11px]" disabled={!catalogReady} onClick={() => start(current.id)}>
            {scenario ? <RotateCcw size={11} /> : <Play size={11} />}
            {scenario ? (done ? "Replay" : "Restart") : "Run"}
          </button>
        </Tooltip>
        <AnimatePresence>
          {scenario && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              className="flex items-center overflow-hidden whitespace-nowrap px-1.5 text-[10.5px]"
            >
              {done ? (
                <span className="flex items-center gap-1 text-green">
                  <Check size={11} /> Finished
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-blue">
                  <span className="pulse-dot" style={{ width: 5, height: 5 }} /> Running
                </span>
              )}
            </motion.span>
          )}
        </AnimatePresence>
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <Tooltip label={playing ? "Pause the simulator" : "Resume"}>
          <button
            className="icon-btn h-7 w-7"
            onClick={() => {
              sfx.toggle(!playing);
              useOps.getState().set({ playing: !playing });
            }}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
        </Tooltip>
        <div className="flex items-center rounded-[9px] bg-white/[0.03] p-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className="btn relative h-6 px-1.5 text-[10.5px]"
              data-active={speed === s}
              onClick={() => {
                sfx.click();
                useOps.getState().set({ speed: s });
              }}
            >
              {speed === s && <motion.span layoutId="sim-speed" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="mono relative">{s}×</span>
            </button>
          ))}
        </div>
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <Tooltip label={autopilot ? "Simulated operators answer on their own" : "You answer for both operators"}>
          <button
            className="btn h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => {
              sfx.toggle(!autopilot);
              useOps.getState().set({ autopilot: !autopilot });
            }}
            aria-pressed={autopilot}
          >
            <span
              className="relative h-[12px] w-[20px] rounded-full transition-colors duration-200"
              style={{ background: autopilot ? "var(--green)" : "rgba(255,255,255,0.14)" }}
            >
              <motion.span
                className="absolute top-[2px] h-[8px] w-[8px] rounded-full bg-white"
                animate={{ left: autopilot ? 10 : 2 }}
                transition={{ type: "spring", stiffness: 700, damping: 34 }}
              />
            </span>
            Autopilot
          </button>
        </Tooltip>
        <Tooltip label="Clear the board and stop the story">
          <button
            className="icon-btn h-7 w-7"
            onClick={() => {
              sfx.close();
              engine.reset();
              engine.boot();
            }}
            aria-label="Reset"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>
    </motion.div>
  );
}
