"use client";

import { create } from "zustand";
import type { Catalog } from "@/lib/catalog/client";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, EventStatus as OpsStatus, Party, SpaceObjectRef } from "@/lib/ops/types";
import { OWNER_FLAGS } from "@/lib/owners";
import type {
  AgentSummary,
  ApprovalStatus,
  Color,
  EventRow,
  EventStatus,
  InboxEntry,
  Lang,
  Pc,
  RoomProjection,
  Side,
  SpaceObject,
  Workflow,
} from "./types";

// Real mode: the open case as the simulator's ConjunctionEvent, so the existing shell (header, parties bar, stepper,
// collapsed bar, globe markers) renders it. Only what the backend sends carries a value; toEvent lists the rest.

export interface CaseSide {
  side: Side;
  object: SpaceObject;
  /** The company that owns the object; null for debris, an unregistered owner, or a queue row. */
  owner: { companyId: string; name: string; country: string | null; language: Lang | null } | null;
}

/** The open case's row: inbox.get, or the queue row when the inbox cannot be read. */
export interface CaseRow {
  eventId: string;
  color: Color;
  status: EventStatus;
  tcaUtc: string;
  missKm: number;
  relSpeedKmS: number;
  pc: Pc;
  mySide: Side | null;
  workflow: Workflow | null;
  sides: CaseSide[];
  /** Queue rows carry the run flags, inbox rows do not; agentSummaries.get has them either way. */
  agentsWorking: boolean | null;
}

export function rowFromInbox(e: InboxEntry): CaseRow {
  return {
    eventId: e.eventId,
    color: e.color,
    status: e.status,
    tcaUtc: e.tcaUtc,
    missKm: e.missKm,
    relSpeedKmS: e.relSpeedKmS,
    pc: e.pc,
    mySide: e.mySide,
    workflow: e.workflow,
    sides: e.sides.map((s) => ({ side: s.side, object: s.object, owner: s.owner })),
    agentsWorking: null,
  };
}

/** A myQueue or catalogPairs row. The backend never fills owners on these (`ownerCompanyId` is always null). */
export function rowFromQueue(r: EventRow & { workflow?: Workflow }): CaseRow {
  return {
    eventId: r.eventId,
    color: r.color,
    status: r.status,
    tcaUtc: r.tcaUtc,
    missKm: r.missKm,
    relSpeedKmS: r.relSpeedKmS,
    pc: r.pc,
    mySide: r.mySide,
    workflow: r.workflow ?? null,
    sides: [
      { side: "A", object: r.objectA, owner: null },
      { side: "B", object: r.objectB, owner: null },
    ],
    agentsWorking: r.agentsWorking,
  };
}

