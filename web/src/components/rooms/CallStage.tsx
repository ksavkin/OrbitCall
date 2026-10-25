"use client";

import { AnimatePresence, motion } from "motion/react";
import { Languages, Loader2, LogOut, Mic, MicOff, PhoneCall, Send, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { CallMessage, Lang } from "@/call/api";
import type { CallParticipant, UseCoordinationCall } from "@/call/useCoordinationCall";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { ClaudeGlyph } from "@/components/ops/Glyphs";

// The coordination call, in the app's design, on useCoordinationCall (or its dev stand-in: same shape).
// Rules from the call module: join from a click; only the primary button talks; speech never approves anything.

const LANG_NAME: Record<Lang, string> = { en: "English", ru: "Russian", zh: "Mandarin" };
const ERROR_TEXT: Record<string, string> = {
  UPSTREAM_UNAVAILABLE: "The call service is unavailable right now. Captions may still arrive.",
  FEATURE_DISABLED: "Live calls are turned off on this deployment.",
  FORBIDDEN: "You are not a member of this coordination room.",
  MIC_DENIED: "Microphone access was denied. Allow it in the site settings, then join again.",
  MIC_UNAVAILABLE: "No usable microphone. Pick another one or connect a wired headset.",
  DISCONNECTED: "The call was disconnected. Join again.",
};

export type StageCall = UseCoordinationCall & { simulated?: boolean; sendText?: (t: string) => void };

/** Flag per participant identity, from the room's parties (falls back to none). */
export type FlagOf = (p: CallParticipant) => string | null;

export function CallStage({ call: c, title, subtitle, flagOf }: { call: StageCall; title: ReactNode; subtitle?: ReactNode; flagOf: FlagOf }) {
  const joined = c.state === "joined" || c.state === "reconnecting";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="call-panel" data-state={c.state}>
      {/* header */}
      <div className="flex items-start gap-3 px-6 pb-4 pt-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-neutral-500">
            <span className={`h-1.5 w-1.5 rounded-full ${joined ? "bg-green" : "bg-neutral-600"}`} style={joined ? { boxShadow: "0 0 8px var(--green)" } : undefined} />
            {joined ? (c.state === "reconnecting" ? "Reconnecting" : "Live") : c.state === "joining" ? "Joining" : "Not joined"}
            {c.simulated && <span className="rounded-full bg-[rgba(255,159,64,0.12)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-orange">simulated · no audio</span>}
          </div>
          <div className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-white">{title}</div>
          {subtitle && <div className="mt-0.5 text-[13px] text-neutral-500">{subtitle}</div>}
        </div>
        {joined && <TranslatorBadge c={c} />}
      </div>

      {c.error && (
        <div className="mx-6 mb-3 flex items-center gap-3 rounded-[12px] bg-[rgba(255,90,79,0.1)] px-4 py-2.5 text-[13px] text-[#ff8a80]" role="alert" data-testid="call-error" data-code={c.error.code}>
          {ERROR_TEXT[c.error.code] ?? `${c.error.code}: ${c.error.message}`}
          <button className="ml-auto text-[12px] text-neutral-400 underline" onClick={c.clearError}>
            Dismiss
          </button>
        </div>
      )}
      {c.presenceError && <div className="mx-6 mb-2 text-[12px] text-amber">Presence sync failed ({c.presenceError.code}); the call itself works.</div>}

      {/* who is here */}
      <AnimatePresence>{joined && <Participants list={c.participants} flagOf={flagOf} />}</AnimatePresence>

      {/* captions */}
      <Captions c={c} />

      {/* controls */}
      <Controls c={c} joined={joined} />
    </div>
  );
}

