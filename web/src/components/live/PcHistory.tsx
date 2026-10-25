"use client";

import { useQuery } from "convex/react";
import { motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { historySeriesRef } from "@/lib/backend/api";
import { fmtAge, fmtStamp, SOURCE_LABEL } from "@/lib/backend/format";
import { useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { EventId, HistorySeries, SeriesPoint, SourceName } from "@/lib/backend/types";
import { fmtChance, fmtMiss, fmtOdds } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Chip } from "@/components/ui/Chip";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useHistoryError } from "./sync/VerificationSync";

// history.series in real mode (wiring map §9): observations only, one line per source, no forecast. Real and
// simulated series are never merged: a simulated line is dashed, orange and named "Simulated". A stale or failed
// read says so above the last good copy. The open case reads useLive (VerificationSync); any other incident reads
// its own subscription.

type Metric = "pc" | "missKm";
type Series = { key: string; label: string; color: string; simulated: boolean; points: SeriesPoint[] };

// The red rule (convex/lib/analyst.ts isRed): Pc above 1 in 10,000 inside 72 h.
const ACTION = 1e-4;

const SOURCE_COLOR: Record<SourceName, string> = {
  socrates: "#ff7a6b",
  cdm_public: "var(--amber)",
  celestrak_gp: "var(--blue)",
  celestrak_supgp: "#9cc2ff",
  gp_history: "#a594ff",
  keeptrack: "var(--fg-2)",
  celestrak_satcat: "var(--fg-2)",
  simulated: "var(--orange)",
};

export function PcHistory({ eventId, compact = false }: { eventId: EventId; compact?: boolean }) {
  const open = useOps((s) => s.incident === eventId);
  if (open) return <OpenCase eventId={eventId} compact={compact} />;
  return (
    <QueryBoundary key={eventId} fallback={(e) => <HistoryView compact={compact} history={undefined} error={briefError(e)} />}>
      <OwnRead eventId={eventId} compact={compact} />
    </QueryBoundary>
  );
}

function OpenCase({ eventId, compact }: { eventId: EventId; compact: boolean }) {
  const history = useLive((s) => s.history);
  const error = useHistoryError((s) => (s.eventId === eventId ? s.message : null));
  return <HistoryView compact={compact} history={history} error={error} />;
}

function OwnRead({ eventId, compact }: { eventId: EventId; compact: boolean }) {
  const history = useQuery(historySeriesRef, { eventId });
  return <HistoryView compact={compact} history={history} error={null} />;
}

/** One series per source, real first; simulated values keep their own series even from the same source. */
function seriesOf(h: HistorySeries): Series[] {
  const out = new Map<string, Series>();
  const add = (p: SeriesPoint, simulated: boolean) => {
    const key = `${simulated ? "sim" : "real"}_${p.source}`;
    const name = SOURCE_LABEL[p.source] ?? p.source;
    const s = out.get(key) ?? {
      key,
      label: !simulated ? name : p.source === "simulated" ? "Simulated" : `Simulated · ${name}`,
      color: simulated ? "var(--orange)" : (SOURCE_COLOR[p.source] ?? "var(--fg-2)"),
      simulated,
      points: [],
    };
    s.points.push(p);
    out.set(key, s);
  };
  for (const p of h.real) add(p, false);
  for (const p of h.simulated) add(p, true);
  return [...out.values()];
}

const has = (s: Series, m: Metric) => s.points.some((p) => p[m] !== null);

/** The newest value of a metric among real series, else among simulated ones. */
function latestOf(series: Series[], m: Metric) {
  const pick = (simulated: boolean) => {
    let best: { t: number; v: number; s: Series } | null = null;
    for (const s of series) {
      if (s.simulated !== simulated) continue;
      for (const p of s.points) {
        const t = Date.parse(p.atUtc);
        const v = p[m];
        if (v !== null && Number.isFinite(t) && (!best || t > best.t)) best = { t, v, s };
      }
    }
    return best;
  };
  return pick(false) ?? pick(true);
}

