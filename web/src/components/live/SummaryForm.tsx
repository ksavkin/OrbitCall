"use client";

import { useQuery } from "convex/react";
import { anyApi, type FunctionReference } from "convex/server";
import { AnimatePresence, motion } from "motion/react";
import { Check, PenLine, RotateCcw, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { hostTriggersRef, summaryEditRef, summaryRequestRef } from "@/lib/backend/api";
import { backendError, type BackendError } from "@/lib/backend/errors";
import { useLive, useRealMode } from "@/lib/backend/live";
import { QueryBoundary } from "@/lib/backend/QueryBoundary";
import { mutate } from "@/lib/backend/run";
import type { EventId, HostTriggerRow, Id, LogEntry, RoomId, RoomMessage, Side, SummaryChanges, SummaryForm, SummaryState } from "@/lib/backend/types";
import { fmtUtc } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { SUMMARY_FORM_KEY } from "./sync/SummarySync";

// The end-of-call summary form (wiring map §5.4, convex/summary.ts). It always follows the selected plan: summary.get
// reads it from the current selection, and a Host summary message is never decision authority. An accepted edit is
// checked in the background (a catalog rescreen for a burn) and published as a new revision, which resets every
// approval. Nothing here selects or approves.

type Direction = "prograde" | "retrograde";
type Draft = { side: Side | null; burn: string; dv: string; dir: Direction | null; note: string };
type Issues = Partial<Record<keyof Draft, string>>;
type Edit = NonNullable<SummaryState["edit"]>;
type Said = { tone: "ok" | "wait" | "error"; text: string };

const NOTE_MAX = 500;
const EASE = [0.22, 1, 0.36, 1] as const;

const field =
  "w-full min-w-0 rounded-[8px] bg-white/[0.045] px-2.5 text-[12px] text-white outline-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] placeholder:text-neutral-600 focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)] disabled:opacity-40";
const input = `h-8 ${field}`;
const invalid = "shadow-[inset_0_0_0_1px_rgba(255,90,79,0.75)]";

/** revisions.request answers { accepted, alreadyApplied } (convex/revisions.ts:200-231); api.ts still types it null. */
const revisionRequestRef = anyApi.revisions.request as unknown as FunctionReference<
  "mutation",
  "public",
  { eventId: EventId; hostRunId: Id },
  { accepted: boolean; alreadyApplied: boolean }
>;

/** End-of-call summary form and its edit (wiring map §5.4). Real mode only. */
export function SummaryFormPanel({ eventId, roomId }: { eventId: EventId; roomId: RoomId | null }) {
  const real = useRealMode();
  return real ? <Panel eventId={eventId} roomId={roomId} /> : null;
}

function Panel({ eventId, roomId }: { eventId: EventId; roomId: RoomId | null }) {
  const state = useLive((s) => s.summaryForm);
  const error = useLive((s) => s.errors[SUMMARY_FORM_KEY]);
  const messages = useLive((s) => s.messages);
  const proposals = useLive((s) => s.proposals);
  // the plan revision the editor was opened on: a new revision closes it, so a draft never targets an old one
  const [editingAt, setEditingAt] = useState<string | null>(null);
  const posted = newest(messages, (m) => m.kind === "summary" && (m.eventId === eventId || m.eventId === null));
  // a Host summary that carries a form is shown only when summary.get has no current selection to read
  const held = !state || state.form ? null : newest(messages, (m) => m.kind === "summary" && m.form !== null && m.eventId === eventId);
  const form = state?.form ?? held?.form ?? null;
  const label = form ? proposals?.find((p) => p.proposalId === form.proposalId)?.label : undefined;
  const request = useSummaryRequest(roomId, posted);
  const at = form ? `${form.proposalId}-${form.revision}` : null;
  const open = editingAt === at && !!state?.form && state.canEdit && state.edit?.state !== "pending";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="rounded-[16px] bg-white/[0.015] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
      data-testid="summary-form"
    >
      <div className="flex items-center gap-3 px-5 pb-3 pt-4">
        <span className="shrink-0 text-[15px] font-semibold tracking-[-0.01em] text-white">Call summary</span>
        {form && (
          <span className="min-w-0 truncate text-[12.5px] text-neutral-500">
            {label ?? "Plan"} · R{form.revision} · {held ? `from the Host summary at ${hhmm(held.at)} UTC` : "the selected plan"}
          </span>
        )}
        <button
          className="btn btn-ghost-line ml-auto h-8 shrink-0 gap-1.5 px-3 text-[12px] disabled:opacity-40"
          disabled={!roomId || request.busy}
          title={roomId ? "The Coordination Host posts a summary of the discussion in the chat" : "Opens with the coordination room"}
          onClick={() => void request.send()}
        >
          <Sparkles size={12} /> {request.busy ? "Requesting" : "Request summary"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {request.said && (
          <motion.div key={request.said.text} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <SaidLine said={request.said} className="px-5 pb-3" />
          </motion.div>
        )}
      </AnimatePresence>

      {error ? (
        <p className="px-5 pb-4 text-[12.5px] text-[#ff8a80]">{error}</p>
      ) : state === undefined ? (
        <p className="px-5 pb-4 text-[12.5px] text-neutral-500">Reading the summary form…</p>
      ) : !form ? (
        <p className="px-5 pb-4 text-[12.5px] text-neutral-500">No plan is selected yet. The form follows the plan in front of both sides.</p>
      ) : open ? (
        <Editor key={at} eventId={eventId} form={form} generation={state.selectionGeneration} onClose={() => setEditingAt(null)} />
      ) : (
        <>
          <Fields form={form} />
          <EditRow state={state} heldAt={held?.at ?? null} onEdit={() => setEditingAt(at)} />
        </>
      )}

      {roomId && (
        <QueryBoundary key={roomId} fallback={() => null}>
          <HostRevision eventId={eventId} roomId={roomId} />
        </QueryBoundary>
      )}
    </motion.div>
  );
}

/* ---------------------------------------------------------------- the form as read */

function Fields({ form }: { form: SummaryForm }) {
  const wait = form.movingSide === null;
  const burn = form.burnTimeUtc ? Date.parse(form.burnTimeUtc) : NaN;
  return (
    <div className="mx-5 grid grid-cols-2 gap-x-5 gap-y-3 rounded-[12px] bg-white/[0.025] px-3.5 py-3 sm:grid-cols-4">
      <Field label="Moving side">{wait ? "No burn · wait" : `Side ${form.movingSide}`}</Field>
      <Field label="Burn time (UTC)">
        {Number.isFinite(burn) ? (
          <span className="mono tnum">
            {fmtUtc(burn).date} {fmtUtc(burn).time}
          </span>
        ) : (
          "—"
        )}
      </Field>
      <Field label="Δv">
        {form.deltaVMs === null ? (
          "—"
        ) : (
          <>
            <span className="mono tnum">{form.deltaVMs}</span> <span className="text-[11px] text-neutral-500">m/s</span>
          </>
        )}
      </Field>
      <Field label="Direction">{form.direction ? capital(form.direction) : "—"}</Field>
      <div className="col-span-full">
        <Field label="Note">{form.note ? <span className="whitespace-pre-wrap">{form.note}</span> : <span className="text-neutral-600">No note</span>}</Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className="mt-0.5 break-words text-[12.5px] leading-[1.5] text-neutral-200">{children}</div>
    </div>
  );
}

/** The last edit's progress, why the form is read only, and the Edit button. */
function EditRow({ state, heldAt, onEdit }: { state: SummaryState | undefined; heldAt: string | null; onEdit: () => void }) {
  const approvals = useLive((s) => s.approvals);
  const pending = state?.edit?.state === "pending";
  const canEdit = !!state?.form && state.canEdit && !pending;
  const hint = heldAt
    ? "This Host summary is not the current selection, so it cannot be edited."
    : pending
      ? "One edit at a time. The form opens again when the check ends."
      : canEdit
        ? "A checked edit publishes a new revision and resets every approval."
        : approvals?.deciding && !approvals.myTurn && approvals.turn
          ? `Side ${approvals.turn} is deciding. The form opens on your turn.`
          : "Read only. The operator whose turn it is edits the selected plan.";
  return (
    <div className="mt-3 flex items-center gap-3 border-t border-white/[0.06] px-5 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        {state?.edit && <EditProgress edit={state.edit} />}
        <div className="text-[12px] text-neutral-500">{hint}</div>
      </div>
      {canEdit && (
        <button
          className="btn btn-ghost-line h-8 shrink-0 gap-1.5 px-3 text-[12px]"
          onClick={() => {
            sfx.click();
            onEdit();
          }}
        >
          <PenLine size={12} /> Edit
        </button>
      )}
    </div>
  );
}

const EDIT_FAILED: Record<string, string> = {
  RESCREEN_REFUSED: "The edited burn did not pass the catalog rescreen. Nothing was published.",
  RESCREEN_TIMEOUT: "The catalog rescreen timed out. Nothing was published.",
  EDIT_TIMEOUT: "The check timed out. Nothing was published.",
  STALE_REVISION: "The selection, evidence or responsibility changed during the check. Nothing was published.",
  BURN_TIME_EXPIRED: "The burn time passed during the check. Nothing was published.",
  SHARED_TRAJECTORY_REQUIRED: "This burn affects linked incidents and needs a shared plan. Nothing was published.",
};

/** summary.get().edit: the newest edit job of this incident (convex/summary.ts get). */
function EditProgress({ edit }: { edit: Edit }) {
  if (edit.state === "pending") {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-[#9cc2ff]">
        <span className="pulse-dot shrink-0" style={{ width: 5, height: 5 }} /> Checking the last edit. Nothing changes until it passes.
      </div>
    );
  }
  if (edit.state === "completed") {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-green">
        <Check size={12} className="shrink-0" /> The last edit was published as a new revision. Approvals were reset.
      </div>
    );
  }
  const why = (edit.errorCode && EDIT_FAILED[edit.errorCode]) ?? `The last edit was not published (${edit.errorCode ?? "unknown error"}). Existing revisions and approvals are kept.`;
  return (
    <div className="flex items-start gap-2 text-[12.5px] text-[#ff8a80]">
      <X size={12} className="mt-[3px] shrink-0" /> {why}
    </div>
  );
}

