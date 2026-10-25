"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallMessage, Lang, ProtectedValue } from "@/call/api";
import type { CallParticipant, CallState, MicMode, UseCoordinationCall } from "@/call/useCoordinationCall";
import { fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party } from "@/lib/ops/types";

// Dev mode stand-in for useCoordinationCall: the same return shape, so the room screen cannot tell the difference.
// No LiveKit, no audio. My own phrases come from the browser's speech recognition (or the text box); the other
// side's lines are scripted in their language with an English translation, and labeled simulated.

const LANG_OF: Record<string, Lang> = { English: "en", Russian: "ru", Chinese: "zh", Japanese: "en" };

/** Numbers with units, times and designators become protected values, like the worker's tokenizer. */
export function protect(text: string): ProtectedValue[] {
  // times, case IDs and numbers with a unit; digits inside a name like STARLINK-34510 stay part of the name
  const re = /((?:\w{3} )?\d{2}:\d{2}(?: UTC)?|\bCE-\d+|(?<![\w-])\d[\d.,]*\s?(?:m\/s|km\/s|km|m|g|h|%)(?!\w)|(?<![\w-])1 in [\d,]+\d)/g;
  return [...text.matchAll(re)].map((m, i) => ({
    placeholder: `⟦v${i + 1}⟧`,
    kind: /:\d{2}/.test(m[0]) ? "datetime" : /CE-/.test(m[0]) ? "object_id" : "number",
    text: m[0].trim(),
  }));
}

