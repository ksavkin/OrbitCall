"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sfx } from "@/lib/sound";

// Menus that never leave the screen and never sit under another panel. They render in a portal on <body>
// (panels have transforms and overflow: hidden, which would clip or re-anchor a fixed element), measure the
// trigger, open on the side with more room, keep an 8 px margin from every edge, cap their height to the room
// they have and scroll inside. Escape, an outside press, scrolling whatever holds the trigger, or a resize close them.

const MARGIN = 8;
const GAP = 6;

type Place = { left: number; top: number; maxHeight: number; up: boolean };

function place(anchor: DOMRect, width: number, height: number): Place {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = vh - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = height > below && above > below;
  const room = up ? above : below;
  const h = Math.min(height, room);
  const left = Math.min(Math.max(anchor.left, MARGIN), vw - width - MARGIN);
  const top = up ? anchor.top - GAP - h : anchor.bottom + GAP;
  return { left: Math.max(MARGIN, left), top, maxHeight: Math.max(room, 120), up };
}

export function Popover({
  open,
  onClose,
  anchor,
  width = 260,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  width?: number;
  children: ReactNode;
  label: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Place | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const w = Math.min(width, window.innerWidth - MARGIN * 2);
      setPos(place(a, w, panel.current?.scrollHeight ?? 320));
    };
    measure();
    // a second pass once the content has its real height
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        onClose();
      }
    };
    // close only when the trigger itself moved: a list re-rendering under the menu is not a reason to close it
    const scroll = (ev: Event) => {
      const t = ev.target;
      if (t === document || (t instanceof Node && anchor.current && t.contains(anchor.current))) onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchor]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          role="dialog"
          aria-label={label}
          initial={{ opacity: 0, y: pos?.up ? 4 : -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos?.up ? 4 : -4, scale: 0.98 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          className="thin-scroll fixed z-[80] overflow-y-auto rounded-[12px] bg-[rgba(14,14,16,0.98)] p-1 text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_24px_60px_-12px_rgba(0,0,0,0.9)] backdrop-blur-xl"
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            width: Math.min(width, typeof window === "undefined" ? width : window.innerWidth - MARGIN * 2),
            maxHeight: pos?.maxHeight,
            transformOrigin: pos?.up ? "bottom left" : "top left",
          }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** A custom select: a trigger showing the current choice and a Popover of options. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  width = 220,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
  icon?: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = options.find((o) => o.value === value);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={btn}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] bg-white/[0.04] px-2 text-[11.5px] text-neutral-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-colors hover:bg-white/[0.07] hover:text-white"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${cur?.label ?? ""}`}
        onClick={() => {
          sfx.click();
          setOpen((o) => !o);
        }}
      >
        {icon}
        <span className="truncate">{cur?.label}</span>
        <ChevronDown size={11} className={`shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <Popover open={open} onClose={close} anchor={btn} width={width} label={label}>
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-500">{label}</div>
        <div role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className="flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
              onClick={() => {
                sfx.click();
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="mt-[2px] w-3 shrink-0 text-white">{o.value === value && <Check size={12} />}</span>
              <span className="min-w-0">
                <span className={`block text-[12.5px] ${o.value === value ? "text-white" : "text-neutral-300"}`}>{o.label}</span>
                {o.hint && <span className="block text-[11px] leading-snug text-neutral-500">{o.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
