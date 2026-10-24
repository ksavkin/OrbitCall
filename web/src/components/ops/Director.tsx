"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Span } from "@/lib/ops/types";
import { sceneRef } from "@/lib/sceneRef";

// Cinematic camera: while agents work on the focused event, each stage of the
// pipeline gets its own shot. Wide during screening, the crossing when it turns red,
// the real satellite while A's side talks, the synthetic one for B, wide again for the
// catalog re-screen. The user's hand always wins: any drag or zoom pauses it.

type Shot =
  | { kind: "wide"; dist: number }
  | { kind: "tca"; dist: number }
  | { kind: "a"; dist: number }
  | { kind: "b"; dist: number };

const MIN_GAP = 3200; // ms between cuts, so shots read as shots
const HANDS_OFF = 9000; // ms the director waits after the user moves the camera

function shotFor(s: Span, e: ConjunctionEvent): Shot | null {
  if (s.agent === "monitor") {
    if (s.kind === "handoff") return { kind: "tca", dist: 1.1 };
    if (s.name === "screen_catalog") return { kind: "wide", dist: 4.4 };
    return null;
  }
  if (s.agent === "analyst") {
    if (s.kind === "http" && s.name.startsWith("GP element")) return { kind: "a", dist: 0.14 };
    if (s.name.startsWith("compute_conjunction")) return { kind: "tca", dist: 0.42 };
    if (s.kind === "llm") return { kind: "tca", dist: 0.8 };
    if (s.kind === "check") return { kind: "tca", dist: 0.32 };
    return null;
  }
  if (s.agent === "advocateA") return s.kind === "llm" || s.kind === "tool" ? { kind: "a", dist: 0.11 } : null;
  if (s.agent === "advocateB") return s.kind === "llm" || s.kind === "tool" ? { kind: e.b.kind === "debris" ? "tca" : "b", dist: 0.11 } : null;
  if (s.agent === "checker") return { kind: "tca", dist: 0.5 };
  if (s.agent === "host") return s.kind === "human" || s.name === "open_room" ? { kind: "tca", dist: 1.9 } : null;
  if (s.agent === "scheduler") return s.name.startsWith("rescreen") ? { kind: "wide", dist: 4.6 } : null;
  if (s.agent === "verifier") return s.kind === "http" ? { kind: "a", dist: 0.12 } : null;
  return null;
}

export function Director() {
  useEffect(() => {
    let lastCut = 0;
    let pending: { shot: Shot; event: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lastShot = { key: "" };

    const cut = (shot: Shot, eventId: string) => {
      const scene = sceneRef.get();
      const ops = useOps.getState();
      const e = ops.events.find((x) => x.id === eventId);
      if (!scene || !e) return;
      const key = `${shot.kind}:${shot.dist}:${eventId}`;
      if (key === lastShot.key) return;
      lastShot.key = key;
      lastCut = performance.now();
      const tca = scene.conj.tcaPoint(eventId) ?? new THREE.Vector3();
      if (shot.kind === "wide") {
        scene.shotWide(tca, shot.dist);
        scene.conj.setScanning(true);
      } else if (shot.kind === "tca") scene.focusConjunction(eventId, { fly: true, dist: shot.dist });
      else if (shot.kind === "a" && e.a.catalogIndex !== null) scene.shotObject(e.a.catalogIndex, shot.dist);
      else if (shot.kind === "b") scene.shotSynthetic(eventId, shot.dist);
      if (shot.kind !== "wide") scene.conj.setScanning(ops.scanning);
    };

    const flush = () => {
      timer = null;
      if (!pending) return;
      const p = pending;
      pending = null;
      cut(p.shot, p.event);
    };

    const unsub = useOps.subscribe((s, prev) => {
      // scan phases: pull back so the sweep and every candidate are in view
      if (s.scan.phase !== prev.scan.phase && s.cinematic && s.tab === "conjunctions") {
        const scene = sceneRef.get();
        if (scene && (s.scan.phase === "scanning" || s.scan.phase === "results")) {
          lastShot.key = "";
          lastCut = performance.now();
          scene.focusConjunction(null);
          scene.shotWide(null, s.scan.phase === "scanning" ? 4.8 : 4.2, 2600);
        }
      }
      if (s.spans === prev.spans || !s.cinematic || !s.dev || s.tab !== "conjunctions" || !s.focusEvent) return;
      const scene = sceneRef.get();
      if (!scene || performance.now() - scene.userCameraAt < HANDS_OFF) return;
      const e = s.events.find((x) => x.id === s.focusEvent);
      if (!e) return;
      // only spans that just started for the focused event
      const before = new Set(prev.spans.map((x) => x.id));
      let shot: Shot | null = null;
      for (const sp of s.spans) {
        if (before.has(sp.id)) continue;
        const forEvent = sp.eventId === e.id || (sp.eventId === null && sp.name === "screen_catalog" && e.status === "new");
        if (!forEvent) continue;
        shot = shotFor(sp, e) ?? shot;
      }
      if (!shot) return;
      pending = { shot, event: e.id };
      const wait = MIN_GAP - (performance.now() - lastCut);
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}
