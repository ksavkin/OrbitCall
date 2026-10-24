"use client";

import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SatObject } from "@/lib/catalog/client";
import { fmtInt } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { CATEGORY_META } from "@/lib/theme";

// Well-known objects; each is shown only if present in the loaded catalog.
const FEATURED = [25544, 48274, 20580, 43013, 33591, 28654, 41866, 44713];

export function SearchPalette() {
  const open = useOrbit((s) => s.searchOpen);
  const catalog = useOrbit((s) => s.catalog);
  const set = useOrbit((s) => s.set);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      sfx.open();
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const results = useMemo<SatObject[]>(() => {
    if (!catalog) return [];
    const s = q.trim().toLowerCase();
    if (!s) {
      const byId = new Map(catalog.objects.map((o) => [o.norad, o]));
      return FEATURED.map((id) => byId.get(id)).filter(Boolean) as SatObject[];
    }
    const starts: SatObject[] = [];
    const contains: SatObject[] = [];
    for (const o of catalog.objects) {
      if (String(o.norad) === s || o.name.toLowerCase().startsWith(s)) starts.push(o);
      else if (o.searchKey.includes(s)) contains.push(o);
      if (starts.length > 60) break;
    }
    return [...starts, ...contains].slice(0, 60);
  }, [catalog, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const reset = () => {
    setQ("");
    setActive(0);
  };
  const close = () => {
    sfx.close();
    reset();
    set({ searchOpen: false });
  };
  const pick = (o: SatObject) => {
    sfx.select();
    // make sure the object's layer is visible
    const enabled = useOrbit.getState().enabled;
    if (!enabled[o.category]) set({ enabled: { ...enabled, [o.category]: true } });
    reset();
    set({ searchOpen: false, selected: o.index, following: false });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, scale: 0.985, filter: "blur(6px)" }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="glass glass-strong relative w-[540px] overflow-hidden rounded-[16px]"
          >
            <div className="flex h-12 items-center gap-2.5 border-b border-white/[0.06] px-4">
              <Search size={15} className="text-muted" />
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                  else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, results.length - 1));
                    sfx.hover();
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                    sfx.hover();
                  } else if (e.key === "Enter" && results[active]) pick(results[active]);
                }}
                placeholder="Search name, NORAD ID or COSPAR designator"
                className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              />
              <span className="kbd">esc</span>
            </div>
            <div className="px-2 pb-1 pt-2">
              <div className="eyebrow px-2 pb-1">
                {q ? `${results.length === 60 ? "60+" : results.length} matches` : "Featured"}
                {catalog && !q && <span className="ml-2 normal-case tracking-normal text-faint">of {fmtInt(catalog.objects.length)} objects</span>}
              </div>
            </div>
            <div ref={list} className="thin-scroll max-h-[340px] overflow-y-auto px-2 pb-2">
              {results.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-muted">No objects match “{q}”.</div>}
              {results.map((o, i) => {
                const m = CATEGORY_META[o.category];
                return (
                  <button
                    key={o.index}
                    data-i={i}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => pick(o)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-[9px] px-2 text-left transition-colors ${
                      i === active ? "bg-white/[0.07]" : ""
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.color, boxShadow: `0 0 6px ${m.color}` }} />
                    <span className="truncate text-[12.5px] text-fg">{o.name}</span>
                    <span className="mono text-[10.5px] text-muted">#{o.norad}</span>
                    <span className="ml-auto flex items-center gap-2 text-[10.5px] text-muted">
                      <span>{m.label}</span>
                      <span className="mono w-8 text-right text-faint">{o.regime}</span>
                      <CornerDownLeft size={11} className={i === active ? "text-fg-2" : "opacity-0"} />
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
