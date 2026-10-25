"use client";

import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, Languages, Mic, MicOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, DecisionOption, Party, Reply } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { ProposalPanel } from "@/components/proposals/ProposalPanel";

// The dispatcher's decision, in the middle of the screen (ROOM-5, ROOM-7): the plan cards live in
// components/proposals; this file keeps the room states around them. Originally: the summary,
// four options with the agents' pick marked, and a free answer by text or voice.
// Then the room: waiting for the other side, their reply with its translation, the result.

type Mode = "decide" | "waiting" | "reply" | "done";

/** "Raise STARLINK-3741" plus the burn details on a second line, so similar options never read the same. */
export function optionText(e: ConjunctionEvent, o: Pick<DecisionOption, "mover" | "action" | "dvMs" | "burnAt">) {
  if (o.action === "wait") return { verb: "Wait", who: null as "a" | "b" | null, sub: "No burn · next CDM decides" };
  const lead = o.burnAt ? Math.round((e.tca - o.burnAt) / 3600_000) : null;
  return {
    verb: o.action === "raise" ? "Raise" : "Lower",
    who: o.mover === "none" ? null : o.mover,
    sub: `${o.dvMs} m/s${o.burnAt ? ` · burn ${fmtWhen(o.burnAt)}` : ""}${lead !== null ? ` · ${lead} h before TCA` : ""}`,
  };
}

function partyOf(e: ConjunctionEvent, side: "a" | "b"): Party | undefined {
  return e.parties?.find((p) => p.role === side);
}

/** Where the room stands for the person at this screen: deciding, waiting, reading a reply, or done. */
export function useRoomState(e: ConjunctionEvent | undefined, now: number) {
  const actAs = useOps((s) => s.actAs);
  const humans = useOps((s) => s.humans);
  const replies = useOps((s) => s.replies);
  const viewer: "a" | "b" = actAs ?? "a";
  const other: "a" | "b" = viewer === "a" ? "b" : "a";
  const state = useMemo(() => {
    if (!e) return null;
    const prompt = humans.find((h) => h.eventId === e.id && h.side === viewer);
    const mine = [...replies].reverse().find((r) => r.eventId === e.id && r.side === viewer);
    const theirs = [...replies].reverse().find((r) => r.eventId === e.id && r.side === other);
    const twoSided = e.b.kind !== "debris";
    let mode: Mode | null = null;
    if (prompt) mode = "decide";
    else if (theirs && mine && theirs.t >= mine.t && now - theirs.t < 7000) mode = "reply";
    else if (twoSided && mine && (e.status === "communication" || e.status === "proposal") && e.approvals[viewer] !== "pending" && e.approvals[other] === "pending")
      mode = "waiting";
    else if (mine && ["approved", "scheduled"].includes(e.status) && now - Math.max(mine.t, theirs?.t ?? 0) < 9000) mode = "done";
    return mode ? { mode, mine, theirs } : null;
  }, [e, humans, replies, viewer, other, now]);
  return { state, viewer, other };
}

export function DecisionDock() {
  const tab = useOps((s) => s.tab);
  const e = useOps((s) => s.events.find((x) => x.id === s.focusEvent));
  const now = useNow(500);
  const resolvedId = useOps((s) => s.resolved?.eventId);
  const incident = useOps((s) => s.incident);
  const room = useRoomState(e, now);
  const { viewer, other } = room;
  // the incident view owns its case; the resolution card takes over once it closes
  const state = !e || tab !== "orbit" || resolvedId === e.id || incident === e.id ? null : room.state;

  return (
    <AnimatePresence>
      {e && state && (
        <motion.div
          key={`dock-${e.id}`}
          initial={{ opacity: 0, y: 24, scale: 0.97, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: 16, scale: 0.98, filter: "blur(4px)" }}
          transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
          className="glass glass-strong pointer-events-auto absolute bottom-[98px] left-1/2 z-30 w-[600px] max-w-[calc(100vw-700px)] min-w-[460px] -translate-x-1/2 overflow-hidden rounded-[16px]"
          style={state.mode === "decide" ? { boxShadow: "0 0 0 1px rgba(255,159,64,0.35), 0 30px 70px -18px rgba(0,0,0,0.9), 0 0 40px -10px rgba(255,159,64,0.35)" } : undefined}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state.mode + (e.proposal?.version ?? 0)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              {state.mode === "decide" && <Decide e={e} viewer={viewer} now={now} />}
              {state.mode === "waiting" && <Waiting e={e} other={other} mine={state.mine!} now={now} />}
              {state.mode === "reply" && <TheirReply e={e} r={state.theirs!} />}
              {state.mode === "done" && <Done e={e} />}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------------------------------------------------------- decide */

export function Decide({ e, viewer, now, embedded = false }: { e: ConjunctionEvent; viewer: "a" | "b"; now: number; embedded?: boolean }) {
  return <ProposalPanel e={e} viewer={viewer} now={now} embedded={embedded} />;
}

/* ----------------------------------------------------------------- voice */

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

/** Free answer by text or by voice (Web Speech API where the browser has it). */
export function VoiceInput({ value, onChange, onEnter, lang }: { value: string; onChange: (v: string) => void; onEnter: () => void; lang: string }) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser capability is only known on the client
    if (!SR) setSupported(false);
    return () => rec.current?.stop();
  }, []);

  const toggle = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (ev) => {
      let t = "";
      for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      onChange(t);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    sfx.toggle(true);
    setListening(true);
    r.start();
  };

  return (
    <div
      className="flex h-9 items-center gap-2 rounded-[10px] bg-black/25 pl-3 pr-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]"
      style={listening ? { boxShadow: "inset 0 0 0 1px rgba(255,90,79,0.6), 0 0 18px -6px rgba(255,90,79,0.6)" } : undefined}
    >
      <input
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") onEnter();
          ev.stopPropagation();
        }}
        placeholder={listening ? "Listening…" : "Something else? Type or say it, the room translates it"}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-faint"
      />
      <Tooltip label={<span className="flex items-center gap-1"><Languages size={11} /> Delivered to the other side in {lang === "English" ? "their language" : lang}</span>}>
        <span className="text-faint">
          <Languages size={13} />
        </span>
      </Tooltip>
      <Tooltip label={supported ? (listening ? "Stop" : "Answer by voice") : "Voice input isn't available in this browser"}>
        <button
          className="icon-btn h-7 w-7"
          data-active={listening}
          disabled={!supported}
          onClick={toggle}
          aria-label="Voice input"
          style={listening ? { color: "var(--red)" } : undefined}
        >
          {listening ? <Mic size={14} className="animate-pulse" /> : supported ? <Mic size={14} /> : <MicOff size={14} />}
        </button>
      </Tooltip>
    </div>
  );
}