/* ---------------------------------------------------------------- the edit */

function draftOf(f: SummaryForm): Draft {
  return { side: f.movingSide, burn: f.burnTimeUtc ?? "", dv: f.deltaVMs === null ? "" : String(f.deltaVMs), dir: f.direction, note: f.note };
}

/**
 * The changed fields only, and what is wrong with the draft. Mirrors summary.edit (convex/summary.ts editedCandidate,
 * lib/policies.ts validateCandidates): a burn needs a whole-second future UTC time, Δv above 0 and at most 1 m/s and a
 * direction; waiting carries none of them; the note is trimmed and at most 500 characters. `now` is 0 before the
 * first tick, which skips the future check.
 */
function checkDraft(f: SummaryForm, d: Draft, now: number): { changes: SummaryChanges; issues: Issues } {
  const changes: SummaryChanges = {};
  const issues: Issues = {};
  if (d.side !== f.movingSide) changes.movingSide = d.side;
  if (d.side === null) {
    if (f.burnTimeUtc !== null) changes.burnTimeUtc = null;
    if (f.deltaVMs !== null) changes.deltaVMs = null;
    if (f.direction !== null) changes.direction = null;
  } else {
    const burn = utcSecond(d.burn);
    if (burn === null) issues.burn = "Use a whole-second UTC time, like 2026-10-26T14:05:00Z.";
    else if (now && Date.parse(burn) <= now) issues.burn = "The burn time must be in the future.";
    else if (burn !== utcSecond(f.burnTimeUtc ?? "")) changes.burnTimeUtc = burn;
    const dv = d.dv.trim() ? Number(d.dv) : NaN;
    if (!Number.isFinite(dv) || dv <= 0) issues.dv = "Δv must be above 0 m/s.";
    else if (dv > 1) issues.dv = "At most 1 m/s, the numerical service limit.";
    else if (dv !== f.deltaVMs) changes.deltaVMs = dv;
    if (d.dir === null) issues.dir = "Choose a direction.";
    else if (d.dir !== f.direction) changes.direction = d.dir;
  }
  const note = d.note.trim();
  if (note.length > NOTE_MAX) issues.note = `At most ${NOTE_MAX} characters.`;
  else if (note !== f.note) changes.note = note;
  return { changes, issues };
}

