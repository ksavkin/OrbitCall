"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Check, DoorOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtMiss, fmtOdds, fmtWhen } from "@/lib/ops/format";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { Flag } from "@/components/ui/OwnerBadge";
import { STATUS_META } from "@/components/ops/meta";
import { CallStage, type FlagOf, type StageMode } from "./CallStage";
import { useSimCall } from "./simCall";
import { SAMPLE_ID, sampleCards, sampleEvent, sampleMessages } from "./sampleRoom";
import { roomCards } from "@/components/roomChat/model";
import { LiveRoom, useLiveTarget, type LiveTarget } from "./LiveRoom";
import { SmokeLiveCall } from "./SmokeLiveCall";
import { useMe } from "@/components/auth/session";
import {
  acceptSmokeInvite,
  isSmokeDemo,
  readSmokeInvite,
  smokeSideFor,
  subscribeSmokeInvites,
} from "@/lib/ops/smoke";

// Rooms: one coordination room per incident, with the live call in the middle and the case beside it.

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
        .filter((e) => !e.outcome?.resolvedAt && (e.id === incident || ROOM_STATUSES.includes(e.status)))
        .sort((a, b) => (a.id === incident ? -1 : b.id === incident ? 1 : a.tca - b.tca)),
    [events, incident],
  );
  // closed rooms stay readable: the whole meeting and the report, newest first
  const past = useMemo(() => events.filter((e) => e.outcome?.resolvedAt).sort((a, b) => b.outcome!.resolvedAt! - a.outcome!.resolvedAt!), [events]);
  const smoke = isSmokeDemo();
  // product recording: never fall back to a sample room; only real open cases
  const [sample] = useState(sampleEvent);
  const shown = rooms.length ? rooms : smoke ? [] : [sample];
  const [pick, setPick] = useState<string | null>(null);
  const roomId = pick && shown.some((r) => r.id === pick) ? pick : (shown[0]?.id ?? null);
  const e = shown.find((r) => r.id === roomId);
  const [live, setLive] = useLiveTarget();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.99, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.99, filter: "blur(6px)" }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-auto absolute inset-x-2.5 bottom-[42px] top-[58px] z-[38] grid grid-cols-[280px_minmax(0,1fr)_320px] overflow-hidden rounded-[18px] bg-[rgba(4,4,5,0.94)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_40px_100px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
    >
      {dev || smoke ? <RoomList rooms={shown} past={past} active={roomId} onPick={setPick} /> : <LiveList target={live} onClose={() => setLive(null)} />}
      <div className="flex min-h-0 flex-col border-x border-white/[0.06]">
        {!dev && !smoke ? (
          <LiveRoom target={live} onOpen={setLive} onLeave={() => setLive(null)} />
        ) : e ? (
          <RoomCall key={e.id} e={e} />
        ) : smoke ? (
          <SmokeInvitePanel />
        ) : (
          <Empty
            title="No open rooms"
            body="A room opens when operators are on a case and the agents have a plan. Run a scan on Orbit and open a case."
          />
        )}
      </div>
      {dev || smoke ? <CaseSide e={e} /> : <LiveSide />}
    </motion.div>
  );
}

/** Waiting for / accepting a coordination invite into the open case. */
function SmokeInvitePanel() {
  const me = useMe();
  const [invite, setInvite] = useState(() => readSmokeInvite());
  useEffect(() => subscribeSmokeInvites(setInvite), []);
  const side = smokeSideFor(me?.userId);
  const guest = side === "b" || side === "affected";
  if (!guest) {
    return (
      <Empty
        title="No open rooms"
        body="Run a scan on Orbit, open the red case, and let the agents invite the other operators."
      />
    );
  }
  const pair = invite?.pair ?? "HAWK-7A × JILIN-1";
  const eventId = invite?.eventId ?? "coordination case";
  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#9cc2ff]">Invitation</div>
        <h2 className="mt-2 text-[18px] font-semibold text-white">Join the coordination room</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">
          American Satellite Dynamics opened {eventId} · {pair}. Accept to enter Decision Center and the live call.
        </p>
        <button
          className="btn btn-primary mt-5 h-10 px-5 text-[13px]"
          onClick={() => {
            if (!me?.userId) return;
            sfx.whoosh();
            acceptSmokeInvite(me.userId);
          }}
        >
          Accept invite
        </button>
      </div>
    </div>
  );
}

