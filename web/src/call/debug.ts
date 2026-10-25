import { Track, type Room } from "livekit-client";
import type { Lang } from "./api";
import { TRANSLATOR_IDENTITY, parseTranslationTrack } from "./tracks";

// Debug view for the /call test page only (end-to-end checks of R1/R2/R3 and latency): `window.__callDebug`, updated
// live. Off unless the test page calls enableCallDebug(); the hook's public API does not change. The first audible frame
// of each heard track is measured with an AnalyserNode on that track's MediaStreamTrack.

export type CallDebug = {
  identity: string | null;
  lang: Lang | null;
  joinedAt: number | null;
  published: { name: string; source: string; dtx: boolean | null; red: boolean | null }[];
  subscribed: { name: string; participantIdentity: string; kind: "translation" | "host" | "raw" }[];
  audioElements: number;
  firstAudioAt: Record<string, number>;
  translatorPresent: boolean;
};

declare global {
  interface Window { __callDebug?: CallDebug }
}

let enabled = false;
/** Called by the test page; production screens never turn it on. */
export function enableCallDebug(): void {
  enabled = true;
}
export const callDebugEnabled = () => enabled && typeof window !== "undefined";

const SILENCE_RMS = 0.01;

/** Watches one room; returns a stop function. */
export function watchCallDebug(room: Room, me: () => { identity: string; lang: Lang } | null, audioElements: () => number): () => void {
  const state: CallDebug = { identity: null, lang: null, joinedAt: null, published: [], subscribed: [], audioElements: 0,
    firstAudioAt: {}, translatorPresent: false };
  window.__callDebug = state;
  let ctx: AudioContext | null = null;
  const probes = new Map<string, () => void>();

  const probe = (name: string, mst: MediaStreamTrack) => {
    if (probes.has(name) || name in state.firstAudioAt) return;
    try {
      ctx ??= new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([mst]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const t = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        if (Math.sqrt(sum / buf.length) > SILENCE_RMS) { state.firstAudioAt[name] = Date.now(); stop(); }
      }, 20);
      const stop = () => { window.clearInterval(t); source.disconnect(); probes.delete(name); };
      probes.set(name, stop);
    } catch { /* no AudioContext: no latency figure */ }
  };

  const tick = window.setInterval(() => {
    const self = me();
    state.identity = self?.identity ?? null;
    state.lang = self?.lang ?? null;
    if (room.state === "connected" && state.joinedAt === null) state.joinedAt = Date.now();
    state.published = [...room.localParticipant.trackPublications.values()].map((p) => ({
      name: p.trackName, source: p.source, dtx: p.options?.dtx ?? null, red: p.options?.red ?? null }));
    const subs: CallDebug["subscribed"] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (!pub.isSubscribed || pub.kind !== Track.Kind.Audio) continue;
        const kind = p.identity === TRANSLATOR_IDENTITY && parseTranslationTrack(pub.trackName) ? "translation"
          : pub.trackName.startsWith("host:") ? "host" : "raw";
        subs.push({ name: pub.trackName, participantIdentity: p.identity, kind });
        const mst = pub.track?.mediaStreamTrack;
        if (mst) probe(pub.trackName, mst);
      }
    }
    state.subscribed = subs;
    state.audioElements = audioElements();
    state.translatorPresent = room.remoteParticipants.has(TRANSLATOR_IDENTITY);
  }, 100);

  return () => {
    window.clearInterval(tick);
    for (const stop of [...probes.values()]) stop();
    void ctx?.close().catch(() => undefined);
  };
}
