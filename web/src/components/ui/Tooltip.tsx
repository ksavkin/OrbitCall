"use client";

import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";

const GAP = 8;
const EDGE = 8;

/**
 * Rendered in a portal with fixed positioning, so scrolling panels can't clip it,
 * and clamped to the viewport so it never runs off screen.
 */
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
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    let x = 0;
    let y = 0;
    if (side === "top" || side === "bottom") {
      x = a.left + a.width / 2 - t.width / 2;
      y = side === "top" ? a.top - t.height - GAP : a.bottom + GAP;
    } else {
      y = a.top + a.height / 2 - t.height / 2;
      x = side === "left" ? a.left - t.width - GAP : a.right + GAP;
    }
    x = Math.min(Math.max(x, EDGE), window.innerWidth - t.width - EDGE);
    y = Math.min(Math.max(y, EDGE), window.innerHeight - t.height - EDGE);
    setPos({ x, y });
  }, [open, side]);

  const offset = { top: { y: 4 }, bottom: { y: -4 }, left: { x: 4 }, right: { x: -4 } }[side];

  return (
    <span
      ref={anchor}
      className="relative inline-flex"
      onPointerEnter={() => {
        timer.current = setTimeout(() => setOpen(true), delay);
      }}
      onPointerLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setOpen(false);
        setPos(null);
      }}
      onPointerDown={() => {
        if (timer.current) clearTimeout(timer.current);
        setOpen(false);
        setPos(null);
      }}
    >
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.span
                ref={tip}
                initial={{ opacity: 0, scale: 0.96, ...offset }}
                animate={{ opacity: pos ? 1 : 0, scale: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-none fixed z-[100] whitespace-nowrap"
                style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
              >
                <span className="flex items-center gap-2 rounded-[7px] border border-white/10 bg-[#18191c]/95 px-2 py-1 text-[11px] text-fg shadow-xl backdrop-blur-md">
                  {label}
                  {hint && <span className="kbd">{hint}</span>}
                </span>
              </motion.span>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </span>
  );
}
