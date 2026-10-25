"use client";

import { Fragment } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, RotateCcw, X } from "lucide-react";
import { create } from "zustand";
import { resetText, statusLine, turnText, workflowNote } from "@/lib/backend/decision";
import { fmtAge, fmtStamp } from "@/lib/backend/format";
import { useLive } from "@/lib/backend/live";
import type { ApprovalStatus, EventId, ISODate, Side, SideApproval } from "@/lib/backend/types";
import { sfx } from "@/lib/sound";
import { useNow } from "@/lib/useNow";
import { Tooltip } from "@/components/ui/Tooltip";

// Where the decision stands, read from approvals.status (wiring map §1.3 points 5-9, "Shared maneuvers").
// Real mode only, for the open case: the data is the decision sync's `useLive.approvals`.

const EASE = [0.22, 1, 0.36, 1] as const;

/** The open case's approvals.status, once it is this event's (undefined while loading). */
function useStatus(eventId: EventId): ApprovalStatus | undefined {
  const status = useLive((s) => s.approvals);
  return status?.eventId === eventId ? status : undefined;
}

/* ---------------------------------------------------------------- turn and status line */

/**
 * The status line "P2 · R2 · A approved · waiting for B" over "Your turn to decide" / "Side B is deciding", then who
 * approved and when (wiring map §1.3 points 5-6). Laid out like a party in the parties bar it sits beside.
 */
