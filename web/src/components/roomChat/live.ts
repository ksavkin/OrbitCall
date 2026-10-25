import type { CallMessage } from "@/call/api";
import type { Role } from "@/components/auth/session";
import type { AgentRole, EventId, Lang, RoomEvent, RoomId, RoomMessage, RoomProjection, Side } from "@/lib/backend/types";

// Real mode (wiring map §3): pure reads of a backend room and its lines, shared by the meeting, the call's text view
// and the composer. No React, no store.

/** The backend room a call stage writes in, and the incident its lines are filed under (null: room-wide). */
export type StageChat = { roomId: RoomId; eventId: EventId | null };

/** messages.send takes 1 to 2000 characters (convex/messages.ts MAX_TEXT). */
export const MAX_TEXT = 2000;

export const LANG_NAME: Record<Lang, string> = { en: "English", ru: "Russian", zh: "Mandarin" };

export const AGENT_NAME: Record<AgentRole, string> = {
  risk_monitor: "Risk Monitor",
  incident_analyst: "Incident Analyst",
  operator_advocate: "Operator Advocate",
  coordination_host: "Coordination Host",
  maneuver_scheduler: "Maneuver Scheduler",
  maneuver_verifier: "Maneuver Verifier",
  second_model: "Independent check",
};

export type TimelineItem = { kind: "line"; at: number; key: string; m: RoomMessage } | { kind: "voice"; at: number; key: string; m: CallMessage };

/** Typed lines and voice phrases (the call keeps its own table) in one list, oldest first. */
export function mergeTimeline(lines: RoomMessage[], voice: CallMessage[]): TimelineItem[] {
  return [
    ...lines.map((m) => ({ kind: "line" as const, at: Date.parse(m.at), key: `line-${m.messageId}`, m })),
    ...voice.map((m) => ({ kind: "voice" as const, at: Date.parse(m.at), key: `voice-${m.messageId}`, m })),
  ].sort((a, b) => a.at - b.at);
}

/** One incident's share of the room: its own lines and the room-wide ones (the room closing). */
export function aboutEvent<T extends { eventId: string | null }>(lines: T[], eventId: EventId): T[] {
  return lines.filter((m) => m.eventId === null || m.eventId === eventId);
}

/** The linked incident a line is about: its own, else the view's, else the room's only one. */
function linkedEvent(room: RoomProjection, eventId: EventId | null): RoomEvent | undefined {
  return room.linkedEvents.find((e) => e.eventId === eventId) ?? (room.linkedEvents.length === 1 ? room.linkedEvents[0] : undefined);
}

/**
 * The author's side. Lines carry no side (wiring map §3.2): the reader's own company is the linked incident's
 * `mySide`, and with two companies in the room the other company is the other side. With more, the room cannot tell.
 */
export function authorSide(m: RoomMessage, room: RoomProjection | undefined, eventId: EventId | null): Side | null {
  if (!room || m.author.kind === "system" || !m.author.companyId) return null;
  const mySide = linkedEvent(room, m.eventId ?? eventId)?.mySide;
  if (!mySide) return null;
  if (m.author.companyId === room.myCompanyId) return mySide;
  return room.companies.length === 2 ? (mySide === "A" ? "B" : "A") : null;
}

export function companyName(room: RoomProjection | undefined, companyId: string): string | null {
  return room?.companies.find((c) => c.companyId === companyId)?.name ?? null;
}

export type ComposerGate = { kind: "open" } | { kind: "locked" | "read_only"; why: string };

/**
 * Who may write now (wiring map §3.2, messages.send). Heads of ops read; a closed room is read only. While a decision
 * is open only the side in turn writes: a line about one incident needs its turn, a room-wide line every open one's.
 */
export function composerGate(room: RoomProjection | undefined, eventId: EventId | null, role: Role | undefined): ComposerGate {
  if (role && role !== "operator") return { kind: "read_only", why: "Read only · dispatchers write in the room" };
  if (room?.state === "closed") return { kind: "read_only", why: "This room is closed · the record stays readable" };
  const waiting = room?.linkedEvents.find((e) => e.deciding && !e.myTurn && (eventId === null || e.eventId === eventId));
  if (waiting) return { kind: "locked", why: waiting.turn ? `Side ${waiting.turn} is deciding` : "The other side is deciding" };
  return { kind: "open" };
}

/** "03:12" in UTC. */
export function hhmm(ms: number): string {
  const t = new Date(ms);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}
