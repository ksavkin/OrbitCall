"use client";

import { useEffect } from "react";
import type { ConjItem } from "@/components/globe/conjunctions";
import { useLive } from "@/lib/backend/live";
import { stopWatching, watchedCase } from "@/lib/backend/workflow";
import { engine } from "@/lib/ops/engine";
import { realEncounter } from "@/lib/ops/encounter";
import type { Catalog, SatObject } from "@/lib/catalog/client";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sceneRef } from "@/lib/sceneRef";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";

/** Screens over the globe that show cases on it: Orbit, and Decision Center behind its panel. */
const onGlobe = (t: string) => t === "orbit" || t === "decision";

const QUIET: ConjunctionEvent["status"][] = ["verified", "no_action", "monitoring"];

// NORAD → catalog object, rebuilt when the catalog changes
let indexFor: Catalog | null = null;
let byNorad = new Map<number, SatObject>();
function catalogObject(objectId: string): SatObject | null {
  const cat = useOrbit.getState().catalog;
  if (!cat) return null;
  if (indexFor !== cat) {
    byNorad = new Map(cat.objects.map((o) => [o.norad, o]));
    indexFor = cat;
  }
  const n = Number(objectId);
  return Number.isInteger(n) ? (byNorad.get(n) ?? null) : null;
}

/** The focused backend pair as a globe item, or null when either object is not in the loaded catalog. */
function backendItem(eventId: string | null): ConjItem | null {
  if (!eventId) return null;
  const row = useOps.getState().backendRows?.find((r) => r.eventId === eventId);
  if (!row) return null;
  const a = catalogObject(row.objectA.objectId);
  const b = catalogObject(row.objectB.objectId);
  const tca = Date.parse(row.tcaUtc);
  if (!a || !b || !Number.isFinite(tca)) return null;
  const enc = realEncounter(a.elements, b.elements, tca);
  if (!enc) return null;
  return { id: row.eventId, enc, risk: row.color === "red" ? "red" : "yellow", aIndex: a.index, quiet: false };
}

/**
 * Dev off: the case this screen ran the agents on moves from Orbit to the Decision Center when its first plans arrive
 * (the cards, or the room reporting the event at `proposal`). Once only, and only from Orbit: someone on another tab
 * or case by then is not pulled back later. Other operators' screens never move (wiring map §2.2).
 */
function followPlans() {
  const eventId = watchedCase();
  if (!eventId) return;
  const ops = useOps.getState();
  if (ops.dev || ops.incident !== eventId) return stopWatching();
  const live = useLive.getState();
  const ready = !!live.proposals?.length || !!live.room?.linkedEvents.some((e) => e.eventId === eventId && e.status === "proposal");
  if (!ready) return;
  stopWatching();
  if (ops.tab !== "orbit") return;
  sfx.whoosh();
  useOps.setState({ tab: "decision", incidentView: "expanded" });
}

/** Ops store → simulator and globe. Renders nothing. */
export function OpsSync() {
  useEffect(() => {
    const pushItems = () => {
      const scene = sceneRef.get();
      if (!scene) return;
      const ops = useOps.getState();
      // dev off: the focused real pair from the backend queue, built from both catalog element sets
      if (!ops.dev) {
        const item = onGlobe(ops.tab) ? backendItem(ops.focusEvent) : null;
        scene.conj.setItems(item ? [item] : []);
        return;
      }
      const items: ConjItem[] = [];
      for (const e of useOps.getState().events) {
        const enc = engine.encounters.get(e.id);
        if (!enc) continue;
        items.push({ id: e.id, enc, risk: e.risk, aIndex: e.a.catalogIndex, quiet: QUIET.includes(e.status) });
      }
      // only the conjunctions screen shows them on the globe
      scene.conj.setItems(onGlobe(useOps.getState().tab) ? items : []);
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
      // a decision for the person at this screen moves the case from Orbit to the Decision Center
      if (s.humans !== p.humans && s.incident && s.tab === "orbit") {
        const side = s.actAs ?? "a";
        const isNew = (h: { eventId: string; side: string }) => h.eventId === s.incident && h.side === side;
        if (s.humans.some(isNew) && !p.humans.some(isNew)) {
          sfx.whoosh();
          useOps.setState({ tab: "decision", incidentView: "expanded" });
        }
      }
      if (s.events !== p.events || s.tab !== p.tab || (!s.dev && (s.focusEvent !== p.focusEvent || s.backendRows !== p.backendRows))) pushItems();
      if (s.scanning !== p.scanning) sceneRef.get()?.conj.setScanning(s.scanning && onGlobe(s.tab));
      if (s.tab !== p.tab) {
        const scene = sceneRef.get();
        if (!onGlobe(s.tab)) {
          scene?.focusConjunction(null);
          scene?.releasePivot();
          scene?.endPreview();
          scene?.conj.setScanning(false);
        } else {
          scene?.conj.setScanning(s.scanning);
          if (s.focusEvent) scene?.focusConjunction(s.focusEvent, { fly: true });
        }
      }
      if (s.focusEvent !== p.focusEvent && onGlobe(s.tab)) {
        // a real pair zooms in closer: one crossing, not a whole scenario
        sceneRef.get()?.focusConjunction(s.focusEvent, { fly: s.focusEvent !== null, dist: s.dev ? undefined : 0.55 });
        if (s.focusEvent === null) sceneRef.get()?.releasePivot();
      }
      // sound cues for state changes the user should notice
      if (s.events !== p.events && onGlobe(s.tab)) {
        for (const e of s.events) {
          const before = p.events.find((x) => x.id === e.id);
          if (!before) continue;
          if (before.risk !== "red" && e.risk === "red") sfx.alert();
          if (before.status !== e.status && (e.status === "proposal" || e.status === "verified")) sfx.chime();
        }
      }
      // last: it may switch the tab, which runs this listener again
      followPlans();
    });
    const unsubLive = useLive.subscribe((s, p) => {
      if (s.proposals !== p.proposals || s.room !== p.room) followPlans();
    });
    const unsubCat = useOrbit.subscribe((s, p) => {
      if (s.catalog && !p.catalog) startIfReady();
    });
    engine.encounterListeners.add(pushItems);
    startIfReady();
    return () => {
      unsubOps();
      unsubLive();
      unsubCat();
      engine.encounterListeners.delete(pushItems);
    };
  }, []);
  return null;
}