export function TurnStatus({ eventId }: { eventId: EventId }) {
  const status = useStatus(eventId);
  const error = useLive((s) => s.errors.decision);
  if (status?.workflow === "internal_review") return null;
  const line = statusLine(status);
  const turn = turnText(status);
  const mine = !!turn && !!status?.myTurn;
  const approved = status ? approvedSides(status) : [];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="flex min-w-0 items-center gap-3.5 rounded-[12px] px-3.5 py-1.5 transition-colors"
      style={{ background: mine ? "rgba(255,159,64,0.07)" : "rgba(255,255,255,0.03)", boxShadow: mine ? "inset 0 0 0 1px rgba(255,159,64,0.35)" : "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
      data-testid="turn-status"
    >
      <span className="min-w-0">
        <span className={`tnum block truncate text-[13px] font-medium leading-tight ${line ? "text-white" : "text-neutral-400"}`}>
          {line ?? (status ? "No plan selected yet" : error ? <Tooltip label={error}>Approvals unavailable</Tooltip> : "Loading approvals")}
        </span>
        {turn && (
          <span className={`mt-0.5 flex items-center gap-1.5 text-[11.5px] font-medium leading-tight ${mine ? "text-orange" : "text-neutral-300"}`}>
            <span className="pulse-dot shrink-0 text-orange" style={{ width: 5, height: 5 }} />
            {turn}
          </span>
        )}
      </span>
      {approved.map(([side, a]) => (
        <Fragment key={side}>
          <span className="h-7 w-px shrink-0 bg-white/[0.06]" />
          <span className="shrink-0">
            <span className="block max-w-[150px] truncate text-[12.5px] font-medium leading-tight text-neutral-200">{a.byName ?? `Side ${side} operator`}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-tight">
              <span className="flex items-center gap-1 font-medium text-green">
                <Check size={10} strokeWidth={3} /> Approved
              </span>
              <span className="text-neutral-700">·</span>
              <span className="text-neutral-500">Side {side}</span>
              <span className="text-neutral-700">·</span>
              <span className="mono tnum text-[11px] text-neutral-500">{fmtStamp(a.at)}</span>
            </span>
          </span>
        </Fragment>
      ))}
    </motion.div>
  );
}

/** The required sides that have approved the current selection, A first. */
function approvedSides(status: ApprovalStatus): [Side, SideApproval][] {
  return status.requiredApprovalSides.flatMap((side): [Side, SideApproval][] => {
    const a = status.approvals[side];
    return a?.status === "approved" ? [[side, a]] : [];
  });
}

/* ---------------------------------------------------------------- workflow */

const WORKFLOW_HINT = {
  unilateral_debris: "The other object is confirmed debris. Only the active spacecraft's side approves.",
  internal_review: "Both objects belong to one company. Scheduling stays off until an internal approval rule exists.",
} as const;

/** "Single-operator avoidance: debris has no operator" (never "Both approved") or the internal review note (wiring map §1.3 points 7-8). */
export function WorkflowNote({ eventId }: { eventId: EventId }) {
  const status = useStatus(eventId);
  const note = workflowNote(status);
  const workflow = status?.workflow;
  if (!note || !workflow || workflow === "bilateral") return null;
  return (
    <Tooltip label={WORKFLOW_HINT[workflow]}>
      <span className="shrink-0 text-[12px] text-neutral-500" data-testid="workflow-note" data-workflow={workflow}>
        {note}
      </span>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- reset banner */

// Dismissed per reset: a dismissed `at` stays hidden in every mount for this tab; a newer reset shows again.
const useDismissed = create<{ at: Record<EventId, ISODate> }>(() => ({ at: {} }));

const CODE = /^[a-z_]+$/;

/**
 * "Both approvals reset" and why. Selection resets carry a code (`resetText`). A shared maneuver's re-screen writes its
 * own sentence, "Approval reset: <why>" (convex/maneuvers.ts `reset`), and closing a demo run writes plain text.
 */
function resetParts(reason: string, sides: number): { head: string; detail: string | null } {
  const head = sides === 2 ? "Both approvals reset" : sides === 1 ? "Approval reset" : "Approvals reset";
  if (CODE.test(reason)) {
    const text = resetText(reason);
    return { head, detail: text === resetText("") ? null : text };
  }
  const why = (/^(?:Both approvals|Approval) reset:\s*(.+)$/.exec(reason)?.[1] ?? reason).replace(/\.$/, "");
  return { head, detail: why.charAt(0).toUpperCase() + why.slice(1) };
}

/**
 * The reset banner from approvals.status.lastReset (wiring map §1.3 point 9, "Shared maneuvers"). It shows for every
 * reset of this case, also one started in a linked incident while this side did nothing. `compact` fits the room chat.
 */
export function ResetBanner({ eventId, compact = false }: { eventId: EventId; compact?: boolean }) {
  const status = useStatus(eventId);
  const reset = status?.lastReset ?? null;
  const dismissed = useDismissed((s) => s.at[eventId]);
  const parts = reset && status ? resetParts(reset.reason, status.requiredApprovalSides.length) : null;
  const dismiss = () => {
    if (!reset) return;
    sfx.click();
    useDismissed.setState((s) => ({ at: { ...s.at, [eventId]: reset.at } }));
  };
  return (
    <AnimatePresence initial={false} mode="wait">
      {reset && parts && reset.at !== dismissed && (
        <motion.div
          key={reset.at}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="overflow-hidden"
          data-testid="reset-banner"
        >
          <div
            className={`flex items-center bg-[rgba(255,159,64,0.06)] shadow-[inset_0_0_0_1px_rgba(255,159,64,0.22)] ${compact ? "gap-2 rounded-[10px] py-1 pl-2.5 pr-1 text-[12px]" : "gap-2.5 rounded-[12px] py-1.5 pl-3.5 pr-1.5 text-[12.5px]"}`}
          >
            <RotateCcw size={compact ? 11 : 12} className="shrink-0 text-orange" />
            <span className="min-w-0 flex-1 leading-snug">
              <span className="font-medium text-orange">{parts.head}</span>
              {parts.detail && (
                <>
                  <span className="text-neutral-700"> · </span>
                  <span className="text-neutral-300">{parts.detail}</span>
                </>
              )}
              <ResetAge at={reset.at} />
            </span>
            <Tooltip label="Dismiss">
              <button className={`icon-btn shrink-0 ${compact ? "h-5 w-5" : "h-6 w-6"}`} onClick={dismiss} aria-label="Dismiss">
                <X size={compact ? 11 : 12} />
              </button>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** " · 4 min ago", with the exact time on hover. Ticks only while the banner is up. */
function ResetAge({ at }: { at: ISODate }) {
  const now = useNow(1000);
  const t = Date.parse(at);
  if (!now || !Number.isFinite(t)) return null;
  return (
    <>
      <span className="text-neutral-700"> · </span>
      <Tooltip label={fmtStamp(at)}>
        <span className="tnum text-neutral-500">{fmtAge(now - t)}</span>
      </Tooltip>
    </>
  );
}
