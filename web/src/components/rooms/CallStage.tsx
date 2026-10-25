"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Languages, Loader2, LogOut, MessageSquare, Mic, MicOff, PhoneCall, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState, type PointerEvent, type ReactNode } from "react";
import type { Lang } from "@/call/api";
import type { CallParticipant, UseCoordinationCall } from "@/call/useCoordinationCall";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { ClaudeGlyph } from "@/components/ops/Glyphs";
import { RoomTimeline, withValues } from "@/components/roomChat/RoomTimeline";
import { Select } from "@/components/ui/Popover";
import type { RoomCard } from "@/components/roomChat/model";
import { useAudioLevel } from "./useAudioLevel";
import { VoiceBlob } from "./VoiceBlob";

// The coordination call, in the app's design, on useCoordinationCall (or its dev stand-in: same shape).
// Two modes, switched in the middle of the room: Voice (a dot sphere that moves with your voice and the
// translated voice of the others, the latest phrase as a subtitle) and Text (the room's messages and an input;
// the microphone is off while typing). Rules from the call module: join from a click; only the primary button
// talks; speech never approves anything.

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
export type StageMode = "voice" | "text";

/** Flag per participant identity, from the room's parties (falls back to none). */
export type FlagOf = (p: CallParticipant) => string | null;

