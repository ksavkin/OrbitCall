"use client";

import { AnimatePresence, motion } from "motion/react";
import { Database, Eye, EyeOff, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "@/lib/catalog/types";
import { fmtAgo, fmtInt, fmtUtc } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { CATEGORY_META, ownerColor, OWNER_COLORS } from "@/lib/theme";
import { ownerInfo } from "@/lib/owners";
import { OwnerBadge } from "./OwnerBadge";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

const REGIME_COLORS = { LEO: "#e6e8eb", MEO: "#f5c451", GEO: "#a594ff", HEO: "#ff9f40" } as const;

export function CatalogPanel() {
  const catalog = useOrbit((s) => s.catalog);
  const enabled = useOrbit((s) => s.enabled);
  const toggle = useOrbit((s) => s.toggleCategory);
  const solo = useOrbit((s) => s.soloCategory);
  const set = useOrbit((s) => s.set);
  const [open, setOpen] = useState(true);

  const hiddenOwners = useOrbit((s) => s.hiddenOwners);
  const colorBy = useOrbit((s) => s.colorBy);
  const [tab, setTab] = useState<"types" | "countries">("types");

  const filterCount = CATEGORIES.filter((c) => !enabled[c]).length + hiddenOwners.length;
  const visible = useMemo(() => {
    if (!catalog) return 0;
    const hidden = new Set(hiddenOwners);
    let n = 0;
    for (const o of catalog.objects) if (enabled[o.category] && !hidden.has(o.owner)) n++;
    return n;
  }, [catalog, enabled, hiddenOwners]);

  return (
    <div className="pointer-events-none relative flex min-h-0 shrink flex-col">
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <motion.aside
            key="panel"
            initial={{ opacity: 0, x: -14, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: -14, filter: "blur(6px)" }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="glass pointer-events-auto relative flex max-h-full min-h-0 w-[244px] flex-col overflow-hidden rounded-[14px]"
          >
            {/* header */}
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
              <span className="eyebrow">Tracked objects</span>
              <Tooltip label="Collapse" side="right">
                <button className="icon-btn -mr-1 h-6 w-6" onClick={() => setOpen(false)} aria-label="Collapse panel">
                  <PanelLeftClose size={13} />
                </button>
              </Tooltip>
            </div>
            <div className="px-3">
              <div className="flex items-baseline gap-1.5">
                <span className="tnum text-[26px] font-semibold leading-none tracking-[-0.03em]">
                  {catalog ? fmtInt(visible) : "—"}
                </span>
                {catalog && visible !== catalog.objects.length && (
                  <span className="tnum text-[12px] text-muted">/ {fmtInt(catalog.objects.length)}</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">SGP4-propagated from public element sets</div>
            </div>

            {/* orbit regimes */}
            {catalog && <RegimeBar regimes={catalog.regimes} total={catalog.objects.length} />}

            <div className="mx-3 mt-3 h-px bg-white/[0.06]" />

            {/* layers: by type or by owner country */}
            <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
              <Segmented
                value={tab}
                options={[
                  { value: "types", label: "Types" },
                  { value: "countries", label: "Countries" },
                ]}
                onChange={(v) => setTab(v as typeof tab)}
                id="layer-tab"
              />
              <AnimatePresence>
                {filterCount > 0 && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="flex h-5 items-center gap-1 rounded-[6px] bg-white/[0.06] pl-1.5 pr-1 text-[10.5px] text-fg-2 hover:bg-white/10"
                    onClick={() => {
                      sfx.click();
                      set({ enabled: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as typeof enabled, hiddenOwners: [] });
                    }}
                  >
                    Filter <span className="text-blue">· {filterCount}</span>
                    <X size={11} className="text-muted" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <div className="flex items-center justify-between px-3 pb-1.5">
              <span className="flex items-center gap-1 text-[10.5px]">
                {(["all", "none"] as const).map((k) => (
                  <button
                    key={k}
                    className="rounded-[5px] px-1.5 py-0.5 text-muted transition-colors hover:bg-white/[0.07] hover:text-fg"
                    onClick={() => {
                      sfx.click();
                      const on = k === "all";
                      if (tab === "types") {
                        set({ enabled: Object.fromEntries(CATEGORIES.map((c) => [c, on])) as typeof enabled });
                      } else {
                        const codes = catalog ? [...new Set(catalog.objects.map((o) => o.owner))] : [];
                        set({ hiddenOwners: on ? [] : codes });
                      }
                    }}
                  >
                    {k === "all" ? "All" : "None"}
                  </button>
                ))}
              </span>
              <Segmented
                value={colorBy}
                options={[
                  { value: "category", label: "Type" },
                  { value: "country", label: "Country" },
                ]}
                onChange={(v) => set({ colorBy: v as typeof colorBy })}
                label="Color by"
                id="color-by"
                small
              />
            </div>
            {tab === "types" ? (
              <ul className="thin-scroll min-h-[96px] overflow-y-auto px-1.5 pb-1.5">
                {CATEGORIES.map((c) => {
                  const m = CATEGORY_META[c];
                  const on = enabled[c];
                  return (
                    <li key={c}>
                      <LayerRow
                        on={on}
                        swatch={colorBy === "category" ? m.color : null}
                        label={
                          <Tooltip label={m.hint} side="right" delay={600}>
                            <span>{m.label}</span>
                          </Tooltip>
                        }
                        count={catalog ? catalog.counts[c] : null}
                        onToggle={() => {
                          sfx.toggle(!on);
                          toggle(c);
                        }}
                        onOnly={() => {
                          sfx.click();
                          solo(c);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <CountryList />
            )}

            {catalog && <DataCard meta={catalog.meta} objects={catalog.objects} />}
          </motion.aside>
        ) : (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="pointer-events-auto"
          >
            <Tooltip label="Show catalog" side="right">
              <button
                className="glass icon-btn relative h-9 w-9 rounded-[11px]"
                onClick={() => setOpen(true)}
                aria-label="Expand panel"
              >
                <PanelLeftOpen size={14} />
              </button>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RegimeBar({ regimes, total }: { regimes: Record<keyof typeof REGIME_COLORS, number>; total: number }) {
  const keys = Object.keys(REGIME_COLORS) as (keyof typeof REGIME_COLORS)[];
  return (
    <div className="px-3 pt-3">
      <div className="flex h-[5px] gap-[2px] overflow-hidden rounded-full">
        {keys.map((k) => (
          <motion.div
            key={k}
            initial={{ flexGrow: 0 }}
            animate={{ flexGrow: Math.max(regimes[k] / total, 0.004) }}
            transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
            style={{ background: REGIME_COLORS[k], flexBasis: 0, opacity: k === "LEO" ? 0.85 : 1 }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1">
        {keys.map((k) => (
          <Tooltip
            key={k}
            label={
              {
                LEO: "Low Earth orbit: apogee below 2,000 km",
                MEO: "Medium Earth orbit, between LEO and GEO",
                GEO: "Period within 90 min of one sidereal day",
                HEO: "Highly elliptical: eccentricity above 0.25",
              }[k]
            }
          >
            <div>
              <div className="flex items-center gap-1 text-[9.5px] text-muted">
                <span className="h-1 w-1 rounded-full" style={{ background: REGIME_COLORS[k] }} />
                {k}
              </div>
              <div className="mono tnum text-[11px] text-fg-2">{fmtInt(regimes[k])}</div>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function DataCard({
  meta,
  objects,
}: {
  meta: { source: string; fetchedAt: string; count: number };
  objects: { epoch: Date }[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const medianEpochAge = useMemo(() => {
    const ages = objects.map((o) => o.epoch.getTime()).sort((a, b) => a - b);
    return ages[Math.floor(ages.length / 2)];
  }, [objects]);
  const fetched = Date.parse(meta.fetchedAt);
  const t = fmtUtc(fetched);
  const live = meta.source === "celestrak-live" || meta.source === "celestrak-cache";
  // fraction of the 2 h CelesTrak refresh window used up
  const used = Math.min((now - fetched) / (2 * 3600 * 1000), 1);
  return (
    <div className="m-1.5 mt-0.5 rounded-[10px] bg-white/[0.03] p-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] text-fg-2">
          <Database size={11} className="text-muted" />
          CelesTrak GP + SATCAT
        </span>
        <span className="text-[10px]" style={{ color: live ? "var(--green)" : "var(--orange)" }}>
          {live ? "live" : "snapshot"}
        </span>
      </div>
      <div className="mono tnum mt-1.5 text-[11px] text-fg">
        {t.time} <span className="text-muted">UTC · {fmtAgo(now - fetched)} ago</span>
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full bg-white/70 transition-[width] duration-700" style={{ width: `${(1 - used) * 100}%` }} />
      </div>
      <div className="mt-1.5 text-[10px] text-muted">
        Median element-set age <span className="mono text-fg-2">{fmtAgo(now - medianEpochAge)}</span>
      </div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
  id,
  small,
  label,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  id: string;
  small?: boolean;
  label?: string;
}) {
  const control = (
    <div className={`flex items-center rounded-[8px] bg-white/[0.035] p-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${small ? "h-[22px]" : "h-[24px]"}`}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`relative h-full rounded-[6px] px-2 text-muted transition-colors hover:text-fg data-[active=true]:text-fg ${small ? "text-[10.5px]" : "text-[11px]"}`}
          data-active={value === o.value}
          onClick={() => {
            if (value !== o.value) sfx.click();
            onChange(o.value);
          }}
        >
          {value === o.value && (
            <motion.span layoutId={`${id}-pill`} className="seg-pill !rounded-[6px]" transition={{ type: "spring", stiffness: 520, damping: 38 }} />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
  if (!label) return control;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[10.5px] text-muted">{label}</span>
      {control}
    </span>
  );
}

function LayerRow({
  on,
  swatch,
  label,
  count,
  onToggle,
  onOnly,
}: {
  on: boolean;
  swatch: string | null;
  label: ReactNode;
  count: number | null;
  onToggle: () => void;
  onOnly: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => e.key === "Enter" && onToggle()}
      className="group flex h-[30px] cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 transition-colors hover:bg-white/[0.05]"
    >
      {swatch && (
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full transition-all duration-300"
          style={{
            background: on ? swatch : "transparent",
            boxShadow: on ? `0 0 8px ${swatch}aa` : `inset 0 0 0 1px ${swatch}88`,
          }}
        />
      )}
      <span className={`min-w-0 truncate text-[12px] transition-colors ${on ? "text-fg" : "text-faint"}`}>{label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          className="hidden h-5 rounded-[5px] px-1.5 text-[10px] text-muted hover:bg-white/10 hover:text-fg group-hover:block"
          onClick={(e) => {
            e.stopPropagation();
            onOnly();
          }}
        >
          Only
        </button>
        <span className={`mono tnum text-[11px] ${on ? "text-fg-2" : "text-faint"}`}>{count !== null ? fmtInt(count) : "—"}</span>
        <span className="w-4 text-faint transition-colors group-hover:text-fg-2">{on ? <Eye size={12} /> : <EyeOff size={12} />}</span>
      </span>
    </div>
  );
}

/** Every owner in the catalog, largest first, with flags and a search box. */
function CountryList() {
  const catalog = useOrbit((s) => s.catalog);
  const hiddenOwners = useOrbit((s) => s.hiddenOwners);
  const colorBy = useOrbit((s) => s.colorBy);
  const set = useOrbit((s) => s.set);
  const [q, setQ] = useState("");

  const owners = useMemo(() => {
    if (!catalog) return [];
    const counts = new Map<string, number>();
    for (const o of catalog.objects) counts.set(o.owner, (counts.get(o.owner) ?? 0) + 1);
    return [...counts.entries()]
      .map(([code, n]) => ({ info: ownerInfo(code, catalog.owners), code, n }))
      .filter((x) => x.info !== null)
      .sort((a, b) => b.n - a.n);
  }, [catalog]);

  const hidden = new Set(hiddenOwners);
  const s = q.trim().toLowerCase();
  const shown = s ? owners.filter((o) => `${o.info!.name} ${o.info!.fullName} ${o.code}`.toLowerCase().includes(s)) : owners;

  const toggle = (code: string) => {
    const on = !hidden.has(code);
    sfx.toggle(!on);
    set({ hiddenOwners: on ? [...hiddenOwners, code] : hiddenOwners.filter((c) => c !== code) });
  };
  const only = (code: string) => {
    sfx.click();
    const isOnly = hiddenOwners.length === owners.length - 1 && !hidden.has(code);
    set({ hiddenOwners: isOnly ? [] : owners.map((o) => o.code).filter((c) => c !== code) });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mx-3 mb-1 flex h-7 items-center gap-1.5 rounded-[8px] bg-white/[0.035] px-2 text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
        <Search size={12} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`${owners.length} owners`}
          className="h-full min-w-0 flex-1 bg-transparent text-[11.5px] text-fg outline-none placeholder:text-faint"
        />
      </div>
      <ul className="thin-scroll max-h-[260px] overflow-y-auto px-1.5 pb-1.5">
        {shown.map(({ info, code, n }) => (
          <li key={code}>
            <LayerRow
              on={!hidden.has(code)}
              swatch={colorBy === "country" ? ownerColor(code) : null}
              label={<OwnerBadge owner={info!} h={10} />}
              count={n}
              onToggle={() => toggle(code)}
              onOnly={() => only(code)}
            />
          </li>
        ))}
        {colorBy === "country" && !s && (
          <li className="px-1.5 pt-1 text-[10px] leading-snug text-faint">
            The {Object.keys(OWNER_COLORS).length} largest operators get their own color; the rest are grey.
          </li>
        )}
      </ul>
    </div>
  );
}
