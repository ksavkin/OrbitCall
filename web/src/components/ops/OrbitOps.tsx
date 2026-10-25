"use client";

import { AnimatePresence, motion } from "motion/react";
import { ListChecks, Radar, RotateCw } from "lucide-react";
import { fmtAge, fmtObjectId } from "@/lib/backend/format";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { FleetMine, ScanRun } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";
import { OWNER_FLAGS } from "@/lib/owners";
import { useOrbit } from "@/lib/store";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { useFleet, useMe } from "@/components/auth/session";
import { KIND_COLOR, KIND_LABEL } from "@/components/auth/SatGlyph";
import { retryQueueSync, useFleetAccount, useQueueSync } from "@/components/live/sync/QueueSync";
import { Flag } from "@/components/ui/OwnerBadge";
import { MyIncidents } from "./BackendQueue";
import { ScanButton } from "./DemoFlow";

// Orbit's working block, top left: my fleet, Run Scan, and the way back to the last results. The case
// itself runs on the globe with the agents on the right; the Decision Center opens when a decision is due.
// Real mode with a provisioned account: the server's fleet (fleetQuery.listMine) and, below it, My Incidents.

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
  const real = useRealMode();
  const account = useFleetAccount();
  // a provisioned operator or head of ops in real mode: the server's fleet and their own queue
  const live = real && account !== null;
  return (
    <>
      <FleetPanel live={live} />
      <AnimatePresence>{live && <MyIncidents key="incidents" />}</AnimatePresence>
    </>
  );
}

function FleetPanel({ live }: { live: boolean }) {
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
      {live ? (
        <LiveFleet now={now} expected={me?.assignedObjectIds.length ?? 0} />
      ) : me && fleet.length > 0 ? (
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

/** Real mode: the satellites the server holds this account responsible for (fleetQuery.listMine, via QueueSync). */
function LiveFleet({ now, expected }: { now: number; expected: number }) {
  const fleet = useLive((s) => s.fleet);
  const scan = useLive((s) => s.scan);
  const error = useQueueSync((s) => s.errors.fleet);
  if (error) {
    return (
      <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted">
        {error.message}
        {error.code !== "FORBIDDEN" && (
          <button
            className="ml-1.5 inline-flex items-center gap-1 text-fg-2 hover:text-white"
            onClick={() => {
              sfx.click();
              retryQueueSync();
            }}
          >
            <RotateCw size={10} /> Retry
          </button>
        )}
      </p>
    );
  }
  if (!fleet) {
    // one placeholder per assigned satellite, each the height of a loaded row, so nothing jumps when they arrive
    return (
      <ul className="mt-2 space-y-0.5" role="status" aria-label="Loading your fleet">
        {Array.from({ length: Math.min(Math.max(expected, 1), 6) }, (_, i) => (
          <li key={i} className="flex animate-pulse items-center gap-2 px-1.5 py-1" style={{ animationDelay: `${i * 120}ms` }}>
            <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-white/[0.07]" />
            <span className="min-w-0 flex-1">
              <span className="flex h-[18px] items-center">
                <span className="h-2.5 w-28 rounded bg-white/[0.07]" />
              </span>
              <span className="mt-px flex h-[15px] items-center">
                <span className="h-2 w-20 rounded bg-white/[0.05]" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (fleet.satellites.length === 0) {
    return <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted">No satellites are assigned to this account yet.</p>;
  }
  return (
    <ul className="mt-2 space-y-0.5">
      {fleet.satellites.map((sat) => (
        <FleetRow key={sat.object.objectId} sat={sat} scan={scan} now={now} />
      ))}
    </ul>
  );
}

/**
 * Last screening coverage of one satellite. listMine always says "not_scanned" (it predates scan runs), so the
 * caller's latest scan (scans.getMine, in useLive) speaks for the satellites it covered.
 */
function coverageText(objectId: string, scan: ScanRun | null | undefined, now: number): string {
  if (!scan?.primaryObjectIds.includes(objectId)) return "Not scanned";
  if (scan.status === "failed") return "Last scan failed";
  if (scan.status !== "completed") return "Scanning…";
  if (scan.coverage.missingPrimaryIds.includes(objectId)) return "Not screened";
  return scan.finishedAt && now ? `Scanned ${fmtAge(now - scan.finishedAt)}` : "Scanned";
}

/** One assigned satellite: name, catalog id and owner, open incidents, last scan. No position: listMine has none. */
function FleetRow({ sat, scan, now }: { sat: FleetMine["satellites"][number]; scan: ScanRun | null | undefined; now: number }) {
  const { object, unresolvedIncidentCount: open } = sat;
  const flag = object.country ? (OWNER_FLAGS[object.country]?.[0] ?? null) : null;
  const owner = [object.ownerName, object.country].filter(Boolean).join(" · ") || "owner unknown";
  return (
    <li>
      <button
        className="flex w-full items-center gap-2 rounded-[7px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.05]"
        title={`${object.name} · click to show it on the globe`}
        onClick={() => showSatellite(/^\d+$/.test(object.objectId) ? Number(object.objectId) : null)}
      >
        {/* orange while it is a party to an unresolved incident */}
        <span className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: open > 0 ? "var(--orange)" : "#737373" }} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {flag && <Flag code={flag} h={9} />}
            <span className="truncate text-[12px] text-fg-2">{object.name}</span>
            {object.simulated && <span className="mono shrink-0 text-[8.5px] uppercase tracking-[0.1em] text-orange">sim</span>}
          </span>
          <span className="mt-px flex min-w-0 items-center gap-1 text-[10px] text-muted">
            <span className="mono shrink-0">{fmtObjectId(object.objectId)}</span>
            <span className="shrink-0 text-faint">·</span>
            <span className="truncate">{owner}</span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className={`mono tnum text-[10.5px] ${open > 0 ? "text-fg-2" : "text-muted"}`}>{open} open</span>
          <span className="text-[9.5px] text-faint">{coverageText(object.objectId, scan, now)}</span>
        </span>
      </button>
    </li>
  );
}
