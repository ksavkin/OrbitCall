"use client";

import { useQuery } from "convex/react";
import { motion } from "motion/react";
import { ArrowUpRight, DoorOpen, Eye, Hourglass, Loader2, LogIn, RotateCw, ServerOff } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useMe } from "@/components/auth/session";
import { STATUS_META } from "@/components/ops/meta";
import { Chip } from "@/components/ui/Chip";
import { roomsMineRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { fmtObjectId, fmtStamp } from "@/lib/backend/format";
import { openCase } from "@/lib/backend/live";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import type { Color, EventStatus, RoomEvent, RoomId, RoomProjection } from "@/lib/backend/types";
import { fmtCountdown } from "@/lib/ops/format";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { sfx } from "@/lib/sound";
import { useOrbit } from "@/lib/store";
import { useNow } from "@/lib/useNow";

// Real mode: the caller's open coordination rooms (rooms.listMine, wiring map §3.2), earliest closest approach first.
// Pick a room on the left; the middle shows its incidents and who is in it, and an incident opens its case with the
// room remembered for this tab (§1.5: once a room closes, listMine and rooms.get no longer return it).

type Member = RoomProjection["members"][number];

const TONE: Record<Color, string> = { red: "var(--red)", yellow: "var(--amber)", none: "var(--muted)" };
const COLOR_LABEL: Record<Color, string> = { red: "Red", yellow: "Yellow", none: "No alert" };

// Backend statuses drawn with the existing status labels and colors.
const STATUS_OF: Record<EventStatus, ConjunctionEvent["status"]> = {
  new: "new",
  agents: "agents",
  proposal: "proposal",
  communication: "communication",
  approved: "approved",
  scheduled: "scheduled",
  monitoring: "monitoring",
  awaiting_verification_data: "awaiting_verification",
  verified: "verified",
  flagged: "flagged",
  no_action_needed: "no_action",
};

/** The left and middle columns of the Rooms screen, behind their own boundary so a refused read stays here. */
export function MyRooms() {
  const [attempt, setAttempt] = useState(0);
  return (
    <QueryBoundary key={attempt} fallback={(e) => <Unavailable error={e} onRetry={() => setAttempt((n) => n + 1)} />}>
      <Rooms />
    </QueryBoundary>
  );
}

function Rooms() {
  const rooms = useQuery(roomsMineRef, {});
  const [pick, setPick] = useState<RoomId | null>(null);
  const now = useNow(1000);

  if (rooms === undefined) {
    return (
      <Columns
        list={<LoadingRows />}
        main={<Center icon={<Loader2 size={18} className="animate-spin" />} title="Loading your rooms" body="Reading the open rooms of your incidents." />}
      />
    );
  }
  if (rooms.length === 0) {
    return (
      <Columns
        list={<div className="px-3 py-6 text-[12.5px] text-neutral-600">No open rooms.</div>}
        main={
          <Center
            icon={<DoorOpen size={18} />}
            title="No open coordination rooms"
            body="A room opens when someone runs the agents on one of your incidents. Everyone assigned to the satellites involved is added, and the Inbox tells them."
          />
        }
      />
    );
  }
  const room = rooms.find((r) => r.roomId === pick) ?? rooms[0];
  return (
    <Columns
      list={rooms.map((r, i) => (
        <motion.div
          key={r.roomId}
          layout="position"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, delay: Math.min(i, 12) * 0.015, ease: [0.22, 1, 0.36, 1] }}
        >
          <RoomRow room={r} on={r.roomId === room.roomId} now={now} onPick={setPick} />
        </motion.div>
      ))}
      main={<RoomBoard key={room.roomId} room={room} now={now} />}
    />
  );
}

function Columns({ list, main }: { list: ReactNode; main: ReactNode }) {
  return (
    <>
      <div className="flex min-h-0 flex-col">
        <div className="px-5 pb-3 pt-5">
          <div className="text-[16px] font-semibold text-white">Rooms</div>
          <div className="text-[12px] text-neutral-500">Your open rooms · earliest closest approach first</div>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">{list}</div>
      </div>
      <div className="flex min-h-0 flex-col border-x border-white/[0.06]">{main}</div>
    </>
  );
}

/* ------------------------------------------------------------------ list */

