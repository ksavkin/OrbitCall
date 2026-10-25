"use client";

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
  // looking at an object means the globe: Orbit, with the case bar to come back
  useOps.setState({ incidentView: "collapsed", tab: "orbit" });
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
      {/* a span, not a button: these links sit inside rows that are buttons, and nested buttons are invalid HTML */}
      <span
        role="link"
        tabIndex={0}
        onClick={(ev) => {
          ev.stopPropagation();
          showObjectOnGlobe(e.id, side);
        }}
        onKeyDown={(ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          ev.stopPropagation();
          showObjectOnGlobe(e.id, side);
        }}
        // reads as a name in the sentence, not a box: underline on hover says it is a link
        className={`group/chip inline-flex cursor-pointer outline-none focus-visible:decoration-white max-w-full items-baseline gap-1 align-baseline font-semibold text-white underline decoration-white/20 decoration-1 underline-offset-[4px] transition-colors hover:decoration-white/80`}
      >
        {info?.flags[0] && (
          <span className="relative top-[1px] inline-block self-center overflow-hidden rounded-[2px]">
            <Flag code={info.flags[0]} h={size === "sm" ? 9 : 10} />
          </span>
        )}
        <span className="truncate">{ref.name.replace(/\s*\(SYN\)$/, "")}</span>
        {ref.synthetic && <span className="self-center text-[9px] font-medium uppercase tracking-[0.08em] text-neutral-500 no-underline">syn</span>}
      </span>
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
      <span key={`${key}-${m.index}`} className="tnum font-medium text-white">
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
    <dl className="space-y-2.5">
      {shown.map((l, i) => (
        <div key={i} className="grid grid-cols-[56px_1fr] gap-3">
          <dt className="pt-[2px] text-[11px] font-medium text-neutral-500">{BRIEF_LABELS[i] ?? i + 1}</dt>
          <dd className="text-[13.5px] leading-[1.6] text-neutral-300">
            <RichLine e={e} text={l} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
