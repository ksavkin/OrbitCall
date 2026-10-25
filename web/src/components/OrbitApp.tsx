"use client";

import { AnimatePresence } from "motion/react";
import { useEffect } from "react";
import { Globe } from "@/components/globe/Globe";
import { VIEW_MODES } from "@/components/globe/shaders";
import { BootScreen } from "@/components/ui/BootScreen";
import { CatalogPanel } from "@/components/ui/CatalogPanel";
import { Footer } from "@/components/ui/Footer";
import { MapControls } from "@/components/ui/MapControls";
import { Navbar } from "@/components/ui/Navbar";
import { SatellitePanel } from "@/components/ui/SatellitePanel";
import { SearchPalette } from "@/components/ui/SearchPalette";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { WeatherSync } from "@/components/globe/WeatherSync";
import { StormLabels, WeatherCard } from "@/components/ui/Weather";
import { toggleDev } from "@/components/ui/Navbar";
import { AgentsExpanded, AgentsPanel } from "@/components/ops/AgentsPanel";
import { BackendSync } from "@/components/ops/BackendSync";
import { RealModeStatus } from "@/components/ops/RealModeStatus";
import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { ConjunctionMarkers } from "@/components/ops/ConjunctionMarkers";
import { OrbitOps } from "@/components/ops/OrbitOps";
import { OpsSync } from "@/components/ops/OpsSync";
import { Director } from "@/components/ops/Director";
import { ScanResults, UrgencyOverlay } from "@/components/ops/DemoFlow";
import { DecisionDock } from "@/components/ops/DecisionDock";
import { ResolutionCue } from "@/components/ops/Resolution";
import { IncidentView, setIncidentView } from "@/components/ops/IncidentView";
import { RoomsScreen } from "@/components/rooms/RoomsScreen";
import { PolicyScreen } from "@/components/policy/PolicyScreen";
import { AuditScreen } from "@/components/audit/AuditScreen";
import { ObserverFeed } from "@/components/observer/feed";
import { ProfileSheet } from "@/components/auth/ProfileSheet";
import { ScenarioBar } from "@/components/ops/ScenarioBar";
import { useLocalhost } from "@/lib/localhost";
import { useOps } from "@/lib/ops/store";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";

const SOUND_KEY = "orbitcall.sound";

export function OrbitApp() {
  useGlobalInteractions();
  useShortcuts();
  useDeployedRealMode();

  const tab = useOps((s) => s.tab);
  const dev = useOps((s) => s.dev);
  const orbit = tab === "orbit";
  // a case is running: Orbit shows the agents on the right instead of the satellite panel
  const caseLive = useOps((s) => !!s.incident && s.resolved?.eventId !== s.incident);

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-black select-none">
      <Globe dev={dev} />
      {/* edge vignette keeps the chrome legible over bright imagery */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/50 to-transparent" />
      <WeatherSync />
      <OpsSync />
      <ObserverFeed />
      <ProfileSheet />
      <Director />
      {/* backend half of the Dev Switch: only with a Convex client, and never in synthetic mode */}
      {!dev && CONVEX_ENABLED && <BackendSync />}
      {!dev && <RealModeStatus />}
      <StormLabels />
      <ConjunctionMarkers />
      <Navbar />
      {/* left column: per-screen panels share the height */}
      <div className="pointer-events-none absolute bottom-[112px] left-2.5 top-[58px] z-20 flex w-[264px] flex-col gap-2">
        {orbit && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <OrbitOps />
            <CatalogPanel />
            <WeatherCard />
          </div>
        )}
      </div>
      {orbit && !caseLive && <SatellitePanel />}
      <AnimatePresence>{orbit && caseLive && <AgentsPanel key="agents" />}</AnimatePresence>
      {/* Decision Center without a running case: the rooms list (the sample call in Dev) */}
      <AnimatePresence>{tab === "decision" && !caseLive && <RoomsScreen key="rooms" />}</AnimatePresence>
      <AnimatePresence>{tab === "policy" && <PolicyScreen key="policy" />}</AnimatePresence>
      <AnimatePresence>{tab === "audit" && <AuditScreen key="audit" />}</AnimatePresence>
      <AnimatePresence>{orbit && dev && <ScenarioBar key="scenario" />}</AnimatePresence>
      <DecisionDock />
      <IncidentView />
      <UrgencyOverlay />
      <ScanResults />
      <ResolutionCue />
      <AgentsExpanded />
      <ViewSwitcher />
      <MapControls />
      <Footer />
      <SearchPalette />
      <BootScreen />
    </main>
  );
}