/** One row per observation: recharts joins each series across the rows of the others. */
function rowsOf(series: Series[], m: Metric) {
  const rows: Record<string, number>[] = [];
  for (const s of series) {
    for (const p of s.points) {
      const t = Date.parse(p.atUtc);
      const v = p[m];
      if (v === null || !Number.isFinite(t)) continue;
      rows.push({ t, [s.key]: m === "pc" ? Math.max(v, 1e-9) : v });
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

const fmtValue = (m: Metric, v: number) => (m === "missKm" ? fmtMiss(v * 1000) : v > 0 ? fmtOdds(v) : "0");
// the cache stores failures as "CODE: message"; the message is the readable part
const readable = (e: string) => e.replace(/^[A-Z_]+:\s*/, "");

function HistoryView({ history, error, compact }: { history: HistorySeries | undefined; error: string | null; compact: boolean }) {
  const now = useNow(60_000);
  const id = useId().replace(/:/g, "");
  const [pick, setPick] = useState<Metric | null>(null);
  const series = useMemo(() => (history ? seriesOf(history) : []), [history]);
  const hasPc = series.some((s) => has(s, "pc"));
  const hasMiss = series.some((s) => has(s, "missKm"));
  const metric: Metric = pick ?? (hasPc || !hasMiss ? "pc" : "missKm");
  const shown = useMemo(() => series.filter((s) => has(s, metric)), [series, metric]);
  const rows = useMemo(() => rowsOf(shown, metric), [shown, metric]);
  const latest = latestOf(shown, metric);
  const ago = (t: number) => (now ? fmtAge(Math.max(0, now - t)) : "");

  const title = metric === "pc" ? "Chance of collision" : "Miss distance";
  const above = metric === "pc" && !!latest && latest.v > ACTION;
  const status = latest ? [latest.s.label, ago(latest.t)].filter(Boolean).join(" · ") : null;

  return (
    <div data-testid="pc-history">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className={compact ? "text-[12px] font-semibold text-neutral-200" : "text-[13px] font-medium text-white"}>{title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-neutral-500">
            {status ?? "Observations only, no forecast"}
            {shown.some((s) => s.simulated) && (
              <Chip color="var(--orange)" size="sm">
                Simulated
              </Chip>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasPc && hasMiss && <MetricSwitch id={id} value={metric} onChange={setPick} />}
          {latest && (
            <span className="tnum text-[13px] font-semibold" style={{ color: above ? "#ff8a80" : "#d4d4d4" }}>
              {fmtValue(metric, latest.v)}
            </span>
          )}
        </div>
      </div>

      <CacheNotes history={history} error={error} ago={ago} />

      {rows.length > 0 ? (
        <Chart id={id} series={shown} rows={rows} metric={metric} compact={compact} ago={ago} />
      ) : (
        <div className={`mt-3 grid place-items-center rounded-[9px] bg-white/[0.02] px-3 text-center text-[12px] text-neutral-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] ${compact ? "h-[112px]" : "h-[150px]"}`}>
          {!history ? (
            error ? <span className="break-words text-[#ff8a80]">History could not be read · {error}</span> : <span className="shimmer">Reading the observation history…</span>
          ) : history.fetchedAt === null ? (
            "No observations have been read yet"
          ) : (
            "No observations for this incident yet"
          )}
        </div>
      )}

      {shown.length > 1 && <Legend series={shown} />}
    </div>
  );
}

/** Stale copy, a failed cache read and a failed query over the last good data, each in one quiet line. */
function CacheNotes({ history, error, ago }: { history: HistorySeries | undefined; error: string | null; ago: (t: number) => string }) {
  const fetched = history?.fetchedAt != null ? ago(history.fetchedAt) : "";
  return (
    <>
      {history?.stale && (
        <div className="mt-1.5 text-[11.5px] text-orange">
          Stale · {history.fetchedAt !== null ? `last good copy${fetched ? ` from ${fetched}` : ""}` : "not read yet"}
        </div>
      )}
      {history?.error && <div className="mt-1 break-words text-[11.5px] text-orange">Last read failed · {readable(history.error)}</div>}
      {history && error && <div className="mt-1 break-words text-[11.5px] text-[#ff8a80]">History could not be read · {error}</div>}
    </>
  );
}

function MetricSwitch({ id, value, onChange }: { id: string; value: Metric; onChange: (m: Metric) => void }) {
  return (
    <div className="flex h-[22px] items-center rounded-[8px] bg-white/[0.035] p-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      {(["pc", "missKm"] as const).map((m) => (
        <button
          key={m}
          className="relative h-full rounded-[6px] px-2 text-[10.5px] text-muted transition-colors hover:text-fg data-[active=true]:text-fg"
          data-active={value === m}
          onClick={() => {
            if (value !== m) sfx.click();
            onChange(m);
          }}
        >
          {value === m && <motion.span layoutId={`${id}-metric`} className="seg-pill !rounded-[6px]" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
          <span className="relative">{m === "pc" ? "Chance" : "Miss"}</span>
        </button>
      ))}
    </div>
  );
}

function Chart({ id, series, rows, metric, compact, ago }: { id: string; series: Series[]; rows: Record<string, number>[]; metric: Metric; compact: boolean; ago: (t: number) => string }) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const values = rows.flatMap((r) => series.map((s) => r[s.key]).filter((v): v is number => v !== undefined));
  const pc = metric === "pc";
  const lo = Math.min(1e-5, ...values) / 2;
  const hi = Math.max(1e-3, ...values) * 2;
  const ticks = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1].filter((v) => v >= lo && v <= hi);
  return (
    <ChartContainer config={config} className={`mt-3 ${compact ? "h-[112px]" : "h-[150px]"}`}>
      <LineChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={6} tickCount={3} tickFormatter={(t: number) => ago(t)} />
        {pc ? (
          <YAxis scale="log" domain={[lo, hi]} ticks={ticks} allowDataOverflow tickLine={false} axisLine={false} width={74} tickFormatter={(v: number) => fmtOdds(v)} />
        ) : (
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMiss(v * 1000)} />
        )}
        {pc && <ReferenceLine y={ACTION} strokeDasharray="4 4" label={{ value: "Action line", position: "insideTopLeft", fill: "#ff8a80", fontSize: 10 }} />}
        <ChartTooltip
          cursor={{ stroke: "rgba(255,255,255,0.25)" }}
          content={
            <ChartTooltipContent
              config={config}
              labelFormatter={(t) => fmtStamp(new Date(Number(t)).toISOString())}
              valueFormatter={(v) => (pc ? `${fmtOdds(v)} · ${fmtChance(v)}` : fmtMiss(v * 1000))}
            />
          }
        />
        {series.map((s) => (
          <Line
            key={`${id}-${s.key}`}
            dataKey={s.key}
            type="linear"
            connectNulls
            stroke={`var(--color-${s.key})`}
            strokeWidth={s.simulated ? 1.6 : 2}
            strokeDasharray={s.simulated ? "4 3" : undefined}
            dot={{ r: 2, fill: `var(--color-${s.key})`, strokeWidth: 0 }}
            activeDot={{ r: 4, fill: `var(--color-${s.key})`, stroke: "#000", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="h-0 w-3 border-t-2" style={{ borderColor: s.color, borderStyle: s.simulated ? "dashed" : "solid" }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