function TranslatorBadge({ c }: { c: StageCall }) {
  return (
    <Tooltip
      label={
        c.translatorPresent
          ? `Each phrase is translated into every language in the room, numbers locked. You hear ${c.lang ? LANG_NAME[c.lang] : "your language"}.`
          : "Without the translator, captions still arrive but nobody hears translations."
      }
    >
      <span
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
        data-testid="call-translator"
        data-present={c.translatorPresent}
        style={{
          color: c.translatorPresent ? "var(--green)" : "var(--amber)",
          background: c.translatorPresent ? "rgba(61,220,151,0.1)" : "rgba(245,196,81,0.1)",
        }}
      >
        <Languages size={13} />
        {c.translatorPresent ? "Live translation · EN · RU · ZH" : "Translator not in the room"}
      </span>
    </Tooltip>
  );
}

function Participants({ list, flagOf }: { list: CallParticipant[]; flagOf: FlagOf }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
      data-testid="call-participants"
    >
      <div className="flex flex-wrap gap-2.5 px-6 pb-4">
        {list.map((p) => {
          const flag = flagOf(p);
          return (
            <div
              key={p.identity}
              data-identity={p.identity}
              data-speaking={p.speaking}
              className="flex items-center gap-2.5 rounded-full bg-white/[0.04] py-1.5 pl-1.5 pr-3.5 transition-shadow duration-200"
              style={p.speaking ? { boxShadow: "0 0 0 1.5px var(--green), 0 0 18px -4px rgba(61,220,151,0.7)" } : { boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }}
            >
              <span className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-[#16171b] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
                {p.isTranslator ? <ClaudeGlyph size={15} /> : flag ? <Flag code={flag} h={32} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-tight text-white">
                  {p.isTranslator ? "Translator" : p.name}
                  {p.isMe && <span className="text-neutral-500"> · you</span>}
                </span>
                <span className="block text-[11px] text-neutral-500">{p.isTranslator ? "agent · numbers locked" : p.lang ? LANG_NAME[p.lang] : ""}</span>
              </span>
              {p.speaking && <Bars />}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

/** Small live level bars next to whoever is speaking. */
function Bars() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-[2.5px] rounded-full bg-green"
          animate={{ height: ["30%", "100%", "45%", "80%", "30%"] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }}
        />
      ))}
    </span>
  );
}

function Captions({ c }: { c: StageCall }) {
  const box = useRef<HTMLDivElement>(null);
  const list = c.captions ?? [];
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [list.length]);
  const myUserId = c.identity?.replace(/^user-/, "") ?? null;
  return (
    <div ref={box} className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06] px-6 py-4" data-testid="call-captions">
      {list.length === 0 && (
        <div className="grid h-full place-items-center text-center text-[13px] text-neutral-500">
          {c.state === "joined" ? "Nobody has spoken yet. Hold the talk button or press Space." : "Join the call to talk. Every phrase appears here in your language."}
        </div>
      )}
      <ol className="space-y-3.5">
        <AnimatePresence initial={false}>
          {list.map((m) => (
            <Caption key={m.messageId} m={m} myUserId={myUserId} />
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

/** Protected values (numbers, times, IDs) set apart so a dispatcher sees they were never altered. */
function withValues(text: string, values: CallMessage["values"], onLight = false) {
  if (!values.length) return text;
  const parts: ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (const v of values) {
    const i = rest.indexOf(v.text);
    if (i < 0) continue;
    parts.push(rest.slice(0, i));
    parts.push(
      <Tooltip key={k++} label="Protected value: copied exactly, never translated">
        <span className={`tnum rounded-[4px] px-1 font-medium ${onLight ? "bg-black/[0.07] text-black" : "bg-white/[0.08] text-white"}`}>{v.text}</span>
      </Tooltip>,
    );
    rest = rest.slice(i + v.text.length);
  }
  parts.push(rest);
  return parts;
}

function Caption({ m, myUserId }: { m: CallMessage; myUserId: string | null }) {
  const [original, setOriginal] = useState(false);
  const mine = m.author.kind === "human" && m.author.userId === myUserId;
  const who = m.author.kind === "human" ? (mine ? "You" : m.author.name) : m.author.kind === "agent" ? m.author.role : "System";
  // the speaker reads their own words; others read their language, with the original one click away
  const shown = mine || original ? m.originalText : m.text;
  const t = new Date(m.at);
  const time = `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={`flex gap-3 ${mine ? "flex-row-reverse" : ""}`}
      data-testid="call-caption"
      data-status={m.translationStatus}
      data-lang={m.originalLang}
      data-seg={m.segId}
      data-mine={mine}
    >
      <div className={`max-w-[78%] ${mine ? "text-right" : ""}`}>
        <div className="mb-1 text-[11.5px] text-neutral-500">
          <span className="font-medium text-neutral-300">{who}</span> · {time} UTC
          {!mine && m.originalLang && <span> · spoke {LANG_NAME[m.originalLang]}</span>}
        </div>
        <div
          className={`inline-block rounded-[16px] px-4 py-2.5 text-left text-[15px] leading-[1.55] ${mine ? "rounded-tr-[4px] bg-white text-black" : "rounded-tl-[4px] bg-white/[0.06] text-neutral-100"}`}
        >
          {m.translationStatus === "pending" && !mine ? <span className="shimmer">Translating…</span> : withValues(shown, m.values, mine)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
          {mine && m.translationStatus === "pending" && <span className="flex items-center gap-1 text-neutral-500"><Loader2 size={11} className="animate-spin" /> translating for the room</span>}
          {mine && m.translationStatus === "ok" && <span className="text-neutral-500">delivered in every language</span>}
          {!mine && m.translationStatus === "original_only" && (
            <span className="text-orange" data-testid={m.translationError?.code === "NOT_TRANSLATED" ? "call-caption-untranslated" : "call-caption-failed"}>
              {m.translationError?.code === "NOT_TRANSLATED" ? "Original: you joined after this phrase" : "Original only: the numbers did not survive translation, so it was not voiced"}
            </span>
          )}
          {!mine && m.translationStatus === "ok" && m.voiceError && (
            <span className="text-amber" data-testid="call-caption-voice-failed">
              Text only: the voice failed ({m.voiceError.code})
            </span>
          )}
          {!mine && m.text !== m.originalText && (
            <button className="text-neutral-500 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-300" onClick={() => setOriginal((o) => !o)}>
              {original ? "Show translation" : `Show original (${LANG_NAME[m.originalLang]})`}
            </button>
          )}
        </div>
      </div>
    </motion.li>
  );
}

function Controls({ c, joined }: { c: StageCall; joined: boolean }) {
  const [text, setText] = useState("");
  // primary button only: a right click opens the context menu and may never deliver pointerup (a stuck microphone)
  const press = (e: PointerEvent) => {
    if (e.button === 0) {
      sfx.toggle(true);
      c.startTalking();
    }
  };
  if (!joined) {
    return (
      <div className="flex items-center justify-center gap-3 border-t border-white/[0.06] px-6 py-5">
        <button
          className="btn btn-primary h-12 gap-2 px-6 text-[15px]"
          data-testid="call-join"
          disabled={!c.ready || c.state === "joining"}
          onClick={() => {
            sfx.chime();
            void c.join();
          }}
        >
          {c.state === "joining" ? <Loader2 size={16} className="animate-spin" /> : <PhoneCall size={16} />}
          {c.state === "joining" ? "Joining…" : c.state === "left" ? "Join again" : "Join the call"}
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4 border-t border-white/[0.06] px-6 py-4">
      {c.role === "observer" ? (
        <span className="text-[13px] text-neutral-500" data-testid="call-observer">
          Observer · listen only
        </span>
      ) : (
        <>
          {c.micMode === "hold" ? (
            <button
              className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full transition-transform active:scale-95 disabled:opacity-40"
              style={{ background: c.micOn ? "var(--green)" : "#fff", color: "#000", boxShadow: c.micOn ? "0 0 0 6px rgba(61,220,151,0.18), 0 0 30px -4px rgba(61,220,151,0.8)" : undefined }}
              data-testid="call-talk"
              data-on={c.micOn}
              disabled={!c.canTalk}
              onPointerDown={press}
              onPointerUp={c.stopTalking}
              onPointerLeave={c.stopTalking}
              onPointerCancel={c.stopTalking}
              aria-label="Hold to talk"
            >
              <Mic size={22} />
            </button>
          ) : (
            <button
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full disabled:opacity-40"
              style={{ background: c.micOn ? "var(--green)" : "rgba(255,255,255,0.1)", color: c.micOn ? "#000" : "#fff" }}
              data-testid="call-talk"
              data-on={c.micOn}
              disabled={!c.canTalk}
              onClick={c.toggleMic}
              aria-label={c.micOn ? "Mute" : "Unmute"}
            >
              {c.micOn ? <Mic size={22} /> : <MicOff size={22} />}
            </button>
          )}
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-white">{c.micOn ? "Talking…" : c.micMode === "hold" ? "Hold to talk" : "Microphone off"}</div>
            <div className="text-[12px] text-neutral-500">{c.micMode === "hold" ? "or hold Space · release to send" : "click to turn the microphone on or off"}</div>
          </div>
          <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12px]">
            {(["hold", "open"] as const).map((m) => (
              <button
                key={m}
                className={`rounded-full px-3 py-1 transition-colors ${c.micMode === m ? "bg-white/[0.14] text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                onClick={() => c.setMicMode(m)}
              >
                {m === "hold" ? "Hold" : "Open mic"}
              </button>
            ))}
          </div>
        </>
      )}

      {/* the text path (LANG-7): same translation, for noisy rooms */}
      {c.sendText && c.role !== "observer" && (
        <form
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-white/[0.05] pl-4 pr-1 focus-within:bg-white/[0.08]"
          onSubmit={(ev) => {
            ev.preventDefault();
            c.sendText?.(text);
            setText("");
          }}
        >
          <input
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            onKeyDown={(ev) => ev.stopPropagation()}
            placeholder="Or type a message, the room translates it"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-white outline-none placeholder:text-neutral-600"
          />
          <button className="grid h-8 w-8 place-items-center rounded-full bg-white text-black disabled:opacity-30" disabled={!text.trim()} aria-label="Send">
            <Send size={13} />
          </button>
        </form>
      )}
      {!c.sendText && <span className="flex-1" />}

      {c.soundBlocked && (
        <button className="btn h-10 gap-1.5 px-3 text-[13px] text-amber" data-testid="call-sound" onClick={() => void c.enableSound()}>
          <Volume2 size={14} /> Enable sound
        </button>
      )}
      {c.devices.mics.length > 0 && c.role === "operator" && (
        <select
          className="h-9 max-w-[160px] rounded-full bg-white/[0.05] px-3 text-[12px] text-neutral-300 outline-none"
          value={c.devices.micId ?? ""}
          disabled={c.state !== "joined"}
          onChange={(e) => void c.devices.chooseMic(e.target.value)}
          aria-label="Microphone"
        >
          <option value="">Default microphone</option>
          {c.devices.mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      )}
      {c.devices.canChooseSpeaker && c.devices.speakers.length > 0 && (
        <select
          className="h-9 max-w-[160px] rounded-full bg-white/[0.05] px-3 text-[12px] text-neutral-300 outline-none"
          value={c.devices.speakerId ?? ""}
          disabled={c.state !== "joined"}
          onChange={(e) => c.devices.chooseSpeaker(e.target.value)}
          aria-label="Speaker"
        >
          <option value="">Default speaker</option>
          {c.devices.speakers.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      )}
      <button
        className="btn h-10 gap-1.5 px-3.5 text-[13px] text-neutral-300 hover:text-red"
        data-testid="call-leave"
        onClick={() => {
          sfx.close();
          void c.leave();
        }}
      >
        <LogOut size={14} /> Leave
      </button>
    </div>
  );
}
