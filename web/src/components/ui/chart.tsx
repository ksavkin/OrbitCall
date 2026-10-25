"use client";

import type { ReactNode } from "react";
import { ResponsiveContainer, Tooltip as RTooltip, type TooltipProps } from "recharts";

// The shadcn/ui chart pattern on Recharts, in this app's style: a container that sizes the chart and names its
// series, and a tooltip card in the app's dark look. Series colors come from the config, never from Recharts.

export type ChartConfig = Record<string, { label: string; color: string }>;

export function ChartContainer({ config, className = "", children }: { config: ChartConfig; className?: string; children: ReactNode }) {
  const vars = Object.fromEntries(Object.entries(config).map(([k, v]) => [`--color-${k}`, v.color]));
  return (
    <div
      className={`w-full text-[11px] [&_.recharts-cartesian-axis-tick_text]:fill-neutral-500 [&_.recharts-cartesian-grid_line]:stroke-white/[0.06] [&_.recharts-reference-line_line]:stroke-[#ff5a4f]/60 [&_.recharts-surface]:outline-none ${className}`}
      style={vars as React.CSSProperties}
    >
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

export const ChartTooltip = RTooltip;

/** Tooltip card: a title line and one row per series, with its color swatch. */
export function ChartTooltipContent({
  active,
  payload,
  label,
  config,
  labelFormatter,
  valueFormatter,
}: TooltipProps<number, string> & {
  config: ChartConfig;
  labelFormatter?: (label: unknown) => ReactNode;
  valueFormatter?: (value: number, key: string) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[150px] rounded-[10px] bg-[rgba(14,14,16,0.97)] px-3 py-2 text-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_-12px_rgba(0,0,0,0.9)]">
      {label !== undefined && <div className="mb-1 text-[11px] text-neutral-500">{labelFormatter ? labelFormatter(label) : String(label)}</div>}
      {payload.map((p) => {
        const key = String(p.dataKey ?? p.name);
        const c = config[key];
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: c?.color ?? String(p.color) }} />
            <span className="text-neutral-400">{c?.label ?? key}</span>
            <span className="tnum ml-auto font-semibold text-white">{valueFormatter ? valueFormatter(Number(p.value), key) : String(p.value)}</span>
          </div>
        );
      })}
    </div>
  );
}
