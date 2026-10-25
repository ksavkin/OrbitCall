"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, DoorOpen, ServerOff } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { toggleDev } from "@/components/ui/Navbar";
import { STATUS_META } from "@/components/ops/meta";
import { CallStage, type FlagOf } from "./CallStage";
import { useSimCall } from "./simCall";

// Rooms: one coordination room per incident, with the live call in the middle and the case beside it.
// Dev mode runs a simulated call with the same shape as the real hook; live mode waits for the backend's
// call module (convex/call) and the voice worker, and the /call test page proves the real path until then.

const ROOM_STATUSES: ConjunctionEvent["status"][] = [
  "proposal",
  "communication",
  "approved",
  "scheduled",
  "awaiting_verification",
  "verified",
  "needs_decision",
  "monitoring",
];

export function RoomsScreen() {
  const dev = useOps((s) => s.dev);
  const events = useOps((s) => s.events);
  const incident = useOps((s) => s.incident);
  const rooms = useMemo(
    () =>
      events
        // a room needs someone on the other side: debris and dead satellites have no operator to call
        .filter((e) => (e.parties ?? []).some((p) => p.role === "b"))
        .filter((e) => e.id === incident || ROOM_STATUSES.includes(e.status))
        .sort((a, b) => (a.id === incident ? -1 : b.id === incident ? 1 : a.tca - b.tca)),
    [events, incident],
  );
  const [pick, setPick] = useState<string | null>(null);
  const roomId = pick && rooms.some((r) => r.id === pick) ? pick : (rooms[0]?.id ?? null);
  const e = rooms.find((r) => r.id === roomId);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.99, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.99, filter: "blur(6px)" }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-auto absolute inset-x-2.5 bottom-[42px] top-[58px] z-[38] grid grid-cols-[280px_minmax(0,1fr)_320px] overflow-hidden rounded-[18px] bg-[rgba(4,4,5,0.94)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_40px_100px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
    >
      <RoomList rooms={rooms} active={roomId} onPick={setPick} />
      <div className="flex min-h-0 flex-col border-x border-white/[0.06]">
        {!dev ? (
          <LiveUnavailable />
        ) : e ? (
          <RoomCall key={e.id} e={e} />
        ) : (
          <Empty
            title="No open rooms"
            body="A room opens when another operator is in a case and the agents have a plan. Debris cases have no one to call. Run a scan on Conjunctions and pick a case with two operators."
          />
        )}
      </div>
      <CaseSide e={dev ? e : undefined} />
    </motion.div>
  );
}

/** One room's call. Keyed by room: switching rooms leaves the call, as the real hook does. */
function RoomCall({ e }: { e: ConjunctionEvent }) {
  const call = useSimCall(e);
  const flagOf: FlagOf = (p) => {
    if (p.isTranslator) return null;
    const id = p.identity.replace(/^user-/, "");
    return e.parties?.find((x) => x.id === id)?.country ?? null;
  };
  return (
    <CallStage
      call={call}
      flagOf={flagOf}
      title={`Coordination room · ${e.id}`}
      subtitle={
        <>
          {e.a.name} × {e.b.name} · closest approach {fmtWhen(e.tca)}
        </>
      }
    />
  );
}

