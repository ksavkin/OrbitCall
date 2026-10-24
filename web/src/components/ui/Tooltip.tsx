"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";

type Side = "top" | "bottom" | "left" | "right";

export function Tooltip({
  label,
  hint,
  side = "bottom",
  children,
  delay = 250,
}: {
  label: ReactNode;
  hint?: string;
  side?: Side;
  children: ReactNode;
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pos: Record<Side, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };
  const offset = { top: { y: 4 }, bottom: { y: -4 }, left: { x: 4 }, right: { x: -4 } }[side];
  return (
    <span
      className="relative inline-flex"
      onPointerEnter={() => {
        timer.current = setTimeout(() => setOpen(true), delay);
      }}
      onPointerLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setOpen(false);
      }}
      onPointerDown={() => {
        if (timer.current) clearTimeout(timer.current);
        setOpen(false);
      }}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            initial={{ opacity: 0, scale: 0.96, ...offset }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className={`pointer-events-none absolute z-50 whitespace-nowrap ${pos[side]}`}
          >
            <span className="flex items-center gap-2 rounded-[7px] border border-white/10 bg-[#18191c]/95 px-2 py-1 text-[11px] text-fg shadow-xl backdrop-blur-md">
              {label}
              {hint && <span className="kbd">{hint}</span>}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
