"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, Lock, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CallMessage, Lang } from "@/call/api";
import { Tooltip } from "@/components/ui/Tooltip";
import type { RoomCard } from "./model";

// The room's text: everything people said (voice or typed) in the reader's language with the original one
// click away, protected values set apart, the event each phrase is about, and the shared cards between them.
// It renders the spec Message shape (call module's CallMessage), so live captions and the dev room look alike.

const LANG_NAME: Record<Lang, string> = { en: "English", ru: "Russian", zh: "Mandarin" };

type Item = { kind: "msg"; at: number; m: CallMessage } | { kind: "card"; at: number; c: RoomCard };

export function RoomTimeline({
  messages,
  cards = [],
  myUserId,
  empty,
  testId,
}: {
  messages: CallMessage[];
  cards?: RoomCard[];
  myUserId: string | null;
  empty: ReactNode;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const items = useMemo<Item[]>(
    () =>
      [...messages.map((m) => ({ kind: "msg" as const, at: Date.parse(m.at), m })), ...cards.map((c) => ({ kind: "card" as const, at: c.at, c }))].sort(
        (a, b) => a.at - b.at,
      ),
    [messages, cards],
  );
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items.length]);
  return (
    <div ref={box} className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06] px-6 py-4" data-testid={testId}>
      {items.length === 0 && <div className="grid h-full place-items-center text-center text-[13px] text-neutral-500">{empty}</div>}
      <ol className="space-y-3.5">
        <AnimatePresence initial={false}>
          {items.map((it) => (it.kind === "msg" ? <Message key={it.m.messageId} m={it.m} myUserId={myUserId} /> : <SharedCard key={it.c.id} c={it.c} />))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

/** Protected values (numbers, times, IDs) set apart so a dispatcher sees they were never altered. */
export function withValues(text: string, values: CallMessage["values"], onLight = false) {
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

const hhmm = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
};

/** Which event (and plan revision) a phrase is about: rooms can hold several linked events. */
function Refs({ m }: { m: CallMessage }) {
  const ev = m.refs?.eventId ?? m.eventId;
  if (!ev) return null;
  return (
    <span className="mono rounded-[5px] bg-white/[0.04] px-1.5 py-[1px] text-[10.5px] text-neutral-500">
      {ev}
      {m.refs?.revision ? ` · v${m.refs.revision}` : ""}
    </span>
  );
}

function Message({ m, myUserId }: { m: CallMessage; myUserId: string | null }) {
  const [original, setOriginal] = useState(false);
  const mine = m.author.kind === "human" && m.author.userId === myUserId;
  const who = m.author.kind === "human" ? (mine ? "You" : m.author.name) : m.author.kind === "agent" ? m.author.role : "System";
  // the speaker reads their own words; others read their language, with the original one click away
  const shown = mine || original ? m.originalText : m.text;
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
        <div className={`mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-neutral-500 ${mine ? "justify-end" : ""}`}>
          <span className="font-medium text-neutral-300">{who}</span>
          <span>· {hhmm(Date.parse(m.at))} UTC</span>
          {!mine && m.originalLang && <span>· {m.kind === "voice" ? "spoke" : "wrote"} {LANG_NAME[m.originalLang]}</span>}
          <Refs m={m} />
        </div>
        <div
          className={`inline-block rounded-[16px] px-4 py-2.5 text-left text-[15px] leading-[1.55] ${mine ? "rounded-tr-[4px] bg-white text-black" : "rounded-tl-[4px] bg-white/[0.06] text-neutral-100"}`}
        >
          {m.translationStatus === "pending" && !mine ? <span className="shimmer">Translating…</span> : withValues(shown, m.values, mine)}
        </div>
        <div className={`mt-1 flex flex-wrap items-center gap-2 text-[11.5px] ${mine ? "justify-end" : ""}`}>
          {mine && m.translationStatus === "pending" && (
            <span className="flex items-center gap-1 text-neutral-500">
              <Loader2 size={11} className="animate-spin" /> translating for the room
            </span>
          )}
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

const TONE = {
  ok: { icon: <Check size={12} />, color: "var(--green)" },
  no: { icon: <X size={12} />, color: "#ff8a80" },
  reset: { icon: <RotateCcw size={11} />, color: "var(--orange)" },
  info: { icon: <Lock size={11} />, color: "#a3a3a3" },
} as const;

/** A shared record in the room. Read only: it has no control, and reading it changes nothing. */
function SharedCard({ c }: { c: RoomCard }) {
  const t = TONE[c.tone];
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto max-w-[560px]"
      data-testid="room-card"
      data-can-act="false"
    >
      <div className="rounded-[12px] bg-white/[0.025] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        <div className="flex items-center gap-2 text-[12.5px] font-medium" style={{ color: t.color }}>
          <span className="shrink-0">{t.icon}</span>
          <span className="min-w-0 flex-1">{c.title}</span>
          <span className="tnum shrink-0 text-[11px] font-normal text-neutral-600">{hhmm(c.at)} UTC</span>
        </div>
        {c.detail && <div className="mt-1 pl-5 text-[12px] leading-[1.5] text-neutral-500">{c.detail}</div>}
        <div className="mt-1.5 flex items-center gap-1.5 pl-5 text-[10.5px] text-neutral-600">
          <span className="mono rounded-[5px] bg-white/[0.04] px-1.5 py-[1px]">
            {c.refs.eventId}
            {c.refs.label ? ` · ${c.refs.label}` : ""}
          </span>
          <span>shared record · approves nothing</span>
        </div>
      </div>
    </motion.li>
  );
}
