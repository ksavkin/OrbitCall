"use client";

import { DEMO_ACCOUNTS } from "@/components/auth/session";
import { useOps } from "./store";
import type { ConjunctionEvent, Party } from "./types";

/** Shared LiveKit / sim room name for the rehearsed three-operator smoke case. */
export const SMOKE_ROOM = "smoke-trilateral";
export const SMOKE_CHANNEL = "orbitcall.smoke";
export const SMOKE_STORAGE = "orbitcall.smoke.v1";

/** First red case after Run scan in smoke mode (US × CN, RU invited). */
export const SMOKE_VARIANT = "trilateral";

type SmokeInvite = {
  eventId: string;
  pair: string;
  openedAt: number;
  hostUserId: string;
  /** Snapshot the guests hydrate so every laptop sees the same cards without Convex. */
  event: ConjunctionEvent;
};

type SmokeMsg =
  | { type: "invite"; invite: SmokeInvite }
  | { type: "state"; invite: SmokeInvite; actAs?: "a" | "b" | null }
  | { type: "accepted"; userId: string; eventId: string };

function envSmoke() {
  return process.env.NEXT_PUBLIC_SMOKE_DEMO === "1" || process.env.NEXT_PUBLIC_SMOKE_DEMO === "true";
}

/** Smoke demo: Dev simulator on Vercel (and localhost) for the Cal Hacks recording. */
export function isSmokeDemo() {
  if (typeof window === "undefined") return envSmoke();
  if (envSmoke()) return true;
  try {
    if (new URLSearchParams(window.location.search).get("smoke") === "1") return true;
  } catch {}
  return false;
}

/** Which decision side this demo account plays in the smoke case. */
export function smokeSideFor(userId: string | null | undefined): "a" | "b" | "affected" | null {
  if (userId === "demo-us") return "a";
  if (userId === "demo-cn") return "b";
  if (userId === "demo-ru") return "affected";
  return null;
}

export function smokeCompanyFor(userId: string | null | undefined) {
  return DEMO_ACCOUNTS.find((a) => a.me.userId === userId)?.me.company ?? null;
}

function channel() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(SMOKE_CHANNEL);
  } catch {
    return null;
  }
}

function readStored(): SmokeInvite | null {
  try {
    const raw = localStorage.getItem(SMOKE_STORAGE);
    if (!raw) return null;
    return JSON.parse(raw) as SmokeInvite;
  } catch {
    return null;
  }
}

function writeStored(invite: SmokeInvite | null) {
  try {
    if (!invite) localStorage.removeItem(SMOKE_STORAGE);
    else localStorage.setItem(SMOKE_STORAGE, JSON.stringify(invite));
  } catch {}
}

/** Host (US) publishes the open room so CN/RU tabs and same-origin windows see Accept. */
export function publishSmokeInvite(event: ConjunctionEvent, hostUserId: string) {
  const invite: SmokeInvite = {
    eventId: event.id,
    pair: `${event.a.name} × ${event.b.name}`,
    openedAt: Date.now(),
    hostUserId,
    event: JSON.parse(JSON.stringify(event)) as ConjunctionEvent,
  };
  writeStored(invite);
  const ch = channel();
  ch?.postMessage({ type: "invite", invite } satisfies SmokeMsg);
  ch?.close();
  return invite;
}

export function readSmokeInvite(): SmokeInvite | null {
  return readStored();
}