function RoomRow({ room, on, now, onPick }: { room: RoomProjection; on: boolean; now: number; onPick: (id: RoomId) => void }) {
  const first = room.linkedEvents[0];
  const more = room.linkedEvents.length - 1;
  const names = useObjectNames(first?.objectIds ?? []);
  return (
    <button
      onClick={() => {
        sfx.click();
        onPick(room.roomId);
      }}
      onPointerEnter={() => sfx.hover()}
      className={`relative mb-1 block w-full rounded-[12px] px-3 py-2.5 text-left transition-colors ${on ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"}`}
    >
      {on && <motion.span layoutId="my-room-sel" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-white" />}
      <div className="flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[worst(room.linkedEvents)] }} />
        {/* the ids sit here when the title shows names; without any name the title is the ids */}
        {first && names.some(Boolean) && <span className="mono truncate">{pairOf(first)}</span>}
        {more > 0 && <span className="mono shrink-0">+{more}</span>}
        {room.simulated && <SimPill />}
        {first && <Countdown iso={first.tcaUtc} now={now} />}
      </div>
      <div className="mt-1 truncate text-[13.5px] font-medium text-white">{first ? <PairNames ids={first.objectIds} names={names} /> : <Companies room={room} />}</div>
      {first && (
        <div className="mt-0.5 truncate text-[12px] text-neutral-500">
          <Companies room={room} />
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <RoomState events={room.linkedEvents} />
        <Presence members={room.members} />
      </div>
    </button>
  );
}

/** Your turn anywhere in the room wins, then the side deciding, then the first incident's status. */
function RoomState({ events }: { events: RoomEvent[] }) {
  const ev = events.find((e) => e.myTurn) ?? events.find((e) => e.deciding) ?? events[0];
  if (!ev) return null;
  return ev.deciding ? <TurnChip ev={ev} /> : <StatusChip status={ev.status} />;
}

function Presence({ members }: { members: Member[] }) {
  const inCall = members.filter((m) => m.inCall).length;
  const inRoom = members.filter((m) => m.inRoom).length;
  return (
    <span className="tnum ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-500">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: inCall ? "var(--green)" : "#5a5a5a" }} />
      <span className="truncate">{inCall ? `${inCall} in the call` : `${inRoom} in the room`}</span>
    </span>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-1" role="status" aria-label="Loading rooms">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-[12px] bg-white/[0.03] px-3 py-2.5" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="h-2 w-24 rounded bg-white/[0.07]" />
          <div className="mt-2 h-3 w-40 rounded bg-white/[0.07]" />
          <div className="mt-2 h-2.5 w-28 rounded bg-white/[0.05]" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ the picked room */

function RoomBoard({ room, now }: { room: RoomProjection; now: number }) {
  const first = room.linkedEvents[0];
  const n = room.linkedEvents.length;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="thin-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5"
    >
      <div className="flex items-center gap-2 text-[11.5px] font-medium text-neutral-500">
        <span className="h-1.5 w-1.5 rounded-full bg-green" style={{ boxShadow: "0 0 8px var(--green)" }} />
        Open since <span className="mono tnum">{fmtStamp(room.createdAt)}</span>
        {room.simulated && <span className="rounded-full bg-[rgba(255,159,64,0.12)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-orange">simulated</span>}
      </div>
      <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.02em] text-white">
        <Companies room={room} />
      </div>
      <div className="mt-0.5 text-[13px] text-neutral-500">
        {n} {n === 1 ? "incident" : "linked incidents"}
        {first && (
          <>
            {" "}
            · closest approach <span className="mono tnum">{fmtStamp(first.tcaUtc)}</span>
          </>
        )}
      </div>

      <div className="mt-6 text-[12px] font-semibold text-neutral-500">{n === 1 ? "The incident" : "Incidents in this room"}</div>
      <div className="mt-2 space-y-2">
        {room.linkedEvents.map((ev) => (
          <IncidentCard key={ev.eventId} ev={ev} roomId={room.roomId} now={now} />
        ))}
      </div>

      <div className="mt-6 text-[12px] font-semibold text-neutral-500">People</div>
      <People room={room} />

      <p className="mt-6 text-[12px] leading-[1.55] text-neutral-600">The call, the plans and the approvals are inside the case. Closed rooms leave this list.</p>
    </motion.div>
  );
}

function IncidentCard({ ev, roomId, now }: { ev: RoomEvent; roomId: RoomId; now: number }) {
  const names = useObjectNames(ev.objectIds);
  return (
    <div className="relative flex items-center gap-4 overflow-hidden rounded-[12px] bg-white/[0.025] py-3 pl-4 pr-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
      <span
        className="absolute bottom-3 left-0 top-3 w-[2px] rounded-full"
        style={{ background: ev.color === "none" ? "rgba(255,255,255,0.18)" : TONE[ev.color], boxShadow: ev.color === "none" ? undefined : `0 0 8px ${TONE[ev.color]}` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          Closest approach <span className="mono tnum text-neutral-400">{fmtStamp(ev.tcaUtc)}</span>
          <Countdown iso={ev.tcaUtc} now={now} />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium text-white">
            <PairNames ids={ev.objectIds} names={names} />
          </span>
          {ev.simulated && <SimPill />}
        </div>
        {names.some(Boolean) && <div className="mono mt-0.5 truncate text-[11px] text-neutral-500">{pairOf(ev)}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Chip color={TONE[ev.color]} size="sm">
            {COLOR_LABEL[ev.color]}
          </Chip>
          <StatusChip status={ev.status} />
          {ev.deciding && <TurnChip ev={ev} />}
          {ev.mySide && <span className="ml-1 text-[11px] text-neutral-500">You are side {ev.mySide}</span>}
        </div>
      </div>
      <button
        className="btn btn-primary h-9 shrink-0 gap-1.5 px-3 text-[12.5px]"
        onClick={() => {
          sfx.whoosh();
          openCase(ev.eventId, roomId);
        }}
      >
        <DoorOpen size={13} /> Open the case <ArrowUpRight size={12} />
      </button>
    </div>
  );
}

function People({ room }: { room: RoomProjection }) {
  const myUserId = useMe()?.userId ?? null;
  if (room.members.length === 0) return <div className="mt-2 text-[12.5px] text-neutral-600">Nobody has been added to this room yet.</div>;
  // my company first, so "who is here from our side" reads before the other side
  const members = [...room.members].sort((a, b) => Number(b.companyId === room.myCompanyId) - Number(a.companyId === room.myCompanyId));
  const companyOf = (id: string) => room.companies.find((c) => c.companyId === id)?.name ?? "Unknown company";
  return (
    <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
      {members.map((m) => (
        <MemberTile key={m.userId} m={m} company={companyOf(m.companyId)} me={m.userId === myUserId} />
      ))}
    </div>
  );
}

function MemberTile({ m, company, me }: { m: Member; company: string; me: boolean }) {
  const name = m.name ?? "Unnamed operator";
  const st = m.inCall
    ? { text: "In the call", color: "var(--green)" }
    : m.inRoom
      ? { text: "In the room", color: "var(--fg-2)" }
      : { text: "Not in the room", color: "#8a8a8a" };
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-[12px] bg-white/[0.03] py-1.5 pl-1.5 pr-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[#16171b] text-[11px] font-semibold tracking-[0.02em] text-neutral-300 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]">
        {initials(name)}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-medium leading-tight text-white">
          <span className="truncate">{name}</span>
          {me && <span className="shrink-0 text-[11px] font-normal text-neutral-500">you</span>}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-tight">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: st.color }} />
          <span className="shrink-0 font-medium" style={{ color: st.color }}>
            {st.text}
          </span>
          <span className="text-neutral-700">·</span>
          <span className="truncate text-neutral-500">{company}</span>
        </span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function TurnChip({ ev }: { ev: RoomEvent }) {
  if (ev.myTurn) {
    return (
      <Chip color="var(--orange)" size="sm" dot>
        Your turn
      </Chip>
    );
  }
  return ev.turn ? (
    <Chip color="var(--muted)" size="sm" icon={<Hourglass size={9} />}>
      Side {ev.turn} is deciding
    </Chip>
  ) : null;
}

function StatusChip({ status }: { status: EventStatus }) {
  // a status added on the backend after this build reads as itself instead of breaking the list
  const st = STATUS_META[STATUS_OF[status]] ?? { label: status, color: "var(--muted)" };
  return (
    <Chip color={st.color} size="sm">
      {st.label}
    </Chip>
  );
}

function Companies({ room }: { room: RoomProjection }) {
  const names = [...room.companies]
    .sort((a, b) => Number(b.companyId === room.myCompanyId) - Number(a.companyId === room.myCompanyId))
    .map((c) => c.name);
  if (names.length === 0) return <>Coordination room</>;
  return (
    <>
      {names.map((name, i) => (
        <span key={i}>
          {i > 0 && <span className="text-neutral-600"> × </span>}
          {name}
        </span>
      ))}
    </>
  );
}

/** "ISS (ZARYA) × STARLINK-1234"; an object the catalog does not know reads as its "#ID" in mono. */
function PairNames({ ids, names }: { ids: string[]; names: (string | null)[] }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={i}>
          {i > 0 && <span className="text-neutral-600"> × </span>}
          {names[i] ?? <span className="mono">{fmtObjectId(id)}</span>}
        </span>
      ))}
    </>
  );
}

function Countdown({ iso, now }: { iso: string; now: number }) {
  const t = Date.parse(iso);
  const known = now > 0 && Number.isFinite(t);
  return (
    <span className="mono tnum ml-auto shrink-0" style={{ color: known && t - now < 24 * 3600_000 ? "var(--orange)" : "var(--fg-2)" }}>
      {known ? fmtCountdown(t - now) : "—"}
    </span>
  );
}

function SimPill() {
  return <span className="shrink-0 rounded-full bg-[rgba(255,159,64,0.12)] px-1.5 text-[10px] font-medium text-orange">sim</span>;
}

/* ------------------------------------------------------------------ states */

function Unavailable({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const role = useMe()?.role;
  const { code, message } = backendError(error);
  const main =
    code === "UNAUTHENTICATED" ? (
      <Center
        icon={<LogIn size={18} />}
        title="Sign in to see your rooms"
        body="Rooms belong to the operators of each incident. Sign in with your company account."
        action={
          <Link href="/signin" className="btn btn-primary mt-4 h-9 px-3 text-[13px]" onClick={() => sfx.click()}>
            Sign in
          </Link>
        }
      />
    ) : code === "FORBIDDEN" && role === "demo_observer" ? (
      <Center
        icon={<Eye size={18} />}
        title="Rooms are for operators"
        body="Observers follow the demonstration on the public view. Calls, plans and approvals stay with the operators of each incident."
        action={
          <Link href="/observer" className="btn btn-primary mt-4 h-9 px-3 text-[13px]" onClick={() => sfx.click()}>
            Open the public view
          </Link>
        }
      />
    ) : code === "FORBIDDEN" ? (
      <Center
        icon={<LogIn size={18} />}
        title="No rooms for this account"
        body={message}
        action={
          <Link href="/signin" className="btn btn-primary mt-4 h-9 px-3 text-[13px]" onClick={() => sfx.click()}>
            Use another account
          </Link>
        }
      />
    ) : (
      <Center
        icon={<ServerOff size={18} />}
        title="Could not load your rooms"
        body={code === "UNKNOWN" ? briefError(error) : message}
        action={
          <button
            className="btn btn-ghost-line mt-4 h-9 gap-1.5 px-3 text-[12.5px]"
            onClick={() => {
              sfx.click();
              onRetry();
            }}
          >
            <RotateCw size={12} /> Try again
          </button>
        }
      />
    );
  return <Columns list={<div className="px-3 py-6 text-[12.5px] text-neutral-600">No rooms to show.</div>} main={main} />;
}

function Center({ title, body, icon, action }: { title: string; body: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid h-full place-items-center px-10 text-center">
      <div className="max-w-[420px]">
        {icon && <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-white/[0.05] text-neutral-400">{icon}</div>}
        <div className="text-[16px] font-semibold text-white">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.6] text-neutral-500">{body}</p>
        {action}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * Object names from the globe's public catalog (the pinned OMM snapshot in real mode), by catalog number. Null for
 * "SIM-…" ids, before the catalog loads, or when it has no such object: the backend's room carries ids only.
 */
function useObjectNames(ids: string[]): (string | null)[] {
  const catalog = useOrbit((s) => s.catalog);
  const key = ids.join("|");
  return useMemo(
    () =>
      (key ? key.split("|") : []).map((id) => (/^\d+$/.test(id) ? (catalog?.objects.find((o) => o.norad === Number(id))?.name ?? null) : null)),
    [catalog, key],
  );
}

function pairOf(ev: RoomEvent): string {
  return ev.objectIds.map(fmtObjectId).join(" × ");
}

/** Red over yellow over no alert: the room's dot shows its most urgent incident. */
function worst(events: RoomEvent[]): Color {
  return events.some((e) => e.color === "red") ? "red" : events.some((e) => e.color === "yellow") ? "yellow" : "none";
}

/** "Dispatcher US" → "DU", as the call tiles draw a person without a flag. */
function initials(name: string) {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
