"use client";

import { create } from "zustand";
import { useOps } from "@/lib/ops/store";
import { CONVEX_ENABLED } from "./provider";
import type {
  AdvocatesView,
  AgentLog,
  AgentSummary,
  ApprovalStatus,
  CardRationale,
  ConfigFlags,
  EventId,
  FleetMine,
  HistorySeries,
  InboxEntry,
  LogEntry,
  Maneuver,
  MyQueueRow,
  ProposalCard,
  PublicSpan,
  RoomId,
  RoomMessage,
  RoomProjection,
  ScanId,
  ScanRun,
  SummaryState,
  Verification,
} from "./types";

// Real mode (dev off): what the backend says, as the sync components in components/live/sync write it.
// The open case is `useOps.incident` (a backend event id in real mode); the fields below the line belong to it.
// `undefined` means loading or not subscribed. Each sync owns its own fields and its own `errors` key.

export type LiveKey =
  | "flags"
  | "inbox"
  | "queue"
  | "scan"
  | "case"
  | "decision"
  | "advocates"
  | "agents"
  | "summary"
  | "verification"
  | "room"
  | "summaryForm"
  | "fleet";

interface CaseData {
  /** The case's coordination room: from startWorkflow, rooms.forEvent, or remembered for this tab. */
  roomId: RoomId | null;
  proposals: ProposalCard[] | undefined;
  approvals: ApprovalStatus | undefined;
  maneuver: Maneuver | null | undefined;
  rationale: CardRationale[] | undefined;
  /** `log.list({ eventId })`, newest first: schedule_failed and other shared audit rows for the case. */
  log: LogEntry[] | undefined;
  /** FORBIDDEN for a head of ops: stays undefined with `errors.advocates` set. */
  advocates: AdvocatesView | undefined;
  room: RoomProjection | undefined;
  messages: RoomMessage[] | undefined;
  summary: AgentSummary | undefined;
  summaryForm: SummaryState | undefined;
  spans: PublicSpan[] | undefined;
  agentLogs: AgentLog[] | undefined;
  verification: Verification | null | undefined;
  history: HistorySeries | undefined;
}

interface LiveState extends CaseData {
  flags: ConfigFlags | undefined;
  inbox: InboxEntry[] | undefined;
  myQueue: MyQueueRow[] | undefined;
  fleet: FleetMine | undefined;
  /** The scan this screen started; null shows the caller's latest. */
  scanId: ScanId | null;
  scan: ScanRun | null | undefined;
  errors: Partial<Record<LiveKey, string>>;
  /** Bumped by Retry; remounts every sync. */
  epoch: number;
  set: (p: Partial<LiveState>) => void;
}

const EMPTY_CASE: CaseData = {
  roomId: null,
  proposals: undefined,
  approvals: undefined,
  maneuver: undefined,
  rationale: undefined,
  log: undefined,
  advocates: undefined,
  room: undefined,
  messages: undefined,
  summary: undefined,
  summaryForm: undefined,
  spans: undefined,
  agentLogs: undefined,
  verification: undefined,
  history: undefined,
};

const CASE_KEYS: LiveKey[] = ["case", "decision", "advocates", "agents", "summary", "summaryForm", "verification", "room"];

export const useLive = create<LiveState>((set) => ({
  ...EMPTY_CASE,
  flags: undefined,
  inbox: undefined,
  myQueue: undefined,
  fleet: undefined,
  scanId: null,
  scan: undefined,
  errors: {},
  epoch: 0,
  set: (p) => set(p),
}));

/** Record (or clear) one sync's error; a sync clears its key once it has data again. */
export function setLiveError(key: LiveKey, message: string | null) {
  useLive.setState((s) => {
    const errors = { ...s.errors };
    if (message === null) delete errors[key];
    else errors[key] = message;
    return { errors };
  });
}

/** Dev off and a Convex client present: components read `useLive` and call the backend. */
export function useRealMode(): boolean {
  const dev = useOps((s) => s.dev);
  return !dev && CONVEX_ENABLED;
}

/* ---------------------------------------------------------------- the room of a case, kept for this tab */

// After a reload rooms.get is null for a closed room; rooms.forEvent finds it again, and this saves a round trip.
const ROOM_KEY = (eventId: EventId) => `orbitcall.room.${eventId}`;

export function rememberRoom(eventId: EventId, roomId: RoomId) {
  try {
    sessionStorage.setItem(ROOM_KEY(eventId), roomId);
  } catch {}
}

export function rememberedRoom(eventId: EventId): RoomId | null {
  try {
    return sessionStorage.getItem(ROOM_KEY(eventId));
  } catch {
    return null;
  }
}

/** Set the open case's room (from startWorkflow, rooms.get or rooms.forEvent) and keep it for this tab. */
export function setCaseRoom(eventId: EventId, roomId: RoomId) {
  rememberRoom(eventId, roomId);
  if (useOps.getState().incident === eventId && useLive.getState().roomId !== roomId) useLive.setState({ roomId });
}

/** Open a backend case in the Decision Center. */
export function openCase(eventId: EventId, roomId?: RoomId | null) {
  if (roomId) rememberRoom(eventId, roomId);
  useOps.setState({ incident: eventId, focusEvent: eventId, tab: "decision", incidentView: "expanded", resolved: null });
}

// A new open case starts empty. This runs synchronously on the store change, before any sync of the new case writes.
useOps.subscribe((s, prev) => {
  if (s.incident === prev.incident) return;
  const errors = { ...useLive.getState().errors };
  for (const k of CASE_KEYS) delete errors[k];
  useLive.setState({ ...EMPTY_CASE, roomId: s.incident ? rememberedRoom(s.incident) : null, errors });
});
