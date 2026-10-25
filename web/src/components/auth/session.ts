"use client";

import { create } from "zustand";

// Who is at this screen, in the shapes of `users.me` and `fleet.listMine` (spec §3.1, §3.2). When Convex has a
// signed-in identity, BackendSession reads `session.me` and that account wins. Otherwise a server-checked demo
// login (/api/session) maps to one of the fixture accounts below; they hold profile data only, no credentials.
// `fleet.listMine` has not landed, so a server account's fleet lists its assigned IDs with the details it does not
// have left null.
//
// Access is the gate on everything that spends model or screening credits (Run scan, cases). Anyone may sign
// up, but only accounts the team provisioned have access; the server enforces it (users table plus fleet
// assignments, see convex/operators.ts), and the UI only mirrors that answer.

export type Access = "granted" | "none";

export type Lang = "en" | "ru" | "zh";
export type Role = "operator" | "head_of_ops" | "demo_observer";

export interface Me {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
  language: Lang | null;
  dispatcherCountry: string | null;
  company: { companyId: string; name: string; country: string | null; simulated: boolean } | null;
  assignedObjectIds: string[];
  assignmentVersion: number | null;
  access: Access;
}

/** What a spacecraft does, for its drawing in the fleet list. */
export type SatKind = "imaging" | "rf" | "weather" | "cubesat";

export interface FleetSatellite {
  object: { objectId: string; name: string; norad: number | null; orbit: string | null; kind?: SatKind };
  assignedAt: string | null;
  freshness: "current" | "stale" | "unknown";
  unresolvedIncidentCount: number | null;
  scanCoverage: "not_scanned" | "complete" | "partial" | "failed" | "unknown";
}

/** `session.me` as the server returns it (convex/session.ts). */
export interface ServerMe {
  userId: string;
  name: string | null;
  role: Role;
  language: Lang | null;
  dispatcherCountry: string | null;
  company: { companyId: string; name: string; country: string | null; simulated: boolean };
  assignedObjectIds: string[];
  assignmentVersion: number | null;
}

/** The server's answer for the signed-in identity: an account, not provisioned, or not readable right now. */
export type BackendAccount = { status: "ok"; me: ServerMe } | { status: "forbidden" } | { status: "error" };

// Real catalog objects (NORAD IDs, orbits from the gp-20261024T2134Z snapshot) assigned to fictional demo
// companies, so "My fleet" finds their real conjunctions in the queue. Open cases are counted live from the queue.
const sat = (norad: number, name: string, orbit: string, kind: SatKind): FleetSatellite => ({
  object: { objectId: String(norad), name, norad, orbit, kind },
  assignedAt: "2026-10-24T08:00:00Z",
  freshness: "current",
  unresolvedIncidentCount: null,
  scanCoverage: "not_scanned",
});

