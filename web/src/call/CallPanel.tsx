"use client";

import { useState, type PointerEvent } from "react";
import type { CallMessage, Lang } from "./api";
import { useCoordinationCall } from "./useCoordinationCall";

// Reference markup on useCoordinationCall: plain Tailwind, every value comes from the hook. Replace it with the app's
// own design; keep the rules (join from a click, one hook per page, mounted where it is not unmounted). The
// data-testid attributes are what the end-to-end check drives.

const LANG_NAME: Record<Lang, string> = { en: "English", ru: "Russian", zh: "Mandarin" };
const ERROR_TEXT: Record<string, string> = {
  UPSTREAM_UNAVAILABLE: "The call service is unavailable right now (LiveKit or a voice provider). Captions may still arrive.",
  FEATURE_DISABLED: "Live calls are turned off on this deployment.",
  FORBIDDEN: "You are not a member of this coordination room.",
  MIC_DENIED: "Microphone access was denied: allow it in the browser's site settings, then join again.",
  MIC_UNAVAILABLE: "No usable microphone: pick another one or connect a wired headset.",
  DISCONNECTED: "The call was disconnected. Join again.",
};

export function CallPanel({ roomId, devToken }: { roomId: string; devToken?: string }) {
  const c = useCoordinationCall({ roomId, devToken });
  const joined = c.state === "joined" || c.state === "reconnecting";
  // Primary button only: a right click opens the context menu and may never deliver pointerup (a stuck microphone).
  const press = (e: PointerEvent) => { if (e.button === 0) c.startTalking(); };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 p-4 text-sm" data-testid="call-panel" data-state={c.state}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Coordination call</span>
        <span className="rounded bg-white/10 px-2 py-0.5 text-xs" data-testid="call-state">{c.state}</span>
        {c.lang && <span className="text-xs opacity-70">You hear {LANG_NAME[c.lang]}</span>}
        {c.role === "observer" && <span className="rounded bg-white/10 px-2 py-0.5 text-xs" data-testid="call-observer">Observer · listen only</span>}
        {joined && (
          <span className="rounded px-2 py-0.5 text-xs" data-testid="call-translator" data-present={c.translatorPresent}
            style={{ background: c.translatorPresent ? "rgba(34,197,94,.2)" : "rgba(234,179,8,.2)" }}>
            {c.translatorPresent ? `Translator ready · ${c.translationTracks} translated track(s)` : "Translator not in the room — captions only"}
          </span>
        )}
      </header>

      {c.error && (
        <p className="text-red-400" role="alert" data-testid="call-error" data-code={c.error.code}>
          {ERROR_TEXT[c.error.code] ?? `${c.error.code}: ${c.error.message}`} <button className="underline" onClick={c.clearError}>dismiss</button>
        </p>
      )}

      {c.presenceError && (
        <p className="text-xs text-yellow-400" data-testid="call-presence-error">Presence sync failed ({c.presenceError.code}); the call itself works.</p>
      )}
      {c.state === "reconnecting" && <p className="text-xs text-yellow-400">Reconnecting… the microphone is off until the call is back.</p>}

      {!joined ? (
        <button className="self-start rounded bg-blue-600 px-3 py-1.5 disabled:opacity-40" data-testid="call-join"
          disabled={!c.ready || c.state === "joining"} onClick={() => void c.join()}>
          {c.state === "joining" ? "Joining…" : "Join call"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {c.role === "observer" ? null : c.micMode === "hold" ? (
            <button className="rounded bg-blue-600 px-3 py-1.5 disabled:opacity-40" data-testid="call-talk" data-on={c.micOn}
              disabled={!c.canTalk} onPointerDown={press} onPointerUp={c.stopTalking} onPointerLeave={c.stopTalking} onPointerCancel={c.stopTalking}>
              {c.micOn ? "Talking…" : "Hold to talk (or Space)"}
            </button>
          ) : (
            <button className="rounded bg-blue-600 px-3 py-1.5 disabled:opacity-40" data-testid="call-talk" data-on={c.micOn}
              disabled={!c.canTalk} onClick={c.toggleMic}>
              {c.micOn ? "Mute" : "Unmute"}
            </button>
          )}
          {c.role !== "observer" && <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={c.micMode === "open"} onChange={(e) => c.setMicMode(e.target.checked ? "open" : "hold")} /> Open mic
          </label>}
          {c.soundBlocked && (
            <button className="rounded bg-yellow-600 px-3 py-1.5" data-testid="call-sound" onClick={() => void c.enableSound()}>Enable sound</button>
          )}
          <button className="rounded border border-white/20 px-3 py-1.5" data-testid="call-leave" onClick={() => void c.leave()}>Leave</button>
        </div>
      )}

      {joined && (
        <div className="flex flex-wrap gap-3 text-xs">
          {c.role === "operator" && c.devices.mics.length > 0 && (
            <label>Microphone{" "}
              <select className="bg-transparent" value={c.devices.micId ?? ""} disabled={c.state !== "joined"} onChange={(e) => void c.devices.chooseMic(e.target.value)}>
                <option value="">System default</option>
                {c.devices.mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
              </select>
            </label>
          )}
          {c.devices.canChooseSpeaker && c.devices.speakers.length > 0 && (
            <label>Speaker{" "}
              <select className="bg-transparent" value={c.devices.speakerId ?? ""} disabled={c.state !== "joined"} onChange={(e) => c.devices.chooseSpeaker(e.target.value)}>
                <option value="">System default</option>
                {c.devices.speakers.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {joined && (
        <ul className="flex flex-wrap gap-2 text-xs" data-testid="call-participants">
          {c.participants.map((p) => (
            <li key={p.identity} className="rounded border border-white/10 px-2 py-0.5" data-identity={p.identity} data-speaking={p.speaking}>
              {p.isTranslator ? "Translator" : p.name}{p.isMe ? " (you)" : ""}{p.lang ? ` · ${p.lang}` : ""}{p.speaking ? " · speaking" : ""}
            </li>
          ))}
        </ul>
      )}

      <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="call-captions">
        {(c.captions ?? []).map((m) => <Caption key={m.messageId} m={m} myUserId={c.identity?.replace(/^user-/, "") ?? null} />)}
      </ol>
    </section>
  );
}

function Caption({ m, myUserId }: { m: CallMessage; myUserId: string | null }) {
  const [original, setOriginal] = useState(false);
  const mine = m.author.kind === "human" && m.author.userId === myUserId;
  const who = m.author.kind === "human" ? (mine ? "You" : m.author.name) : m.author.kind === "agent" ? m.author.role : "System";
  // The speaker always reads their own words; others read their language, with the original one click away.
  const shown = mine || original ? m.originalText : m.text;
  return (
    <li className="leading-snug" data-testid="call-caption" data-status={m.translationStatus} data-lang={m.originalLang} data-seg={m.segId}
      data-mine={mine}>
      <span className="opacity-60">{who}: </span>
      <span>{shown}</span>
      {!mine && m.translationStatus === "pending" && <span className="ml-1 opacity-60">(translating…)</span>}
      {!mine && m.translationStatus === "original_only" && (m.translationError?.code === "NOT_TRANSLATED" ? (
        <span className="ml-1 opacity-60" data-testid="call-caption-untranslated">(original: you joined after this phrase)</span>
      ) : (
        <span className="ml-1 text-orange-400" data-testid="call-caption-failed"
          title={m.translationError?.message ?? "The protected values did not survive translation; this phrase was not voiced"}>
          original only{m.translationError ? ` · ${m.translationError.code}` : ""} — not voiced
        </span>
      ))}
      {!mine && m.translationStatus === "ok" && m.voiceError && (
        <span className="ml-1 text-yellow-400" data-testid="call-caption-voice-failed" title={m.voiceError.message}>
          text only — voice failed ({m.voiceError.code})
        </span>
      )}
      {m.values.length > 0 && <span className="ml-1 font-mono text-xs opacity-70">[{m.values.map((v) => v.text).join(", ")}]</span>}
      {!mine && m.text !== m.originalText && (
        <button className="ml-1 text-xs underline opacity-60" onClick={() => setOriginal((o) => !o)}>{original ? "translation" : "original"}</button>
      )}
    </li>
  );
}
