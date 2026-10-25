"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Check, CheckCheck, CircleDot, Hourglass, RotateCcw, Sparkles, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CallMessage } from "@/call/api";
import { fmtMiss, fmtMs, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { AGENTS, MODELS } from "@/lib/ops/roster";
import { useOps } from "@/lib/ops/store";
import type { AgentId, ConjunctionEvent, Reply, Span } from "@/lib/ops/types";
import { Message } from "@/components/roomChat/RoomTimeline";
import { ProposalPanel } from "@/components/proposals/ProposalPanel";
import { NodeGlyph } from "./Glyphs";
import { ObjectChip, RichLine } from "./Entity";
import type { useRoomState } from "./DecisionDock";

// The Decision Center as one shared meeting, oldest at the top: what people said (voice or typed, in each reader's
// language), the agents' reasoning that matters (each note says which tools it used, so it reads as an agent at
// work, not a bare model call), and quiet lines for every selection, approval and reset. The plans sit at the end
// while a decision is open; the closing report ends the case. Every tool call stays in Agent run.

type Item =
  | { kind: "msg"; at: number; key: string; m: CallMessage }
  | { kind: "agent"; at: number; key: string; s: Span; tools: Span[] }
  | { kind: "line"; at: number; key: string; tone: "ok" | "no" | "reset" | "info" | "select"; who?: string; text: string };

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");

/** Agent steps worth reading in the meeting: model calls that carry reasoning. Tool calls stay in Agent run. */
const isNote = (s: Span) => s.kind === "llm" && s.status === "ok" && !!s.reasoning;

function itemsOf(e: ConjunctionEvent, spans: Span[], replies: Reply[], messages: CallMessage[]): Item[] {
  const who = (side: "a" | "b") => clean(e.parties?.find((p) => p.role === side)?.operator) || `Side ${side.toUpperCase()}`;
  const out: Item[] = messages.map((m) => ({ kind: "msg", at: Date.parse(m.at), key: m.messageId, m }));

  // each note counts the tools its agent used since that agent's previous note
  const mine = spans.filter((s) => s.eventId === e.id).sort((a, b) => a.t0 - b.t0);
  const lastNote = new Map<AgentId, number>();
  for (const s of mine) {
    if (!isNote(s)) continue;
    const from = lastNote.get(s.agent) ?? 0;
    const tools = mine.filter((t) => t.agent === s.agent && t.kind !== "llm" && t.kind !== "handoff" && t.t0 >= from && t.t0 <= s.t0);
    lastNote.set(s.agent, s.t0);
    out.push({ kind: "agent", at: s.t1 ?? s.t0, key: s.id, s, tools });
  }

  for (const p of e.proposals ?? []) {
    if (!p.publishedAt || !p.label) continue;
    if (p.by && p.by !== "agents") continue; // a person's selection is its own line, from the reply
    const n = e.options?.length ?? 4;
    out.push({
      kind: "line",
      at: p.publishedAt,
      key: `pub-${p.version}`,
      tone: p.version > 1 ? "reset" : "info",
      who: "The agents",
      text: p.version > 1 ? `published a revised set · ${p.label} · R${p.revision ?? 1} · approvals reset` : `published ${n} plans · nothing is selected until a side selects`,
    });
  }
  for (const r of replies) {
    if (r.eventId !== e.id) continue;
    if (r.via === "message" || (r.decision === "countered" && !r.via)) continue; // said in the call: already a message
    const line: Item =
      r.via === "select"
        ? { kind: "line", at: r.t, key: `sel-${r.side}-${r.t}`, tone: "select", who: who(r.side), text: `selected ${r.label ?? "a plan"} for both sides` }
        : r.decision === "approved"
          ? { kind: "line", at: r.t, key: `ok-${r.side}-${r.t}`, tone: "ok", who: who(r.side), text: `approved ${r.label ?? "the selected plan"}` }
          : { kind: "line", at: r.t, key: `no-${r.side}-${r.t}`, tone: "no", who: who(r.side), text: `vetoed ${r.label ?? "the selected plan"}${r.note ? ` · “${r.note}”` : ""}` };
    out.push(line);
  }
  return out.sort((a, b) => a.at - b.at);
}

export function Meeting({ e, now, room, onRun }: { e: ConjunctionEvent; now: number; room: ReturnType<typeof useRoomState>; onRun: (agent: AgentId) => void }) {
  const spans = useOps((s) => s.spans);
  const replies = useOps((s) => s.replies);
  const live = useOps((s) => (s.callLive?.eventId === e.id ? s.callLive : null));
  const humans = useOps((s) => s.humans);
  const messages = live?.messages;
  const items = useMemo(() => itemsOf(e, spans, replies, messages ?? []), [e, spans, replies, messages]);
  const st = room.state;
  const deciding = humans.filter((h) => h.eventId === e.id).map((h) => h.side);
  const open = (e.status === "proposal" || e.status === "communication") && !!e.options?.length;
  const closed = !!e.outcome?.checks.length;
  const turnOf = deciding.includes("a") ? "a" : deciding[0];
  const turnName = turnOf ? clean(e.parties?.find((p) => p.role === turnOf)?.operator) : "";

  // stay pinned to the newest entry while the reader is at the bottom; someone reading back is left in place
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    const inner = list.current;
    if (!el || !inner) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    };
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    follow();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // a decision that becomes due is brought into view, even for someone who was reading back
  const due = open && st?.mode === "decide";
  useEffect(() => {
    if (!due) return;
    pinned.current = true;
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [due]);

  return (
    <div ref={box} className="thin-scroll absolute inset-0 overflow-y-auto" data-testid="meeting">
      <div ref={list} className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 pb-6 pt-2">
        <div className="pb-1 text-center text-[11.5px] text-neutral-600">
          Shared with everyone on {e.id} · each person reads it in their own language · nothing here approves anything
        </div>
        <AnimatePresence initial={false}>
          {items.map((it) =>
            it.kind === "msg" ? (
              <ol key={it.key} className="contents">
                <Message m={it.m} myUserId={live?.me ?? null} />
              </ol>
            ) : it.kind === "agent" ? (
              <AgentNote key={it.key} e={e} s={it.s} tools={it.tools} onRun={onRun} />
            ) : (
              <Line key={it.key} at={it.at} tone={it.tone} who={it.who} text={it.text} />
            ),
          )}
        </AnimatePresence>

        {/* the decision, at the end of the meeting while it is open */}
        {due ? (
          <motion.div layout className="rounded-[16px] bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,159,64,0.32)]" data-testid="meeting-decision">
            <ProposalPanel e={e} viewer={room.viewer} now={now} embedded />
          </motion.div>
        ) : open ? (
          <motion.div layout className="rounded-[16px] bg-white/[0.015] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <ProposalPanel e={e} viewer={room.viewer} now={now} embedded readOnly />
            {turnName && (
              <div className="flex items-center gap-2 border-t border-white/[0.06] px-5 py-3 text-[12.5px] text-neutral-500">
                <Hourglass size={12} className="text-[#9cc2ff]" /> {turnName} decides now. Your controls open on your turn.
              </div>
            )}
          </motion.div>
        ) : null}

        {!open && !closed && e.agentsWorking && (
          <div className="flex items-center gap-2.5 pl-1 text-[13px] text-neutral-500">
            <Sparkles size={13} className="text-[#9cc2ff]" />
            <span className="shimmer font-medium">The agents are working · their notes appear here</span>
          </div>
        )}

        {closed && <Report e={e} />}
      </div>
    </div>
  );
}

/** One agent's reasoning, written like an assistant reply, with proof of the work behind it. */
function AgentNote({ e, s, tools, onRun }: { e: ConjunctionEvent; s: Span; tools: Span[]; onRun: (agent: AgentId) => void }) {
  const a = AGENTS[s.agent];
  const [more, setMore] = useState(false);
  const text = s.reasoning ?? "";
  const long = text.length > 320;
  const names = [...new Set(tools.map((t) => t.name.replace(/\(.*\)$/, "")))];
  const ms = tools.reduce((n, t) => n + (t.ms ?? 0), 0) + (s.ms ?? 0);
  const tokens = (s.tokensIn ?? 0) + (s.tokensOut ?? 0);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="flex gap-3" data-testid="agent-note" data-agent={s.agent}>
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <NodeGlyph id={s.agent} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <span className="font-medium text-neutral-200">{a.name}</span>
          <span className="text-neutral-600">{MODELS[a.model].label}</span>
          <span className="text-neutral-700">·</span>
          <span className="text-neutral-600">{s.name}</span>
        </div>
        <div className={`mt-1 text-[14px] leading-[1.65] text-neutral-300 ${long && !more ? "line-clamp-3" : ""}`}>
          <RichLine e={e} text={text} />
        </div>
        {long && (
          <button className="mt-0.5 text-[12px] text-neutral-500 hover:text-white" onClick={() => setMore((m) => !m)}>
            {more ? "Show less" : "Show all"}
          </button>
        )}
        <button
          className="group mt-2 flex max-w-full items-center gap-2 rounded-full bg-white/[0.03] py-1 pl-2 pr-2.5 text-[11.5px] text-neutral-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors hover:bg-white/[0.07] hover:text-neutral-200"
          onClick={() => onRun(s.agent)}
          title="Open this agent's calls in Agent run"
        >
          <Wrench size={11} className="shrink-0" />
          <span className="shrink-0">
            {tools.length ? `${tools.length} tool${tools.length > 1 ? "s" : ""}` : "No tools"}
          </span>
          {names.length > 0 && <span className="truncate text-neutral-600 group-hover:text-neutral-400">{names.join(", ")}</span>}
          <span className="shrink-0 text-neutral-700">·</span>
          <span className="tnum shrink-0">{fmtMs(ms)}</span>
          {tokens > 0 && (
            <>
              <span className="shrink-0 text-neutral-700">·</span>
              <span className="tnum shrink-0">{(tokens / 1000).toFixed(1)}k tokens</span>
            </>
          )}
          <ArrowUpRight size={11} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </div>
    </motion.div>
  );
}

