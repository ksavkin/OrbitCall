"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Eye, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { engine } from "@/lib/ops/engine";
import { fmtCountdown, fmtMiss, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { Brief, ObjectChip } from "@/components/ops/Entity";
import { VoiceInput, optionText } from "@/components/ops/DecisionDock";
import { cardsOf, requiredSides, revisionOf, type Card } from "./model";

// Proposal cards and approval (spec §3.4, §4.1). Three separate acts, never merged:
//   select  — shared: puts a card in front of both sides and resets every required approval;
//   approve — this side's yes to the selected card's current revision, and nothing else;
//   veto    — this side's no, with an optional reason; the agents revise.
// A message (counter, question, constraint) goes to the room as text and approves nothing.
// Looking at a card only previews it. Nothing here approves because of an animation or a timer.

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");

function partyOf(e: ConjunctionEvent, side: "a" | "b"): Party | undefined {
  return e.parties?.find((p) => p.role === side);
}

export function ProposalPanel({
  e,
  viewer,
  now,
  embedded = false,
  readOnly = false,
}: {
  e: ConjunctionEvent;
  viewer: "a" | "b";
  now: number;
  embedded?: boolean;
  /** Observer and waiting views: the same cards, no controls (canAct: false). */
  readOnly?: boolean;
}) {
  const autopilot = useOps((s) => s.autopilot && s.actAs !== viewer);
  const cards = cardsOf(e);
  const sel = cards.find((c) => c.selected) ?? cards[0];
  const [look, setLook] = useState<string | undefined>(undefined);
  const viewing = cards.find((c) => c.option.id === look) ?? sel;
  const [text, setText] = useState("");
  const me = partyOf(e, viewer);
  const rev = revisionOf(e, sel?.option);
  const selName = sel ? `${sel.label} · R${rev}` : "";

  const approve = () => {
    if (!sel) return;
    sfx.chime();
    engine.decide(e.id, viewer, { decision: "approved", via: "approve", label: sel.label });
  };
  const veto = () => {
    sfx.click();
    engine.decide(e.id, viewer, { decision: "vetoed", via: "veto", label: sel?.label, note: text.trim() || "rejected by the dispatcher" });
  };
  const select = (c: Card) => {
    sfx.whoosh();
    engine.decide(e.id, viewer, { decision: "countered", via: "select", label: c.label, preferred: { mover: c.option.mover, action: c.option.action } });
  };
  const message = () => {
    const note = text.trim();
    if (!note) return;
    sfx.click();
    engine.decide(e.id, viewer, { decision: "countered", via: "message", note });
  };

  return (
    <div className="text-fg">
      <div className="flex items-start gap-3 px-5 pb-3 pt-5">
        {!readOnly && (
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
            {me?.country ? <Flag code={me.country} h={36} /> : null}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-2 text-[11px] font-medium ${readOnly ? "text-neutral-500" : "text-orange"}`}>
            {!readOnly && <span className="pulse-dot" style={{ width: 5, height: 5 }} />}
            {readOnly ? "Shared view · read only" : "Your decision"} · {selName} selected
          </div>
          <div className="mt-1 text-[19px] font-semibold leading-tight tracking-[-0.02em] text-white">
            {readOnly ? "Plans on the table" : `Review the plans for ${clean(me?.operator) || "your side"}`}
          </div>
          <div className="mt-1 text-[13px] leading-snug text-neutral-400">Both sides approve the same selected plan. Selecting another plan resets every approval.</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum text-[20px] font-semibold leading-none tracking-[-0.02em] text-white">{now ? fmtCountdown(e.tca - now).replace("T−", "") : ""}</div>
          <div className="mt-1 text-[11px] text-neutral-500">until closest approach</div>
        </div>
      </div>

      {!embedded && e.summary && (
        <div className="mx-5 mb-3 rounded-[12px] bg-white/[0.03] p-3.5">
          <Brief e={e} lines={e.summary} skipOptions />
        </div>
      )}

      <Approvals e={e} sel={sel} rev={rev} />

      <div className="mx-5 mt-3 overflow-hidden rounded-[14px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
        {cards.map((c, i) => (
          <PlanCard
            key={c.option.id}
            e={e}
            c={c}
            index={i}
            last={i === cards.length - 1}
            viewing={viewing?.option.id === c.option.id}
            onLook={() => setLook(c.option.id)}
            canSelect={!readOnly}
            onSelect={() => select(c)}
          />
        ))}
      </div>

      {!readOnly && (
        <>
          <div className="flex items-center gap-2 px-5 pt-3">
            <div className="min-w-0 flex-1">
              <VoiceInput value={text} onChange={setText} onEnter={message} lang={me?.language ?? "English"} />
            </div>
            <button className="btn h-9 shrink-0 px-3 text-[12.5px] text-neutral-300" disabled={!text.trim()} onClick={message}>
              <Send size={12} /> Send to room
            </button>
          </div>
          <div className="px-5 pt-1.5 text-[11.5px] text-neutral-600">A message is a counter or a question. It never approves anything.</div>

          <div className="mt-4 flex items-center gap-2 border-t border-white/[0.07] px-5 py-3">
            {autopilot ? (
              <span className="flex items-center gap-1.5 text-[12px] text-neutral-500">
                <Sparkles size={12} className="text-blue" /> Autopilot answers for the other side
              </span>
            ) : (
              <span className="text-[12px] text-neutral-500">{e.b.kind === "debris" ? "Only your approval is needed: debris has no operator." : "Your answer is for the selected plan only."}</span>
            )}
            <button className="btn ml-auto h-9 gap-1.5 px-3.5 text-[13px] text-neutral-300 hover:text-red" onClick={veto}>
              <X size={13} /> Veto {sel?.label}
            </button>
            <button className="btn btn-primary h-9 gap-1.5 px-4 text-[13px]" onClick={approve}>
              <Check size={14} /> Approve {selName}
            </button>
          </div>
        </>
      )}
      {readOnly && <div className="h-4" />}
    </div>
  );
}

/** Who has approved the current selection; resets show why. */
function Approvals({ e, sel, rev }: { e: ConjunctionEvent; sel: Card | undefined; rev: number }) {
  const sides = requiredSides(e);
  const reset = e.lastReset;
  return (
    <div className="mx-5 rounded-[12px] bg-white/[0.025] px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {sides.map((side) => {
          const p = partyOf(e, side);
          const st = e.approvals[side];
          const tone = st === "approved" ? "text-green" : st === "vetoed" ? "text-[#ff8a80]" : "text-neutral-500";
          const word = st === "approved" ? `approved ${sel?.label} · R${rev}` : st === "vetoed" ? "vetoed" : "not approved yet";
          return (
            <span key={side} className="flex items-center gap-2 text-[12.5px]">
              <span className="overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">{p?.country && <Flag code={p.country} h={16} />}</span>
              <span className="text-neutral-200">{clean(p?.operator) || `Side ${side.toUpperCase()}`}</span>
              <span className={tone}>{word}</span>
            </span>
          );
        })}
      </div>
      <AnimatePresence initial={false}>
        {reset && (
          <motion.div
            key={reset.at}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-1.5 overflow-hidden pt-2 text-[12px] text-orange"
          >
            <RotateCcw size={11} className="shrink-0" /> {reset.reason}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One plan: what moves, what it costs, what it gives. Clicking previews; selecting is a separate, explicit button. */
function PlanCard({
  e,
  c,
  index,
  last,
  viewing,
  onLook,
  canSelect,
  onSelect,
}: {
  e: ConjunctionEvent;
  c: Card;
  index: number;
  last: boolean;
  viewing: boolean;
  onLook: () => void;
  canSelect: boolean;
  onSelect: () => void;
}) {
  const o = c.option;
  const t = optionText(e, o);
  const lead = o.burnAt ? Math.round((e.tca - o.burnAt) / 3600_000) : null;
  const meta =
    o.action === "wait"
      ? "No burn. The next conjunction message decides."
      : `Burn ${fmtWhen(o.burnAt!)}${lead !== null ? `, ${lead} h before closest approach` : ""} · ${(o.fuelKg * 1000).toFixed(1)} g fuel`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + index * 0.05, duration: 0.25 }}
      className={`relative ${last ? "" : "border-b border-white/[0.06]"} ${c.selected ? "bg-white/[0.06]" : viewing ? "bg-white/[0.035]" : ""}`}
    >
      {c.selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-white" />}
      <button
        onClick={() => {
          sfx.click();
          onLook();
        }}
        onPointerEnter={() => sfx.hover()}
        className="flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors duration-200 hover:bg-white/[0.03]"
      >
        <span className="mono mt-[2px] w-6 shrink-0 text-[12px] font-semibold text-neutral-500">{c.label}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[14.5px] font-semibold leading-snug text-white">
            {t.verb}
            {t.who ? <ObjectChip e={e} side={t.who} size="sm" /> : <span>for the next CDM</span>}
            {o.action !== "wait" && <span className="tnum font-normal text-neutral-400">by {o.dvMs} m/s</span>}
            {c.selected && <span className="ml-1 rounded-full bg-white px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.06em] text-black">Selected</span>}
            {o.recommended && (
              <span className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]">
                Agents&rsquo; pick
              </span>
            )}
          </span>
          <span className="tnum mt-1 block text-[12.5px] text-neutral-400">{meta}</span>
          <AnimatePresence initial={false}>
            {(viewing || c.selected) && (
              <motion.span initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="block overflow-hidden">
                <span className="mt-1 block text-[12.5px] leading-[1.5] text-neutral-500">{o.why}</span>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="shrink-0 pt-0.5 text-right">
          <span className="tnum block text-[18px] font-semibold leading-none tracking-[-0.02em]" style={{ color: o.action === "wait" ? "var(--red)" : "#fff" }}>
            {fmtMiss(o.missAfterM)}
          </span>
          <span className="tnum mt-1 block text-[11px] text-neutral-500">from {fmtMiss(e.missM)}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {canSelect && viewing && !c.selected && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="flex items-center gap-3 px-4 pb-3.5 pl-[54px]">
              <button className="btn h-8 gap-1.5 px-3 text-[12.5px] text-white" onClick={onSelect}>
                <Eye size={12} /> Select {c.label} for both sides
              </button>
              <span className="text-[11.5px] leading-snug text-neutral-500">Puts it in front of both sides and resets approvals. It does not approve it.</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
