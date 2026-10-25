"use client";

import { motion } from "motion/react";
import { Info, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { fmtStamp } from "@/lib/backend/format";
import { useLive } from "@/lib/backend/live";
import type { EventId, ProposalId, RoomMessage, RoomProjection, SummaryForm } from "@/lib/backend/types";
import { AGENT_NAME, LANG_NAME, authorSide, companyName, hhmm, type TimelineItem } from "./live";
import { Message, withValues } from "./RoomTimeline";

// Real mode: the room's lines as the backend sends them (wiring map §3.2). People write in bubbles, agents as notes,
// system lines as centred notices, the Coordination Host's summary as a shared record. Every line is read only.

const ENTER = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const } };

type Ctx = { room: RoomProjection | undefined; eventId: EventId | null; myUserId: string | null };

/** One timeline entry: a typed line, or a voice phrase from the call (its event chip would print a raw backend id). */
export function LiveItem({ it, ...ctx }: Ctx & { it: TimelineItem }) {
  if (it.kind === "voice") {
    return (
      <ol className="contents">
        <Message m={it.m} myUserId={ctx.myUserId} refs={false} />
      </ol>
    );
  }
  const m = it.m;
  if (m.kind === "system" || m.author.kind === "system") return <Notice m={m} />;
  if (m.kind === "summary") return <Summary m={m} />;
  if (m.author.kind === "agent") return <AgentLine m={m} />;
  return <HumanLine m={m} {...ctx} />;
}

const tag = "mono rounded-[5px] bg-white/[0.04] px-1.5 py-[1px] text-[10.5px] text-neutral-500";

/** "P2 · R2" when a line names a plan of this case. */
function PlanRef({ proposalId, revision }: { proposalId?: ProposalId; revision?: number }) {
  const label = useLive((s) => s.proposals?.find((c) => c.proposalId === proposalId)?.label);
  if (!proposalId || !label) return null;
  return (
    <span className={tag}>
      {label}
      {revision ? ` · R${revision}` : ""}
    </span>
  );
}

function HumanLine({ m, room, eventId, myUserId }: Ctx & { m: RoomMessage }) {
  const [original, setOriginal] = useState(false);
  if (m.author.kind !== "human") return null;
  const mine = m.author.userId === myUserId;
  const side = authorSide(m, room, eventId);
  const company = mine ? null : companyName(room, m.author.companyId);
  // the writer reads their own words; others read their language, with the original one click away
  const shown = mine || original ? m.originalText : m.text;
  return (
    <motion.div {...ENTER} className={`flex gap-3 ${mine ? "flex-row-reverse" : ""}`} data-testid="room-line" data-kind={m.kind} data-status={m.translationStatus} data-mine={mine}>
      <div className={`max-w-[78%] ${mine ? "text-right" : ""}`}>
        <div className={`mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-neutral-500 ${mine ? "justify-end" : ""}`}>
          <span className="font-medium text-neutral-300">{mine ? "You" : m.author.name}</span>
          {company && company !== m.author.name && <span>· {company}</span>}
          {side && <span className={tag}>Side {side}</span>}
          <span className="tnum">· {hhmm(Date.parse(m.at))} UTC</span>
          <PlanRef proposalId={m.refs.proposalId} revision={m.refs.revision} />
        </div>
        <div
          className={`inline-block rounded-[16px] px-4 py-2.5 text-left text-[15px] leading-[1.55] ${mine ? "rounded-tr-[4px] bg-white text-black" : "rounded-tl-[4px] bg-white/[0.06] text-neutral-100"}`}
        >
          {withValues(shown, m.values, mine)}
        </div>
        {!mine && <Translation m={m} original={original} onToggle={() => setOriginal((o) => !o)} />}
      </div>
    </motion.div>
  );
}

/**
 * How a line reached this reader: being translated (the original shows meanwhile), translated with the original one
 * click away, or kept in its original language.
 */
function Translation({ m, original, onToggle, quiet = false }: { m: RoomMessage; original: boolean; onToggle: () => void; quiet?: boolean }) {
  const lang = LANG_NAME[m.originalLang];
  if (m.translationStatus === "pending") {
    return (
      <div className="mt-1 flex items-center gap-1 text-[11.5px] text-neutral-500" data-testid="room-line-translating">
        <Loader2 size={11} className="animate-spin" /> Translating · showing the {lang} original
      </div>
    );
  }
  if (m.translationStatus === "original_only") {
    return quiet ? null : <div className="mt-1 text-[11.5px] text-neutral-600">{lang} original · not translated</div>;
  }
  if (m.text === m.originalText) return null;
  return (
    <button className="mt-1 text-[11.5px] text-neutral-500 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-300" onClick={onToggle}>
      {original ? "Show translation" : `Show original (${lang})`}
    </button>
  );
}

