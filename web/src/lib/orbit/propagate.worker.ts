/// <reference lib="webworker" />
// SGP4 propagation off the main thread. Output is in scene units:
// 1 unit = 1 Earth radius, axes remapped from TEME (x, y, z) to three.js (x, z, -y).

import { propagate, type SatRec } from "satellite.js";
import { EARTH_RADIUS_KM } from "./constants";
import { satrecOf, type Elements } from "./elements";

type InMsg =
  | { type: "init"; elements: Elements[] }
  | { type: "sample"; id: number; time: number }
  | { type: "path"; id: number; index: number; time: number; steps: number; span?: number };

let recs: (SatRec | null)[] = [];

const R = EARTH_RADIUS_KM;

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    recs = msg.elements.map((el) => {
      try {
        const r = satrecOf(el);
        return r.error ? null : r;
      } catch {
        return null;
      }
    });
    self.postMessage({ type: "ready", count: recs.length, failed: recs.filter((r) => !r).length });
    return;
  }

  if (msg.type === "sample") {
    const n = recs.length;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const date = new Date(msg.time);
    const t0 = performance.now();
    let invalid = 0;
    for (let i = 0; i < n; i++) {
      const rec = recs[i];
      const pv = rec ? propagate(rec, date) : null;
      const p = pv?.position;
      const v = pv?.velocity;
      if (!p || !v || !Number.isFinite(p.x)) {
        // Decayed or failed element set: park it at the origin, the shader hides it.
        invalid++;
        continue;
      }
      const o = i * 3;
      pos[o] = p.x / R;
      pos[o + 1] = p.z / R;
      pos[o + 2] = -p.y / R;
      vel[o] = v.x / R;
      vel[o + 1] = v.z / R;
      vel[o + 2] = -v.y / R;
    }
    (self as unknown as Worker).postMessage(
      { type: "sample", id: msg.id, time: msg.time, pos, vel, invalid, ms: performance.now() - t0 },
      [pos.buffer, vel.buffer],
    );
    return;
  }

  if (msg.type === "path") {
    const rec = recs[msg.index];
    if (!rec) {
      self.postMessage({ type: "path", id: msg.id, index: msg.index, points: null });
      return;
    }
    // One full revolution by default (rec.no is mean motion in rad/min).
    const periodMs = ((2 * Math.PI) / rec.no) * 60_000;
    const span = msg.span ?? periodMs;
    const steps = msg.steps;
    const points = new Float32Array((steps + 1) * 3);
    const alts = new Float32Array(steps + 1);
    const start = msg.time;
    for (let s = 0; s <= steps; s++) {
      const t = start + (s / steps) * span;
      const pv = propagate(rec, new Date(t));
      const p = pv?.position;
      if (!p) continue;
      points[s * 3] = p.x / R;
      points[s * 3 + 1] = p.z / R;
      points[s * 3 + 2] = -p.y / R;
      alts[s] = Math.hypot(p.x, p.y, p.z) - R;
    }
    (self as unknown as Worker).postMessage(
      { type: "path", id: msg.id, index: msg.index, start, span, periodMs, points, alts },
      [points.buffer, alts.buffer],
    );
  }
};

// The bundler bootstraps workers asynchronously; announce readiness so the
// main thread doesn't post into the void before onmessage exists.
self.postMessage({ type: "boot" });
