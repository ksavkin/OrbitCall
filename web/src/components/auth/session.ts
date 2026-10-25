"use client";

import { create } from "zustand";

// Who is at this screen, in the shapes of `users.me` and `fleet.listMine` (spec §3.1, §3.2). Until Auth0 and
// those queries are deployed, sign-in picks one of the fixture accounts below; the screens read this store
// either way, so wiring the real queries replaces the source, not the UI.
//
// Access is the gate on everything that spends model or screening credits (Run scan, cases). Anyone may sign
// up, but only accounts the team provisioned have access; the server enforces it (users table plus fleet
// assignments, see convex/operators.ts), and the UI only mirrors that answer.

export type Access = "granted" | "none";

export interface Me {
  userId: string;
  name: string;
  email: string;
  role: "operator" | "head_of_ops" | "demo_observer";
  language: "en" | "ru" | "zh";
  dispatcherCountry: string;
  company: { companyId: string; name: string; country: string; simulated: boolean } | null;
  assignedObjectIds: string[];
  assignmentVersion: number;
  access: Access;
}

export interface FleetSatellite {
  object: { objectId: string; name: string; norad: number; orbit: string };
  assignedAt: string;
  freshness: "current" | "stale" | "unknown";
  unresolvedIncidentCount: number;
  scanCoverage: "not_scanned" | "complete" | "partial" | "failed";
}

const sat = (objectId: string, name: string, norad: number, orbit: string, incidents = 0, freshness: FleetSatellite["freshness"] = "current"): FleetSatellite => ({
  object: { objectId, name, norad, orbit },
  assignedAt: "2026-10-24T08:00:00Z",
  freshness,
  unresolvedIncidentCount: incidents,
  scanCoverage: incidents ? "complete" : "not_scanned",
});

/** Demo accounts: three dispatchers with four simulated spacecraft each, and a new sign-up without access. */
export const DEMO_ACCOUNTS: { me: Me; fleet: FleetSatellite[] }[] = [
  {
    me: {
      userId: "demo-us",
      name: "Alex Carter",
      email: "dispatch@asd.example",
      role: "operator",
      language: "en",
      dispatcherCountry: "us",
      company: { companyId: "asd", name: "American Satellite Dynamics", country: "us", simulated: true },
      assignedObjectIds: ["ASD-1", "ASD-2", "ASD-3", "ASD-4"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [sat("ASD-1", "ASD-1 PATHFINDER", 90001, "LEO 550 km", 1), sat("ASD-2", "ASD-2 RELAY", 90002, "LEO 560 km"), sat("ASD-3", "ASD-3 IMAGER", 90003, "SSO 530 km"), sat("ASD-4", "ASD-4 RELAY", 90004, "LEO 570 km", 0, "stale")],
  },
  {
    me: {
      userId: "demo-ru",
      name: "Irina Volkova",
      email: "dispatch@sever.example",
      role: "operator",
      language: "ru",
      dispatcherCountry: "ru",
      company: { companyId: "sever", name: "Sever Imaging", country: "ru", simulated: true },
      assignedObjectIds: ["SEV-1", "SEV-2", "SEV-3", "SEV-4"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [sat("SEV-1", "SEVER-1", 90101, "SSO 510 km", 1), sat("SEV-2", "SEVER-2", 90102, "SSO 512 km"), sat("SEV-3", "SEVER-3", 90103, "LEO 600 km"), sat("SEV-4", "SEVER-4", 90104, "LEO 605 km")],
  },
  {
    me: {
      userId: "demo-cn",
      name: "Wei Zhang",
      email: "dispatch@jade.example",
      role: "operator",
      language: "zh",
      dispatcherCountry: "cn",
      company: { companyId: "jade", name: "Jade Orbit", country: "cn", simulated: true },
      assignedObjectIds: ["JDE-1", "JDE-2", "JDE-3", "JDE-4"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [sat("JDE-1", "JADE-1", 90201, "LEO 520 km"), sat("JDE-2", "JADE-2", 90202, "LEO 525 km"), sat("JDE-3", "JADE-3", 90203, "SSO 540 km", 1), sat("JDE-4", "JADE-4", 90204, "LEO 700 km")],
  },
  {
    me: {
      userId: "demo-new",
      name: "New user",
      email: "someone@example.com",
      role: "operator",
      language: "en",
      dispatcherCountry: "us",
      company: null,
      assignedObjectIds: [],
      assignmentVersion: 0,
      access: "none",
    },
    fleet: [],
  },
];

export const ACCESS_EMAIL = "bazarkua@oregonstate.edu";

const KEY = "orbitcall.account";

interface Session {
  /** null while signed out. */
  userId: string | null;
  profileOpen: boolean;
  signIn: (userId: string) => void;
  signOut: () => void;
  setProfileOpen: (v: boolean) => void;
}

function saved(): string | null | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? undefined : v === "" ? null : v;
  } catch {
    return undefined;
  }
}

function save(v: string | null) {
  try {
    localStorage.setItem(KEY, v ?? "");
  } catch {
    /* storage blocked: the session lasts for this page only */
  }
}

// The demo starts signed in as the US dispatcher; signing out or switching is remembered in this browser.
export const useSession = create<Session>((set) => ({
  userId: "demo-us",
  profileOpen: false,
  signIn: (userId) => {
    save(userId);
    set({ userId, profileOpen: false });
  },
  signOut: () => {
    save(null);
    set({ userId: null, profileOpen: false });
  },
  setProfileOpen: (profileOpen) => set({ profileOpen }),
}));

/** Read the remembered account once on the client (after hydration, so server and client render the same). */
export function restoreSession() {
  const v = saved();
  if (v !== undefined && DEMO_ACCOUNTS.some((a) => a.me.userId === v || v === null)) useSession.setState({ userId: v });
}

export function useMe(): Me | null {
  const id = useSession((s) => s.userId);
  return DEMO_ACCOUNTS.find((a) => a.me.userId === id)?.me ?? null;
}

export function useFleet(): FleetSatellite[] {
  const id = useSession((s) => s.userId);
  return DEMO_ACCOUNTS.find((a) => a.me.userId === id)?.fleet ?? [];
}

/** Whether the person at this screen may start work that spends credits. */
export function useCanScan() {
  return useMe()?.access === "granted";
}
