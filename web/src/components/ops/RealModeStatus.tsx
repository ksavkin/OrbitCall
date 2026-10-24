"use client";

import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { useOps } from "@/lib/ops/store";
import { useOrbit } from "@/lib/store";

/** Explicit integration state: never substitute the development TLE catalog. */
export function RealModeStatus() {
  const snapshot = useOps((s) => s.backendSnapshot);
  const stage = useOrbit((s) => s.stage);
  const loadError = useOrbit((s) => s.error);
  const drawn = useOrbit((s) => (s.catalog?.meta.source === "omm-snapshot" ? s.catalog.objects.length : 0));
  const error = snapshot === "error";
  const hasOmm = snapshot && !error && snapshot.ommUrl;
  // The globe shows the OMM catalog: nothing left to explain.
  if (hasOmm && drawn > 0 && stage === "ready") return null;
  const failed = hasOmm && stage === "error";
  const title = !CONVEX_ENABLED
    ? "Real mode: backend not connected"
    : error
      ? "Could not load the OMM snapshot"
      : failed
        ? "Could not load the OMM catalog"
        : hasOmm
          ? "Loading the OMM catalog"
          : "Real mode: waiting for OMM";
  const detail = failed
    ? loadError
    : hasOmm
      ? "Pinned CelesTrak element sets named by the backend. No TLE fallback is used."
      : "Real satellite data appears after the OMM pipeline is connected. Turn Dev on to explore the TLE catalog and synthetic scenarios.";

  return (
    <div className="glass pointer-events-auto absolute left-1/2 top-[76px] z-30 w-[360px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[12px] px-4 py-3" role="status">
      <div className="text-[12px] font-medium">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{detail}</p>
    </div>
  );
}
