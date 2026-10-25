"use client";

import { AnimatePresence, motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useMe } from "@/components/auth/session";
import { SummaryFormPanel } from "@/components/live/SummaryForm";
import { VerificationPanel } from "@/components/live/Verification";
import { ProposalPanel } from "@/components/proposals/ProposalPanel";
import { useLive } from "@/lib/backend/live";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { useNow } from "@/lib/useNow";
import { aboutEvent, mergeTimeline } from "./live";
import { LiveItem } from "./LiveLines";
import { usePinnedScroll } from "./useRoom";

// Real mode: the Decision Center's meeting on the backend room (wiring map §3). The plans stay pinned above the
// discussion while there are any; the panel gates turns itself and carries the reset banner. Below: this incident's
// lines and the room-wide ones, oldest at the top, with the call's voice phrases; system lines (every reset, the room
// closing) as centred notices. The end-of-call summary form and the verification close the case.

export function LiveMeeting({ e, viewer }: { e: ConjunctionEvent; viewer: "a" | "b" }) {
  const eventId = e.id;
  const roomId = useLive((s) => s.roomId);
  const room = useLive((s) => s.room);
  const messages = useLive((s) => s.messages);
  const plans = useLive((s) => (s.proposals?.length ?? 0) > 0);
  const voice = useOps((s) => (s.callLive?.eventId === eventId ? s.callLive.messages : undefined));
  const myUserId = useMe()?.userId ?? null;
  const items = useMemo(() => mergeTimeline(aboutEvent(messages ?? [], eventId), aboutEvent(voice ?? [], eventId)), [messages, voice, eventId]);
  const { box, list } = usePinnedScroll();

  return (
    <div className="absolute inset-0 flex flex-col" data-testid="meeting-wrap" data-mode="live">
      {plans && <PinnedPlans e={e} viewer={viewer} />}
      <div ref={box} className={`thin-scroll min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] ${plans ? "mt-3 border-t border-white/[0.06]" : ""}`} data-testid="meeting">
        <div ref={list} className="mx-auto flex max-w-[908px] flex-col gap-4 px-6 pb-6 pt-3">
          <div className="pb-1 text-center text-[11.5px] text-neutral-600">
            Shared with everyone in this room · each person reads it in their own language · nothing here approves anything
          </div>
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <LiveItem key={it.key} it={it} room={room} eventId={eventId} myUserId={myUserId} />
            ))}
          </AnimatePresence>
          <MeetingState hasRoom={!!roomId} loading={messages === undefined} empty={items.length === 0} />
          <SummaryFormPanel eventId={eventId} roomId={roomId} />
          <VerificationPanel eventId={eventId} />
        </div>
      </div>
    </div>
  );
}

/**
 * The plans, pinned above the discussion as in the simulator, so people talk about them underneath. The panel gates
 * turns from approvals.status itself; the orange rim says it is this side's turn. The countdown runs on its own clock,
 * at the case view's 250 ms.
 */
function PinnedPlans({ e, viewer }: { e: ConjunctionEvent; viewer: "a" | "b" }) {
  const now = useNow(250);
  const myTurn = useLive((s) => s.approvals?.myTurn ?? false);
  return (
    <div className="thin-scroll max-h-[58%] shrink-0 overflow-y-auto px-6 pt-1 [scrollbar-gutter:stable]">
      <motion.div
        layout
        className={`mx-auto max-w-[860px] rounded-[16px] ${myTurn ? "bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,159,64,0.32)]" : "bg-white/[0.015] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"}`}
        data-testid="meeting-decision"
      >
        <ProposalPanel e={e} viewer={viewer} now={now} embedded />
      </motion.div>
    </div>
  );
}

/** Before the room opens, while it loads, when it fails, when nothing is said yet, and while the agents work. */
function MeetingState({ hasRoom, loading, empty }: { hasRoom: boolean; loading: boolean; empty: boolean }) {
  const error = useLive((s) => s.errors.room);
  const working = useLive((s) => s.summary?.agentsWorking ?? false);
  const note = (text: string) => <div className="py-6 text-center text-[13px] leading-[1.6] text-neutral-500">{text}</div>;
  if (!hasRoom) return note("The coordination room opens when the agents start on this case. What people say, the agents' notes and every reset appear here.");
  if (error) {
    return (
      <div className="flex items-center justify-center gap-3 py-6 text-[13px] text-[#ff8a80]" role="alert" data-testid="meeting-error">
        Could not load the room · {error}
        <button className="btn btn-ghost-line h-8 px-3 text-[12px] text-neutral-300" onClick={() => useLive.setState((s) => ({ epoch: s.epoch + 1 }))}>
          Retry
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="py-6 text-center text-[13px]">
        <span className="shimmer">Opening the room…</span>
      </div>
    );
  }
  if (working) {
    return (
      <div className="flex items-center gap-2.5 pl-1 text-[13px] text-neutral-500">
        <Sparkles size={13} className="text-[#9cc2ff]" />
        <span className="shimmer font-medium">The agents are working · their notes appear here</span>
      </div>
    );
  }
  return empty ? note("Nothing said yet. Type in the call below, or talk; each side reads it in their own language.") : null;
}
