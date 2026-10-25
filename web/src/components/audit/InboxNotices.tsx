"use client";

import { AnimatePresence, motion } from "motion/react";
import { Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import { Chip } from "@/components/ui/Chip";
import { inboxMarkReadRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { fmtStamp } from "@/lib/backend/format";
import { openCase, setLiveError, useLive } from "@/lib/backend/live";
import { mutate } from "@/lib/backend/run";
import type { Color, EventId, EventStatus, InboxEntry } from "@/lib/backend/types";
import { fmtMiss } from "@/lib/ops/format";
import { sfx } from "@/lib/sound";

// The personal inbox in real mode (wiring map §6, INBOX-6..8): one entry per fleet event from `useLive.inbox`, newest
// update first, in three sections. Unread entries are bold. Opening one marks it read for this person only; it never
// approves or resolves anything.

type Section = InboxEntry["section"];

const SECTIONS: { id: Section; label: string }[] = [
  { id: "attention", label: "Needs attention" },
  { id: "watch", label: "Watching" },
  { id: "previous", label: "Previous" },
];

/** Rows a section shows before "more": the fleet's history can run to a few hundred entries. */
const FIRST = 5;

const TONE: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "var(--muted)" };
const COLOR_LABEL: Record<Color, string> = { red: "Red", yellow: "Yellow", none: "No alert" };

// Backend statuses with the labels and colors of STATUS_META (keyed by the simulator's statuses). Verified reads as
// evidence, never as a confirmed maneuver.
const STATUS: Record<EventStatus, { label: string; color: string }> = {
  new: { label: "New", color: "var(--muted)" },
  agents: { label: "Agents working", color: "var(--blue)" },
  proposal: { label: "Proposal ready", color: "var(--amber)" },
  communication: { label: "In room", color: "#a594ff" },
  approved: { label: "Approved", color: "var(--green)" },
  scheduled: { label: "Scheduled", color: "var(--green)" },
  monitoring: { label: "Monitoring", color: "var(--fg-2)" },
  awaiting_verification_data: { label: "Awaiting data", color: "var(--orange)" },
  verified: { label: "Consistent with plan", color: "var(--green)" },
  flagged: { label: "Mismatch", color: "var(--red)" },
  no_action_needed: { label: "No action needed", color: "var(--muted)" },
};

const MISSING: Record<string, string> = { pc: "probability", "pc.epochUtc": "probability epoch", spread: "source spread", room: "room" };

/** `missing[]` in words (INBOX-3): "owner:B" → "side B owner". An unknown key is shown as it is, never dropped. */
function missingText(keys: string[]): string[] {
  return keys
    .filter((k) => !(k === "pc.epochUtc" && keys.includes("pc")))
    .map((k) => {
      const [field, side] = k.split(":");
      if (side && (field === "owner" || field === "contact")) return `side ${side} ${field}`;
      return MISSING[k] ?? k;
    });
}

export function InboxNotices() {
  const inbox = useLive((s) => s.inbox);
  const error = useLive((s) => s.errors.inbox);
  const [pending, setPending] = useState<EventId | null>(null);
  const [failed, setFailed] = useState<{ eventId: EventId; message: string } | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<Section, boolean>>>({});

  async function open(entry: InboxEntry) {
    if (pending) return;
    setPending(entry.eventId);
    setFailed(null);
    try {
      await mutate(inboxMarkReadRef, { eventId: entry.eventId });
    } catch (e) {
      setFailed({ eventId: entry.eventId, message: backendError(e).message });
      setPending(null);
      return;
    }
    setPending(null);
    sfx.whoosh();
    openCase(entry.eventId, entry.room?.roomId);
  }

  return (
    <div className="mb-3 px-2 pt-1">
      {error && <SyncError message={error} />}
      {inbox === undefined ? (
        !error && <Loading />
      ) : inbox.length === 0 ? (
        <section>
          <Label text="Notifications" />
          <p className="rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[12px] leading-[1.5] text-neutral-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
            No incidents involve your fleet yet. A scan that finds a close approach adds one here, and each later update lands on the same entry.
          </p>
        </section>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }} className="space-y-3">
          {SECTIONS.map(({ id, label }) => {
            const rows = inbox.filter((e) => e.section === id);
            if (rows.length === 0) return null;
            const shown = expanded[id] ? rows : rows.slice(0, FIRST);
            return (
              <section key={id}>
                <Label text={label} count={rows.length} />
                <ul className="space-y-1.5">
                  <AnimatePresence initial={false}>
                    {shown.map((entry) => (
                      <motion.li
                        key={entry.eventId}
                        layout="position"
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97 }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <Row
                          entry={entry}
                          busy={pending !== null}
                          opening={pending === entry.eventId}
                          failure={failed?.eventId === entry.eventId ? failed.message : null}
                          onOpen={() => open(entry)}
                        />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
                {rows.length > FIRST && (
                  <button
                    className="btn mt-1.5 h-7 w-full text-[11.5px] text-neutral-400"
                    onClick={() => {
                      sfx.click();
                      setExpanded((s) => ({ ...s, [id]: !s[id] }));
                    }}
                  >
                    {expanded[id] ? "Show fewer" : `Show ${rows.length - FIRST} more`}
                  </button>
                )}
              </section>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

function Row({
  entry,
  busy,
  opening,
  failure,
  onOpen,
}: {
  entry: InboxEntry;
  busy: boolean;
  opening: boolean;
  failure: string | null;
  onOpen: () => void;
}) {
  const tone = TONE[entry.color];
  const status = STATUS[entry.status] ?? { label: entry.status, color: "var(--muted)" };
  const gaps = missingText(entry.missing);
  return (
    <div className="flex items-center gap-3 rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <span
        role="img"
        aria-label={COLOR_LABEL[entry.color]}
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: tone, boxShadow: entry.unread && entry.color !== "none" ? `0 0 10px ${tone}` : undefined }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-[13px] ${entry.unread ? "font-semibold text-white" : "font-normal text-fg-2"}`}>{entry.title}</span>
          {entry.simulated && <span className="mono shrink-0 text-[8.5px] uppercase tracking-[0.1em] text-orange">sim</span>}
          <Chip color={status.color} size="sm" className="ml-auto">
            {status.label}
          </Chip>
        </div>
        <p className={`mt-0.5 text-[12px] leading-[1.45] ${entry.unread ? "text-neutral-300" : "text-neutral-500"}`}>{entry.lastUpdateSummary}</p>
        <div className="mono tnum mt-1 flex flex-wrap gap-x-3 text-[11px] text-neutral-500">
          <span>TCA {fmtStamp(entry.tcaUtc)}</span>
          <span>Miss {Number.isFinite(entry.missKm) ? fmtMiss(entry.missKm * 1000) : "unknown"}</span>
        </div>
        {gaps.length > 0 && <p className="mt-0.5 text-[11px] leading-[1.45] text-faint">Unavailable: {gaps.join(", ")}</p>}
        {failure && <p className="mt-1 text-[11.5px] leading-[1.45] text-red">{failure}</p>}
      </div>
      <button className="btn h-8 shrink-0 px-3 text-[12px] text-neutral-300 disabled:opacity-50" disabled={busy} onClick={onOpen}>
        {opening && <Loader2 size={12} className="animate-spin" />}
        Open
      </button>
    </div>
  );
}

function Label({ text, count }: { text: string; count?: number }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
      {text}
      {count !== undefined && <span className="mono tnum font-normal tracking-normal text-faint">{count}</span>}
    </div>
  );
}

function Loading() {
  return (
    <section role="status" aria-label="Loading the inbox">
      <Label text="Notifications" />
      <div className="space-y-1.5">
        {[0, 1].map((i) => (
          <div key={i} className="animate-pulse rounded-[12px] bg-white/[0.03] px-3.5 py-3" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="h-3 w-44 rounded bg-white/[0.07]" />
            <div className="mt-2 h-2.5 w-72 max-w-full rounded bg-white/[0.05]" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** inbox.list failed (its message comes from LiveSync's boundary). Retry remounts every sync. */
function SyncError({ message }: { message: string }) {
  return (
    <div className="mb-3 flex items-center gap-3 rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-white">Couldn’t load the inbox</div>
        <p className="mono mt-0.5 break-words text-[10.5px] leading-[1.5] text-muted">{message}</p>
      </div>
      <button
        className="btn btn-ghost-line h-7 shrink-0 text-[11px]"
        onClick={() => {
          sfx.click();
          setLiveError("inbox", null);
          useLive.setState((s) => ({ epoch: s.epoch + 1 }));
        }}
      >
        <RotateCw size={11} /> Retry
      </button>
    </div>
  );
}
