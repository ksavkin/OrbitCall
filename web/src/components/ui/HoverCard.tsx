"use client";

import { useEffect, useState } from "react";
import type { SatLive } from "@/components/globe/GlobeScene";
import { fmtInt, fmtNum } from "@/lib/format";
import { sceneRef } from "@/lib/sceneRef";
import { useOrbit } from "@/lib/store";
import { CATEGORY_META, ownerColor } from "@/lib/theme";
import { ownerInfo } from "@/lib/owners";
import { OwnerBadge } from "./OwnerBadge";

/** Small card that rides next to the hovered satellite (positioned by Globe). */
export function HoverCard() {
  const hovered = useOrbit((s) => s.hovered);
  const selected = useOrbit((s) => s.selected);
  const obj = useOrbit((s) => (s.hovered !== null ? s.catalog?.objects[s.hovered] : undefined));
  const owners = useOrbit((s) => s.catalog?.owners);
  const colorBy = useOrbit((s) => s.colorBy);
  const [live, setLive] = useState<SatLive | null>(null);

  useEffect(() => {
    if (hovered === null) return;
    const tick = () => setLive(sceneRef.get()?.liveState(hovered) ?? null);
    tick();
    const id = setInterval(tick, 120);
    return () => clearInterval(id);
  }, [hovered]);

  if (!obj || hovered === selected) return null;
  const meta = CATEGORY_META[obj.category];
  const dot = colorBy === "country" ? ownerColor(obj.owner) : meta.color;
  const owner = ownerInfo(obj.owner, owners ?? {});

  return (
    <>
      <div
        className="absolute rounded-full"
        style={{
          left: -9,
          top: -9,
          width: 18,
          height: 18,
          border: `1.5px solid ${dot}`,
          boxShadow: `0 0 12px ${dot}66`,
        }}
      />
      <div className="glass glass-strong absolute left-4 top-3 w-[212px] rounded-[11px] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
          <span className="truncate text-[12px] font-medium text-fg">{obj.name}</span>
          <span className="mono ml-auto text-[10px] text-muted">{obj.norad}</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2">
          <Stat label="alt" value={live ? fmtInt(Math.round(live.altKm)) : "—"} unit="km" />
          <Stat label="vel" value={live ? fmtNum(live.speedKms, 2) : "—"} unit="km/s" />
          <Stat label="inc" value={fmtNum(obj.inclination, 1)} unit="°" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted">
          {owner ? <OwnerBadge owner={owner} h={10} className="text-fg-2" /> : <span>Owner unknown</span>}
          <span className="shrink-0">
            {meta.label} · {obj.regime}
          </span>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] text-muted">{label}</div>
      <div className="tnum truncate text-[12.5px] font-medium text-fg">
        {value}
        <span className="ml-0.5 text-[10px] font-normal text-muted">{unit}</span>
      </div>
    </div>
  );
}
