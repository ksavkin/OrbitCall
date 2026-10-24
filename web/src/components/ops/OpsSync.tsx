"use client";

import { useEffect } from "react";
import type { ConjItem } from "@/components/globe/conjunctions";
import { engine } from "@/lib/ops/engine";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";

const QUIET: ConjunctionEvent["status"][] = ["verified", "no_action", "monitoring"];

/** Ops store → simulator and globe. Renders nothing. */
export function OpsSync() {
  useEffect(() => {
    const pushItems = () => {
      const scene = sceneRef.get();
      if (!scene) return;
      const items: ConjItem[] = [];
      for (const e of useOps.getState().events) {
        const enc = engine.encounters.get(e.id);
        if (!enc) continue;
        items.push({ id: e.id, enc, risk: e.risk, aIndex: e.a.catalogIndex, quiet: QUIET.includes(e.status) });
      }
      // only the conjunctions screen shows them on the globe
      scene.conj.setItems(useOps.getState().tab === "conjunctions" ? items : []);
    };

    const startIfReady = () => {
      const ops = useOps.getState();
      if (ops.dev && useOrbit.getState().catalog) engine.boot();
    };

    const unsubOps = useOps.subscribe((s, p) => {
      if (s.dev !== p.dev) {
        if (s.dev) startIfReady();
        else {
          engine.reset();
          engine.stop();
          sceneRef.get()?.releasePivot();
          sceneRef.get()?.endPreview();
        }
      }
      if (s.events !== p.events || s.tab !== p.tab) pushItems();
      if (s.scanning !== p.scanning) sceneRef.get()?.conj.setScanning(s.scanning && s.tab === "conjunctions");
      if (s.tab !== p.tab) {
        const scene = sceneRef.get();
        if (s.tab !== "conjunctions") {
          scene?.focusConjunction(null);
          scene?.releasePivot();
          scene?.endPreview();
          scene?.conj.setScanning(false);
        } else {
          scene?.conj.setScanning(s.scanning);
          if (s.focusEvent) scene?.focusConjunction(s.focusEvent, { fly: true });
        }
      }
      if (s.focusEvent !== p.focusEvent && s.tab === "conjunctions") {
        sceneRef.get()?.focusConjunction(s.focusEvent, { fly: s.focusEvent !== null });
        if (s.focusEvent === null) sceneRef.get()?.releasePivot();
      }
      // sound cues for state changes the user should notice
      if (s.events !== p.events && s.tab === "conjunctions") {
        for (const e of s.events) {
          const before = p.events.find((x) => x.id === e.id);
          if (!before) continue;
          if (before.risk !== "red" && e.risk === "red") sfx.alert();
          if (before.status !== e.status && (e.status === "proposal" || e.status === "verified")) sfx.chime();
        }
      }
    });
    const unsubCat = useOrbit.subscribe((s, p) => {
      if (s.catalog && !p.catalog) startIfReady();
    });
    engine.encounterListeners.add(pushItems);
    startIfReady();
    return () => {
      unsubOps();
      unsubCat();
      engine.encounterListeners.delete(pushItems);
    };
  }, []);
  return null;
}
