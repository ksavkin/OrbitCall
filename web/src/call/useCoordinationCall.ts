"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  AudioPresets, Room, RoomEvent, Track, createLocalAudioTrack, supportsAudioOutputSelection,
  type AudioCaptureOptions, type LocalAudioTrack, type Participant, type RemoteParticipant, type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { callApi, type CallError, type CallMessage, type Lang } from "./api";
import { RootAudio } from "./audio";
import { callDebugEnabled, watchCallDebug } from "./debug";
import { pickable, resolveRealDeviceId } from "./devices";
import { registerActiveCall } from "./session";
import { TRANSLATOR_IDENTITY, isLang, parseTranslationTrack, shouldHear } from "./tracks";

// The live call of one coordination room, headless (team spec §5): join from a click, publish the microphone, hear only
// the translations into my language plus same-language speakers, captions from Convex. Build the call panel in the
// app's own design on this hook; `CallPanel.tsx` is only a reference. Exactly one hook per page: it owns the page's
// only LiveKit Room and root audio layer; mount it where re-renders do not unmount it.
//
// Lessons applied (from two earlier LiveKit products): R2 hear only allowed tracks (tracks.ts), R3 no DTX + RED +
// music preset, R4 one root audio layer (audio.ts), R7 language/company/role come from the server, R17 startAudio on
// the joining click and an "enable sound" path, R18 real microphone ids, R19 no disconnect on pagehide (own
// beforeunload). The microphone is published already muted: it is never live until the user talks.

export type CallState = "idle" | "joining" | "joined" | "reconnecting" | "left" | "error";
export type MicMode = "hold" | "open";
/** An observer's token cannot publish (spec §5): no microphone, listening and captions only. */
export type CallRole = "operator" | "observer";

export type CallParticipant = {
  identity: string;
  name: string;
  lang: Lang | null;
  isTranslator: boolean;
  isMe: boolean;
  /** A human speaking now (the translator's own activity is not shown: it may be another language). */
  speaking: boolean;
};

export type UseCoordinationCall = {
  /** Captions loaded: enable Join from here on. */
  ready: boolean;
  state: CallState;
  /** The last failed action (join, talk, device). Presence problems are separate (presenceError). */
  error: CallError | null;
  clearError: () => void;
  /** Presence sync failed (the call itself works); cleared by the next successful heartbeat. */
  presenceError: CallError | null;
  /** My identity ("user-<userId>"), language and role, known after joining. */
  identity: string | null;
  lang: Lang | null;
  role: CallRole | null;
  /** Call from a click handler (browsers allow sound and the microphone only after a user gesture). Never throws. */
  join: () => Promise<void>;
  leave: () => Promise<void>;
  /** "hold": the microphone is live only while held (startTalking / stopTalking, Space); "open": toggleMic. */
  micMode: MicMode;
  setMicMode: (mode: MicMode) => void;
  micOn: boolean;
  /** Talking is possible now: joined (not reconnecting), operator, microphone published. */
  canTalk: boolean;
  startTalking: () => void;
  stopTalking: () => void;
  toggleMic: () => void;
  /** Playback was refused (autoplay, iOS after sleep): show a button that calls enableSound(). */
  soundBlocked: boolean;
  enableSound: () => Promise<void>;
  /** The translator agent is in the room; without it nobody hears translations (captions still arrive). */
  translatorPresent: boolean;
  /** Translated tracks I currently hear (tr:<myLang>:*): 0 while nobody of another language is in the call. */
  translationTracks: number;
  participants: CallParticipant[];
  /** Voice phrases of the room, oldest first, text in my language with the original attached (spec Message). */
  captions: CallMessage[] | undefined;
  devices: {
    mics: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
    micId: string | null;
    speakerId: string | null;
    canChooseSpeaker: boolean;
    chooseMic: (deviceId: string) => Promise<void>;
    chooseSpeaker: (deviceId: string) => void;
  };
};

