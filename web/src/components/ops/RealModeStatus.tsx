"use client";

import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { useOps } from "@/lib/ops/store";

/** Explicit integration state: never substitute the development TLE catalog. */
export function RealModeStatus() {
  const snapshot = useOps((s) => s.backendSnapshot);
  const error = snapshot === "error";
  const hasOmm = snapshot && !error && snapshot.ommUrl;
  const title = !CONVEX_ENABLED
    ? "Real mode: backend not connected"
    : error
      ? "Could not load the OMM snapshot"
      : hasOmm
        ? "OMM snapshot available; globe integration pending"
        : "Real mode: waiting for OMM";

  return (
    <div className="glass pointer-events-auto absolute left-1/2 top-[76px] z-30 w-[360px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[12px] px-4 py-3" role="status">
      <div className="text-[12px] font-medium">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        Real satellite data appears after the OMM pipeline is connected. Turn Dev on to explore the TLE catalog and synthetic scenarios.
      </p>
    </div>
  );
}
