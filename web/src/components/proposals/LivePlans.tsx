"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Eye, Mic, Reply, RotateCcw, Send, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { approvalsApproveRef, approvalsVetoRef, messagesSendRef, proposalsSelectRef } from "@/lib/backend/api";
import { decideGate, decisionArgs, diffState, selectGate, selectionFailures, workflowNote, type Gate } from "@/lib/backend/decision";
import { backendError, type BackendError } from "@/lib/backend/errors";
import { useLive } from "@/lib/backend/live";
import { mutate } from "@/lib/backend/run";
import type { ApprovalStatus, ProposalCard, RoomId } from "@/lib/backend/types";
import { fmtCountdown, fmtMiss } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Party } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { Brief, ObjectChip } from "@/components/ops/Entity";
import { VoiceInput } from "@/components/ops/DecisionDock";
import { AdvocateChips, AdvocatesSituation, CardRationale } from "@/components/live/CardInsights";
import { ResetBanner } from "@/components/live/DecisionStatus";
import { ScheduleDiff } from "@/components/live/ScheduleDiff";
import { revisionText } from "./model";

// The plan panel in real mode (wiring map §1). Cards, selection and approvals come from useLive (DecisionSync);
// nothing here reads e.options, e.selection or e.approvals. The same three acts as the simulator, now on the backend:
//   select  — proposals.select: shared, and changing the card resets every approval (it is never a counter);
//   approve — exactly the selection the server holds (decisionArgs), never built from the card list;
//   veto    — the same arguments and an optional private reason that is never posted to the room.
// A counter is a room message tied to the selected plan (messages.send with refs). Speech only offers a selection.

type Act = "select" | "approve" | "veto" | "counter";
type Note = { tone: "warn" | "error" | "ok"; text: string; at: number };

/** How long the answer to the last click stays in the footer. */
const NOTE_MS = 10_000;
const VETO_MAX = 500;
const TEXT_MAX = 2000;

const TONE: Record<Note["tone"] | "muted", string> = { warn: "text-orange", error: "text-[#ff8a80]", ok: "text-green", muted: "text-neutral-500" };

const clean = (s: string | undefined) => (s ?? "").replace(/\s*\(synthetic\)/i, "");
const lower = (side: "A" | "B") => (side === "A" ? "a" : "b");

function partyOf(e: ConjunctionEvent, side: "a" | "b"): Party | undefined {
  return e.parties?.find((p) => p.role === side);
}

export function LivePlans({ e, now, embedded, readOnly }: { e: ConjunctionEvent; now: number; embedded: boolean; readOnly: boolean }) {
  // useLive holds the open case only (DecisionSync follows useOps.incident); another event's panel has no data here
  const open = useOps((s) => s.incident === e.id);
  const cards = useLive((s) => (open ? s.proposals : undefined));
  const status = useLive((s) => (open ? s.approvals : undefined));
  const error = useLive((s) => s.errors.decision);
  return (
    <div className="text-fg">
      <LiveHeader e={e} now={now} embedded={embedded} readOnly={readOnly} status={status} />
      {!embedded && e.summary && (
        <div className="mx-5 mb-3 rounded-[12px] bg-white/[0.03] p-3.5">
          <Brief e={e} lines={e.summary} skipOptions />
        </div>
      )}
      {cards && status ? (
        <LiveDecision key={e.id} e={e} now={now} embedded={embedded} readOnly={readOnly} cards={cards} status={status} />
      ) : (
        <LiveWaiting open={open} error={error} />
      )}
    </div>
  );
}

