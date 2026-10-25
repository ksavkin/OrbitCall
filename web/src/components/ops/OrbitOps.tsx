"use client";

import { motion } from "motion/react";
import { ListChecks, Radar } from "lucide-react";
import { useOps } from "@/lib/ops/store";
import { useOrbit } from "@/lib/store";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { useFleet, useMe } from "@/components/auth/session";
import { KIND_COLOR, KIND_LABEL } from "@/components/auth/SatGlyph";
import { ScanButton } from "./DemoFlow";

// Orbit's working block, top left: my fleet, Run Scan, and the way back to the last results. The case
// itself runs on the globe with the agents on the right; the Decision Center opens when a decision is due.

/** Select a fleet satellite on the globe and fly to it, as picking it in search does. */
function showSatellite(norad: number | null) {
  const orbit = useOrbit.getState();
  const o = norad === null ? undefined : orbit.catalog?.objects.find((x) => x.norad === norad);
  if (!o) return;
  sfx.select();
  // its layer may be hidden; the selection must be visible
  if (!orbit.enabled[o.category]) orbit.set({ enabled: { ...orbit.enabled, [o.category]: true } });
  orbit.set({ selected: o.index, following: false });
}

export function OrbitOps() {
  const me = useMe();
  const fleet = useFleet();
  const dev = useOps((s) => s.dev);
  const scan = useOps((s) => s.scan);
  const lastScan = useOps((s) => s.lastScan);
  const now = useNow(1000);
  const found = scan.ids.length;
  return (
    <motion.section
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="glass pointer-events-auto shrink-0 rounded-[14px] px-3 pb-3 pt-3"
    >
      <div className="flex items-center justify-between">
        <span className="eyebrow">My fleet</span>
        {me?.company && <span className="truncate pl-2 text-[11px] text-muted">{me.company.name}</span>}
      </div>
      {me && fleet.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {fleet.map((f) => {
            const km = f.object.orbit?.match(/(\d{3,4}) ×/)?.[1] ?? f.object.orbit?.match(/(\d{3,4}) km/)?.[1];
            return (
              <li key={f.object.objectId}>
                <button
                  className="flex w-full items-center gap-2 rounded-[7px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.05]"
                  title={`${f.object.kind ? KIND_LABEL[f.object.kind] : ""} · ${f.object.orbit ?? ""} · click to show it on the globe`}
                  onClick={() => showSatellite(f.object.norad)}
                >
                <span className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: f.object.kind ? KIND_COLOR[f.object.kind] : "#737373" }} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">{f.object.name}</span>
                {km && <span className="mono shrink-0 text-[10.5px] text-muted">{km} km</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted">{me ? "No satellites are assigned to this account yet." : "Sign in to see your satellites and scan them."}</p>
      )}
      <div className="mt-2.5">
        <ScanButton />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10.5px] text-muted">
        <Radar size={11} className={scan.phase === "scanning" ? "text-[#7fd8ff]" : ""} />
        {scan.phase === "scanning" ? (
          <span className="shimmer font-medium">Screening your fleet against the catalog…</span>
        ) : found > 0 ? (
          <>
            <span>
              Last scan found <span className="text-fg-2">{found}</span> conjunction{found > 1 ? "s" : ""}
            </span>
            <button
              className="ml-auto flex items-center gap-1 text-fg-2 hover:text-white"
              onClick={() => {
                sfx.click();
                useOps.setState((s) => ({ scan: { ...s.scan, phase: "results" } }));
              }}
            >
              <ListChecks size={11} /> Show
            </button>
          </>
        ) : dev && lastScan ? (
          <span>
            Routine check {now ? Math.max(0, Math.round((now - lastScan.at) / 60000)) : 0} min ago · {lastScan.objects.toLocaleString("en-US")} objects
          </span>
        ) : (
          <span>72 hours ahead · 5 km screening distance</span>
        )}
      </div>
    </motion.section>
  );
}