/* --------------------------------------------------------------- waiting */

export function Waiting({ e, other, mine, now }: { e: ConjunctionEvent; other: "a" | "b"; mine: Reply; now: number }) {
  const them = partyOf(e, other);
  const verb = answerVerb(mine, "You");
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="relative grid h-11 w-11 shrink-0 place-items-center">
        <span className="absolute inset-0 rounded-[12px] border border-white/20" style={{ animation: "ping 1.8s var(--ease-out) infinite" }} />
        <span className="relative grid h-11 w-11 place-items-center overflow-hidden rounded-[12px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
          {them?.country && <Flag code={them.country} h={44} square />}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13.5px] font-semibold tracking-[-0.01em]">
          Waiting for {them?.operator.replace(/\s*\(synthetic\)/i, "") ?? `Operator ${other.toUpperCase()}`}
          <WaitingDots />
        </div>
        <div className="mt-0.5 text-[11px] text-muted">
          {verb}
          {mine.note ? ` · “${mine.note}”` : ""}
          {them?.language && them.language !== "English" ? ` · translated to ${them.language}` : ""}
        </div>
      </div>
      <div className="text-right">
        <div className="mono tnum text-[12px] text-fg-2">{Math.max(0, Math.round((now - mine.t) / 1000))}s</div>
        <div className="text-[9.5px] text-muted">since you answered</div>
      </div>
    </div>
  );
}

function WaitingDots() {
  return (
    <span className="ml-0.5 flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1 w-1 rounded-full bg-fg-2"
          animate={{ opacity: [0.2, 1, 0.2], y: [0, -2, 0] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

/** "You approved P1", "Polar Sat selected P3 for review": how an answer was given, in plain words. */
function answerVerb(r: Reply, who: string) {
  if (r.via === "select") return `${who} selected ${r.label ?? "another plan"} for review`;
  if (r.decision === "approved") return `${who} approved${r.label ? ` ${r.label}` : ""}`;
  if (r.decision === "vetoed") return `${who} vetoed${r.label ? ` ${r.label}` : ""}`;
  return `${who} sent a message`;
}

export function TheirReply({ e, r }: { e: ConjunctionEvent; r: Reply }) {
  const them = partyOf(e, r.side);
  const ok = r.decision === "approved";
  const color = ok ? "var(--green)" : r.decision === "vetoed" ? "var(--red)" : "var(--orange)";
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[9px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
          {them?.country && <Flag code={them.country} h={32} square />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em]" style={{ color }}>
            {answerVerb(r, them?.operator.replace(/\s*\(synthetic\)/i, "") ?? "Other side")}
          </div>
          <div className="text-[11px] text-muted">
            {ok ? "Both sides agree on this version." : r.via === "select" ? "Both sides review it now. Every approval was reset." : "The agents take this as a new constraint and re-plan."}
          </div>
        </div>
      </div>
      {r.note && (
        <div className="mt-2.5 space-y-1.5 rounded-[10px] bg-black/25 p-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          {r.original && (
            <div className="text-[11.5px] text-fg-2">
              <span className="mr-1.5 text-[9.5px] uppercase tracking-[0.1em] text-muted">{r.lang ?? "Original"}</span>“{r.original}”
            </div>
          )}
          <div className="flex items-start gap-1.5 text-[12.5px] text-fg">
            <Languages size={12} className="mt-[3px] shrink-0 text-blue" />“{r.note}”
          </div>
        </div>
      )}
    </div>
  );
}

export function Done({ e }: { e: ConjunctionEvent }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <motion.span
        initial={{ scale: 0.4, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 18 }}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(61,220,151,0.15)] text-green shadow-[0_0_24px_-4px_rgba(61,220,151,0.6)]"
      >
        <CheckCheck size={18} />
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-green">Both approved</div>
        <div className="text-[11px] text-muted">
          {e.status === "scheduled" ? "Scheduled and checked against the catalog. No new conjunctions." : "Writing the maneuver and re-screening the whole catalog…"}
        </div>
      </div>
    </div>
  );
}