const MIC_KEY = "orbit-call-mic";
const SPK_KEY = "orbit-call-spk";
/** Presence heartbeat: the server treats a row older than 75 s as not in the call (beforeunload is unreliable). */
const HEARTBEAT_MS = 30_000;
const load = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string | null) => {
  try { if (v) window.localStorage.setItem(k, v); else window.localStorage.removeItem(k); } catch { /* storage may be blocked */ }
};
const CAPTURE: AudioCaptureOptions = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const PUBLISH = { source: Track.Source.Microphone, dtx: false, red: true, audioPreset: AudioPresets.music };

/** ConvexError data → { code, message }; media errors → MIC_*; anything else the fallback code with its message. */
export function callErrorOf(e: unknown, fallback = "UNKNOWN"): CallError {
  if (e instanceof ConvexError && e.data && typeof e.data === "object") {
    const d = e.data as { code?: unknown; message?: unknown };
    return { code: String(d.code ?? "UNKNOWN"), message: String(d.message ?? "") };
  }
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return { code: "MIC_DENIED", message: "Microphone access was denied" };
  if (["NotFoundError", "NotReadableError", "OverconstrainedError", "AbortError"].includes(name)) {
    return { code: "MIC_UNAVAILABLE", message: "No usable microphone" };
  }
  return { code: fallback, message: e instanceof Error ? e.message : String(e) };
}

/** A saved microphone that is gone fails capture: retry once on the system default and forget the saved id. */
async function captureMic(preferred: string | null): Promise<LocalAudioTrack> {
  if (!preferred) return createLocalAudioTrack(CAPTURE);
  try {
    return await createLocalAudioTrack({ ...CAPTURE, deviceId: preferred });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name !== "OverconstrainedError" && name !== "NotFoundError" && name !== "NotReadableError") throw e;
    save(MIC_KEY, null);
    return createLocalAudioTrack(CAPTURE);
  }
}