/** The plan a phrase names: "option B" / "plan 2" / "P2" / "вариант Б" → "P2". Null when it names none. */
function planNamed(text: string): string | null {
  const t = text.toLowerCase();
  const m = t.match(/\b(?:option|plan|card)\s*([a-d1-4])\b/) ?? t.match(/\bp\s*([1-4])\b/) ?? t.match(/вариант\s*([а-г1-4])/);
  if (!m) return null;
  const k = m[1];
  const n = "abcd".indexOf(k) + 1 || "абвг".indexOf(k) + 1 || Number(k);
  return n >= 1 && n <= 4 ? `P${n}` : null;
}

function useCallLock(e: ConjunctionEvent) {
  const viewer = useOps((s) => s.actAs ?? "a");
  const humans = useOps((s) => s.humans);
  const deciding = useMemo(() => humans.filter((h) => h.eventId === e.id), [humans, e.id]);
  const otherSide = deciding.find((h) => h.side !== viewer);
  return otherSide && !deciding.some((h) => h.side === viewer)
    ? (e.parties?.find((p) => p.role === otherSide.side)?.operator ?? `Side ${otherSide.side.toUpperCase()}`).replace(/\s*\(synthetic\)/i, "")
    : undefined;
}

export function RoomCall({ e, compact = false }: { e: ConjunctionEvent; compact?: boolean }) {
  const isSample = e.id === SAMPLE_ID;
  const lockedBy = useCallLock(e);
  // product recording: real LiveKit + translator, not the local stand-in
  if (isSmokeDemo() && !isSample) {
    return <SmokeLiveCall e={e} compact={compact} lockedBy={lockedBy} />;
  }
  return <SimRoomCall e={e} compact={compact} lockedBy={lockedBy} isSample={isSample} />;
}