/** Demo accounts: three dispatchers with four simulated spacecraft each, and a sign-up without access. Logins for them are server-side. */
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
      assignedObjectIds: ["56191", "56193", "56200", "62382"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [
      sat(56191, "HAWK-7A", "SSO · 479 × 481 km", "rf"),
      sat(56193, "HAWK-7B", "SSO · 479 × 481 km", "rf"),
      sat(56200, "HAWK-7C", "SSO · 479 × 481 km", "rf"),
      sat(62382, "HAWK-11A", "LEO 45° · 468 × 473 km", "rf"),
    ],
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
      assignedObjectIds: ["64880", "64890", "57182", "57178"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [
      sat(64880, "GEOSCAN 1", "SSO · 460 × 473 km", "cubesat"),
      sat(64890, "GEOSCAN 2", "SSO · 459 × 471 km", "cubesat"),
      sat(57182, "MONITOR-4", "SSO · 468 × 483 km", "imaging"),
      sat(57178, "CUBESX-HSE 3", "SSO · 457 × 470 km", "cubesat"),
    ],
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
      assignedObjectIds: ["43023", "58646", "58647", "54686"],
      assignmentVersion: 1,
      access: "granted",
    },
    fleet: [
      sat(43023, "JILIN-1 05", "SSO · 455 × 463 km", "imaging"),
      sat(58646, "TIANMU-1 12", "SSO · 479 × 486 km", "weather"),
      sat(58647, "TIANMU-1 13", "SSO · 479 × 486 km", "weather"),
      sat(54686, "DONGPO 08", "SSO · 452 × 464 km", "imaging"),
    ],
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

interface Session {
  /** null while signed out; undefined until the server has answered. */
  userId: string | null | undefined;
  /** Set only while Convex has a signed-in identity; it replaces the demo account. */
  backend: BackendAccount | null;
  profileOpen: boolean;
  signIn: (username: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  setProfileOpen: (v: boolean) => void;
  setBackend: (v: BackendAccount | null) => void;
  /** The Auth0 login, mirrored here by Auth0Bridge while the tenant is configured. */
  auth0: { email: string | null; name: string | null; logout: () => void } | null;
}

// Who is signed in comes from the server (/api/session reads a signed httpOnly cookie); the browser never
// holds a password or decides on its own that someone is signed in.
export const useSession = create<Session>((set) => ({
  userId: undefined,
  backend: null,
  auth0: null,
  profileOpen: false,
  signIn: async (username, password) => {
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { accountId?: string; error?: string } | null;
    if (!res?.ok || !data?.accountId) return data?.error ?? "Could not reach the server. Try again.";
    set({ userId: data.accountId, profileOpen: false });
    return null;
  },
  signOut: async () => {
    await fetch("/api/session", { method: "DELETE" }).catch(() => null);
    set({ userId: null, profileOpen: false });
    // an Auth0 login ends at Auth0 too, which redirects back here
    useSession.getState().auth0?.logout();
  },
  setProfileOpen: (profileOpen) => set({ profileOpen }),
  setBackend: (backend) => set({ backend }),
}));

/** Ask the server who is signed in (once per page load). */
export async function restoreSession() {
  const res = await fetch("/api/session").catch(() => null);
  const data = (await res?.json().catch(() => null)) as { accountId?: string | null } | null;
  const id = data?.accountId ?? null;
  useSession.setState({ userId: DEMO_ACCOUNTS.some((a) => a.me.userId === id) ? id : null });
}

function serverAccount(b: BackendAccount): Me {
  if (b.status !== "ok") {
    return { userId: "server", name: null, email: null, role: "operator", language: null, dispatcherCountry: null,
      company: null, assignedObjectIds: [], assignmentVersion: null, access: "none" };
  }
  const { me } = b;
  // The server returns an account only for a provisioned user with a company; responsibility is the assignment list.
  return { ...me, email: null, access: me.assignedObjectIds.length ? "granted" : "none" };
}

export function useMe(): Me | null {
  const id = useSession((s) => s.userId);
  const backend = useSession((s) => s.backend);
  const auth0 = useSession((s) => s.auth0);
  if (backend) {
    const me = serverAccount(backend);
    // session.me has no email or (yet) a name for unprovisioned logins; Auth0 knows both
    return { ...me, email: me.email ?? auth0?.email ?? null, name: me.name ?? auth0?.name ?? null };
  }
  return DEMO_ACCOUNTS.find((a) => a.me.userId === id)?.me ?? null;
}

export function useFleet(): FleetSatellite[] {
  const id = useSession((s) => s.userId);
  const backend = useSession((s) => s.backend);
  if (backend) {
    if (backend.status !== "ok") return [];
    return backend.me.assignedObjectIds.map((objectId) => ({
      object: { objectId, name: objectId, norad: /^\d+$/.test(objectId) ? Number(objectId) : null, orbit: null },
      assignedAt: null,
      freshness: "unknown",
      unresolvedIncidentCount: null,
      scanCoverage: "unknown",
    }));
  }
  return DEMO_ACCOUNTS.find((a) => a.me.userId === id)?.fleet ?? [];
}

/** Whether the person at this screen may start work that spends credits. */
export function useCanScan() {
  return useMe()?.access === "granted";
}
