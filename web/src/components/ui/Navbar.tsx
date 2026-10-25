"use client";

import { motion } from "motion/react";
import { Search, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";
import { fmtUtc } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { useOrbit } from "@/lib/store";
import { useOps, type Tab } from "@/lib/ops/store";
import { isLocalHost, useLocalhost } from "@/lib/localhost";
import { isSmokeDemo } from "@/lib/ops/smoke";
import { LogoMark } from "./Logo";
import { Tooltip } from "./Tooltip";

const NAV: { id: Tab; label: string; ready: boolean }[] = [
  { id: "orbit", label: "Orbit", ready: true },
  { id: "decision", label: "Decision Center", ready: true },
  { id: "policy", label: "Policy", ready: true },
  { id: "audit", label: "Inbox", ready: true },
];

export function Navbar() {
  const soundOn = useOrbit((s) => s.soundOn);
  const set = useOrbit((s) => s.set);
  const source = useOrbit((s) => s.catalog?.meta.source);
  const tab = useOps((s) => s.tab);
  // dev on: synthetic scenarios; dev off: red rows of the backend queue
  const redCount = useOps((s) =>
    s.dev
      ? s.events.filter((e) => e.risk === "red" && !["verified", "scheduled", "no_action"].includes(e.status)).length
      : (s.backendRows ?? []).filter((r) => r.color === "red").length,
  );

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 p-2.5">
      {/* brand + sections */}
      <div className="glass pointer-events-auto relative flex h-10 items-center gap-1 rounded-[13px] pl-3 pr-1">
        <div className="mr-2 flex items-center gap-2">
          <LogoMark size={17} />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">OrbitCall</span>
          <span className="rounded-[5px] border border-white/10 px-1 py-px text-[9px] font-medium uppercase tracking-[0.12em] text-muted">
            Ops
          </span>
        </div>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <nav className="flex items-center gap-0.5">
          {NAV.map((n) =>
            n.ready ? (
              <button
                key={n.id}
                className="btn relative"
                data-active={tab === n.id}
                onClick={() => {
                  if (tab === n.id) return;
                  sfx.click();
                  useOps.getState().set({ tab: n.id });
                }}
              >
                {tab === n.id && (
                  <motion.span layoutId="nav-pill" className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                )}
                <span className="relative">{n.label}</span>
                {n.id === "decision" && redCount > 0 && (
                  <span className="relative ml-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-red px-1 text-[9.5px] font-semibold text-black">
                    {redCount}
                  </span>
                )}
              </button>
            ) : (
              <Tooltip key={n.id} label="Next screen in the build">
                <button className="btn text-muted" aria-disabled>
                  {n.label}
                </button>
              </Tooltip>
            ),
          )}
        </nav>
      </div>

      {/* utilities */}
      <div className="glass pointer-events-auto relative flex h-10 items-center gap-1 rounded-[13px] px-1">
        <button
          className="group flex h-7 w-[232px] items-center gap-2 rounded-[9px] bg-white/[0.035] pl-2.5 pr-1 text-left text-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors hover:bg-white/[0.06] hover:text-fg-2"
          onClick={() => set({ searchOpen: true })}
        >
          <Search size={13} strokeWidth={2} />
          <span className="text-[11.5px]">Search name, NORAD, COSPAR</span>
          <span className="kbd ml-auto">⌘K</span>
        </button>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <DevSwitch />
        <SourcePill source={source} />
        <UtcClock />
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <AccountMenu />
        <Tooltip label={soundOn ? "Mute sounds" : "Enable sounds"} hint="M">
          <button
            className="icon-btn"
            data-active={soundOn}
            onClick={() => {
              const v = !soundOn;
              sfx.setEnabled(true);
              sfx.toggle(v);
              sfx.setEnabled(v);
              set({ soundOn: v });
            }}
            aria-label="Toggle sound"
          >
            {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

/** Dev mode on localhost only. Hidden on deploy and during the product recording. */
function DevSwitch() {
  const local = useLocalhost();
  const dev = useOps((s) => s.dev);
  if (isSmokeDemo() || local !== true) return null;
  return (
    <Tooltip
      label={
        dev ? (
          <span>
            Synthetic scenarios over the TLE catalog. <span className="text-muted">Click to use the real OMM mode.</span>
          </span>
        ) : (
          "Real mode requires backend OMM. Click for the TLE catalog and synthetic scenarios."
        )
      }
      hint="D"
    >
      <button
        className="group relative flex h-6 items-center gap-1.5 rounded-full pl-1 pr-2 text-[11px] font-medium transition-colors"
        style={{
          color: dev ? "var(--orange)" : "var(--muted)",
          background: dev ? "rgba(255,159,64,0.1)" : "rgba(255,255,255,0.03)",
          boxShadow: `inset 0 0 0 1px ${dev ? "rgba(255,159,64,0.22)" : "rgba(255,255,255,0.07)"}`,
        }}
        onClick={() => toggleDev()}
        aria-pressed={dev}
        aria-label="Toggle dev mode"
      >
        <span
          className="relative h-[14px] w-[24px] rounded-full transition-colors duration-200"
          style={{ background: dev ? "rgba(255,159,64,0.85)" : "rgba(255,255,255,0.12)" }}
        >
          <motion.span
            className="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
            animate={{ left: dev ? 12 : 2 }}
            transition={{ type: "spring", stiffness: 700, damping: 34 }}
          />
        </span>
        Dev
      </button>
    </Tooltip>
  );
}

export function toggleDev() {
  if (!isLocalHost() && !isSmokeDemo()) return;
  const s = useOps.getState();
  const v = !s.dev;
  sfx.toggle(v);
  s.set({ dev: v });
}

function SourcePill({ source }: { source?: string }) {
  if (!source) {
    return (
      <span className="flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40" />
        Connecting
      </span>
    );
  }
  const live = source === "celestrak-live" || source === "celestrak-cache";
  const label =
    source === "celestrak-live" ? "Live · CelesTrak" : source === "celestrak-cache" ? "Live · cached" : source === "omm-snapshot" ? "OMM snapshot" : "Offline snapshot";
  return (
    <Tooltip
      label={
        live
          ? "Element sets from CelesTrak GP, refreshed at most every 2 h"
          : source === "omm-snapshot"
            ? "Pinned CelesTrak OMM element sets, the catalog the backend serves"
            : "CelesTrak unreachable, using the committed snapshot"
      }
    >
      <span
        className="flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium"
        style={{
          color: live ? "var(--green)" : "var(--orange)",
          background: live ? "rgba(61,220,151,0.09)" : "rgba(255,159,64,0.1)",
          boxShadow: `inset 0 0 0 1px ${live ? "rgba(61,220,151,0.16)" : "rgba(255,159,64,0.18)"}`,
        }}
      >
        <span className="pulse-dot" style={{ width: 5, height: 5 }} />
        {label}
      </span>
    </Tooltip>
  );
}

function UtcClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // first tick right away; null on the server avoids a hydration mismatch
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  const t = now ? fmtUtc(now) : null;
  return (
    <Tooltip label="Wall clock, UTC">
      <span className="mono tnum flex h-6 items-center px-2 text-[11px] text-fg-2">
        {t ? t.time : "--:--:--"}
        <span className="ml-1 text-muted">UTC</span>
      </span>
    </Tooltip>
  );
}