function touched(f: SummaryForm, d: Draft): boolean {
  const o = draftOf(f);
  return d.side !== o.side || d.dir !== o.dir || d.burn.trim() !== o.burn || d.dv.trim() !== o.dv || d.note.trim() !== o.note.trim();
}

/** "2026-10-26T14:05:00Z" from a typed UTC time, or null. Whole seconds only: summary.edit refuses a fraction. */
function utcSecond(raw: string): string | null {
  const t = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/\.0+Z$/, "Z");
  const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00Z` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t) ? `${t}Z` : t;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(full)) return null;
  const ms = Date.parse(full);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === full.slice(0, 19) ? full : null;
}

function Editor({ eventId, form, generation, onClose }: { eventId: EventId; form: SummaryForm; generation: number; onClose: () => void }) {
  const now = useNow(1000);
  const approvals = useLive((s) => s.approvals);
  const [draft, setDraft] = useState(() => draftOf(form));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<BackendError | null>(null);
  const { issues } = checkDraft(form, draft, now);
  // typed away from the form, valid or not: Send then shows what is wrong instead of staying disabled
  const dirty = touched(form, draft);
  const shown: Issues = tried ? issues : {};
  const wait = draft.side === null;
  // only a side that approves can move (summary.edit: "Only an active operator's spacecraft can maneuver")
  const sides: Side[] = approvals?.requiredApprovalSides.length ? approvals.requiredApprovalSides : ["A", "B"];
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const send = async () => {
    if (busy) return;
    sfx.click();
    setTried(true);
    setFailed(null);
    const fresh = checkDraft(form, draft, Date.now());
    if (Object.keys(fresh.issues).length) return;
    if (!Object.keys(fresh.changes).length) return setFailed({ code: "VALIDATION", message: "The summary fields are unchanged." });
    setBusy(true);
    try {
      await mutate(summaryEditRef, {
        eventId,
        proposalId: form.proposalId,
        baseRevision: form.revision,
        // summary.edit refuses a generation below 1; it is 0 only before the first selection
        ...(generation >= 1 ? { expectedGeneration: generation } : {}),
        changes: fresh.changes,
      });
      onClose();
    } catch (e) {
      setFailed(backendError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
      <div className="mx-5 grid grid-cols-2 gap-x-3 gap-y-3 rounded-[12px] bg-white/[0.025] px-3.5 py-3 sm:grid-cols-4">
        <Labeled label="Moving side" group error={shown.side}>
          <Segmented
            id={`summary-side-${eventId}`}
            value={draft.side ?? "wait"}
            options={[...sides.map((s) => ({ id: s, label: `Side ${s}` })), { id: "wait", label: "Wait" }]}
            onChange={(v) => set({ side: v === "wait" ? null : (v as Side) })}
          />
        </Labeled>
        <Labeled label="Burn time (UTC)" error={shown.burn}>
          <input
            className={`${input} mono ${shown.burn ? invalid : ""}`}
            value={wait ? "" : draft.burn}
            placeholder={wait ? "No burn" : "2026-10-26T14:05:00Z"}
            disabled={wait}
            spellCheck={false}
            autoComplete="off"
            aria-label="Burn time UTC"
            aria-invalid={!!shown.burn}
            onChange={(e) => set({ burn: e.target.value })}
          />
        </Labeled>
        <Labeled label="Δv" unit="m/s" error={shown.dv}>
          <input
            className={`${input} mono tnum ${shown.dv ? invalid : ""}`}
            value={wait ? "" : draft.dv}
            placeholder={wait ? "—" : "0.10"}
            disabled={wait}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Delta-v in m/s"
            aria-invalid={!!shown.dv}
            onChange={(e) => set({ dv: e.target.value })}
          />
        </Labeled>
        <Labeled label="Direction" group error={shown.dir}>
          <Segmented
            id={`summary-dir-${eventId}`}
            value={draft.dir ?? ""}
            options={[
              { id: "prograde", label: "Prograde" },
              { id: "retrograde", label: "Retrograde" },
            ]}
            disabled={wait}
            onChange={(v) => set({ dir: v as Direction })}
          />
        </Labeled>
        <div className="col-span-full">
          <Labeled label="Note" unit={`${draft.note.trim().length}/${NOTE_MAX}`} error={shown.note}>
            <textarea
              className={`${field} block min-h-[56px] resize-none py-2 leading-[1.5] ${shown.note ? invalid : ""}`}
              value={draft.note}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="What changed and why, for the record"
              aria-label="Note"
              onChange={(e) => set({ note: e.target.value })}
            />
          </Labeled>
        </div>
      </div>
      {failed && <p className={`px-5 pt-2.5 text-[12px] ${failed.code === "INVALID_STATE" ? "text-orange" : "text-[#ff8a80]"}`}>{failed.message}</p>}
      <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] px-5 py-3">
        <span className="min-w-0 flex-1 text-[12px] text-neutral-500">A checked edit publishes a new revision and resets every approval.</span>
        <button
          className="btn h-8 shrink-0 px-3 text-[12px]"
          disabled={busy}
          onClick={() => {
            sfx.click();
            onClose();
          }}
        >
          Cancel
        </button>
        <button className="btn btn-primary h-8 shrink-0 gap-1.5 px-3.5 text-[12px] disabled:opacity-40" disabled={!dirty || busy} onClick={() => void send()}>
          <Check size={12} /> {busy ? "Sending" : dirty ? "Send edit" : "Change a field to send"}
        </button>
      </div>
    </motion.div>
  );
}

/** A field label. `group` wraps a set of buttons: a <label> would forward its clicks to the first one. */
function Labeled({ label, unit, group = false, error, children }: { label: string; unit?: string; group?: boolean; error?: string; children: ReactNode }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[10.5px] text-muted">
        <span className="truncate">{label}</span>
        {unit && <span className="mono shrink-0 text-faint">{unit}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-red">{error}</span>}
    </Tag>
  );
}

function Segmented({
  id,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  value: string;
  options: { id: string; label: string }[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <span className={`flex h-8 rounded-[8px] bg-white/[0.04] p-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] ${disabled ? "opacity-40" : ""}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="btn relative h-7 min-w-0 flex-1 px-1.5"
          data-active={value === o.id}
          disabled={disabled}
          onClick={() => {
            sfx.click();
            onChange(o.id);
          }}
        >
          {value === o.id && !disabled && <motion.span layoutId={id} className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          <span className="relative truncate">{o.label}</span>
        </button>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- Request summary */

/**
 * summary.request: the Coordination Host posts its summary in the chat as a kind "summary" message. An unchanged
 * discussion reuses the last Host run, so nothing new may arrive (convex/hostTriggers.ts request).
 */
function useSummaryRequest(roomId: RoomId | null, posted: RoomMessage | null) {
  const [busy, setBusy] = useState(false);
  // the newest summary when the request went out: a different one is the answer
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState<BackendError | null>(null);

  const send = async () => {
    if (!roomId || busy) return;
    sfx.click();
    setBusy(true);
    setFailed(null);
    try {
      await mutate(summaryRequestRef, { roomId });
      setBefore(posted?.messageId ?? null);
    } catch (e) {
      setFailed(backendError(e));
    } finally {
      setBusy(false);
    }
  };

  let said: Said | null = null;
  if (failed) said = { tone: failed.code === "INVALID_STATE" ? "wait" : "error", text: failed.message };
  else if (before !== undefined && posted && posted.messageId !== before) said = { tone: "ok", text: `The Host posted its summary in the chat at ${hhmm(posted.at)} UTC.` };
  else if (before !== undefined) said = { tone: "wait", text: "Requested. The Host posts its summary in the chat. An unchanged discussion keeps the last one." };
  return { busy, send, said };
}

function SaidLine({ said, className = "" }: { said: Said; className?: string }) {
  const color = said.tone === "ok" ? "text-green" : said.tone === "wait" ? "text-neutral-400" : "text-[#ff8a80]";
  return <p className={`text-[12px] ${color} ${className}`}>{said.text}</p>;
}

/* ---------------------------------------------------------------- revisions.request */

type HostAsk = { hostRunId: Id; reason: string | null };

/**
 * What the room's latest checked Host run asks of this incident: revised plans, or a hard constraint or correction
 * that revises them (convex/revisions.ts affectedEvents). revisions.request accepts only that run (loadDiscussion).
 */
function hostAsk(rows: HostTriggerRow[], eventId: EventId): HostAsk | null {
  const run = rows.find((r) => r.status === "succeeded");
  const out = run?.output as
    | { requestedRevisions?: { eventId: string; reason: string }[]; understood?: { eventId: string | null; kind: string; hard: boolean }[] }
    | null
    | undefined;
  if (!run || !out) return null;
  const asked = (out.requestedRevisions ?? []).filter((r) => r.eventId === eventId);
  const ruled = (out.understood ?? []).some((u) => (u.eventId === eventId || u.eventId === null) && ((u.hard && u.kind === "constraint") || u.kind === "correction"));
  return asked.length || ruled ? { hostRunId: run.hostRunId, reason: asked[0]?.reason ?? null } : null;
}

/** A revision from this run is already published, or the run left the plans unchanged (revisions.ts loadDiscussion `done`). */
function revisedBy(log: LogEntry[] | undefined, hostRunId: Id): boolean {
  return !!log?.some(
    (l) => l.after?.hostRunId === hostRunId && (l.action === "proposal_revised" || (l.action === "negotiation" && l.after?.kind === "revision_unchanged")),
  );
}

/** hostTriggers.listForRoom: room members of an involved company only. Anyone else sees nothing here. */
function HostRevision({ eventId, roomId }: { eventId: EventId; roomId: RoomId }) {
  const rows = useQuery(hostTriggersRef, { roomId });
  const log = useLive((s) => s.log);
  const ask = rows ? hostAsk(rows, eventId) : null;
  if (!ask || revisedBy(log, ask.hostRunId)) return null;
  return <RevisionRetry key={ask.hostRunId} eventId={eventId} ask={ask} />;
}

/**
 * The Host's revision runs on its own after a checked run (hostTriggers.ts run → revisions.fromHost). This retries it
 * from the Decision Center when it failed or did not arrive; the deciding side only.
 */
function RevisionRetry({ eventId, ask }: { eventId: EventId; ask: HostAsk }) {
  const approvals = useLive((s) => s.approvals);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const offTurn = !!approvals?.deciding && !approvals.myTurn;

  const retry = async () => {
    if (busy || offTurn) return;
    sfx.click();
    setBusy(true);
    setSaid(null);
    try {
      const r = await mutate(revisionRequestRef, { eventId, hostRunId: ask.hostRunId });
      setSaid(r.alreadyApplied ? { tone: "ok", text: "The plans already include this discussion." } : { tone: "wait", text: "Recalculation requested. A new revision resets every approval." });
    } catch (e) {
      const b = backendError(e);
      setSaid({ tone: b.code === "INVALID_STATE" ? "wait" : "error", text: b.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="flex items-start gap-3 border-t border-white/[0.06] px-5 py-3">
      <RotateCcw size={13} className="mt-[3px] shrink-0 text-[#9cc2ff]" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-neutral-200">The Host asked for revised plans from the discussion</div>
        {ask.reason && <div className="mt-0.5 line-clamp-2 text-[12px] text-neutral-400">{ask.reason}</div>}
        <div className="mt-0.5 text-[12px] text-neutral-500">They are recalculated on their own. Retry if none arrive.</div>
        {offTurn && approvals?.turn && <div className="mt-0.5 text-[12px] text-neutral-500">Side {approvals.turn} is deciding. A retry opens on your turn.</div>}
        {said && <SaidLine said={said} className="mt-1" />}
      </div>
      <button className="btn btn-ghost-line h-8 shrink-0 px-3 text-[12px] disabled:opacity-40" disabled={busy || offTurn} onClick={() => void retry()}>
        {busy ? "Requesting" : "Retry recalculation"}
      </button>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- helpers */

function newest(messages: RoomMessage[] | undefined, keep: (m: RoomMessage) => boolean): RoomMessage | null {
  let best: RoomMessage | null = null;
  for (const m of messages ?? []) if (keep(m) && (!best || m.at > best.at)) best = m;
  return best;
}

const hhmm = (iso: string) => fmtUtc(Date.parse(iso)).time.slice(0, 5);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