function RoomList({ rooms, active, onPick }: { rooms: ConjunctionEvent[]; active: string | null; onPick: (id: string) => void }) {
  const incident = useOps((s) => s.incident);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[16px] font-semibold text-white">Rooms</div>
        <div className="text-[12px] text-neutral-500">One room per case · voice and text, translated live</div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {rooms.length === 0 && <div className="px-3 py-6 text-[12.5px] text-neutral-600">No rooms yet.</div>}
        {rooms.map((e) => {
          const st = STATUS_META[e.status];
          const on = e.id === active;
          return (
            <button
              key={e.id}
              onClick={() => {
                sfx.click();
                onPick(e.id);
              }}
              onPointerEnter={() => sfx.hover()}
              className={`relative mb-1 block w-full rounded-[12px] px-3 py-2.5 text-left transition-colors ${on ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"}`}
            >
              {on && <motion.span layoutId="room-sel" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white" />}
              <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                <span className="mono">{e.id}</span>
                {e.id === incident && <span className="rounded-full bg-[rgba(79,140,255,0.14)] px-1.5 text-[10px] font-medium text-blue">your case</span>}
                <span className="ml-auto" style={{ color: st.color }}>
                  {st.label}
                </span>
              </div>
              <div className="mt-1 truncate text-[13.5px] font-medium text-white">
                {e.a.name} <span className="text-neutral-600">×</span> {e.b.name}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {(e.parties ?? []).map((p) =>
                  p.country ? (
                    <span key={p.id} className="overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
                      <Flag code={p.country} h={14} />
                    </span>
                  ) : null,
                )}
                <span className="ml-1 text-[11px] text-neutral-500">{(e.parties ?? []).length} {(e.parties ?? []).length === 1 ? "party" : "parties"}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CaseSide({ e }: { e: ConjunctionEvent | undefined }) {
  if (!e) return <div />;
  const p = e.proposal;
  const openCase = () => {
    sfx.whoosh();
    const st = useOps.getState();
    st.set({ tab: "conjunctions", focusEvent: e.id, ...(st.incident === e.id ? { incidentView: "expanded" as const } : {}) });
  };
  return (
    <div className="thin-scroll min-h-0 overflow-y-auto px-5 py-5">
      <div className="text-[12px] font-semibold text-neutral-500">The case</div>
      <div className="mt-2 text-[16px] font-semibold leading-snug text-white">
        {e.a.name} passes {fmtMiss(e.missM)} from {e.b.name}
      </div>
      <div className="tnum mt-1 text-[12.5px] text-neutral-500">
        {fmtWhen(e.tca)} · chance <span className={e.risk === "red" ? "text-[#ff8a80]" : "text-amber"}>{fmtOdds(e.pc)}</span>
      </div>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="text-[12px] font-semibold text-neutral-500">Plan on the table</div>
        {p ? (
          <>
            <div className="mt-1.5 text-[14px] font-semibold text-white">
              {p.action === "wait" ? "Both wait for the next CDM" : `${p.mover === "a" ? e.a.name : e.b.name} ${p.action}s ${p.dvMs} m/s`}
            </div>
            <div className="tnum mt-0.5 text-[12.5px] text-neutral-400">
              v{p.version} · miss {fmtMiss(p.missBeforeM)} → <span className="text-white">{fmtMiss(p.missAfterM)}</span>
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[13px] text-neutral-500">The agents are still preparing a plan.</div>
        )}
      </div>

      <div className="mt-5 space-y-2.5 border-t border-white/[0.06] pt-4">
        <div className="text-[12px] font-semibold text-neutral-500">Who has approved</div>
        {(e.parties ?? [])
          .filter((x) => x.role !== "affected")
          .map((x) => {
            const a = e.approvals[x.role as "a" | "b"];
            const color = a === "approved" ? "var(--green)" : a === "vetoed" ? "var(--red)" : a === "countered" ? "var(--orange)" : "#737373";
            return (
              <div key={x.id} className="flex items-center gap-2.5">
                <span className="overflow-hidden rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">{x.country && <Flag code={x.country} h={20} />}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-white">{x.operator.replace(/\s*\(synthetic\)/i, "")}</span>
                <span className="text-[12px] font-medium" style={{ color }}>
                  {a === "vetoed" ? "rejected" : a === "pending" ? "waiting" : a}
                </span>
              </div>
            );
          })}
      </div>

      <p className="mt-5 rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[1.55] text-neutral-400">
        Talking never approves anything. Approve or reject the plan in the case.
      </p>
      <button className="btn btn-primary mt-3 h-10 w-full gap-1.5 text-[13px]" onClick={openCase}>
        <DoorOpen size={14} /> Open the case <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

function LiveUnavailable() {
  return (
    <Empty
      icon={<ServerOff size={18} />}
      title="Live rooms need the call backend"
      body="The call module is installed in the app. Live rooms start once the backend deploys its call functions (convex/call) and the voice worker runs with its keys. The /call test page checks the real path with a seeded room."
      action={
        <button className="btn btn-ghost-line mt-4 h-9 px-3 text-[12.5px]" onClick={() => toggleDev()}>
          Try a simulated room <span className="kbd">D</span>
        </button>
      }
    />
  );
}

function Empty({ title, body, icon, action }: { title: string; body: string; icon?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid h-full place-items-center px-10 text-center">
        <div className="max-w-[420px]">
          {icon && <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-white/[0.05] text-neutral-400">{icon}</div>}
          <div className="text-[16px] font-semibold text-white">{title}</div>
          <p className="mt-2 text-[13px] leading-[1.6] text-neutral-500">{body}</p>
          {action}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
