"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { fmtInt } from "@/lib/format";
import { useOrbit, type LoadStage } from "@/lib/store";
import { LogoMark } from "./Logo";

const ORDER: LoadStage[] = ["catalog", "parse", "propagate", "ready"];

export function BootScreen() {
  const stage = useOrbit((s) => s.stage);
  const error = useOrbit((s) => s.error);
  const count = useOrbit((s) => s.catalog?.objects.length);
  const at = ORDER.indexOf(stage);

  const steps = [
    { label: "Fetching CelesTrak GP element sets and SATCAT", done: at > 0 },
    { label: count ? `Parsing ${fmtInt(count)} element sets` : "Parsing element sets", done: at > 1 },
    { label: "Propagating with SGP4 in a worker", done: at > 2 },
  ];

  return (
    <AnimatePresence>
      {stage !== "ready" && (
        <motion.div
          className="absolute inset-0 z-[60] grid place-items-center bg-black"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] } }}
        >
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, filter: "blur(6px)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="w-[300px]"
          >
            <div className="flex items-center gap-2.5">
              <LogoMark size={20} />
              <span className="text-[15px] font-semibold tracking-[-0.01em]">OrbitCall</span>
            </div>
            <div className="mt-1 text-[11px] text-muted">A dispatcher for orbit</div>
            <div className="mt-6 space-y-2">
              {steps.map((s, i) => {
                const current = !s.done && (i === 0 || steps[i - 1].done);
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: s.done || current ? 1 : 0.35, x: 0 }}
                    transition={{ delay: 0.08 * i }}
                    className="mono flex items-center gap-2.5 text-[11px]"
                  >
                    <span className="grid h-3.5 w-3.5 place-items-center">
                      {s.done ? (
                        <Check size={12} className="text-green" />
                      ) : current ? (
                        <span className="h-3 w-3 animate-spin rounded-full border border-white/20 border-t-white" />
                      ) : (
                        <span className="h-1 w-1 rounded-full bg-white/30" />
                      )}
                    </span>
                    <span className={current ? "shimmer" : s.done ? "text-fg-2" : "text-muted"}>{s.label}</span>
                  </motion.div>
                );
              })}
            </div>
            <div className="mt-5 h-[2px] overflow-hidden rounded-full bg-white/[0.08]">
              <motion.div
                className="h-full rounded-full bg-white"
                animate={{ width: `${(Math.max(at, 0) / 3) * 100 + 6}%` }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            {error && (
              <div className="mt-4 rounded-[9px] border border-red/30 bg-red/10 px-3 py-2 text-[11px] text-red">{error}</div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