/** Frozen guest case when the host invite has not reached this browser (other laptop). Cards match the smoke story. */
function guestTemplate(): ConjunctionEvent {
  const tca = Date.now() + 19 * 3600_000;
  const burnAt = tca - 6 * 3600_000;
  const parties: Party[] = [
    { id: "humanA", role: "a", operator: "American Satellite Dynamics (synthetic)", owner: "US", country: "us", language: "English" },
    { id: "humanB", role: "b", operator: "Jade Orbit (synthetic)", owner: "PRC", country: "cn", language: "Chinese" },
    { id: "humanC", role: "affected", operator: "Sever Imaging (synthetic)", owner: "CIS", country: "ru", language: "Russian" },
  ];
  return {
    id: "CE-SMOKE1",
    a: {
      norad: 56191,
      name: "HAWK-7A",
      owner: "US",
      operator: "American Satellite Dynamics (synthetic)",
      kind: "payload",
      catalogIndex: null,
      synthetic: false,
    },
    b: {
      norad: 90861,
      name: "JILIN-1 (SYN)",
      owner: "PRC",
      operator: "Jade Orbit (synthetic)",
      kind: "payload",
      catalogIndex: null,
      synthetic: true,
    },
    tca,
    missM: 165,
    uncertaintyM: 98,
    radialM: 40,
    pc: 7.4e-4,
    pcSource: "SOCRATES + CDM",
    relVelKms: 12.4,
    risk: "red",
    trend: "rising",
    pcHistory: [{ t: Date.now() - 6 * 3600_000, pc: 2e-4 }, { t: Date.now(), pc: 7.4e-4 }],
    status: "communication",
    agentsWorking: false,
    where: { lat: 41.2, lon: 116.4, altKm: 480 },
    proposal: {
      version: 1,
      mover: "a",
      action: "raise",
      burnAt,
      dvMs: 0.07,
      fuelKg: 0.0038,
      missBeforeM: 165,
      missAfterM: 920,
      rationale: "HAWK-7A raises 0.07 m/s at TCA−6 h. Recommended for ASD; Jade keeps imaging; Sever stays clear.",
      label: "P1",
      revision: 1,
      by: "agents",
      publishedAt: Date.now(),
    },
    options: [
      {
        id: "a-raise-v1",
        mover: "a",
        action: "raise",
        dvMs: 0.07,
        burnAt,
        fuelKg: 0.0038,
        missAfterM: 920,
        recommended: true,
        why: "Agents' pick: ASD moves, Jade and Sever keep their windows.",
      },
      {
        id: "b-lower-v1",
        mover: "b",
        action: "lower",
        dvMs: 0.08,
        burnAt: tca - 8 * 3600_000,
        fuelKg: 0.055,
        missAfterM: 880,
        recommended: false,
        why: "Jade would burn; imaging pass conflict.",
      },
      {
        id: "a-wait-v1",
        mover: "none",
        action: "wait",
        dvMs: 0,
        burnAt: null,
        fuelKg: 0,
        missAfterM: 165,
        recommended: false,
        why: "Wait for the next CDM; Pc still above the action line.",
      },
      {
        id: "a-lower-v1",
        mover: "a",
        action: "lower",
        dvMs: 0.07,
        burnAt,
        fuelKg: 0.0038,
        missAfterM: 760,
        recommended: false,
        why: "Lower path; denser debris band.",
      },
    ],
    agentPick: { mover: "a", action: "raise" },
    approvals: { a: "pending", b: "pending" },
    summary: [
      "HAWK-7A × JILIN-1 (SYN), TCA in ~19 h, miss 165 m, Pc 7.4×10⁻⁴.",
      "Both GP and a public CDM list the pair; epochs within 2 minutes.",
      "ASD electric thruster can raise 0.07 m/s inside policy fuel.",
      "Jade imaging window blocks a Jade burn this afternoon.",
      "Sever GEOSCAN is affected visibility only; miss after raise >1 km.",
    ],
    parties,
    createdAt: Date.now(),
    scenario: SMOKE_VARIANT,
    confidence: { level: "high", why: "Matched CDM and SOCRATES; three-operator smoke case" },
    reference: { status: "matched", runAt: Date.now() - 7 * 3600_000, tca: tca - 1000, missM: 170, maxProb: 7.1e-4 },
  };
}

/** Guest Accept: load the shared case, open Decision Center, set actAs for this account. */
export function acceptSmokeInvite(userId: string) {
  const invite = readStored();
  const side = smokeSideFor(userId);
  const actAs = side === "a" || side === "b" ? side : null;
  const event = invite?.event ?? guestTemplate();
  const parties: Party[] = [...(event.parties ?? [])];
  if (!parties.some((p) => p.role === "affected")) {
    parties.push({
      id: "humanC",
      role: "affected",
      operator: "Sever Imaging (synthetic)",
      owner: "CIS",
      country: "ru",
      language: "Russian",
    });
  }
  const next = {
    ...event,
    parties,
    status: event.options?.length ? ("communication" as const) : event.status,
  };
  const prev = useOps.getState().events.filter((e) => e.id !== next.id);
  useOps.setState({
    dev: true,
    events: [next, ...prev],
    incident: next.id,
    focusEvent: next.id,
    tab: "decision",
    incidentView: "expanded",
    actAs,
    autopilot: false,
    alert: null,
  });
  if (!invite) {
    writeStored({
      eventId: next.id,
      pair: `${next.a.name} × ${next.b.name}`,
      openedAt: Date.now(),
      hostUserId: "demo-us",
      event: next,
    });
  }
  const ch = channel();
  ch?.postMessage({ type: "accepted", userId, eventId: next.id } satisfies SmokeMsg);
  ch?.close();
  return next;
}

/** Keep guest tabs in sync when the US host republishes (optional). */
export function subscribeSmokeInvites(onInvite: (invite: SmokeInvite) => void) {
  const ch = channel();
  if (!ch) return () => {};
  const onMsg = (ev: MessageEvent<SmokeMsg>) => {
    const msg = ev.data;
    if (!msg || (msg.type !== "invite" && msg.type !== "state")) return;
    writeStored(msg.invite);
    onInvite(msg.invite);
  };
  ch.addEventListener("message", onMsg);
  // same-tab storage events do not fire; cross-tab localStorage does
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SMOKE_STORAGE || !e.newValue) return;
    try {
      onInvite(JSON.parse(e.newValue) as SmokeInvite);
    } catch {}
  };
  window.addEventListener("storage", onStorage);
  return () => {
    ch.removeEventListener("message", onMsg);
    ch.close();
    window.removeEventListener("storage", onStorage);
  };
}

/** Turn Dev on for the smoke recording (localhost or Vercel with NEXT_PUBLIC_SMOKE_DEMO). */
export function ensureSmokeDev() {
  if (!isSmokeDemo()) return;
  if (!useOps.getState().dev) useOps.getState().set({ dev: true, autopilot: false });
}