/** An agent's line, written like the meeting's agent notes. */
function AgentLine({ m }: { m: RoomMessage }) {
  const [original, setOriginal] = useState(false);
  const [more, setMore] = useState(false);
  if (m.author.kind !== "agent") return null;
  const text = original ? m.originalText : m.text;
  const long = text.length > 320;
  return (
    <motion.div {...ENTER} className="flex gap-3" data-testid="room-line" data-kind={m.kind} data-agent={m.author.role}>
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.05] text-[#9cc2ff] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <Sparkles size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <span className="font-medium text-neutral-200">{AGENT_NAME[m.author.role]}</span>
          {m.kind === "negotiation" && <span className="text-neutral-600">negotiation</span>}
          <span className="tnum text-neutral-600">{hhmm(Date.parse(m.at))} UTC</span>
          <PlanRef proposalId={m.refs.proposalId} revision={m.refs.revision} />
        </div>
        <div className={`mt-1 text-[14px] leading-[1.65] text-neutral-300 ${long && !more ? "line-clamp-3" : ""}`}>{withValues(text, m.values)}</div>
        {long && (
          <button className="mt-0.5 text-[12px] text-neutral-500 hover:text-white" onClick={() => setMore((x) => !x)}>
            {more ? "Show less" : "Show all"}
          </button>
        )}
        {/* agent lines are written in English; a reader of another language is not told so on every line */}
        <Translation m={m} original={original} onToggle={() => setOriginal((o) => !o)} quiet />
      </div>
    </motion.div>
  );
}

/** A system line ("Both approvals reset.", the room closing) as a centred notice. */
function Notice({ m }: { m: RoomMessage }) {
  // the backend's reset lines are "Both approvals reset." / "Approval reset." (convex/lib/approvalState.ts)
  const reset = /\breset\b/i.test(m.originalText);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex items-center gap-3 text-[12.5px]" data-testid="room-notice" data-tone={reset ? "reset" : "info"}>
      <span className="h-px min-w-[24px] flex-1 bg-white/[0.05]" />
      <span className="flex max-w-[72%] items-center gap-2 text-center">
        <span className="shrink-0" style={{ color: reset ? "var(--orange)" : "#a3a3a3" }}>
          {reset ? <RotateCcw size={11} /> : <Info size={11} />}
        </span>
        <span className="text-neutral-400">{withValues(m.text, m.values)}</span>
        <span className="tnum shrink-0 text-[11px] text-neutral-600">{hhmm(Date.parse(m.at))}</span>
      </span>
      <span className="h-px min-w-[24px] flex-1 bg-white/[0.05]" />
    </motion.div>
  );
}

/** The Coordination Host's summary of the discussion, with the end-of-call form when it carries one. */
function Summary({ m }: { m: RoomMessage }) {
  const by = m.author.kind === "agent" ? AGENT_NAME[m.author.role] : "The room";
  return (
    <motion.div {...ENTER} className="mx-auto w-full max-w-[640px]" data-testid="room-summary">
      <div className="rounded-[12px] bg-white/[0.025] px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Summary</span>
          <span className="text-[11.5px] text-neutral-500">{by}</span>
          <span className="tnum ml-auto text-[11px] text-neutral-600">{hhmm(Date.parse(m.at))} UTC</span>
        </div>
        <div className="mt-1.5 text-[13.5px] leading-[1.6] text-neutral-200">{withValues(m.text, m.values)}</div>
        {m.form && <FormRows form={m.form} />}
        <div className="mt-2 text-[10.5px] text-neutral-600">shared record · approves nothing</div>
      </div>
    </motion.div>
  );
}

/** The summary form's fields, read only. Editing it is the summary form panel's job (wiring map §5.4). */
function FormRows({ form }: { form: SummaryForm }) {
  const label = useLive((s) => s.proposals?.find((c) => c.proposalId === form.proposalId)?.label) ?? "Plan";
  const rows: [string, string][] = [
    ["Plan", `${label} · R${form.revision}`],
    ["Moves", form.movingSide ? `Side ${form.movingSide}` : "—"],
    ["Burn", fmtStamp(form.burnTimeUtc)],
    ["Δv", form.deltaVMs === null ? "—" : `${form.deltaVMs} m/s${form.direction ? ` ${form.direction}` : ""}`],
  ];
  return (
    <div className="mt-2.5 rounded-[10px] bg-black/25 px-3 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="mono tnum min-w-0 break-words text-neutral-200">{v}</dd>
          </div>
        ))}
      </dl>
      {form.note && <div className="mt-1.5 text-[12.5px] leading-[1.55] text-neutral-400">{form.note}</div>}
    </div>
  );
}
