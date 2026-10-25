"use client";

import { ArrowDownUp, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { sfx } from "@/lib/sound";
import { Popover, Select } from "@/components/ui/Popover";
import { useMe } from "@/components/auth/session";
import { activeFilters, useQueueView, type Objects, type Severity, type Sort, type Within } from "./queueView";

// Search, sort, filters and "My fleet" over the backend queue. Compact on purpose: it sits in the narrow queue
// column, so the filter groups live in a menu and only what is active shows as removable chips.

const SORTS: { value: Sort; label: string; hint: string }[] = [
  { value: "queue", label: "Queue order", hint: "Red first, then the earliest closest approach" },
  { value: "tca", label: "Soonest closest approach", hint: "Ignores severity" },
  { value: "pc", label: "Highest chance", hint: "Pairs without a reported chance go last" },
  { value: "miss", label: "Smallest miss distance", hint: "Closest predicted pass first" },
];

export function QueueControls({ shown, total }: { shown: number; total: number }) {
  const v = useQueueView();
  const me = useMe();
  const hasFleet = (me?.assignedObjectIds.length ?? 0) > 0;
  const active = activeFilters(v);

  return (
    <div className="space-y-1.5 px-2 pb-2">
      <label className="flex h-7 items-center gap-1.5 rounded-[8px] bg-white/[0.04] px-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]">
        <Search size={12} className="shrink-0 text-neutral-500" />
        <input
          value={v.search}
          onChange={(e) => v.set({ search: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Search satellite, NORAD or event"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-white outline-none placeholder:text-neutral-600"
          aria-label="Search the queue"
        />
        {v.search && (
          <button className="text-neutral-500 hover:text-white" onClick={() => v.set({ search: "" })} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
      </label>

      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Select value={v.sort} options={SORTS} onChange={(sort) => v.set({ sort })} label="Sort" icon={<ArrowDownUp size={11} className="shrink-0 text-neutral-500" />} width={250} />
        </div>
        <FiltersMenu count={active.length} />
        {hasFleet && (
          <button
            className="h-7 shrink-0 rounded-[8px] px-2 text-[11.5px] transition-colors"
            style={
              v.mine
                ? { background: "#fff", color: "#000" }
                : { background: "rgba(255,255,255,0.04)", color: "#d4d4d4", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }
            }
            aria-pressed={v.mine}
            onClick={() => {
              sfx.toggle(!v.mine);
              v.set({ mine: !v.mine });
            }}
          >
            My fleet
          </button>
        )}
      </div>

      {(active.length > 0 || v.mine || v.search) && (
        <div className="flex flex-wrap items-center gap-1">
          {active.map((f) => (
            <button
              key={f.key}
              className="flex h-5 items-center gap-1 rounded-full bg-white/[0.07] pl-2 pr-1.5 text-[10.5px] text-neutral-300 hover:bg-white/[0.1] hover:text-white"
              onClick={() => v.set({ [f.key]: "all" } as Partial<typeof v>)}
              aria-label={`Remove filter ${f.label}`}
            >
              {f.label} <X size={10} />
            </button>
          ))}
          <span className="tnum ml-auto text-[10.5px] text-neutral-500">
            {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
          </span>
        </div>
      )}
    </div>
  );
}

function FiltersMenu({ count }: { count: number }) {
  const v = useQueueView();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={btn}
        className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] bg-white/[0.04] px-2 text-[11.5px] text-neutral-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-colors hover:bg-white/[0.07] hover:text-white"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          sfx.click();
          setOpen((o) => !o);
        }}
      >
        <SlidersHorizontal size={11} className="text-neutral-500" />
        Filters
        {count > 0 && <span className="tnum grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] font-semibold text-black">{count}</span>}
      </button>
      <Popover open={open} onClose={close} anchor={btn} width={280} label="Filters">
        <div className="space-y-3 p-2">
          <Group<Severity>
            title="Severity"
            value={v.severity}
            onChange={(severity) => v.set({ severity })}
            options={[
              { value: "all", label: "All" },
              { value: "red", label: "Red" },
              { value: "yellow", label: "Yellow" },
            ]}
          />
          <Group<Within>
            title="Closest approach within"
            value={v.within}
            onChange={(within) => v.set({ within })}
            options={[
              { value: "all", label: "Any time" },
              { value: "24h", label: "24 h" },
              { value: "72h", label: "72 h" },
              { value: "7d", label: "7 days" },
            ]}
          />
          <Group<Objects>
            title="Objects"
            value={v.objects}
            onChange={(objects) => v.set({ objects })}
            options={[
              { value: "all", label: "All" },
              { value: "payloads", label: "Satellites" },
              { value: "debris", label: "Debris" },
            ]}
          />
          <div className="flex items-center justify-between border-t border-white/[0.07] pt-2.5">
            <button
              className="text-[11.5px] text-neutral-400 hover:text-white disabled:opacity-40"
              disabled={count === 0}
              onClick={() => v.set({ severity: "all", within: "all", objects: "all" })}
            >
              Clear filters
            </button>
            <button className="btn btn-primary h-7 px-3 text-[11.5px]" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function Group<T extends string>({ title, value, options, onChange }: { title: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-500">{title}</div>
      <div className="flex gap-1 rounded-[9px] bg-white/[0.035] p-0.5" role="radiogroup" aria-label={title}>
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            className={`h-7 flex-1 rounded-[7px] text-[11.5px] transition-colors ${o.value === value ? "bg-white text-black" : "text-neutral-400 hover:text-white"}`}
            onClick={() => {
              sfx.click();
              onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
