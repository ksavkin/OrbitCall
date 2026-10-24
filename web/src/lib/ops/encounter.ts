import { eciToGeodetic, gstime, propagate, type SatRec } from "satellite.js";
import { satrecOf, type Elements } from "@/lib/orbit/elements";
import { EARTH_RADIUS_KM, MU_EARTH } from "@/lib/orbit/constants";

// Synthetic encounters with a real satellite. Object A is a live catalog object (SGP4);
// object B is synthetic: placed at A's TCA position plus the miss vector, with A's velocity
// turned about the local vertical by the crossing angle, then flown with two-body Kepler.
// Both really pass within `missM` of each other at TCA, so the globe shows a true geometry.

export type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3) => mul(a, 1 / (len(a) || 1));

/** Rodrigues rotation of v about unit axis k. */
function rotate(v: V3, k: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

function stumpff(z: number) {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return { C: (1 - Math.cos(s)) / z, S: (s - Math.sin(s)) / (s * s * s) };
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return { C: (Math.cosh(s) - 1) / -z, S: (Math.sinh(s) - s) / (s * s * s) };
  }
  return { C: 1 / 2, S: 1 / 6 };
}

/** Universal-variable Kepler propagation (Curtis, Alg. 3.3/3.4). Units: km, s. */
export function kepler(r0: V3, v0: V3, dt: number): { r: V3; v: V3 } {
  const mu = MU_EARTH;
  const sm = Math.sqrt(mu);
  const ro = len(r0);
  const vr0 = dot(r0, v0) / ro;
  const alpha = 2 / ro - dot(v0, v0) / mu; // 1/a
  // fold whole revolutions away so Newton starts close
  if (alpha > 0) {
    const T = 2 * Math.PI * Math.sqrt(1 / (alpha * alpha * alpha) / mu);
    dt = ((dt % T) + T) % T;
    if (dt > T / 2) dt -= T;
  }
  let x = sm * Math.abs(alpha) * dt;
  for (let k = 0; k < 40; k++) {
    const z = alpha * x * x;
    const { C, S } = stumpff(z);
    const F = ((ro * vr0) / sm) * x * x * C + (1 - alpha * ro) * x * x * x * S + ro * x - sm * dt;
    const dF = ((ro * vr0) / sm) * x * (1 - alpha * x * x * S) + (1 - alpha * ro) * x * x * C + ro;
    const step = F / dF;
    x -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  const z = alpha * x * x;
  const { C, S } = stumpff(z);
  const f = 1 - ((x * x) / ro) * C;
  const g = dt - (x * x * x * S) / sm;
  const r = add(mul(r0, f), mul(v0, g));
  const rm = len(r);
  const fd = (sm / (rm * ro)) * (alpha * x * x * x * S - x);
  const gd = 1 - ((x * x) / rm) * C;
  return { r, v: add(mul(r0, fd), mul(v0, gd)) };
}

export interface Encounter {
  tca: number;
  /** A's state at TCA (TEME km, km/s). */
  rA: V3;
  vA: V3;
  /** B's state at TCA. */
  rB: V3;
  vB: V3;
  missM: number;
  radialM: number;
  relVelKms: number;
  crossDeg: number;
  periodB: number; // s
  where: { lat: number; lon: number; altKm: number };
  satrec: SatRec;
}

export function buildEncounter(
  elements: Elements,
  tca: number,
  opts: { missM: number; crossDeg: number; radialShare?: number },
): Encounter | null {
  const satrec = satrecOf(elements);
  const pv = propagate(satrec, new Date(tca));
  if (!pv?.position || !pv.velocity || !Number.isFinite(pv.position.x)) return null;
  const rA: V3 = [pv.position.x, pv.position.y, pv.position.z];
  const vA: V3 = [pv.velocity.x, pv.velocity.y, pv.velocity.z];
  const up = unit(rA);
  const vB = rotate(vA, up, (opts.crossDeg * Math.PI) / 180);
  const rel = unit(sub(vB, vA));
  // miss vector perpendicular to the relative velocity: TCA is exactly here
  const e1 = unit(sub(up, mul(rel, dot(up, rel))));
  const e2 = cross(rel, e1);
  const share = opts.radialShare ?? 0.35;
  const phi = Math.acos(Math.min(Math.max(share, -1), 1));
  const missKm = opts.missM / 1000;
  const m = add(mul(e1, Math.cos(phi) * missKm), mul(e2, Math.sin(phi) * missKm));
  const rB = add(rA, m);
  const alpha = 2 / len(rB) - dot(vB, vB) / MU_EARTH;
  const geo = eciToGeodetic({ x: rA[0], y: rA[1], z: rA[2] }, gstime(new Date(tca)));
  return {
    tca,
    rA,
    vA,
    rB,
    vB,
    missM: opts.missM,
    radialM: opts.missM * Math.cos(phi),
    relVelKms: len(sub(vB, vA)),
    crossDeg: opts.crossDeg,
    periodB: 2 * Math.PI * Math.sqrt(1 / (alpha * alpha * alpha) / MU_EARTH),
    where: { lat: (geo.latitude * 180) / Math.PI, lon: (geo.longitude * 180) / Math.PI, altKm: geo.height },
    satrec,
  };
}

/** B's TEME position at time t (ms). */
export function posB(enc: Encounter, t: number): V3 {
  return kepler(enc.rB, enc.vB, (t - enc.tca) / 1000).r;
}

/** A's TEME position at time t from SGP4. */
export function posA(enc: Encounter, t: number): V3 | null {
  const pv = propagate(enc.satrec, new Date(t));
  const p = pv?.position;
  return p && Number.isFinite(p.x) ? [p.x, p.y, p.z] : null;
}

/** TEME km → scene units (three.js frame, Earth radii). */
export function toScene(p: V3, out: { set: (x: number, y: number, z: number) => unknown }) {
  out.set(p[0] / EARTH_RADIUS_KM, p[2] / EARTH_RADIUS_KM, -p[1] / EARTH_RADIUS_KM);
  return out;
}

/** Points along one revolution centered on TCA, scene units. */
export function orbitPath(enc: Encounter, which: "a" | "b", steps = 360): Float32Array {
  const periodS = which === "b" ? enc.periodB : (2 * Math.PI) / enc.satrec.no / (1 / 60);
  const out = new Float32Array((steps + 1) * 3);
  const R = EARTH_RADIUS_KM;
  for (let s = 0; s <= steps; s++) {
    const t = enc.tca + ((s / steps - 0.5) * periodS * 0.995) * 1000;
    const p = which === "a" ? posA(enc, t) : posB(enc, t);
    if (!p) continue;
    out[s * 3] = p[0] / R;
    out[s * 3 + 1] = p[2] / R;
    out[s * 3 + 2] = -p[1] / R;
  }
  return out;
}

/** Actual closest approach found by sampling around TCA (validates the construction). */
export function measureMiss(enc: Encounter) {
  let best = Infinity;
  let bestT = enc.tca;
  for (let dt = -2000; dt <= 2000; dt += 5) {
    const t = enc.tca + dt;
    const a = posA(enc, t);
    if (!a) continue;
    const d = len(sub(a, posB(enc, t)));
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  return { missM: best * 1000, tcaOffsetMs: bestT - enc.tca };
}
