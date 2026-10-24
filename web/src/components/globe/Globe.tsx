"use client";

import { useEffect, useRef } from "react";
import { parseCatalog } from "@/lib/catalog/client";
import type { CatalogPayload } from "@/lib/catalog/types";
import { liveStats, sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { GlobeScene, type ScreenPoint } from "./GlobeScene";
import { HoverCard } from "@/components/ui/HoverCard";

export function Globe() {
  const host = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const store = useOrbit.getState();
    const place = (node: HTMLDivElement | null, p: ScreenPoint | null) => {
      if (!node) return;
      if (!p || !p.visible) {
        node.style.opacity = "0";
        return;
      }
      node.style.opacity = "1";
      node.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    };

    const scene = new GlobeScene(el, {
      onHover: (i) => {
        useOrbit.getState().set({ hovered: i });
        if (i !== null) sfx.hover();
      },
      onSelect: (i) => {
        const s = useOrbit.getState();
        s.set({ selected: i, following: i === null ? false : s.following });
        if (i !== null) sfx.select();
      },
      onTrack: (h, s) => {
        place(hoverRef.current, h);
        // The reticle frames tiny models; once the model itself is big it only gets in the way.
        place(selRef.current, scene.following ? null : s);
      },
      onCamera: (alt) => {
        liveStats.altKm = alt;
      },
      onCursor: (c) => {
        liveStats.cursor = c;
      },
      onStats: (s) => {
        liveStats.propagateMs = s.propagateMs;
        liveStats.invalid = s.invalid;
      },
      onReady: () => useOrbit.getState().set({ stage: "ready" }),
    });
    sceneRef.set(scene);
    if (process.env.NODE_ENV === "development") (window as unknown as { __scene: GlobeScene }).__scene = scene;
    scene.setViewMode(store.viewMode);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/catalog");
        if (!res.ok) throw new Error(`Catalog request failed (HTTP ${res.status})`);
        useOrbit.getState().set({ stage: "parse" });
        const payload = (await res.json()) as CatalogPayload;
        if (cancelled) return;
        const catalog = parseCatalog(payload);
        useOrbit.getState().set({ catalog, stage: "propagate" });
        scene.setCatalog(catalog);
        scene.setEnabled(useOrbit.getState().enabled);
      } catch (e) {
        useOrbit.getState().set({ stage: "error", error: (e as Error).message });
      }
    })();

    // store → scene
    const unsub = useOrbit.subscribe((s, prev) => {
      if (s.viewMode !== prev.viewMode) scene.setViewMode(s.viewMode);
      if (s.enabled !== prev.enabled) scene.setEnabled(s.enabled);
      if (s.selected !== prev.selected && s.selected !== scene.selected) scene.select(s.selected, { fly: true });
      if (s.following !== prev.following && s.following !== scene.following) scene.setFollow(s.following);
      if (s.speed !== prev.speed) scene.clock.setSpeed(s.speed);
      if (s.paused !== prev.paused) scene.clock.setPaused(s.paused);
      if (s.autoRotate !== prev.autoRotate) scene.setAutoRotate(s.autoRotate);
      if (s.showGroundTrack !== prev.showGroundTrack) scene.setShowGroundTrack(s.showGroundTrack);
    });

    return () => {
      cancelled = true;
      unsub();
      sceneRef.set(null);
      scene.dispose();
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div ref={selRef} className="reticle" style={{ opacity: 0 }}>
          <div className="reticle-ring" />
          <svg className="reticle-ticks" viewBox="0 0 40 40" fill="none">
            {[0, 90, 180, 270].map((a) => (
              <line
                key={a}
                x1="20"
                y1="1"
                x2="20"
                y2="5"
                stroke="white"
                strokeOpacity="0.8"
                strokeWidth="1.2"
                transform={`rotate(${a} 20 20)`}
              />
            ))}
          </svg>
        </div>
        <div ref={hoverRef} className="reticle" style={{ opacity: 0, transition: "opacity .15s" }}>
          <HoverCard />
        </div>
      </div>
    </div>
  );
}