const LINE = {
  ok: { icon: <Check size={10} strokeWidth={3} />, color: "var(--green)" },
  no: { icon: <X size={10} strokeWidth={3} />, color: "#ff8a80" },
  reset: { icon: <RotateCcw size={10} />, color: "var(--orange)" },
  info: { icon: <Sparkles size={10} />, color: "#9cc2ff" },
  select: { icon: <CircleDot size={10} />, color: "#e5e5e5" },
} as const;

const hhmm = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
};

/** A quiet record line: who did what, when. It reads in passing and controls nothing. */
function Line({ at, tone, who, text }: { at: number; tone: keyof typeof LINE; who?: string; text: string }) {
  const t = LINE[tone];
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex items-center gap-2.5 pl-1.5 text-[12.5px]" data-testid="meeting-line" data-tone={tone}>
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full" style={{ color: t.color, background: "rgba(255,255,255,0.04)" }}>
        {t.icon}
      </span>
      <span className="min-w-0 truncate text-neutral-500">
        {who && <span className="font-medium text-neutral-300">{who} </span>}
        {text}
      </span>
      <span className="h-px min-w-[24px] flex-1 bg-white/[0.04]" />
      <span className="tnum shrink-0 text-[11px] text-neutral-600">{hhmm(at)}</span>
    </motion.div>
  );
}

