"use client";

import { useEffect, useRef } from "react";

// Loudness of the call for the voice blob, read every animation frame without re-rendering React.
//   me:   the microphone, measured on its own stream only while the talk button is on;
//   them: the translated voices the call module plays (<audio data-publication>), measured on a captured copy of
//         each element's stream so playback is untouched. Safari has no captureStream: then "someone is speaking"
//         from LiveKit stands in, as a gentle synthetic level.
// The call module's files are not edited; this only listens.

type Meter = { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer>; stop: () => void };

function rms(m: Meter) {
  m.analyser.getFloatTimeDomainData(m.buf);
  let s = 0;
  for (let i = 0; i < m.buf.length; i++) s += m.buf[i] * m.buf[i];
  // speech RMS sits around 0.02-0.2; spread it over 0..1
  return Math.min(1, Math.sqrt(s / m.buf.length) * 6);
}

function contextOf(ctx: { current: AudioContext | null }) {
  if (!ctx.current) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx.current = new AC();
  }
  void ctx.current.resume().catch(() => undefined);
  return ctx.current;
}

function meter(ac: AudioContext, stream: MediaStream, stopStream: boolean): Meter {
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  return {
    analyser,
    buf: new Float32Array(analyser.fftSize),
    stop: () => {
      src.disconnect();
      if (stopStream) stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export function useAudioLevel({ micOn, othersSpeaking }: { micOn: boolean; othersSpeaking: boolean }) {
  const level = useRef({ me: 0, them: 0 });
  const ctx = useRef<AudioContext | null>(null);
  const flags = useRef({ othersSpeaking });
  // the frame loop reads the latest value; updated after render, never during it
  useEffect(() => {
    flags.current.othersSpeaking = othersSpeaking;
  }, [othersSpeaking]);

  // microphone: only while talking
  const mic = useRef<Meter | null>(null);
  useEffect(() => {
    if (!micOn) return;
    let cancelled = false;
    void navigator.mediaDevices
      ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        const ac = contextOf(ctx);
        if (cancelled || !ac) return stream.getTracks().forEach((t) => t.stop());
        mic.current = meter(ac, stream, true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      mic.current?.stop();
      mic.current = null;
    };
  }, [micOn]);

  // translated voices: every audio element the call module adds, now and later
  const outs = useRef(new Map<HTMLAudioElement, Meter>());
  useEffect(() => {
    const live = outs.current;
    const attach = () => {
      const seen = new Set<HTMLAudioElement>();
      document.querySelectorAll<HTMLAudioElement>("audio[data-publication]").forEach((el) => {
        seen.add(el);
        if (outs.current.has(el)) return;
        const capture = (el as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream;
        const ac = contextOf(ctx);
        if (!capture || !ac) return;
        try {
          const stream = capture.call(el);
          if (stream.getAudioTracks().length) outs.current.set(el, meter(ac, stream, false));
        } catch {
          /* not capturable: the speaking flag stands in */
        }
      });
      for (const [el, m] of outs.current) {
        if (seen.has(el)) continue;
        m.stop();
        outs.current.delete(el);
      }
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });
    const t = setInterval(attach, 1500); // a track can attach to an existing element later
    return () => {
      mo.disconnect();
      clearInterval(t);
      for (const m of live.values()) m.stop();
      live.clear();
    };
  }, []);

  // smoothing loop
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const me = mic.current ? rms(mic.current) : 0;
      let them = 0;
      for (const m of outs.current.values()) them = Math.max(them, rms(m));
      // no measurable output (Safari, simulated room): a soft pulse while someone else is speaking
      if (them < 0.02 && flags.current.othersSpeaking) them = 0.35 + 0.25 * Math.sin(now / 140) * Math.sin(now / 370);
      const l = level.current;
      l.me += (me - l.me) * (me > l.me ? 0.45 : 0.12);
      l.them += (them - l.them) * (them > l.them ? 0.45 : 0.12);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => void ctx.current?.close().catch(() => undefined), []);
  return level;
}