const STATUS: Record<EventStatus, OpsStatus> = {
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

const LANGUAGE: Record<Lang, string> = { en: "English", ru: "Russian", zh: "Chinese" };
const FLAGS = new Set(Object.values(OWNER_FLAGS).flat());

/** A flag that exists in public/flags: the company's country (a SATCAT code or ISO alpha-2), else the object's owner code. */
function flagOf(...codes: (string | null)[]): string | null {
  for (const code of codes) {
    if (!code) continue;
    const flag = OWNER_FLAGS[code]?.[0] ?? (FLAGS.has(code.toLowerCase()) ? code.toLowerCase() : null);
    if (flag) return flag;
  }
  return null;
}

/** The side without an operator in a debris workflow: the one approvals does not require, else the one without an owner. */
function debrisSide(sides: CaseSide[], workflow: Workflow | null, required: Side[] | undefined): Side | null {
  if (workflow !== "unilateral_debris") return null;
  if (required?.length === 1) return required[0] === "A" ? "B" : "A";
  const bare = sides.filter((s) => !s.owner);
  return bare.length === 1 ? bare[0].side : null;
}

function objectRef(s: CaseSide, debris: boolean, catalog: Catalog | null): SpaceObjectRef {
  const id = s.object.objectId;
  const catalogNo = /^\d+$/.test(id) ? Number(id) : null;
  return {
    // A simulated object ("SIM-0001") has no catalog number; 0 only reaches the object chip's tooltip.
    norad: catalogNo ?? 0,
    name: s.object.name,
    owner: s.object.country ?? "",
    operator: s.owner?.name ?? s.object.ownerName ?? (debris ? "No operator" : "Operator unknown"),
    kind: debris ? "debris" : "payload",
    catalogIndex: catalogNo === null ? null : (catalog?.objects.find((o) => o.norad === catalogNo)?.index ?? null),
    synthetic: s.object.simulated,
  };
}

function partyOf(s: CaseSide): Party[] {
  if (!s.owner) return [];
  return [
    {
      id: s.side === "A" ? "humanA" : "humanB",
      role: s.side === "A" ? "a" : "b",
      operator: s.owner.name,
      owner: s.object.country ?? "",
      country: flagOf(s.owner.country, s.object.country),
      language: s.owner.language ? LANGUAGE[s.owner.language] : null,
    },
  ];
}

export interface CaseLive {
  room: RoomProjection | undefined;
  approvals: ApprovalStatus | undefined;
  summary: AgentSummary | undefined;
}

/**
 * The case as a ConjunctionEvent. The status comes from the room's linked event when the room is known (it stays
 * readable after the room closes), else from the row; approvals and the workflow from approvals.status.
 *
 * The backend sends no uncertainty, radial distance, trend, Pc history, encounter position, creation time, plan or
 * simulator summary for a case. Those fields hold neutral values the shell tolerates (0, "flat", [], null) and the
 * real-mode panels do not show them: IncidentView reads the row's Pc and the analyst's summary from useLive instead.
 * `pcSource` has no "Simulated": it follows the metric (SOCRATES gives a maximum probability), and no real-mode panel
 * prints it.
 */
export function toEvent(row: CaseRow, live: CaseLive, catalog: Catalog | null): ConjunctionEvent | null {
  const a = row.sides.find((s) => s.side === "A");
  const b = row.sides.find((s) => s.side === "B");
  if (!a || !b) return null;
  const linked = live.room?.linkedEvents.find((x) => x.eventId === row.eventId);
  const status = live.approvals?.eventId === row.eventId ? live.approvals : undefined;
  const debris = debrisSide(row.sides, status?.workflow ?? linked?.workflow ?? row.workflow, status?.requiredApprovalSides ?? linked?.requiredApprovalSides);
  const approval = (side: Side) => status?.approvals[side]?.status ?? "pending";
  return {
    id: row.eventId,
    a: objectRef(a, debris === "A", catalog),
    b: objectRef(b, debris === "B", catalog),
    tca: Date.parse(row.tcaUtc),
    missM: row.missKm * 1000,
    relVelKms: row.relSpeedKmS,
    pc: row.pc.value ?? 0,
    pcSource: row.pc.metric === "max_prob" ? "SOCRATES" : "CDM",
    risk: row.color === "red" ? "red" : "yellow",
    status: STATUS[linked?.status ?? row.status],
    agentsWorking: live.summary?.agentsWorking ?? row.agentsWorking ?? false,
    approvals: { a: approval("A"), b: approval("B") },
    parties: row.sides.flatMap(partyOf),
    uncertaintyM: 0,
    radialM: 0,
    trend: "flat",
    pcHistory: [],
    where: { lat: 0, lon: 0, altKm: 0 },
    proposal: null,
    summary: null,
    createdAt: 0,
  };
}

/* ---------------------------------------------------------------- the open case in the stores */

/** The open case's row as CaseSync last read it. Kept here until useLive has a field for it. */
export const useCaseRow = create<{ row: CaseRow | null }>(() => ({ row: null }));

const adapted = new Set<string>();

/** Put the open case's event into useOps.events, replacing an older copy; nothing happens when it did not change. */
export function upsertCaseEvent(e: ConjunctionEvent) {
  const ops = useOps.getState();
  if (ops.dev || ops.incident !== e.id) return;
  const old = ops.events.find((x) => x.id === e.id);
  if (old && JSON.stringify(old) === JSON.stringify(e)) return;
  adapted.add(e.id);
  useOps.setState({ events: old ? ops.events.map((x) => (x.id === e.id ? e : x)) : [e, ...ops.events] });
}

function dropCaseEvents(ids: string[]) {
  const gone = ids.filter((id) => adapted.has(id));
  if (!gone.length) return;
  for (const id of gone) adapted.delete(id);
  useOps.setState((s) => ({ events: s.events.filter((x) => !gone.includes(x.id)) }));
}

// The adapted event leaves with its case (another case or none) and with real mode (dev on). This runs on the store
// change itself, before OpsSync, which subscribes after this module loads, boots the simulator on an empty board.
useOps.subscribe((s, p) => {
  const devOn = s.dev && !p.dev;
  if (devOn) dropCaseEvents([...adapted]);
  else if (s.incident !== p.incident && p.incident) dropCaseEvents([p.incident]);
  if (devOn || s.incident !== p.incident) useCaseRow.setState({ row: null });
});