/** Deployed hosts have no Dev switch and never run the local simulator. */
function useDeployedRealMode() {
  const local = useLocalhost();
  useEffect(() => {
    if (local === false && useOps.getState().dev) useOps.getState().set({ dev: false });
  }, [local]);
}

/** Cursor spotlight on glass, hover/click ticks on controls, sound preference. */
function useGlobalInteractions() {
  const soundOn = useOrbit((s) => s.soundOn);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SOUND_KEY);
      if (v !== null) useOrbit.getState().set({ soundOn: v === "1" });
    } catch {}
  }, []);

  useEffect(() => {
    sfx.setEnabled(soundOn);
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? "1" : "0");
    } catch {}
  }, [soundOn]);

  useEffect(() => {
    let lastGlass: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      const g = (e.target as HTMLElement | null)?.closest?.(".glass") as HTMLElement | null;
      if (lastGlass && lastGlass !== g) {
        lastGlass.style.setProperty("--mx", "-400px");
        lastGlass.style.setProperty("--my", "-400px");
      }
      lastGlass = g;
      if (!g) return;
      const r = g.getBoundingClientRect();
      g.style.setProperty("--mx", `${e.clientX - r.left}px`);
      g.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    let lastBtn: Element | null = null;
    const over = (e: PointerEvent) => {
      const b = (e.target as HTMLElement | null)?.closest?.(".btn, .icon-btn");
      if (b && b !== lastBtn) sfx.hover();
      lastBtn = b ?? null;
    };
    const down = (e: PointerEvent) => {
      sfx.unlock();
      const b = (e.target as HTMLElement | null)?.closest?.(".icon-btn, .btn");
      if (b && !b.closest("[data-silent]")) sfx.click();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", down);
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useOrbit.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.set({ searchOpen: !s.searchOpen });
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || s.searchOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const scene = sceneRef.get();
      const k = e.key.toLowerCase();
      if (k === "escape") {
        const ops = useOps.getState();
        if (ops.agentsExpanded) ops.set({ agentsExpanded: false });
        else if (ops.incident && ops.tab === "decision") setIncidentView("collapsed");
        else if (s.following) s.set({ following: false });
        else if (ops.tab === "orbit" && ops.focusEvent && !ops.incident) ops.set({ focusEvent: null });
        else s.set({ selected: null });
      } else if (k === "d") {
        toggleDev();
      } else if (k === "e" && useOps.getState().incident) {
        const ops = useOps.getState();
        setIncidentView(ops.tab === "decision" ? "collapsed" : "expanded");
      } else if (k === "p") {
        // Space is the call's push-to-talk, so pause has its own key
        sfx.toggle(s.paused);
        s.set({ paused: !s.paused });
      } else if (k === "f" && s.selected !== null) {
        sfx.whoosh();
        s.set({ following: !s.following });
      } else if (k === "g") {
        sfx.toggle(!s.showGroundTrack);
        s.set({ showGroundTrack: !s.showGroundTrack });
      } else if (k === "a") {
        sfx.toggle(!s.autoRotate);
        s.set({ autoRotate: !s.autoRotate });
      } else if (k === "m") {
        sfx.setEnabled(true);
        sfx.toggle(!s.soundOn);
        s.set({ soundOn: !s.soundOn });
      } else if (k === "r") {
        sfx.whoosh();
        s.set({ following: false });
        scene?.resetView();
      } else if (k === "=" || k === "+") scene?.zoomBy(0.7);
      else if (k === "-" || k === "_") scene?.zoomBy(1.45);
      else if (/^[1-5]$/.test(k)) {
        sfx.click();
        s.set({ viewMode: VIEW_MODES[Number(k) - 1] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