export function useCoordinationCall({ roomId, devToken, spaceToTalk = true }: {
  roomId: string; devToken?: string; spaceToTalk?: boolean;
}): UseCoordinationCall {
  const byRoom = useMemo(() => ({ roomId, ...(devToken ? { devToken } : {}) }), [roomId, devToken]);
  const captionArgs = useMemo(() => ({ ...byRoom, limit: 100 }), [byRoom]);
  const captions = useQuery(callApi.messages.list, captionArgs);
  const mint = useAction(callApi.join);
  const presenceJoin = useMutation(callApi.presence.join);
  const presenceLeave = useMutation(callApi.presence.leave);
  const setInCall = useMutation(callApi.presence.setInCall);

  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<CallError | null>(null);
  const [presenceError, setPresenceError] = useState<CallError | null>(null);
  const [me, setMe] = useState<{ identity: string; lang: Lang } | null>(null);
  const [role, setRole] = useState<CallRole | null>(null);
  const [micMode, setMicModeState] = useState<MicMode>("hold");
  const [micOn, setMicOn] = useState(false);
  const [published, setPublished] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [translationTracks, setTranslationTracks] = useState(0);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string | null>(null);
  const [speakerId, setSpeakerId] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<RootAudio | null>(null);
  const meRef = useRef<{ identity: string; lang: Lang } | null>(null);
  const roleRef = useRef<CallRole | null>(null);
  const leavingRef = useRef(false);
  const joiningRef = useRef(false);
  const micModeRef = useRef<MicMode>("hold");
  /** The microphone state asked for last; mute/unmute calls run one after another behind micChain. */
  const micWantRef = useRef(false);
  const micChain = useRef<Promise<unknown>>(Promise.resolve());
  const stopDebugRef = useRef<(() => void) | null>(null);
  /** An individual <audio> element was refused playback; only a successful enableSound clears it. */
  const elementBlockedRef = useRef(false);
  // The latest presence calls and args, for cleanups that must not re-run when these identities change.
  const presence = useRef({ byRoom, presenceJoin, setInCall, presenceLeave });
  useEffect(() => { presence.current = { byRoom, presenceJoin, setInCall, presenceLeave }; }, [byRoom, presenceJoin, setInCall, presenceLeave]);
  const canChooseSpeaker = useMemo(() => typeof window !== "undefined" && supportsAudioOutputSelection(), []);

  const markInCall = useCallback((inCall: boolean) => {
    const p = presence.current;
    return p.setInCall({ ...p.byRoom, inCall }).then(() => setPresenceError(null), (e) => setPresenceError(callErrorOf(e)));
  }, []);
  /** Heartbeat: join (the row may have expired server-side) then inCall true; the server counts > 75 s as gone. */
  const beat = useCallback(() => {
    const p = presence.current;
    return p.presenceJoin(p.byRoom).then(() => markInCall(true), (e) => setPresenceError(callErrorOf(e)));
  }, [markInCall]);

  /** Re-reads the room into React state: participants, speaking flags, heard translation tracks. */
  const refresh = useCallback(() => {
    const room = roomRef.current;
    const self = meRef.current;
    if (!room || !self) { setParticipants([]); setTranslationTracks(0); return; }
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    const view = (p: Participant, isMe: boolean): CallParticipant => {
      const lang = p.attributes.lang;
      const isTranslator = p.identity === TRANSLATOR_IDENTITY;
      return { identity: p.identity, name: p.name || p.identity, lang: isLang(lang) ? lang : null,
        isTranslator, isMe, speaking: !isTranslator && speaking.has(p.identity) };
    };
    setParticipants([view(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => view(p, false))]);
    const translator = room.remoteParticipants.get(TRANSLATOR_IDENTITY);
    setTranslationTracks(translator ? [...translator.trackPublications.values()]
      .filter((pub) => pub.isSubscribed && parseTranslationTrack(pub.trackName)?.lang === self.lang).length : 0);
  }, []);

  /** The allow-list decision for one publication (tracks.ts), with the original speaker's language for translations. */
  const hears = useCallback((p: RemoteParticipant, pub: RemoteTrackPublication) => {
    const self = meRef.current;
    const room = roomRef.current;
    if (!self || !room || pub.kind !== Track.Kind.Audio) return false;
    const t = p.identity === TRANSLATOR_IDENTITY ? parseTranslationTrack(pub.trackName) : null;
    return shouldHear({ participant: p.identity, participantLang: p.attributes.lang, trackName: pub.trackName,
      isMicrophone: pub.source === Track.Source.Microphone,
      speakerLang: t ? room.remoteParticipants.get(t.speaker)?.attributes.lang : undefined }, self);
  }, []);

  /** Subscribe to exactly the audio this viewer should hear; unsubscribe and detach the rest (R2). */
  const reconcile = useCallback((p: RemoteParticipant, pub: RemoteTrackPublication) => {
    if (pub.kind !== Track.Kind.Audio) return;
    const hear = hears(p, pub);
    if (pub.isSubscribed !== hear) pub.setSubscribed(hear);
    if (!hear) audioRef.current?.detach(pub.trackSid);
  }, [hears]);

  const reconcileAll = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) reconcile(p, pub);
  }, [reconcile]);

  const readDevices = useCallback(async () => {
    try {
      setMics(pickable(await Room.getLocalDevices("audioinput", false), "audioinput"));
      if (canChooseSpeaker) setSpeakers(pickable(await Room.getLocalDevices("audiooutput", false), "audiooutput"));
    } catch { /* enumeration can fail before permission; the lists stay empty */ }
  }, [canChooseSpeaker]);

  /** Mute/unmute in order; the UI follows the resolved state, never a guess. */
  const setMic = useCallback((on: boolean) => {
    micWantRef.current = on;
    micChain.current = micChain.current.then(async () => {
      const room = roomRef.current;
      if (!room || room.state !== "connected" || roleRef.current !== "operator") { setMicOn(false); return; }
      try {
        await room.localParticipant.setMicrophoneEnabled(micWantRef.current);
        setMicOn(room.localParticipant.isMicrophoneEnabled);
      } catch (e) {
        setMicOn(false);
        setError(callErrorOf(e));
      }
    });
  }, []);

  const teardown = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    meRef.current = null;
    roleRef.current = null;
    micWantRef.current = false;
    stopDebugRef.current?.();
    stopDebugRef.current = null;
    audioRef.current?.dispose();
    audioRef.current = null;
    if (room) {
      // stop local mic tracks first so the browser does not keep the session open
      for (const pub of room.localParticipant.trackPublications.values()) {
        try {
          pub.track?.stop();
        } catch {
          /* already stopped */
        }
      }
      void room.disconnect(true);
    }
    setMe(null);
    setRole(null);
    setMicOn(false);
    setPublished(false);
    setParticipants([]);
    setTranslationTracks(0);
  }, []);

  const join = useCallback(async () => {
    if (joiningRef.current || roomRef.current) return;
    joiningRef.current = true;
    // The in-flight flag is reset on every path, including a failure before the connection.
    try {
      leavingRef.current = false;
      setError(null);
      setState("joining");
      // Created synchronously inside the click, so startAudio still counts as a user gesture (R17).
      const room = new Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false, audioCaptureDefaults: CAPTURE,
        publishDefaults: { dtx: false, red: true, audioPreset: AudioPresets.music } });
      roomRef.current = room;
      elementBlockedRef.current = false;
      audioRef.current = new RootAudio(canChooseSpeaker, () => { elementBlockedRef.current = true; setSoundBlocked(true); });
      const sink = load(SPK_KEY);
      if (sink && canChooseSpeaker) { audioRef.current.setSinkId(sink); setSpeakerId(sink); }
      void room.startAudio().catch(() => undefined);
      const current = () => roomRef.current === room;

      room
        .on(RoomEvent.TrackPublished, (pub, p) => { if (current()) { reconcile(p, pub); refresh(); } })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, p) => {
          if (!current() || track.kind !== Track.Kind.Audio) return;
          if (hears(p, pub)) audioRef.current?.attach(pub.trackSid, track, p.identity);
          else pub.setSubscribed(false);
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed, (_t, pub) => { if (current()) { audioRef.current?.detach(pub.trackSid); refresh(); } })
        .on(RoomEvent.TrackUnpublished, (pub) => { if (current()) { audioRef.current?.detach(pub.trackSid); refresh(); } })
        .on(RoomEvent.ParticipantConnected, () => { if (current()) { reconcileAll(); refresh(); } })
        .on(RoomEvent.ParticipantDisconnected, (p) => {
          if (!current()) return;
          for (const pub of p.trackPublications.values()) audioRef.current?.detach(pub.trackSid);
          reconcileAll(); // a translator track for this speaker may need re-evaluation
          refresh();
        })
        .on(RoomEvent.ParticipantAttributesChanged, (_c, p) => {
          if (!current()) return;
          if (p === room.localParticipant) {
            // The server owns my language (R7); a change applies to what I hear at once.
            const lang = p.attributes.lang;
            if (meRef.current && isLang(lang) && lang !== meRef.current.lang) { meRef.current = { ...meRef.current, lang }; setMe(meRef.current); }
          }
          reconcileAll();
          refresh();
        })
        .on(RoomEvent.ActiveSpeakersChanged, () => current() && refresh())
        .on(RoomEvent.AudioPlaybackStatusChanged, () => current() && setSoundBlocked(!room.canPlaybackAudio || elementBlockedRef.current))
        .on(RoomEvent.MediaDevicesChanged, () => current() && void readDevices())
        .on(RoomEvent.Reconnecting, () => {
          if (!current()) return;
          setState("reconnecting");
          // Never leave a microphone hot across a reconnect: mute the track itself (the room is not "connected" now,
          // so setMicrophoneEnabled would be skipped), and enforce it again once connected.
          micWantRef.current = false;
          setMicOn(false);
          for (const pub of room.localParticipant.audioTrackPublications.values()) {
            if (pub.track) pub.track.mediaStreamTrack.enabled = false; // immediate, even if the publication is being restored
            void pub.track?.mute().catch(() => undefined);
          }
        })
        .on(RoomEvent.Reconnected, () => {
          if (!current()) return;
          setState("joined");
          setMic(false);
          // Elements refused before the outage get another chance now (the banner clears only if all of them play).
          void audioRef.current?.resume().then((all) => {
            if (!current() || !all) return;
            elementBlockedRef.current = false;
            setSoundBlocked(!room.canPlaybackAudio);
          });
          reconcileAll();
          refresh();
          void beat(); // do not wait for the next heartbeat: the outage may have outlived the 75 s window
        })
        .on(RoomEvent.Disconnected, () => {
          if (!current()) return;
          const intended = leavingRef.current;
          teardown();
          setState(intended ? "left" : "error");
          if (!intended) {
            // A final, unintended disconnect leaves the room fully, like leave().
            setError({ code: "DISCONNECTED", message: "The call was disconnected" });
            const pr = presence.current;
            void Promise.allSettled([pr.setInCall({ ...pr.byRoom, inCall: false }), pr.presenceLeave(pr.byRoom)]);
          }
        });

      try {
        const j = await mint(byRoom);
        if (!current()) return;
        meRef.current = { identity: j.identity, lang: j.language };
        roleRef.current = j.role;
        setMe(meRef.current);
        setRole(j.role);
        if (callDebugEnabled()) stopDebugRef.current = watchCallDebug(room, () => meRef.current, () => audioRef.current?.size ?? 0);
        await room.connect(j.serverUrl, j.token, { autoSubscribe: false });
        if (!current()) return;
        // The join result decides; the token's permissions guard against a mismatch (never publish without the grant).
        if (room.localParticipant.permissions?.canPublish === false && j.role !== "observer") { roleRef.current = "observer"; setRole("observer"); }
        if (roleRef.current === "operator") {
          // Captured and muted before publishing: the microphone is never live until the user talks.
          const track = await captureMic(load(MIC_KEY));
          try {
            await track.mute();
            if (!current()) { track.stop(); return; }
            await room.localParticipant.publishTrack(track, PUBLISH);
          } catch (e) {
            track.stop(); // release the device: no lingering microphone indicator
            throw e;
          }
          setPublished(true);
          const all = await Room.getLocalDevices("audioinput", false).catch(() => [] as MediaDeviceInfo[]);
          const active = track.mediaStreamTrack.getSettings().deviceId ?? room.getActiveDevice("audioinput");
          const real = active ? resolveRealDeviceId(all, "audioinput", active) : null;
          // Show the device actually capturing: the resolved one only if the switch succeeded (or was not needed).
          const used = real && active && real !== active ? ((await room.switchActiveDevice("audioinput", real).catch(() => false)) ? real : active) : real;
          setMicId(used && pickable(all, "audioinput").some((d) => d.deviceId === used) ? used : null);
        }
        await readDevices();
        reconcileAll();
        refresh();
        setSoundBlocked(!room.canPlaybackAudio || elementBlockedRef.current);
        setState("joined");
        // Presence after the connection exists; the heartbeat below keeps it fresh.
        void beat();
      } catch (e) {
        if (!current()) return;
        setError(callErrorOf(e, "CONNECT_FAILED"));
        leavingRef.current = true;
        teardown();
        setState("error");
      }
    } catch (e) {
      setError(callErrorOf(e, "CONNECT_FAILED"));
      leavingRef.current = true;
      teardown();
      setState("error");
    } finally {
      joiningRef.current = false;
    }
  }, [beat, byRoom, canChooseSpeaker, hears, mint, readDevices, reconcile, reconcileAll, refresh, setMic, teardown]);

  const leave = useCallback(async () => {
    if (!roomRef.current && state !== "joining" && state !== "joined" && state !== "reconnecting") return;
    leavingRef.current = true;
    teardown();
    setState("left");
    const p = presence.current;
    // Independent: a failed inCall update must not keep the presence row alive.
    await Promise.allSettled([p.setInCall({ ...p.byRoom, inCall: false }), p.presenceLeave(p.byRoom)]);
  }, [state, teardown]);

  // so Close case / resolution can hang up without relying only on React unmount order
  useEffect(() => {
    if (state !== "joined" && state !== "reconnecting" && state !== "joining") return;
    return registerActiveCall(leave);
  }, [leave, state]);

  const startTalking = useCallback(() => { if (micModeRef.current === "hold") setMic(true); }, [setMic]);
  const stopTalking = useCallback(() => { if (micModeRef.current === "hold") setMic(false); }, [setMic]);
  const toggleMic = useCallback(() => { if (micModeRef.current === "open") setMic(!micWantRef.current); }, [setMic]);
  const setMicMode = useCallback((mode: MicMode) => { micModeRef.current = mode; setMicModeState(mode); setMic(false); }, [setMic]);

  const enableSound = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try { await room.startAudio(); } catch { /* still blocked: the banner stays */ }
    const all = (await audioRef.current?.resume()) ?? true;
    if (all) elementBlockedRef.current = false;
    setSoundBlocked(!room.canPlaybackAudio || !all);
  }, []);

  /** "" = the system default, resolved to the real device behind the OS alias (R18). */
  const chooseMic = useCallback(async (deviceId: string) => {
    const room = roomRef.current;
    if (roleRef.current !== "operator") return;
    try {
      // Re-enumerate for the system default or when the list may be stale (hotplug).
      const all = deviceId && mics.some((d) => d.deviceId === deviceId) ? mics : await Room.getLocalDevices("audioinput", false);
      const real = resolveRealDeviceId(all, "audioinput", deviceId || "default");
      if (room) await room.switchActiveDevice("audioinput", real);
      save(MIC_KEY, deviceId ? real : null);
      setMicId(deviceId ? real : null);
    } catch (e) {
      setError(callErrorOf(e));
    }
  }, [mics]);

  const chooseSpeaker = useCallback((deviceId: string) => {
    if (!canChooseSpeaker) return;
    save(SPK_KEY, deviceId || null);
    setSpeakerId(deviceId || null);
    audioRef.current?.setSinkId(deviceId || undefined);
  }, [canChooseSpeaker]);

  // Space = hold to talk (not while typing). Release always stops, wherever the focus went; the microphone also stops
  // in hold mode when the window loses focus or the tab hides.
  useEffect(() => {
    if (!spaceToTalk || state !== "joined") return;
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !e.repeat && !typing(e.target)) { e.preventDefault(); startTalking(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") stopTalking(); };
    const stop = () => { if (micModeRef.current === "hold") setMic(false); };
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [setMic, spaceToTalk, startTalking, state, stopTalking]);

  // Presence heartbeat while in the call, also while LiveKit reconnects (Convex is a separate connection).
  useEffect(() => {
    if (state !== "joined" && state !== "reconnecting") return;
    const t = window.setInterval(() => void beat(), HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [beat, state]);

  // Playback can be suspended by the OS (iOS after sleep) without an event: re-check when the page comes back.
  useEffect(() => {
    const check = () => { const room = roomRef.current; if (room && !room.canPlaybackAudio) setSoundBlocked(true); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);

  // A real navigation or close leaves the call (R19: the SDK's own pagehide disconnect is off; the server's 75 s
  // presence window covers the rest). Unmounting leaves the call fully. Runs once: it must never tear down a live call
  // because a dependency changed identity.
  useEffect(() => {
    const bye = () => { leavingRef.current = true; void roomRef.current?.disconnect(); };
    window.addEventListener("beforeunload", bye);
    return () => {
      window.removeEventListener("beforeunload", bye);
      if (!roomRef.current) return;
      leavingRef.current = true;
      teardown();
      const p = presence.current;
      void Promise.allSettled([p.setInCall({ ...p.byRoom, inCall: false }), p.presenceLeave(p.byRoom)]);
    };
  }, [teardown]);

  return {
    ready: captions !== undefined,
    state, error, clearError: () => setError(null), presenceError,
    identity: me?.identity ?? null, lang: me?.lang ?? null, role,
    join, leave,
    micMode, setMicMode, micOn, canTalk: state === "joined" && role === "operator" && published,
    startTalking, stopTalking, toggleMic,
    soundBlocked, enableSound,
    translatorPresent: participants.some((p) => p.isTranslator),
    translationTracks,
    participants,
    captions,
    devices: { mics, speakers, micId, speakerId, canChooseSpeaker, chooseMic, chooseSpeaker },
  };
}