function SimRoomCall({
  e,
  compact = false,
  lockedBy,
  isSample,
}: {
  e: ConjunctionEvent;
  compact?: boolean;
  lockedBy?: string;
  isSample: boolean;
}) {
  const [mode, setMode] = useState<StageMode>("voice");
  const [seed] = useState(() => (isSample ? sampleMessages(e) : undefined));
  const call = useSimCall(e, { seed, joined: isSample, spaceToTalk: mode === "voice" && !lockedBy });

  // in a running case the call joins on its own: nobody should hunt for Join in the middle of a decision
  const joinedOnce = useRef(false);
  useEffect(() => {
    if (!compact || joinedOnce.current || call.state !== "idle") return;
    joinedOnce.current = true;
    void call.join();
  }, [compact, call]);

  // the parties bar shows who is in the call and who is speaking; only the case's docked call reports it
  const inCallKey = call.participants.filter((p) => !p.isTranslator).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const speakingKey = call.participants.filter((p) => p.speaking).map((p) => p.identity.replace(/^user-/, "")).join(",");
  const me = call.identity?.replace(/^user-/, "") ?? null;
  useEffect(() => {
    if (!compact) return;
    useOps.setState({ callLive: { eventId: e.id, inCall: inCallKey ? inCallKey.split(",") : [], speaking: speakingKey ? speakingKey.split(",") : [], messages: call.captions ?? [], me } });
  }, [compact, e.id, inCallKey, speakingKey, call.captions, me]);
  useEffect(() => (compact ? () => useOps.setState({ callLive: null }) : undefined), [compact]);

  // "option B", "P2", "вариант Б": a plan named in the call is offered for confirmation in the plan panel
  const lastSaid = useRef<string | null>(null);
  useEffect(() => {
    const myId = call.identity?.replace(/^user-/, "");
    const mine = [...(call.captions ?? [])].reverse().find((m) => m.author.kind === "human" && m.author.userId === myId);
    if (!mine || mine.messageId === lastSaid.current) return;
    lastSaid.current = mine.messageId;
    const label = planNamed(mine.originalText);
    if (label) useOps.setState({ voiceIntent: { eventId: e.id, label, said: mine.originalText, at: Date.now() } });
  }, [call.captions, call.identity, e.id]);
  const replies = useOps((s) => s.replies);
  const cards = useMemo(() => (isSample ? sampleCards(e) : roomCards(e, replies)), [e, replies, isSample]);
  const flagOf: FlagOf = (p) => {
    if (p.isTranslator) return null;
    const id = p.identity.replace(/^user-/, "");
    return e.parties?.find((x) => x.id === id)?.country ?? null;
  };
  return (
    <CallStage
      compact={compact}
      lockedBy={lockedBy}
      call={call}
      mode={mode}
      onMode={setMode}
      cards={cards}
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

function RoomList({ rooms, past, active, onPick }: { rooms: ConjunctionEvent[]; past: ConjunctionEvent[]; active: string | null; onPick: (id: string) => void }) {
  const incident = useOps((s) => s.incident);
  // a past room opens as its case: the meeting from the first note to the report
  const openPast = (id: string) => {
    sfx.click();
    useOps.setState({ incident: id, focusEvent: id, tab: "decision", incidentView: "expanded", resolved: null });
  };
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[16px] font-semibold text-white">Rooms</div>
        <div className="text-[12px] text-neutral-500">One room per case · voice and text, translated live</div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {past.length > 0 && <div className="px-3 pb-1.5 pt-1 text-[11px] font-medium text-neutral-500">Open</div>}
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
                {e.id === SAMPLE_ID && <span className="rounded-full bg-[rgba(255,159,64,0.12)] px-1.5 text-[10px] font-medium text-orange">sample</span>}
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
                    <span key={p.id} className="h-3.5 w-3.5 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
                      <Flag code={p.country} h={14} square />
                    </span>
                  ) : null,
                )}
                <span className="ml-1 text-[11px] text-neutral-500">{(e.parties ?? []).length} {(e.parties ?? []).length === 1 ? "party" : "parties"}</span>
              </div>
            </button>
          );
        })}
        {past.length > 0 && (
          <>
            <div className="px-3 pb-1.5 pt-4 text-[11px] font-medium text-neutral-500">Past · {past.length}</div>
            {past.map((e) => {
              const p = e.proposal;
              const plan = !p ? "Closed" : p.action === "wait" ? "Both waited" : `${p.mover === "a" ? e.a.name : e.b.name} ${p.action === "raise" ? "raised" : "lowered"} ${p.dvMs} m/s`;
              const at = new Date(e.outcome!.resolvedAt!);
              return (
                <button
                  key={e.id}
                  data-testid="past-room"
                  onClick={() => openPast(e.id)}
                  onPointerEnter={() => sfx.hover()}
                  className="mb-1 block w-full rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.035]"
                >
                  <div className="flex items-center gap-2 text-[11px] text-neutral-600">
                    <span className="mono">{e.id}</span>
                    <span className="tnum ml-auto">
                      Resolved {String(at.getUTCHours()).padStart(2, "0")}:{String(at.getUTCMinutes()).padStart(2, "0")} UTC
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[13px] font-medium text-neutral-300">
                    {e.a.name} <span className="text-neutral-600">×</span> {e.b.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-neutral-500">
                    <Check size={11} className="shrink-0 text-green" /> {plan}
                  </div>
                </button>
              );
            })}
          </>
        )}
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
    st.set(st.incident === e.id ? { tab: "decision", incidentView: "expanded" as const } : { tab: "orbit", focusEvent: e.id });
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
                <span className="h-5 w-5 shrink-0 overflow-hidden rounded-[4px] shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">{x.country && <Flag code={x.country} h={20} square />}</span>
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

function LiveList({ target, onClose }: { target: LiveTarget | null; onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[16px] font-semibold text-white">Rooms</div>
        <div className="text-[12px] text-neutral-500">Live calls · voice translated by the worker</div>
      </div>
      <div className="px-2.5">
        {target ? (
          <div className="relative rounded-[12px] bg-white/[0.07] px-3 py-2.5">
            <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white" />
            <div className="text-[11px] text-neutral-500">Open room</div>
            <div className="mono mt-1 truncate text-[13px] text-white">{target.roomId}</div>
            <button className="mt-2 text-[12px] text-neutral-400 underline-offset-2 hover:text-white hover:underline" onClick={onClose}>
              Open another room
            </button>
          </div>
        ) : (
          <div className="px-3 py-6 text-[12.5px] text-neutral-600">No room open.</div>
        )}
      </div>
    </div>
  );
}

function LiveSide() {
  return (
    <div className="px-5 py-5">
      <div className="text-[12px] font-semibold text-neutral-500">How the room works</div>
      <ul className="mt-2.5 space-y-2 text-[12.5px] leading-[1.55] text-neutral-400">
        <li>Each person speaks their own language. The translator repeats every phrase in the other languages.</li>
        <li>Numbers, times and IDs are copied exactly, never translated.</li>
        <li>You hear only the translations, never the other person&rsquo;s raw microphone.</li>
      </ul>
      <p className="mt-5 rounded-[12px] bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[1.55] text-neutral-400">
        Talking never approves anything. Approve or reject the plan in the case.
      </p>
    </div>
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
