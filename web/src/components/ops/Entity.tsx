"use client";

import { Crosshair } from "lucide-react";
import type { ReactNode } from "react";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, SpaceObjectRef } from "@/lib/ops/types";
import { ownerInfo } from "@/lib/owners";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";

// Object links: a satellite name in any text becomes a chip with its flag. Hover shows who
// operates it; click shows it on the globe (the incident view steps aside for that).

const NO_OWNERS: Record<string, string> = {};

export function showObjectOnGlobe(eventId: string, side: "a" | "b") {
  const scene = sceneRef.get();
  const e = useOps.getState().events.find((x) => x.id === eventId);
  if (!scene || !e) return;
  sfx.whoosh();
  useOps.setState({ incidentView: "collapsed" });
  // the director waits for the user after a manual shot
  scene.userCameraAt = performance.now();
  const ref = side === "a" ? e.a : e.b;
  if (ref.catalogIndex !== null) scene.shotObject(ref.catalogIndex, 0.12);
  else scene.shotSynthetic(eventId, 0.12);
}

export function ObjectChip({ e, side, size = "md" }: { e: ConjunctionEvent; side: "a" | "b"; size?: "sm" | "md" }) {
  const owners = useOrbit((s) => s.catalog?.owners ?? NO_OWNERS);
  const ref: SpaceObjectRef = side === "a" ? e.a : e.b;
  const info = ownerInfo(ref.owner, owners);
  return (
    <Tooltip
      label={
        <span className="block">
          <span className="block font-medium text-fg">{ref.name}</span>
          <span className="block text-muted">
            {ref.operator.replace(/\s*\(synthetic\)/i, "")} · NORAD {ref.norad}
            {ref.synthetic ? " · synthetic" : ""}
          </span>
          <span className="mt-0.5 block text-[10px] text-fg-2">Click to show it on the globe</span>
        </span>
      }
    >
      <button
        onClick={(ev) => {
          ev.stopPropagation();
          showObjectOnGlobe(e.id, side);
        }}
        className={`group/chip inline-flex max-w-full items-center gap-1 rounded-[6px] align-baseline font-medium text-fg transition-colors ${
          size === "sm" ? "px-1 py-0 text-[11px]" : "px-1.5 py-px text-[12px]"
        } bg-white/[0.06] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-white/[0.12] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]`}
      >
        {info?.flags[0] && <Flag code={info.flags[0]} h={size === "sm" ? 8 : 9} />}
        <span className="truncate">{ref.name.replace(/\s*\(SYN\)$/, "")}</span>
        {ref.synthetic && <span className="mono text-[8.5px] uppercase tracking-[0.08em] text-orange">syn</span>}
        <Crosshair size={size === "sm" ? 9 : 10} className="shrink-0 text-muted opacity-0 transition-opacity group-hover/chip:opacity-100" />
      </button>
    </Tooltip>
  );
}

/** Numbers, times and distances set in mono so they stand out. */
export function emphasize(line: string, key = 0): ReactNode[] {
  const re = /(\w{3} \d{2}:\d{2} UTC|\d{2}:\d{2} UTC|(?<![\w-])\d[\d.,]*(?:e-\d+)?(?:\s?(?:km\/s|km|m\b|°[NSEW]?|h\b))?|±\d[\d.,]*\s?(?:km|m))/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) out.push(line.slice(last, m.index));
    out.push(
      <span key={`${key}-${m.index}`} className="mono font-semibold text-fg">
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(line.slice(last));
  return out;
}

/** A line with both object names turned into chips and numbers emphasized. */
export function RichLine({ e, text }: { e: ConjunctionEvent; text: string }) {
  const names: [string, "a" | "b"][] = [
    [e.a.name, "a"],
    [e.b.name, "b"],
  ];
  const parts: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length) {
    let best: { i: number; name: string; side: "a" | "b" } | null = null;
    for (const [name, side] of names) {
      const i = rest.indexOf(name);
      if (i >= 0 && (!best || i < best.i)) best = { i, name, side };
    }
    if (!best) {
      parts.push(...emphasize(rest, k++));
      break;
    }
    if (best.i > 0) parts.push(...emphasize(rest.slice(0, best.i), k++));
    parts.push(<ObjectChip key={`chip-${k++}`} e={e} side={best.side} size="sm" />);
    rest = rest.slice(best.i + best.name.length);
  }
  return <>{parts}</>;
}

const BRIEF_LABELS = ["What", "Risk", "Data", "Where", "Options"];

/** The Incident Analyst's five lines, readable at a glance. */
export function Brief({ e, lines, skipOptions = false }: { e: ConjunctionEvent; lines: string[]; skipOptions?: boolean }) {
  const shown = skipOptions ? lines.slice(0, 4) : lines;
  return (
    <dl className="space-y-2">
      {shown.map((l, i) => (
        <div key={i} className="grid grid-cols-[52px_1fr] gap-2">
          <dt className="pt-[3px] text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted">{BRIEF_LABELS[i] ?? i + 1}</dt>
          <dd className="text-[12.5px] leading-[1.6] text-fg-2">
            <RichLine e={e} text={l} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