function LiveHeader({ e, now, embedded, readOnly, status }: { e: ConjunctionEvent; now: number; embedded: boolean; readOnly: boolean; status: ApprovalStatus | undefined }) {
  const sel = status?.selected;
  const selName = sel ? `${sel.label} · R${sel.revision}` : null;
  if (embedded) {
    return (
      <div className="flex items-baseline gap-3 px-5 pb-3 pt-4">
        <span className="shrink-0 text-[15px] font-semibold tracking-[-0.01em] text-white">{readOnly ? "Plans on the table" : "Select a plan"}</span>
        <span className="shrink-0 text-[12.5px] text-neutral-500">{selName ? `${selName} selected` : "none selected yet"}</span>
        <div className="ml-auto min-w-0 truncate text-[12px] text-neutral-600">
          <AdvocatesSituation />
        </div>
      </div>
    );
  }
  const me = status?.mySide ? partyOf(e, lower(status.mySide)) : undefined;
  return (
    <div className="flex items-start gap-3 px-5 pb-3 pt-5">
      {!readOnly && (
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[8px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
          {me?.country ? <Flag code={me.country} h={36} square /> : null}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-2 text-[11px] font-medium ${readOnly ? "text-neutral-500" : "text-orange"}`}>
          {!readOnly && <span className="pulse-dot" style={{ width: 5, height: 5 }} />}
          {readOnly ? "Shared view · read only" : "Your decision"} · {selName ? `${selName} selected` : "no plan selected yet"}
        </div>
        <div className="mt-1 text-[19px] font-semibold leading-tight tracking-[-0.02em] text-white">
          {readOnly ? "Plans on the table" : `Review the plans for ${clean(me?.operator) || "your side"}`}
        </div>
        <div className="mt-1 text-[13px] leading-snug text-neutral-400">Both sides approve the same selected plan. Selecting another plan resets every approval.</div>
        <div className="mt-1 text-[12.5px] leading-snug text-neutral-500 empty:hidden">
          <AdvocatesSituation />
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum text-[20px] font-semibold leading-none tracking-[-0.02em] text-white">{now ? fmtCountdown(e.tca - now).replace("T−", "") : ""}</div>
        <div className="mt-1 text-[11px] text-neutral-500">until closest approach</div>
      </div>
    </div>
  );
}

/** Before the plans and the approval state arrive: loading, or the sync's error with a retry. */
function LiveWaiting({ open, error }: { open: boolean; error: string | undefined }) {
  return (
    <div className="mx-5 mb-4 flex min-h-[46px] items-center gap-3 rounded-[14px] bg-white/[0.02] px-4 py-2.5 text-[12.5px] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
      {!open ? (
        <span className="text-neutral-500">Open this case to see its plans.</span>
      ) : error ? (
        <>
          <span className="min-w-0 flex-1 text-[#ff8a80]">The plans are unavailable. {error}</span>
          <button className="btn h-8 shrink-0 gap-1.5 px-3 text-[12.5px] text-neutral-300" onClick={() => useLive.setState((s) => ({ epoch: s.epoch + 1 }))}>
            <RotateCcw size={12} /> Retry
          </button>
        </>
      ) : (
        <span className="text-neutral-500">Loading the plans…</span>
      )}
    </div>
  );
}

/** One click at a time: a second click while a call is in flight does nothing. Errors become the footer's note. */
function useActs() {
  const [busy, setBusy] = useState<{ act: Act; label: string } | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const flight = useRef(false);
  const run = async (act: Act, label: string, call: () => Promise<unknown>, onError?: (b: BackendError) => boolean): Promise<boolean> => {
    if (flight.current) return false;
    flight.current = true;
    setBusy({ act, label });
    setNote(null);
    try {
      await call();
      return true;
    } catch (err) {
      const b = backendError(err);
      if (!onError?.(b)) setNote({ ...failNote(act, b), at: Date.now() });
      return false;
    } finally {
      flight.current = false;
      setBusy(null);
    }
  };
  return { busy, note, run };
}

/** Wiring map §1.2 error tables, §3.2 for messages.send. Anything else shows the backend's own message. */
function failNote(act: Act, { code, message }: BackendError): Omit<Note, "at"> {
  if (code === "STALE_REVISION") {
    // the subscription already holds the fresh state, so nothing is retried
    return { tone: "warn", text: act === "select" ? "The plan changed; refreshed." : "The selected plan changed; review the current revision first." };
  }
  if (code === "ALREADY_DECIDED") return { tone: "ok", text: "Already agreed." };
  if (code === "INVALID_STATE" || code === "NOT_SELECTED") return { tone: "warn", text: message };
  if (code === "VALIDATION" && act === "select") console.error("proposals.select refused its arguments:", message);
  return { tone: "error", text: message };
}

/**
 * When this screen first saw the current selection waiting for its schedule diff (wiring map §1.4 point 4), or null.
 * `key` names the selection and its generation: every new generation asks Factory again, so the wait starts again.
 */
function useWaitingSince(key: string | null, waiting: boolean, now: number): number | null {
  const [seen, setSeen] = useState<{ key: string | null; since: number | null }>({ key: null, since: null });
  const kept = seen.key === key ? seen.since : null;
  const since = waiting && now > 0 ? (kept ?? now) : null;
  if (seen.key !== key || seen.since !== since) setSeen({ key, since });
  return since;
}

function counterGate(status: ApprovalStatus, roomId: RoomId | null): Gate {
  if (!status.selected) return { ok: false, why: "Select a plan first" };
  if (status.allRequiredApproved) return { ok: false, why: "Agreed; the room is closed" };
  if (!roomId) return { ok: false, why: "This case has no room yet" };
  if (status.deciding && !status.myTurn) return { ok: false, why: status.turn ? `Side ${status.turn} is deciding` : "The other side is deciding" };
  return { ok: true, why: null };
}

function LiveDecision({
  e,
  now,
  embedded,
  readOnly,
  cards,
  status,
}: {
  e: ConjunctionEvent;
  now: number;
  embedded: boolean;
  readOnly: boolean;
  cards: ProposalCard[];
  status: ApprovalStatus;
}) {
  const maneuver = useLive((s) => s.maneuver);
  const log = useLive((s) => s.log);
  const room = useLive((s) => s.room);
  const roomId = useLive((s) => s.roomId);
  const flags = useLive((s) => s.flags);
  const { busy, note, run } = useActs();
  const [look, setLook] = useState<string | undefined>(undefined);
  // the counter or veto row; it belongs to the selection it was opened for and closes when that changes
  const [opened, setOpened] = useState<{ kind: "counter" | "veto"; key: string | null } | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  // "Factory is still preparing…" from approve: stay in the preparing state with the server's words, for this selection
  const [held, setHeld] = useState<{ key: string; text: string } | null>(null);
  // FORBIDDEN: this viewer has nothing to decide here; the controls go and the reason stays
  const [refused, setRefused] = useState<string | null>(null);

  const sel = status.selected;
  const selName = sel ? `${sel.label} · R${sel.revision}` : "";
  const selKey = sel ? `${sel.proposalId}:${sel.revision}:${sel.generation}` : null;
  const draft = opened && opened.key === selKey ? opened.kind : null;
  const toggle = (kind: "counter" | "veto") => setOpened(draft === kind ? null : { kind, key: selKey });

  // the schedule diff of the selection: first without the clock, to know whether this screen is waiting for one
  const base = { flags, status, cards, maneuver, now };
  const waitingSince = useWaitingSince(selKey, diffState({ ...base, log: undefined, waitingSince: null }) === "preparing", now);
  const diff = diffState({ ...base, log: selectionFailures(log, status, waitingSince), waitingSince });
  const gate = decideGate(status, diff, flags);
  const holding = held !== null && held.key === selKey && diff !== "ready" && diff !== "failed";
  const approveGate = holding ? { ok: true, why: held.text, secondary: true } : gate.approve;
  const pick = selectGate(status, room, e.id);
  const talk = counterGate(status, roomId);

  // a plan named in the call ("option B") is offered as a selection; speech never approves (spec §4.1)
  const intent = useOps((s) => (s.voiceIntent?.eventId === e.id ? s.voiceIntent : null));
  const intentCard = intent && !readOnly ? cards.find((c) => c.label === intent.label) : undefined;
  const clearIntent = () => useOps.setState({ voiceIntent: null });
  const viewing = intentCard ?? cards.find((c) => c.proposalId === look) ?? cards.find((c) => c.proposalId === sel?.proposalId) ?? cards[0];

  const controls = !readOnly && !refused && status.mySide !== null && status.requiredApprovalSides.length > 0;
  const me = status.mySide ? partyOf(e, lower(status.mySide)) : undefined;
  const mine = status.mySide ? status.approvals[status.mySide] : undefined;
  const decideError = (b: BackendError) => {
    if (b.code === "INVALID_STATE" && /still preparing/i.test(b.message) && selKey) {
      setHeld({ key: selKey, text: b.message });
      return true;
    }
    if (b.code === "FORBIDDEN") setRefused(b.message);
    return false;
  };

  const select = (c: ProposalCard) => {
    // re-selecting the card the server holds changes nothing (proposals.ts: the generation does not move)
    if (busy || !pick.ok || (sel?.proposalId === c.proposalId && sel.revision === c.latest.revision)) return;
    sfx.whoosh();
    setLook(c.proposalId);
    void run(
      "select",
      `Selecting ${c.label}…`,
      () => mutate(proposalsSelectRef, { eventId: e.id, proposalId: c.proposalId, revision: c.latest.revision, expectedGeneration: status.selectionGeneration }),
      decideError,
    );
  };
  const approve = async () => {
    const args = decisionArgs(status);
    if (!args || !approveGate.ok) return;
    if (await run("approve", "Approving…", () => mutate(approvalsApproveRef, args), decideError)) sfx.chime();
  };
  const veto = async () => {
    const args = decisionArgs(status);
    if (!args || !gate.veto.ok) return;
    const why = reason.trim().slice(0, VETO_MAX);
    if (!(await run("veto", "Vetoing…", () => mutate(approvalsVetoRef, why ? { ...args, reason: why } : args), decideError))) return;
    sfx.click();
    setReason("");
    setOpened(null);
  };
  const counter = async () => {
    const said = text.trim();
    if (!said || !sel || !roomId || !talk.ok) return;
    const refs = { proposalId: sel.proposalId, revision: sel.revision };
    if (!(await run("counter", "Sending…", () => mutate(messagesSendRef, { roomId, eventId: e.id, text: said, refs }), decideError))) return;
    sfx.click();
    setText("");
    setOpened(null);
  };

  const shown = note && now - note.at < NOTE_MS ? note : null;
  const footer: { text: string; tone: keyof typeof TONE } = refused
    ? { text: refused, tone: "error" }
    : busy
      ? { text: busy.label, tone: "muted" }
      : shown
        ? shown
        : !sel
          ? { text: pick.why ?? "Select a plan. Both sides then decide on it.", tone: "muted" }
          : approveGate.why
            ? { text: approveGate.why, tone: "muted" }
            : status.allRequiredApproved
              ? { text: `Agreed on ${selName}.`, tone: "ok" }
              : { text: workflowNote(status) ?? "Your answer is for the selected plan only.", tone: "muted" };

  return (
    <>
      <LiveApprovals e={e} status={status} />

      <AnimatePresence initial={false}>
        {intentCard && (
          <motion.div key={intent!.at} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mx-5 mt-3 flex items-center gap-3 rounded-[12px] bg-[rgba(79,140,255,0.1)] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(79,140,255,0.3)]">
              <Mic size={14} className="shrink-0 text-blue" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-neutral-200">
                  You said <span className="text-white">“{intent!.said}”</span>
                </div>
                <div className="text-[11.5px] text-neutral-500">Speech never decides. Confirm with a click.</div>
              </div>
              {intentCard.proposalId === sel?.proposalId ? (
                <span className="shrink-0 text-[12px] text-neutral-500">{intentCard.label} is selected</span>
              ) : (
                <button
                  className="btn btn-primary h-8 shrink-0 gap-1.5 px-3 text-[12.5px] disabled:pointer-events-none disabled:opacity-40"
                  disabled={!controls || !pick.ok || !!busy}
                  onClick={() => {
                    clearIntent();
                    select(intentCard);
                  }}
                >
                  <Eye size={13} /> Select {intentCard.label}
                </button>
              )}
              <button className="shrink-0 text-[12px] text-neutral-500 hover:text-white" onClick={clearIntent}>
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mx-5 mt-3 overflow-hidden rounded-[14px] bg-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
        {cards.length === 0 && <div className="px-4 py-3.5 text-[12.5px] text-neutral-500">No plans yet. The agents publish up to four when their analysis is done.</div>}
        {cards.map((c, i) => {
          const checked = c.proposalId === sel?.proposalId;
          return (
            <LiveCard
              key={c.proposalId}
              e={e}
              c={c}
              index={i}
              last={i === cards.length - 1}
              viewing={viewing?.proposalId === c.proposalId}
              checked={checked}
              canSelect={controls && pick.ok && !(checked && sel?.revision === c.latest.revision)}
              locked={!!busy}
              onLook={() => setLook(c.proposalId)}
              onSelect={() => select(c)}
            />
          );
        })}
      </div>

      {readOnly ? (
        <div className="h-4" />
      ) : (
        // embedded in the case view the plans scroll; the answer and the buttons stay pinned and visible
        <div
          className={`mt-4 border-t border-white/[0.07] ${
            embedded ? "sticky bottom-0 z-10 rounded-b-[16px] bg-[rgba(13,13,15,0.97)] shadow-[inset_1px_0_0_rgba(255,159,64,0.38),inset_-1px_0_0_rgba(255,159,64,0.38),inset_0_-1px_0_rgba(255,159,64,0.38)] backdrop-blur-md" : ""
          }`}
        >
          <AnimatePresence initial={false}>
            {controls && draft && sel && (
              <motion.div key={draft} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                {draft === "counter" ? (
                  <Draft
                    hint={`A counter to ${selName}. It goes to the room and approves nothing.`}
                    action={
                      <button className="btn h-9 shrink-0 px-3 text-[12.5px] text-neutral-300 disabled:pointer-events-none disabled:opacity-40" disabled={!text.trim() || !talk.ok || !!busy} onClick={counter}>
                        <Send size={12} /> Send to room
                      </button>
                    }
                  >
                    <VoiceInput value={text} onChange={(v) => setText(v.slice(0, TEXT_MAX))} onEnter={counter} lang={me?.language ?? "English"} />
                  </Draft>
                ) : (
                  <Draft
                    hint="Optional reason. It stays with your veto and is never posted to the room."
                    count={`${reason.length}/${VETO_MAX}`}
                    action={
                      <button className="btn h-9 shrink-0 gap-1.5 px-3 text-[12.5px] text-neutral-300 hover:text-red disabled:pointer-events-none disabled:opacity-40" disabled={!gate.veto.ok || !!busy} onClick={veto}>
                        <X size={12} /> Veto {selName}
                      </button>
                    }
                  >
                    <ReasonInput value={reason} onChange={setReason} onEnter={veto} />
                  </Draft>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-2 px-5 py-3">
            <span className={`min-w-0 flex-1 truncate text-[12px] ${TONE[footer.tone]}`}>{footer.text}</span>
            {controls && (
              <>
                <Tooltip label={talk.why ?? "A message to the room about the selected plan. It approves nothing."}>
                  <button
                    className="btn h-9 shrink-0 gap-1.5 px-3 text-[13px] text-neutral-300 disabled:pointer-events-none disabled:opacity-40"
                    data-active={draft === "counter"}
                    disabled={!talk.ok || !!busy}
                    onClick={() => toggle("counter")}
                  >
                    <Reply size={13} /> Counter
                  </button>
                </Tooltip>
                <Tooltip label={gate.veto.why ?? "Your side's no to the selected plan. The agents revise."}>
                  <button
                    className="btn h-9 shrink-0 gap-1.5 px-3.5 text-[13px] text-neutral-300 hover:text-red disabled:pointer-events-none disabled:opacity-40"
                    data-active={draft === "veto"}
                    disabled={!gate.veto.ok || !!busy}
                    onClick={() => toggle("veto")}
                  >
                    <X size={13} /> Veto{sel ? ` ${sel.label}` : ""}
                  </button>
                </Tooltip>
                <button
                  className={`btn h-9 shrink-0 gap-1.5 px-4 text-[13px] disabled:pointer-events-none disabled:opacity-40 ${approveGate.secondary ? "btn-ghost-line text-neutral-300" : "btn-primary"}`}
                  disabled={!approveGate.ok || !!busy}
                  onClick={approve}
                >
                  <Check size={14} /> {!sel ? "Select a plan to approve" : mine?.status === "approved" ? `Approved ${selName}` : `Approve ${selName}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The row that opens above the buttons for a counter or a veto reason. */
function Draft({ hint, count, action, children }: { hint: string; count?: string; action: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2 px-5 pt-3">
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
      <div className="flex items-baseline gap-3 px-5 pt-1.5 text-[11.5px] text-neutral-600">
        <span className="min-w-0 flex-1">{hint}</span>
        {count && <span className="mono tnum shrink-0">{count}</span>}
      </div>
    </>
  );
}

function ReasonInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <div className="flex h-9 items-center rounded-[10px] bg-black/25 px-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]">
      <input
        autoFocus
        value={value}
        maxLength={VETO_MAX}
        onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") onEnter();
          // the app's single-key shortcuts must not fire while typing
          ev.stopPropagation();
        }}
        placeholder="Why not this plan? Optional, kept private"
        className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-faint"
      />
    </div>
  );
}

/** Who has approved the current selection. The reset banner sits under the sides, as in the simulator. */
function LiveApprovals({ e, status }: { e: ConjunctionEvent; status: ApprovalStatus }) {
  const sel = status.selected;
  return (
    <div className="mx-5 rounded-[12px] bg-white/[0.025] px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {status.requiredApprovalSides.length === 0 && <span className="text-[12.5px] text-neutral-500">{workflowNote(status) ?? "No approval is required"}</span>}
        {status.requiredApprovalSides.map((side) => {
          const p = partyOf(e, lower(side));
          const a = status.approvals[side];
          const ok = a?.status === "approved";
          const turn = !ok && status.deciding && status.turn === side;
          return (
            <span key={side} className="flex items-center gap-2 text-[12.5px]">
              <span className="h-4 w-4 shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">{p?.country && <Flag code={p.country} h={16} square />}</span>
              <span className="text-neutral-200">{clean(p?.operator) || `Side ${side}`}</span>
              <span className={ok ? "text-green" : turn ? "text-orange" : "text-neutral-500"}>
                {ok ? `approved ${sel?.label ?? ""} · R${a.revision ?? sel?.revision ?? ""}` : turn ? "deciding now" : "not approved yet"}
              </span>
              {ok && a.byName && <span className="text-neutral-600">{a.byName}</span>}
            </span>
          );
        })}
      </div>
      <ResetBanner eventId={status.eventId} />
    </div>
  );
}

/** One backend card. The row previews; the radio is the only control that selects (proposals.select). */
function LiveCard({
  e,
  c,
  index,
  last,
  viewing,
  checked,
  canSelect,
  locked,
  onLook,
  onSelect,
}: {
  e: ConjunctionEvent;
  c: ProposalCard;
  index: number;
  last: boolean;
  viewing: boolean;
  /** The selection the server holds (approvals.status.selected). */
  checked: boolean;
  canSelect: boolean;
  /** A call is in flight: the radios ignore clicks without changing their look. */
  locked: boolean;
  onLook: () => void;
  onSelect: () => void;
}) {
  const r = c.latest;
  const t = revisionText(r, e.tca);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + index * 0.05, duration: 0.25 }}
      className={`relative transition-colors duration-200 ${last ? "" : "border-b border-white/[0.06]"} ${checked ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
    >
      {viewing && !checked && <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white/30" />}
      <button
        role="radio"
        aria-checked={checked}
        aria-label={`Select ${c.label}`}
        disabled={!canSelect || locked}
        onClick={() => {
          if (canSelect && !locked) onSelect();
        }}
        className={`group/radio absolute left-4 top-[15px] z-[1] grid h-5 w-5 place-items-center rounded-full transition-[box-shadow,background] duration-200 ${
          checked ? "bg-white" : canSelect ? "shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.32)] hover:shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.8)]" : "shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.14)]"
        } disabled:cursor-default`}
      >
        <AnimatePresence initial={false}>
          {checked ? (
            <motion.span key="on" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 26 }} className="h-2 w-2 rounded-full bg-black" />
          ) : (
            canSelect && <span key="hover" className="h-2 w-2 rounded-full bg-white/0 transition-colors group-hover/radio:bg-white/40" />
          )}
        </AnimatePresence>
      </button>
      <button
        onClick={() => {
          sfx.click();
          onLook();
        }}
        onPointerEnter={() => sfx.hover()}
        className="flex w-full items-start gap-3 py-3.5 pl-12 pr-4 text-left"
      >
        <span className="mt-[2px] w-6 shrink-0">
          <span className="mono block text-[12px] font-semibold text-neutral-500">{c.label}</span>
          <span className="mono tnum block text-[10.5px] text-neutral-600">R{r.revision}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[14.5px] font-semibold leading-snug text-white">
            {t.verb}
            {t.who ? <ObjectChip e={e} side={t.who} size="sm" /> : <span>{r.kind === "wait" ? "for the next CDM" : "the moving object"}</span>}
            {t.by && <span className="tnum font-normal text-neutral-400">{t.by}</span>}
          </span>
          <span className="tnum mt-1 block text-[12.5px] text-neutral-400">{t.meta}</span>
          <AnimatePresence initial={false}>
            {(viewing || checked) && r.changeSummary && (
              <motion.span initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="block overflow-hidden">
                <span className="mt-1 block text-[12.5px] leading-[1.5] text-neutral-500">{r.changeSummary}</span>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="shrink-0 pt-0.5 text-right">
          <span className="tnum block text-[18px] font-semibold leading-none tracking-[-0.02em]" style={{ color: r.kind === "wait" ? "var(--red)" : "#fff" }}>
            {t.miss === null ? "—" : fmtMiss(t.miss)}
          </span>
          <span className="tnum mt-1 block text-[11px] text-neutral-500">from {fmtMiss(t.from)}</span>
        </span>
      </button>
      {/* outside the row button: these may hold their own controls, and buttons cannot nest */}
      <div className="-mt-2 flex flex-col gap-2 pb-3.5 pl-[84px] pr-4 empty:hidden">
        <AdvocateChips proposalId={c.proposalId} />
        <CardRationale proposalId={c.proposalId} revision={r.revision} />
        {checked && r.kind === "maneuver" && <ScheduleDiff eventId={e.id} />}
      </div>
    </motion.div>
  );
}