export function CallStage({
  call: c,
  title,
  subtitle,
  flagOf,
  cards,
  mode,
  onMode,
  compact = false,
  lockedBy,
}: {
  /** Another party is deciding: this dispatcher's voice and text pause until it is their turn. */
  lockedBy?: string;
  /** Inside the case view: the case header already names it, so only the live state and translator show. */
  compact?: boolean;
  call: StageCall;
  title: ReactNode;
  subtitle?: ReactNode;
  flagOf: FlagOf;
  cards?: RoomCard[];
  /** Owned by the caller so Space-to-talk can follow it (off while typing). */
  mode: StageMode;
  onMode: (m: StageMode) => void;
}) {
  const joined = c.state === "joined" || c.state === "reconnecting";
  const othersSpeaking = c.participants.some((p) => !p.isMe && !p.isTranslator && p.speaking);
  const level = useAudioLevel({ micOn: c.micOn, othersSpeaking });

  const switchTo = (m: StageMode) => {
    if (m === mode) return;
    sfx.click();
    // typing turns the microphone off; coming back to voice leaves it off until the person talks
    if (m === "text") {
      c.stopTalking();
      if (c.micMode === "open" && c.micOn) c.toggleMic();
    }
    onMode(m);
  };

  if (compact) return <DockedCall c={c} level={level} joined={joined} lockedBy={lockedBy} mode={mode} onMode={switchTo} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="call-panel" data-state={c.state} data-mode={mode}>
      {/* header */}
      <div className="flex items-start gap-3 px-6 pb-3 pt-5">
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

      {/* voice or text, switched in the middle of the room */}
      {joined && <ModeSwitch mode={mode} onMode={switchTo} />}

      {/* clipped: in the short case-view slot the voice view must never spill over the switch above it */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {!joined || mode === "voice" ? (
            <motion.div
              key="voice"
              initial={{ opacity: 0, scale: 0.97, filter: "blur(6px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.97, filter: "blur(6px)" }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
            >
              <VoiceView c={c} level={level} joined={joined} size={300} lockedBy={lockedBy} />
            </motion.div>
          ) : (
            <motion.div
              key="text"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 flex flex-col"
            >
              <RoomTimeline
                messages={c.captions ?? []}
                cards={cards}
                myUserId={c.identity?.replace(/^user-/, "") ?? null}
                testId="call-captions"
                empty="No messages yet. Type below, or switch to Voice and talk."
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Controls c={c} joined={joined} mode={mode} lockedBy={lockedBy} />
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

/** "Dispatcher US" → "DU", "Ирина Волкова" → "ИВ": two letters for a tile without a flag. */
function initials(name: string) {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** One tile per person, name underneath. A single element carries the speaking ring; nothing is boxed twice. */
function Participants({ list, flagOf }: { list: CallParticipant[]; flagOf: FlagOf }) {
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden" data-testid="call-participants">
      <div className="flex flex-wrap items-start gap-6 px-6 pb-2 pt-1">
        {list.map((p) => {
          const flag = flagOf(p);
          return (
            <div key={p.identity} data-identity={p.identity} data-speaking={p.speaking} className="flex w-[104px] flex-col items-center text-center">
              <span
                className="grid h-11 w-11 place-items-center overflow-hidden rounded-[11px] bg-[#16171b] transition-shadow duration-200"
                style={{ boxShadow: p.speaking ? "0 0 0 2px var(--green), 0 0 22px -4px rgba(61,220,151,0.75)" : "0 0 0 1px rgba(255,255,255,0.12)" }}
              >
                {p.isTranslator ? (
                  <ClaudeGlyph size={18} />
                ) : flag ? (
                  <Flag code={flag} h={44} square />
                ) : (
                  <span className="text-[12px] font-semibold tracking-[0.02em] text-neutral-300">{initials(p.name)}</span>
                )}
              </span>
              <span className="mt-1.5 w-full truncate text-[12px] font-medium leading-tight text-white">{p.isTranslator ? "Translator" : p.name}</span>
              <span className="w-full truncate text-[11px] leading-tight text-neutral-500">
                {p.isMe ? "you · " : ""}
                {p.isTranslator ? "numbers locked" : p.lang ? LANG_NAME[p.lang] : ""}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function ModeSwitch({ mode, onMode, bare = false }: { mode: StageMode; onMode: (m: StageMode) => void; bare?: boolean }) {
  return (
    <div className={bare ? "flex" : "flex justify-center pb-1 pt-2"}>
      <div className="flex rounded-full bg-white/[0.05] p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" role="tablist" aria-label="Talk or type">
        {(
          [
            { id: "voice", label: "Voice", icon: <Mic size={13} /> },
            { id: "text", label: "Text", icon: <MessageSquare size={13} /> },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            data-testid={`call-mode-${m.id}`}
            className={`relative flex h-8 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium transition-colors ${mode === m.id ? "text-black" : "text-neutral-400 hover:text-white"}`}
            onClick={() => onMode(m.id)}
          >
            {mode === m.id && <motion.span layoutId="call-mode-pill" className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
            <span className="relative flex items-center gap-1.5">
              {m.icon}
              {m.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The blob, what is happening in one line, and the latest phrase as a subtitle. */
function VoiceView({ c, level, joined, size, lockedBy }: { c: StageCall; level: ReturnType<typeof useAudioLevel>; joined: boolean; size: number; lockedBy?: string }) {
  const speaker = c.participants.find((p) => !p.isMe && !p.isTranslator && p.speaking);
  const last = (c.captions ?? []).at(-1);
  const mine = last?.author.kind === "human" && last.author.userId === c.identity?.replace(/^user-/, "");
  const who = !last ? "" : last.author.kind === "human" ? (mine ? "You" : last.author.name) : last.author.kind === "agent" ? last.author.role : "System";
  const status = !joined
    ? "Join to talk. Each of you speaks your own language."
    : lockedBy
      ? `${lockedBy} is deciding · your voice is paused until it is your turn`
      : c.micOn
      ? "You're speaking · the room hears it in their language"
      : speaker
        ? `${speaker.name} is speaking`
        : c.micMode === "hold"
          ? "Hold the button or Space to talk"
          : "Microphone off · click the button to open it";
  return (
    <div className="flex h-full flex-col items-center justify-center px-8">
      <div className={`pointer-events-none shrink-0 ${joined ? "" : "opacity-50"}`}>
        <VoiceBlob level={level} size={size} />
      </div>
      <div className="mt-1 text-[13px] font-medium" style={{ color: c.micOn ? "var(--green)" : speaker ? "#dbe7ff" : "#8a8a8a" }}>
        {status}
      </div>
      <div className="mt-4 flex min-h-[64px] w-full max-w-[640px] items-start justify-center text-center">
        <AnimatePresence mode="wait">
          {joined && last && (
            <motion.div
              key={last.messageId + last.translationStatus}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              data-testid="call-subtitle"
            >
              <div className="text-[11.5px] text-neutral-500">{who}</div>
              <div className="mt-1 text-[17px] leading-[1.5] text-neutral-100">
                {last.translationStatus === "pending" && !mine ? <span className="shimmer">Translating…</span> : withValues(mine ? last.originalText : last.text, last.values)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The call docked under the decision: one row. The sphere is the talk button (hold it, or Space; a click toggles in
 * open-mic mode), the middle says what is happening and shows the latest phrase, or the text field in Text mode.
 */
function DockedCall({
  c,
  level,
  joined,
  lockedBy,
  mode,
  onMode,
}: {
  c: StageCall;
  level: ReturnType<typeof useAudioLevel>;
  joined: boolean;
  lockedBy?: string;
  mode: StageMode;
  onMode: (m: StageMode) => void;
}) {
  const speaker = c.participants.find((p) => !p.isMe && !p.isTranslator && p.speaking);
  const last = (c.captions ?? []).at(-1);
  const mine = last?.author.kind === "human" && last.author.userId === c.identity?.replace(/^user-/, "");
  const who = !last ? "" : last.author.kind === "human" ? (mine ? "You" : last.author.name) : last.author.kind === "agent" ? last.author.role : "System";
  const observer = c.role === "observer";
  const canTalk = joined && !observer && c.canTalk && !lockedBy && mode === "voice";
  const status = !joined
    ? c.state === "joining"
      ? "Joining the case's call…"
      : "Not in the call"
    : observer
      ? "Observer · listen only"
      : lockedBy
        ? `${lockedBy} is deciding · your voice is paused`
        : c.micOn
          ? "You're speaking"
          : speaker
            ? `${speaker.name} is speaking`
            : mode === "voice"
              ? c.micMode === "hold"
                ? "Hold the sphere or Space to talk"
                : "Click the sphere to unmute"
              : "Typing · the room reads it in their language";
  const press = (e: PointerEvent) => {
    if (e.button === 0 && c.micMode === "hold") {
      sfx.toggle(true);
      c.startTalking();
    }
  };
  return (
    <div className="flex flex-col" data-testid="call-panel" data-state={c.state} data-mode={mode}>
      {c.error && (
        <div className="mx-auto mt-3 flex w-[calc(100%-48px)] max-w-[860px] items-center gap-3 rounded-[12px] bg-[rgba(255,90,79,0.1)] px-4 py-2 text-[12.5px] text-[#ff8a80]" role="alert" data-testid="call-error" data-code={c.error.code}>
          {ERROR_TEXT[c.error.code] ?? `${c.error.code}: ${c.error.message}`}
          <button className="ml-auto text-[12px] text-neutral-400 underline" onClick={c.clearError}>
            Dismiss
          </button>
        </div>
      )}
      {/* the same column as the meeting above it, so the dock lines up with the chat */}
      <div className="mx-auto flex w-full max-w-[908px] items-center gap-4 px-6 py-3">
        <Tooltip label={canTalk ? (c.micMode === "hold" ? "Hold to talk · or hold Space" : c.micOn ? "Click to mute" : "Click to unmute") : status}>
          <button
            className="relative grid h-[68px] w-[68px] shrink-0 place-items-center rounded-full transition-[transform,opacity] active:scale-95 disabled:cursor-default"
            style={{
              opacity: canTalk || c.micOn ? 1 : 0.45,
              boxShadow: c.micOn ? "0 0 0 2px var(--green), 0 0 28px -6px rgba(61,220,151,0.8)" : "inset 0 0 0 1px rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.025)",
            }}
            data-testid="call-talk"
            data-on={c.micOn}
            disabled={!canTalk}
            onPointerDown={press}
            onPointerUp={() => c.micMode === "hold" && c.stopTalking()}
            onPointerLeave={() => c.micMode === "hold" && c.stopTalking()}
            onPointerCancel={() => c.micMode === "hold" && c.stopTalking()}
            onClick={() => c.micMode === "open" && c.toggleMic()}
            aria-label={c.micMode === "hold" ? "Hold to talk" : c.micOn ? "Mute" : "Unmute"}
          >
            <span className="pointer-events-none">
              <VoiceBlob level={level} size={64} />
            </span>
          </button>
        </Tooltip>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${joined ? "bg-green" : "bg-neutral-600"}`} style={joined ? { boxShadow: "0 0 8px var(--green)" } : undefined} />
            <span className="truncate font-medium" style={{ color: c.micOn ? "var(--green)" : speaker ? "#dbe7ff" : "#8a8a8a" }}>
              {status}
            </span>
            {c.simulated && <span className="shrink-0 rounded-full bg-[rgba(255,159,64,0.12)] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em] text-orange">simulated</span>}
          </div>
          {joined && mode === "text" && !observer ? (
            <Composer c={c} lockedBy={lockedBy} className="mt-2" />
          ) : (
            <AnimatePresence mode="wait">
              {joined && last ? (
                <motion.div key={last.messageId + last.translationStatus} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} data-testid="call-subtitle" className="mt-1 truncate text-[14px] leading-[1.45]">
                  <span className="text-neutral-500">{who} · </span>
                  <span className="text-neutral-100">{last.translationStatus === "pending" && !mine ? <span className="shimmer">Translating…</span> : withValues(mine ? last.originalText : last.text, last.values)}</span>
                </motion.div>
              ) : (
                <div className="mt-1 text-[13px] text-neutral-600">{joined ? "Phrases appear here, translated for you." : ""}</div>
              )}
            </AnimatePresence>
          )}
        </div>

        {joined ? (
          <div className="flex shrink-0 items-center gap-2">
            {!observer && <ModeSwitch mode={mode} onMode={onMode} bare />}
            {!observer && <SoundToggle />}
            {c.soundBlocked && (
              <button className="btn h-10 shrink-0 gap-1.5 px-3 text-[13px] text-amber" data-testid="call-sound" onClick={() => void c.enableSound()}>
                <Volume2 size={14} /> Enable sound
              </button>
            )}
            <Tooltip label="Leave the call">
              <button
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.05] text-neutral-300 transition-colors hover:bg-[rgba(255,90,79,0.14)] hover:text-[#ff8a80]"
                data-testid="call-leave"
                aria-label="Leave the call"
                onClick={() => {
                  sfx.close();
                  void c.leave();
                }}
              >
                <LogOut size={15} />
              </button>
            </Tooltip>
          </div>
        ) : (
          c.state !== "joining" && (
            <button
              className="btn btn-primary h-10 shrink-0 gap-2 px-4 text-[13px]"
              data-testid="call-join"
              disabled={!c.ready}
              onClick={() => {
                sfx.chime();
                void c.join();
              }}
            >
              <PhoneCall size={14} /> {c.state === "left" ? "Join again" : "Join the call"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Rounded message field with a round send button: typed text goes through the same translation as speech. */
function Composer({ c, lockedBy, className = "" }: { c: StageCall; lockedBy?: string; className?: string }) {
  const [text, setText] = useState("");
  return (
    // the text path (LANG-7): same translation, for noisy rooms. Live calls get it with the room-messages backend
    <form
      className={`flex h-11 min-w-0 items-center gap-2 rounded-[22px] bg-white/[0.05] pl-4 pr-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-colors focus-within:bg-white/[0.08] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] ${c.sendText ? "" : "opacity-60"} ${className}`}
      title={c.sendText ? undefined : "Typed messages in live calls need room messages on the backend (messages.send) and a worker that voices text"}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!text.trim()) return;
        c.sendText?.(text);
        setText("");
      }}
    >
      <input
        value={text}
        disabled={!c.sendText || c.role === "observer" || !!lockedBy}
        autoFocus
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => ev.stopPropagation()}
        placeholder={c.role === "observer" ? "Observers read only" : lockedBy ? `${lockedBy} is deciding · you can type when it is your turn` : c.sendText ? "Message the room · each side reads it in their language" : "Typing in live calls is coming · switch to Voice to talk"}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-neutral-600"
      />
      <button className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black transition-opacity disabled:opacity-25" disabled={!c.sendText || !text.trim()} aria-label="Send">
        <ArrowUp size={15} strokeWidth={2.4} />
      </button>
    </form>
  );
}

/**
 * Mutes the translated voices this tab plays. The call module plays them through <audio data-publication> elements
 * it adds to the page (src/call/audio.ts, not edited here); muting those, and any added later, silences the room for
 * this listener only. Speaking is unaffected.
 */
function SoundToggle() {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const apply = () => document.querySelectorAll<HTMLAudioElement>("audio[data-publication]").forEach((a) => (a.muted = muted));
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [muted]);
  useEffect(() => () => document.querySelectorAll<HTMLAudioElement>("audio[data-publication]").forEach((a) => (a.muted = false)), []);
  return (
    <Tooltip label={muted ? "Turn the translated voices back on" : "Mute the translated voices for you"}>
      <button
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.05] text-neutral-300 transition-colors hover:bg-white/[0.09] hover:text-white"
        style={muted ? { background: "rgba(255,90,79,0.14)", color: "#ff8a80" } : undefined}
        aria-pressed={muted}
        aria-label={muted ? "Unmute translated voices" : "Mute translated voices"}
        onClick={() => {
          sfx.toggle(!muted);
          setMuted((m) => !m);
        }}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </Tooltip>
  );
}

function Controls({ c, joined, mode, lockedBy }: { c: StageCall; joined: boolean; mode: StageMode; lockedBy?: string }) {
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

  const leave = (
    <button
      className="btn h-10 shrink-0 gap-1.5 px-3.5 text-[13px] text-neutral-300 hover:text-red"
      data-testid="call-leave"
      onClick={() => {
        sfx.close();
        void c.leave();
      }}
    >
      <LogOut size={14} /> Leave
    </button>
  );
  const sound = c.soundBlocked && (
    <button className="btn h-10 shrink-0 gap-1.5 px-3 text-[13px] text-amber" data-testid="call-sound" onClick={() => void c.enableSound()}>
      <Volume2 size={14} /> Enable sound
    </button>
  );

  if (mode === "text") {
    return (
      <div className="flex items-center gap-3 border-t border-white/[0.06] px-6 py-4">
        <Composer c={c} lockedBy={lockedBy} className="flex-1" />
        {c.role !== "observer" && <SoundToggle />}
        {sound}
        {leave}
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
              disabled={!c.canTalk || !!lockedBy}
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
              disabled={!c.canTalk || !!lockedBy}
              onClick={c.toggleMic}
              aria-label={c.micOn ? "Mute" : "Unmute"}
            >
              {c.micOn ? <Mic size={22} /> : <MicOff size={22} />}
            </button>
          )}
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
      <span className="flex-1" />
      {c.role !== "observer" && <SoundToggle />}
      {sound}
      {c.devices.mics.length > 0 && c.role === "operator" && (
        <Select
          size="md"
          label="Microphone"
          value={c.devices.micId ?? ""}
          disabled={c.state !== "joined"}
          onChange={(id) => void c.devices.chooseMic(id)}
          options={[{ value: "", label: "Default microphone" }, ...c.devices.mics.map((d) => ({ value: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 6)}` }))]}
          icon={<Mic size={13} className="shrink-0 text-neutral-500" />}
          width={280}
          maxTriggerWidth={190}
        />
      )}
      {c.devices.canChooseSpeaker && c.devices.speakers.length > 0 && (
        <Select
          size="md"
          label="Speaker"
          value={c.devices.speakerId ?? ""}
          disabled={c.state !== "joined"}
          onChange={(id) => c.devices.chooseSpeaker(id)}
          options={[{ value: "", label: "Default speaker" }, ...c.devices.speakers.map((d) => ({ value: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 6)}` }))]}
          icon={<Volume2 size={13} className="shrink-0 text-neutral-500" />}
          width={280}
          maxTriggerWidth={190}
        />
      )}
      {leave}
    </div>
  );
}
