"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { useRealMode } from "@/lib/backend/live";
import { fmtChance, fmtOdds } from "@/lib/ops/format";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { useNow } from "@/lib/useNow";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { PcHistory } from "@/components/live/PcHistory";

// Chance of collision over the last day, interactive: hover any point for the time, the odds and the exact value.
// The scale is logarithmic (each step is 10× less likely) but every label speaks in odds, and the action line is named.
// Real mode draws the backend's observation history instead (history.series), never the simulator's.

const ACTION = 1e-4;
const config: ChartConfig = { pc: { label: "Chance", color: "#ff7a6b" } };

export function PcTrend({ e }: { e: ConjunctionEvent }) {
  const real = useRealMode();
  return real ? <PcHistory eventId={e.id} /> : <SimPcTrend e={e} />;
}

function SimPcTrend({ e }: { e: ConjunctionEvent }) {
  const now = useNow(60_000);
  const h = e.pcHistory;
  if (h.length < 2) return null;
  const data = h.map((p) => ({ t: p.t, pc: Math.max(p.pc, 1e-9) }));
  const lo = Math.min(1e-5, ...data.map((d) => d.pc)) / 2;
  const hi = Math.max(1e-3, ...data.map((d) => d.pc)) * 2;
  const ticks = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2].filter((v) => v >= lo && v <= hi);
  const first = data[0].pc;
  const last = data[data.length - 1].pc;
  const ratio = last / first;
  const change = ratio >= 1.5 ? `Rose ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× in 24 h` : ratio <= 0.67 ? `Fell ${Math.round((1 - ratio) * 100)}% in 24 h` : "Steady over 24 h";
  const hoursAgo = (t: number) => (now ? Math.max(0, Math.round((now - t) / 3600_000)) : 0);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[13px] font-medium text-white">Chance of collision</div>
          <div className="mt-0.5 text-[12px] text-neutral-500">
            {change} · {last > ACTION ? "above" : "below"} the action line
          </div>
        </div>
        <div className="tnum text-[13px] font-semibold" style={{ color: last > ACTION ? "#ff8a80" : "#d4d4d4" }}>
          {fmtOdds(last)}
        </div>
      </div>
      <ChartContainer config={config} className="mt-3 h-[150px]">
        <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`pc-fill-${e.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-pc)" stopOpacity={0.28} />
              <stop offset="1" stopColor="var(--color-pc)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={6} tickCount={3} tickFormatter={(t: number) => (hoursAgo(t) === 0 ? "now" : `${hoursAgo(t)} h ago`)} />
          <YAxis dataKey="pc" scale="log" domain={[lo, hi]} ticks={ticks} allowDataOverflow tickLine={false} axisLine={false} width={74} tickFormatter={(v: number) => fmtOdds(v)} />
          <ReferenceLine y={ACTION} strokeDasharray="4 4" label={{ value: "Action line", position: "insideTopLeft", fill: "#ff8a80", fontSize: 10 }} />
          <ChartTooltip
            cursor={{ stroke: "rgba(255,255,255,0.25)" }}
            content={<ChartTooltipContent config={config} labelFormatter={(t) => (hoursAgo(Number(t)) === 0 ? "Now" : `${hoursAgo(Number(t))} h ago`)} valueFormatter={(v) => `${fmtOdds(v)} · ${fmtChance(v)}`} />}
          />
          <Area dataKey="pc" type="monotone" stroke="var(--color-pc)" strokeWidth={2} fill={`url(#pc-fill-${e.id})`} dot={false} activeDot={{ r: 4, fill: "var(--color-pc)", stroke: "#000", strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