/** The closing report: what was decided, by whom, what was done and checked, with links into the case. */
function Report({ e }: { e: ConjunctionEvent }) {
  const p = e.proposal;
  const replies = useOps((s) => s.replies);
  const approvals = replies.filter((r) => r.eventId === e.id && r.decision === "approved" && r.version === p?.version);
  const who = (side: "a" | "b") => clean(e.parties?.find((x) => x.role === side)?.operator) || `Side ${side.toUpperCase()}`;
  const took = e.outcome?.resolvedAt ? e.outcome.resolvedAt - e.createdAt : null;
  const checks = e.outcome?.checks ?? [];
  const next = e.outcome?.next ?? [];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[16px] bg-[rgba(61,220,151,0.035)] shadow-[inset_0_0_0_1px_rgba(61,220,151,0.28)]"
      data-testid="meeting-report"
    >
      <div className="flex items-center gap-3 border-b border-[rgba(61,220,151,0.14)] px-5 py-3.5">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-[rgba(61,220,151,0.16)] text-green">
          <CheckCheck size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-green">Incident resolved</div>
          <div className="mt-0.5 text-[12px] text-neutral-500">
            <span className="mono">{e.id}</span>
            {took !== null && ` · detected to resolved in ${fmtMs(took)}`}
          </div>
        </div>
        <span className="text-[11.5px] text-neutral-600">Report for the record</span>
      </div>

      <div className="space-y-4 px-5 py-4 text-[14px] leading-[1.7] text-neutral-300">
        <p>
          <ObjectChip e={e} side="a" /> and <ObjectChip e={e} side="b" /> were predicted to pass <b className="tnum font-semibold text-white">{fmtMiss(e.missM)}</b> apart on{" "}
          <b className="tnum font-semibold text-white">{fmtWhen(e.tca)}</b>, a chance of <b className="tnum font-semibold text-[#ff8a80]">{fmtOdds(e.pc)}</b>.
        </p>
        {p && (
          <div className="rounded-[12px] bg-black/25 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            <div className="text-[11.5px] text-neutral-500">Decided plan · v{p.version}</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 font-semibold text-white">
              {p.action === "wait" ? (
                "Both wait for the next conjunction message"
              ) : (
                <>
                  <ObjectChip e={e} side={p.mover === "a" ? "a" : "b"} size="sm" /> {p.action === "raise" ? "raises" : "lowers"} its orbit by <span className="tnum">{p.dvMs} m/s</span>
                </>
              )}
            </div>
            <div className="tnum mt-1 text-[13px] text-neutral-400">
              {p.burnAt && <>Burn {fmtWhen(p.burnAt)} · </>}miss {fmtMiss(p.missBeforeM)} → <span className="font-medium text-green">{fmtMiss(p.missAfterM)}</span>
            </div>
          </div>
        )}
        {approvals.length > 0 && (
          <p className="text-[13px] text-neutral-400">
            Approved by {approvals.map((r, i) => (
              <span key={r.t}>
                {i > 0 && (i === approvals.length - 1 ? " and " : ", ")}
                <span className="font-medium text-neutral-100">{who(r.side)}</span>
              </span>
            ))}
            {e.b.kind === "debris" ? ". Debris has no operator." : "."}
          </p>
        )}
        {checks.length > 0 && (
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-[13px] leading-[1.5]">
                <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-black" style={{ background: c.ok ? "var(--green)" : "var(--red)" }}>
                  {c.ok ? <Check size={9} strokeWidth={3.5} /> : <X size={9} strokeWidth={3.5} />}
                </span>
                <span>
                  <span className="font-medium text-neutral-100">{c.label}</span> <span className="text-neutral-500">· {c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {next.length > 0 && (
          <div className="text-[13px] text-neutral-500">
            <span className="text-neutral-400">Next: </span>
            {next.join(" · ")}
          </div>
        )}
      </div>
    </motion.div>
  );
}
