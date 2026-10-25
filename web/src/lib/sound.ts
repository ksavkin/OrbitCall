"use client";

// Small synthesized UI sounds (Web Audio, no assets). Quiet by design.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let lastHover = 0;

function audio() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; to?: number; delay?: number } = {}) {
  const a = audio();
  if (!a || !master || !enabled) return;
  const t0 = a.currentTime + (opts.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.3, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, from: number, to: number, gain = 0.25) {
  const a = audio();
  if (!a || !master || !enabled) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 1.4;
  const t0 = a.currentTime;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
}

/** Two-tone siren: a wailing sweep plus a low pulse, filtered so it alarms without hurting. */
function siren(cycles: number, period: number) {
  const a = audio();
  if (!a || !master || !enabled) return;
  const t0 = a.currentTime;
  const total = cycles * period;
  const osc = a.createOscillator();
  osc.type = "sawtooth";
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2400;
  const g = a.createGain();
  for (let i = 0; i < cycles; i++) {
    const t = t0 + i * period;
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(1180, t + period * 0.5);
    osc.frequency.exponentialRampToValueAtTime(620, t + period);
  }
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.13, t0 + 0.06);
  g.gain.setValueAtTime(0.13, t0 + total - 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + total);
  osc.connect(lp).connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + total + 0.05);
  // low pulse under it so it reads as an alarm, not a whistle
  for (let i = 0; i < cycles * 2; i++) tone(110, 0.18, { type: "square", gain: 0.12, delay: i * (period / 2) });
}

export const sfx = {
  setEnabled(v: boolean) {
    enabled = v;
  },
  /** Very short tick for hovering controls and satellites. */
  hover() {
    const now = performance.now();
    if (now - lastHover < 45) return;
    lastHover = now;
    tone(2400, 0.035, { gain: 0.06, type: "sine" });
  },
  click() {
    tone(880, 0.06, { gain: 0.16, type: "triangle" });
    tone(1320, 0.05, { gain: 0.08, delay: 0.025 });
  },
  toggle(on: boolean) {
    tone(on ? 660 : 990, 0.07, { gain: 0.14, type: "triangle", to: on ? 990 : 660 });
  },
  /** Lock-on chirp when a satellite is selected. */
  select() {
    tone(520, 0.09, { gain: 0.14, type: "sine", to: 1040 });
    tone(1560, 0.12, { gain: 0.07, delay: 0.07 });
  },
  whoosh() {
    noise(0.55, 300, 2400, 0.14);
  },
  open() {
    tone(420, 0.12, { gain: 0.1, to: 640 });
  },
  close() {
    tone(640, 0.1, { gain: 0.08, to: 420 });
  },
  /** Two-tone alert when an event turns red. */
  alert() {
    tone(880, 0.12, { gain: 0.12, type: "triangle" });
    tone(660, 0.16, { gain: 0.1, type: "triangle", delay: 0.13 });
  },
  /** Soft rising chime when a proposal is ready or a step completes. */
  chime() {
    tone(784, 0.18, { gain: 0.08 });
    tone(1175, 0.24, { gain: 0.06, delay: 0.08 });
  },
  /** High-priority alarm: siren wail with a low pulse, then the console beeps. */
  siren() {
    siren(3, 0.9);
    for (let i = 0; i < 3; i++) {
      tone(988, 0.13, { gain: 0.14, type: "square", delay: 2.8 + i * 0.42 });
      tone(740, 0.16, { gain: 0.12, type: "square", delay: 2.8 + i * 0.42 + 0.15 });
    }
  },
  /** Calm attention cue: two soft rising notes, for results that need a look. */
  notice() {
    tone(659.25, 0.32, { gain: 0.09 });
    tone(987.77, 0.42, { gain: 0.08, delay: 0.16 });
  },
  /** Incident closed: a rising major chord. */
  resolved() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.9 - i * 0.12, { gain: 0.1, delay: i * 0.11 }));
    tone(1568, 1.1, { gain: 0.035, delay: 0.45 });
  },
  /** Urgent but not shrill: three falling two-tone pairs, like an ops console. */
  alarm() {
    for (let i = 0; i < 3; i++) {
      tone(988, 0.13, { gain: 0.16, type: "square", delay: i * 0.42 });
      tone(740, 0.16, { gain: 0.14, type: "square", delay: i * 0.42 + 0.15 });
    }
  },
  /** Sonar-like ping when a scan starts. */
  ping() {
    tone(1320, 0.5, { gain: 0.09, to: 990 });
    tone(2640, 0.25, { gain: 0.03, delay: 0.02 });
  },
  /** Barely audible tick for streamed agent steps. */
  tick() {
    tone(3200, 0.02, { gain: 0.025 });
  },
  /** Unlocks the AudioContext on the first gesture. */
  unlock() {
    audio();
  },
};
