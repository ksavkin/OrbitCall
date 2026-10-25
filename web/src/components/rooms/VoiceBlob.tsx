"use client";

import { useEffect, useRef, type RefObject } from "react";

// The room's voice: a sphere of dots that breathes when idle, swells with your voice (green) and with the
// translated voice of the other side (cool white). Canvas 2D, one animation frame loop, sized to its box.

const N = 900;

// points on a unit sphere (Fibonacci), fixed per mount
function sphere() {
  const pts = new Float32Array(N * 3);
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = g * i;
    pts[i * 3] = Math.cos(a) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(a) * r;
  }
  return pts;
}

export function VoiceBlob({ level, size = 340 }: { level: RefObject<{ me: number; them: number }>; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = size * dpr;
    el.height = size * dpr;
    g.scale(dpr, dpr);
    const pts = sphere();
    let raf = 0;
    let rot = 0;
    let energy = 0;
    let warm = 0; // 1 = me speaking, 0 = them / idle
    const draw = (now: number) => {
      const { me, them } = level.current ?? { me: 0, them: 0 };
      const e = Math.max(me, them);
      energy += (e - energy) * 0.18;
      const target = me > them + 0.05 ? 1 : them > me + 0.05 ? 0 : warm;
      warm += (target - warm) * 0.08;
      rot += 0.0035 + energy * 0.02;
      const t = now / 1000;
      const cx = size / 2;
      const cy = size / 2;
      // the sphere fills about 70 % of the canvas at rest and grows with the voice
      const R = size * 0.28 * (1 + Math.sin(t * 1.3) * 0.015 + energy * 0.12);
      g.clearRect(0, 0, size, size);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      // green for your voice, cool white for theirs and for idle
      const cr = Math.round(232 - warm * 171);
      const cg = Math.round(238 - warm * 18);
      const cb = Math.round(255 - warm * 104);
      for (let i = 0; i < N; i++) {
        const x0 = pts[i * 3];
        const y0 = pts[i * 3 + 1];
        const z0 = pts[i * 3 + 2];
        // rotate around y, tilt a little around x
        const x = x0 * cos + z0 * sin;
        const z1 = -x0 * sin + z0 * cos;
        const y = y0 * 0.96 - z1 * 0.28;
        const z = y0 * 0.28 + z1 * 0.96;
        // the surface ripples with the voice: a few travelling waves over the sphere
        const wave = Math.sin(y0 * 6 + t * 3.1) * Math.cos(x0 * 5 - t * 2.3) + Math.sin(z0 * 7 + t * 4.2) * 0.6;
        const r = R * (1 + energy * 0.22 * wave + 0.012 * Math.sin(t * 2 + i));
        const persp = 1.3 / (1.9 - z * 0.55) / 0.74; // 1.3 at the front, about 0.72 at the back
        const px = cx + x * r * persp;
        const py = cy + y * r * persp;
        const depth = (z + 1) / 2; // 0 back, 1 front
        const a = 0.08 + depth * (0.55 + energy * 0.35);
        const s = 0.5 + depth * (1.05 + energy * 0.7);
        g.fillStyle = `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;
        g.fillRect(px - s / 2, py - s / 2, s, s);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level, size]);

  return <canvas ref={canvas} style={{ width: size, height: size }} aria-hidden className="pointer-events-none select-none" />;
}