export function msg(
  e: ConjunctionEvent,
  author: CallMessage["author"],
  originalLang: Lang,
  originalText: string,
  text: string,
  at = Date.now(),
): CallMessage {
  const id = `sim-${at}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    messageId: id,
    roomId: e.id,
    eventId: e.id,
    at: new Date(at).toISOString(),
    author,
    kind: "voice",
    text,
    originalText,
    originalLang,
    translationStatus: "ok",
    values: protect(originalText),
    translationError: null,
    voiceError: null,
    refs: { eventId: e.id, revision: e.proposal?.version },
    form: null,
    simulated: true,
    segId: id,
    rev: 1,
  };
}

const planLine = (e: ConjunctionEvent) =>
  e.proposal
    ? e.proposal.action === "wait"
      ? "both sides wait for the next CDM"
      : `${e.proposal.mover === "a" ? e.a.name : e.b.name} ${e.proposal.action}s ${e.proposal.dvMs} m/s at ${fmtWhen(e.proposal.burnAt!)}`
    : "the agents are still preparing a plan";

/** What the other side says back, in Russian with the English the room would give. */
const B_LINES: { ru: string; en: string }[] = [
  { ru: "Принято. Жду подтверждения плана в карточке события.", en: "Understood. I'm waiting for the plan to be confirmed on the event card." },
  { ru: "С нашей стороны возражений нет, если манёвр не задевает окно съёмки.", en: "No objection from our side, as long as the maneuver doesn't touch the imaging window." },
  { ru: "Подтверждаю: наш спутник остаётся на месте.", en: "Confirmed: our satellite stays where it is." },
];

export function useSimCall(
  e: ConjunctionEvent | undefined,
  opts: { seed?: CallMessage[]; joined?: boolean; spaceToTalk?: boolean } = {},
): UseCoordinationCall & { simulated: true; sendText: (t: string) => void } {
  const replies = useOps((s) => s.replies);
  // the sample room starts mid-conversation, already joined, so its look is visible at once
  const [state, setState] = useState<CallState>(opts.joined ? "joined" : "idle");
  const [micMode, setMicMode] = useState<MicMode>("hold");
  const [micOn, setMicOn] = useState(false);
  const [mine, setMine] = useState<CallMessage[]>(opts.seed ?? []);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const bTurn = useRef(0);
  const rec = useRef<{ stop: () => void } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const parties: Party[] = useMemo(() => e?.parties ?? [], [e?.parties]);
  const meParty = parties.find((p) => p.role === "a");
  const bParty = parties.find((p) => p.role === "b");

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const human = (p: Party | undefined, fallback: string): CallMessage["author"] => ({
    kind: "human",
    userId: p?.id ?? fallback,
    companyId: p?.owner ?? "",
    name: (p?.operator ?? fallback).replace(/\s*\(synthetic\)/i, ""),
    side: null,
  });

  // the room's own history: what the people already said through the decision flow
  const fromReplies = useMemo(() => {
    if (!e) return [];
    return replies
      .filter((r) => r.eventId === e.id && r.note)
      .map((r) => {
        const p = parties.find((x) => x.role === r.side);
        const lang = r.original ? (LANG_OF[r.lang ?? ""] ?? "ru") : "en";
        return msg(e, human(p, `Operator ${r.side.toUpperCase()}`), lang, r.original ?? r.note!, r.note!, r.t);
      });
  }, [replies, e, parties]);

  const say = useCallback(
    (text: string) => {
      if (!e || !text.trim()) return;
      const m = msg(e, human(meParty, "you"), "en", text.trim(), text.trim());
      setMine((x) => [...x, { ...m, translationStatus: "pending" }]);
      // "translation" settles, then the other side answers after a pause
      later(900, () => setMine((x) => x.map((y) => (y.messageId === m.messageId ? { ...y, translationStatus: "ok" } : y))));
      if (bParty) {
        const line = B_LINES[bTurn.current++ % B_LINES.length];
        later(3800, () => setSpeaking(bParty.id));
        later(5200, () => {
          setSpeaking(null);
          setMine((x) => [...x, msg(e, human(bParty, "Operator B"), "ru", line.ru, line.en)]);
        });
      }
    },
    [e, meParty, bParty, later],
  );

  const join = useCallback(async () => {
    if (!e) return;
    setState("joining");
    later(700, () => {
      setState("joined");
      // the host opens the room with a summary in each listener's language
      setMine((x) => [
        ...x,
        msg(
          e,
          { kind: "agent", role: "Coordination Host", side: null },
          "en",
          `Room open for ${e.id}. ${e.a.name} and ${e.b.name} pass ${fmtMiss(e.missM)} apart on ${fmtWhen(e.tca)}, chance ${fmtOdds(e.pc)}. Current plan: ${planLine(e)}.`,
          `Room open for ${e.id}. ${e.a.name} and ${e.b.name} pass ${fmtMiss(e.missM)} apart on ${fmtWhen(e.tca)}, chance ${fmtOdds(e.pc)}. Current plan: ${planLine(e)}.`,
        ),
      ]);
    });
  }, [e, later]);

  const leave = useCallback(async () => {
    rec.current?.stop();
    setMicOn(false);
    setState("left");
  }, []);

  const startTalking = useCallback(() => {
    if (state !== "joined") return;
    setMicOn(true);
    setSpeaking("me");
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = false;
    r.continuous = true;
    let text = "";
    r.onresult = (ev) => {
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    };
    r.onend = () => say(text);
    rec.current = r;
    try {
      r.start();
    } catch {
      /* a second start while one runs */
    }
  }, [state, say]);

  const stopTalking = useCallback(() => {
    setMicOn(false);
    setSpeaking(null);
    rec.current?.stop();
    rec.current = null;
  }, []);

  const toggleMic = useCallback(() => (micOn ? stopTalking() : startTalking()), [micOn, startTalking, stopTalking]);

  // Space to talk in hold mode, like the real hook (never while typing)
  useEffect(() => {
    if (micMode !== "hold" || state !== "joined" || opts.spaceToTalk === false) return;
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" || ev.repeat || typing(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      startTalking();
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" || typing(ev.target)) return;
      ev.preventDefault();
      stopTalking();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [micMode, state, startTalking, stopTalking, opts.spaceToTalk]);

  const participants: CallParticipant[] = useMemo(() => {
    if (state !== "joined") return [];
    // everyone the case involves is in the room: the two sides and any affected operator (2-4 operators)
    const list: CallParticipant[] = parties
      .map((p) => ({
        identity: `user-${p.id}`,
        name: p.operator.replace(/\s*\(synthetic\)/i, ""),
        lang: LANG_OF[p.language ?? ""] ?? "en",
        isTranslator: false,
        isMe: p.role === "a",
        speaking: p.role === "a" ? speaking === "me" : speaking === p.id,
      }));
    list.push({ identity: "translator", name: "Translator", lang: null, isTranslator: true, isMe: false, speaking: false });
    return list;
  }, [state, parties, speaking]);

  const captions = useMemo(() => [...fromReplies, ...mine].sort((a, b) => a.at.localeCompare(b.at)), [fromReplies, mine]);

  return {
    simulated: true,
    sendText: say,
    ready: !!e,
    state,
    error: null,
    clearError: () => {},
    presenceError: null,
    identity: meParty ? `user-${meParty.id}` : null,
    lang: "en",
    role: "operator",
    join,
    leave,
    micMode,
    setMicMode,
    micOn,
    canTalk: state === "joined",
    startTalking,
    stopTalking,
    toggleMic,
    soundBlocked: false,
    enableSound: async () => {},
    translatorPresent: state === "joined",
    translationTracks: state === "joined" && bParty ? 1 : 0,
    participants,
    captions,
    devices: { mics: [], speakers: [], micId: null, speakerId: null, canChooseSpeaker: false, chooseMic: async () => {}, chooseSpeaker: () => {} },
  };
}

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};
