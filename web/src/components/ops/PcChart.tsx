"use client";

import { useId } from "react";
import { useRealMode } from "@/lib/backend/live";
import { fmtChance, fmtOdds, fmtPc } from "@/lib/ops/format";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { useNow } from "@/lib/useNow";
import { Tooltip } from "@/components/ui/Tooltip";
import { PcHistory } from "@/components/live/PcHistory";

// Collision probability over the last day (ROOM-10), readable without knowing log scales:
// the headline says what happened, the axis speaks in odds ("1 in 10,000"), the action line
// is named, and the line turns red only where it is above that line.
// Real mode draws the backend's observation history instead (history.series), never the simulator's.

const ACTION = 1e-4;

function story(e: ConjunctionEvent, now: number) {
  const h = e.pcHistory;
  if (h.length < 2) return "Collision probability";
  const first = h[0].pc;
  const last = h[h.length - 1].pc;
  const ratio = last / first;
  const change =
    ratio >= 1.5 ? `Rose ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× in 24 h` : ratio <= 0.67 ? `Fell ${Math.round((1 - ratio) * 100)}% in 24 h` : "Steady over 24 h";
  // when it crossed the action line, interpolated in log space between samples
  let crossedAt: number | null = null;
  for (let i = 1; i < h.length; i++) {
    if (h[i - 1].pc <= ACTION && h[i].pc > ACTION) {
      const a = Math.log10(h[i - 1].pc);
      const b = Math.log10(h[i].pc);
      const f = (Math.log10(ACTION) - a) / (b - a);
      crossedAt = h[i - 1].t + f * (h[i].t - h[i - 1].t);
    }
  }
  const where =
    last > ACTION
      ? crossedAt && now
        ? `crossed the action line ${Math.max(1, Math.round((now - crossedAt) / 3600_000))} h ago`
        : "above the action line"
      : "below the action line";
  return `${change} · ${where}`;
}

export function PcChart({ e }: { e: ConjunctionEvent }) {
  const real = useRealMode();
  return real ? <PcHistory eventId={e.id} compact /> : <SimPcChart e={e} />;
}

function SimPcChart({ e }: { e: ConjunctionEvent }) {
  const now = useNow(60_000);
  const clip = useId().replace(/:/g, "");
  const h = e.pcHistory;
  if (h.length < 2) return null;
  const logs = h.map((p) => Math.log10(Math.max(p.pc, 1e-9)));
  // whole decades around the data and the action line, so every tick is a round number
  const lo = Math.min(Math.floor(Math.min(...logs)), -5);
  const hi = Math.max(Math.ceil(Math.max(...logs)), -3);
  const yPct = (lg: number) => (1 - (lg - lo) / (hi - lo)) * 100;
  const t0 = h[0].t;
  const t1 = h[h.length - 1].t;
  const xPct = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * 100;
  const pts = h.map((p, i) => [xPct(p.t), yPct(logs[i])] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const actionY = yPct(Math.log10(ACTION));
  const last = h[h.length - 1].pc;
  const [lx, ly] = pts[pts.length - 1];
  const above = last > ACTION;
  const ticks: number[] = [];
  for (let k = hi; k >= lo; k--) ticks.push(k);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold text-neutral-200">Chance of collision</span>
        <Tooltip label={`${fmtChance(last)} chance now · Pc ${fmtPc(last)} · ${e.pcSource}`}>
          <span className="tnum text-[12px] font-semibold" style={{ color: above ? "var(--red)" : "#d4d4d4" }}>
            {fmtOdds(last)}
          </span>
        </Tooltip>
      </div>
      <div className="mt-0.5 text-[12px] text-neutral-500">{story(e, now)}</div>

      <div className="mt-3 flex gap-2">
        {/* odds axis */}
        <div className="relative w-[76px] shrink-0">
          {ticks.map((k) => (
            <span
              key={k}
              className="tnum absolute right-0 -translate-y-1/2 whitespace-nowrap text-[10px] text-neutral-600"
              style={{ top: `${yPct(k)}%` }}
            >
              1 in {(10 ** -k).toLocaleString("en-US")}
            </span>
          ))}
        </div>
        <div className="relative h-[112px] flex-1">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            <defs>
              <clipPath id={`above-${clip}`}>
                <rect x="-1" y="-5" width="102" height={actionY + 5} />
              </clipPath>
              <clipPath id={`below-${clip}`}>
                <rect x="-1" y={actionY} width="102" height={105 - actionY} />
              </clipPath>
              <linearGradient id={`fill-${clip}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#ff5a4f" stopOpacity="0.18" />
                <stop offset="1" stopColor="#ff5a4f" stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks.map((k) => (
              <line key={k} x1="0" x2="100" y1={yPct(k)} y2={yPct(k)} stroke="white" strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
            ))}
            {/* red wash only above the action line */}
            <path d={`${d}L100,${actionY}L0,${actionY}Z`} fill={`url(#fill-${clip})`} clipPath={`url(#above-${clip})`} />
            <line x1="0" x2="100" y1={actionY} y2={actionY} stroke="#ff5a4f" strokeOpacity="0.55" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            <path d={d} fill="none" stroke="#737373" strokeWidth="1.8" vectorEffect="non-scaling-stroke" clipPath={`url(#below-${clip})`} />
            <path d={d} fill="none" stroke="#ff5a4f" strokeWidth="2" vectorEffect="non-scaling-stroke" clipPath={`url(#above-${clip})`} />
          </svg>
          {/* labels in HTML so they stay crisp at any width */}
          <span className="absolute left-1 -translate-y-full pb-0.5 text-[10px] text-[#ff8a80]" style={{ top: `${actionY}%` }}>
            Action line · 1 in 10,000
          </span>
          <span className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${lx}%`, top: `${ly}%` }}>
            <span className="block h-2.5 w-2.5 rounded-full shadow-[0_0_0_3px_rgba(0,0,0,0.7)]" style={{ background: above ? "var(--red)" : "#e5e5e5" }} />
          </span>
        </div>
      </div>
      <div className="ml-[84px] mt-1.5 flex justify-between text-[10px] text-neutral-600">
        <span>24 h ago</span>
        <span>12 h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
