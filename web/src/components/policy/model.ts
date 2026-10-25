import type { FleetSatellite, Lang } from "@/components/auth/session";
import type { PolicySatellite } from "@/lib/backend/types";
import { DEMO_POLICY, DEMO_SETTINGS, utcSlot } from "./demoDefaults";

// Company policy as the operator edits it. Numbers stay strings until save so an empty field is
// empty, not a zero we invented. The wire shape matches policies.update (convex/lib/policyValidators.ts).

export type Priority = "low" | "normal" | "high";

export interface WindowDraft {
  key: string;
  startUtc: string;
  endUtc: string;
  reason: string;
}

export interface SatelliteDraft {
  objectId: string;
  name: string;
  norad: number | null;
  orbit: string | null;
  minFuelReserveKg: string;
  currentFuelKg: string;
  dryMassKg: string;
  ispS: string;
  acceptablePc: string;
  missionPriority: Priority;
  protectedWindows: WindowDraft[];
  preferredWindows: WindowDraft[];
}

export interface PolicyDraft {
  language: Lang | null;
  contact: string;
  satellites: SatelliteDraft[];
}

export interface PolicyIssue {
  objectId: string;
  field: string;
  message: string;
}

/** Catalog NORAD id or a SIM- id. Demo fleet ids such as ASD-1 are not this, and the backend rejects them. */
export const POLICY_OBJECT = /^(?:\d{1,9}|SIM-\d+)$/;

const STORAGE = "orbitcall.policy.v1.";
const MAX_CONTACT = 200;

export function blankSatellite(objectId: string, name = objectId, norad: number | null = null, orbit: string | null = null): SatelliteDraft {
  return {
    objectId,
    name,
    norad,
    orbit,
    minFuelReserveKg: "",
    currentFuelKg: "",
    dryMassKg: "",
    ispS: "",
    acceptablePc: "",
    missionPriority: "normal",
    protectedWindows: [],
    preferredWindows: [],
  };
}

export function newWindow(): WindowDraft {
  return { key: crypto.randomUUID(), startUtc: "", endUtc: "", reason: "" };
}

interface StoredSatellite {
  objectId: string;
  minFuelReserveKg: string;
  currentFuelKg: string;
  dryMassKg: string;
  ispS: string;
  acceptablePc: string;
  missionPriority: Priority;
  protectedWindows: { startUtc: string; endUtc: string; reason: string }[];
  preferredWindows: { startUtc: string; endUtc: string; reason: string }[];
}

interface StoredPolicy {
  language: Lang | null;
  contact: string;
  satellites: StoredSatellite[];
  savedAt: string | null;
}

function isPriority(v: unknown): v is Priority {
  return v === "low" || v === "normal" || v === "high";
}

function isLang(v: unknown): v is Lang {
  return v === "en" || v === "ru" || v === "zh";
}

function readWindows(value: unknown): { startUtc: string; endUtc: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const w = row as Record<string, unknown>;
    if (typeof w.startUtc !== "string" || typeof w.endUtc !== "string" || typeof w.reason !== "string") return [];
    return [{ startUtc: w.startUtc, endUtc: w.endUtc, reason: w.reason }];
  });
}

export function loadPolicy(companyId: string): { draft: StoredPolicy } | null {
  try {
    const raw = localStorage.getItem(STORAGE + companyId);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<StoredPolicy>;
    if (!Array.isArray(data.satellites)) return null;
    const satellites = data.satellites.flatMap((row) => {
      if (!row || typeof row !== "object" || typeof row.objectId !== "string") return [];
      return [{
        objectId: row.objectId,
        minFuelReserveKg: typeof row.minFuelReserveKg === "string" ? row.minFuelReserveKg : "",
        currentFuelKg: typeof row.currentFuelKg === "string" ? row.currentFuelKg : "",
        dryMassKg: typeof row.dryMassKg === "string" ? row.dryMassKg : "",
        ispS: typeof row.ispS === "string" ? row.ispS : "",
        acceptablePc: typeof row.acceptablePc === "string" ? row.acceptablePc : "",
        missionPriority: isPriority(row.missionPriority) ? row.missionPriority : "normal",
        protectedWindows: readWindows(row.protectedWindows),
        preferredWindows: readWindows(row.preferredWindows),
      }];
    });
    return {
      draft: {
        language: isLang(data.language) ? data.language : null,
        contact: typeof data.contact === "string" ? data.contact : "",
        satellites,
        savedAt: typeof data.savedAt === "string" ? data.savedAt : null,
      },
    };
  } catch {
    return null;
  }
}

export function savePolicy(companyId: string, draft: PolicyDraft) {
  const stored: StoredPolicy = {
    language: draft.language,
    contact: draft.contact,
    satellites: draft.satellites.map(strip),
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE + companyId, JSON.stringify(stored));
  return stored.savedAt ?? new Date().toISOString();
}

function strip(s: SatelliteDraft): StoredSatellite {
  return {
    objectId: s.objectId,
    minFuelReserveKg: s.minFuelReserveKg,
    currentFuelKg: s.currentFuelKg,
    dryMassKg: s.dryMassKg,
    ispS: s.ispS,
    acceptablePc: s.acceptablePc,
    missionPriority: s.missionPriority,
    protectedWindows: s.protectedWindows.map(({ startUtc, endUtc, reason }) => ({ startUtc, endUtc, reason })),
    preferredWindows: s.preferredWindows.map(({ startUtc, endUtc, reason }) => ({ startUtc, endUtc, reason })),
  };
}

/** Fleet rows the operator can see, plus any saved satellite that is no longer on the fleet list. */
/** A demo satellite's starting policy as form text, when this browser has no saved copy of it. */
function demoSatellite(f: FleetSatellite): SatelliteDraft | null {
  const d = DEMO_POLICY[f.object.objectId];
  if (!d) return null;
  const win = (kind: string) => (w: { day: number; from: string; to: string; reason: string }, i: number) => ({
    key: `${f.object.objectId}:${kind}:${i}`,
    startUtc: utcSlot(w.day, w.from),
    endUtc: utcSlot(w.day, w.to),
    reason: w.reason,
  });
  return {
    ...blankSatellite(f.object.objectId, f.object.name, f.object.norad, f.object.orbit),
    minFuelReserveKg: String(d.minFuelReserveKg),
    currentFuelKg: String(d.currentFuelKg),
    dryMassKg: String(d.dryMassKg),
    ispS: String(d.ispS),
    acceptablePc: String(d.acceptablePc),
    missionPriority: d.missionPriority,
    protectedWindows: d.protected.map(win("protected")),
    preferredWindows: d.preferred.map(win("preferred")),
  };
}

export function hydrate(stored: StoredPolicy | null, fleet: FleetSatellite[], companyId?: string): PolicyDraft {
  // nothing saved in this browser yet: start the demo companies from realistic values instead of empty fields
  if (!stored && companyId && DEMO_SETTINGS[companyId]) {
    const settings = DEMO_SETTINGS[companyId];
    return {
      language: settings.language,
      contact: settings.contact,
      satellites: fleet.map((f) => demoSatellite(f) ?? blankSatellite(f.object.objectId, f.object.name, f.object.norad, f.object.orbit)),
    };
  }
  const byId = new Map((stored?.satellites ?? []).map((s) => [s.objectId, s]));
  const seen = new Set<string>();
  const satellites: SatelliteDraft[] = [];
  for (const f of fleet) {
    seen.add(f.object.objectId);
    const saved = byId.get(f.object.objectId);
    satellites.push(saved ? attach(saved, f.object.name, f.object.norad, f.object.orbit) : blankSatellite(f.object.objectId, f.object.name, f.object.norad, f.object.orbit));
  }
  for (const saved of stored?.satellites ?? []) {
    if (seen.has(saved.objectId)) continue;
    satellites.push(attach(saved, saved.objectId, null, null));
  }
  return { language: stored?.language ?? null, contact: stored?.contact ?? "", satellites };
}

function attach(saved: StoredSatellite, name: string, norad: number | null, orbit: string | null): SatelliteDraft {
  return {
    ...saved,
    name,
    norad,
    orbit,
    protectedWindows: saved.protectedWindows.map((w, i) => ({ ...w, key: `${saved.objectId}:protected:${i}` })),
    preferredWindows: saved.preferredWindows.map((w, i) => ({ ...w, key: `${saved.objectId}:preferred:${i}` })),
  };
}

export function fingerprint(draft: PolicyDraft) {
  return JSON.stringify({
    language: draft.language,
    contact: draft.contact.trim(),
    satellites: draft.satellites.map((s) => ({
      ...strip(s),
      missionPriority: s.missionPriority,
    })),
  });
}

function touched(s: SatelliteDraft) {
  return (
    [s.minFuelReserveKg, s.currentFuelKg, s.dryMassKg, s.ispS, s.acceptablePc].some((v) => v.trim() !== "") ||
    s.protectedWindows.length > 0 ||
    s.preferredWindows.length > 0 ||
    s.missionPriority !== "normal"
  );
}

/** Accepts a UTC instant with or without seconds, and returns the form the backend checks. */
export function toUtc(raw: string): string | null {
  const t = raw.trim();
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00Z` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t) ? `${t}Z` : t;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(withSeconds)) return null;
  const parsed = Date.parse(withSeconds);
  if (!Number.isFinite(parsed)) return null;
  if (new Date(parsed).toISOString().slice(0, 19) !== withSeconds.slice(0, 19)) return null;
  return withSeconds.replace(/\.\d+Z$/, "Z");
}

function numberOf(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cards the operator has not started are omitted. A started card must be complete.
 * Live saves also require a catalog or SIM object id, because that is what policies.update accepts.
 */
export function checkPolicy(draft: PolicyDraft, mode: "local" | "live"): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (draft.contact.trim().length > MAX_CONTACT) {
    issues.push({ objectId: "", field: "contact", message: `Contact must be at most ${MAX_CONTACT} characters.` });
  }
  const started = draft.satellites.filter(touched);
  if (started.length > 100) issues.push({ objectId: "", field: "form", message: "A company policy covers at most 100 satellites." });
  const ids = started.map((s) => s.objectId);
  if (new Set(ids).size !== ids.length) issues.push({ objectId: "", field: "form", message: "Each satellite can appear once." });
  for (const sat of started) {
    if (mode === "live" && !POLICY_OBJECT.test(sat.objectId)) {
      issues.push({ objectId: sat.objectId, field: "objectId", message: "The backend accepts a NORAD id or a SIM- id for this satellite." });
    }
    const nums: [keyof SatelliteDraft, string, (n: number) => boolean][] = [
      ["minFuelReserveKg", "Minimum fuel reserve", (n) => n >= 0],
      ["currentFuelKg", "Current fuel", (n) => n >= 0],
      ["dryMassKg", "Dry mass", (n) => n > 0],
      ["ispS", "Specific impulse", (n) => n > 0],
      ["acceptablePc", "Acceptable probability", (n) => n >= 0 && n <= 1],
    ];
    for (const [field, label, ok] of nums) {
      const n = numberOf(String(sat[field]));
      if (n === null || !ok(n)) issues.push({ objectId: sat.objectId, field, message: `${label} needs a valid number.` });
    }
    for (const [field, rows, label] of [
      ["protectedWindows", sat.protectedWindows, "Protected window"],
      ["preferredWindows", sat.preferredWindows, "Preferred window"],
    ] as const) {
      if (rows.length > 100) issues.push({ objectId: sat.objectId, field, message: "Too many mission windows." });
      rows.forEach((row, i) => {
        const start = toUtc(row.startUtc);
        const end = toUtc(row.endUtc);
        if (!start) issues.push({ objectId: sat.objectId, field: `${field}.${i}.startUtc`, message: `${label} needs a UTC start.` });
        if (!end) issues.push({ objectId: sat.objectId, field: `${field}.${i}.endUtc`, message: `${label} needs a UTC end.` });
        if (start && end && Date.parse(start) >= Date.parse(end)) issues.push({ objectId: sat.objectId, field: `${field}.${i}.endUtc`, message: "The window must end after it starts." });
        if (!row.reason.trim() || row.reason.trim().length > 500) issues.push({ objectId: sat.objectId, field: `${field}.${i}.reason`, message: "Add a short reason for this window." });
      });
    }
  }
  return issues;
}

export function issueAt(issues: PolicyIssue[], objectId: string, field: string) {
  return issues.find((i) => i.objectId === objectId && i.field === field)?.message;
}

/** Satellites the operator actually filled in, in the order policies.update stores them. */
export function policyPayload(draft: PolicyDraft): PolicySatellite[] {
  return draft.satellites.filter(touched).map((s) => ({
    objectId: s.objectId,
    minFuelReserveKg: numberOf(s.minFuelReserveKg) ?? 0,
    currentFuelKg: numberOf(s.currentFuelKg) ?? 0,
    dryMassKg: numberOf(s.dryMassKg) ?? 0,
    ispS: numberOf(s.ispS) ?? 0,
    acceptablePc: numberOf(s.acceptablePc) ?? 0,
    missionPriority: s.missionPriority,
    protectedWindows: s.protectedWindows.map((w) => ({ startUtc: toUtc(w.startUtc) ?? w.startUtc, endUtc: toUtc(w.endUtc) ?? w.endUtc, reason: w.reason.trim() })),
    preferredWindows: s.preferredWindows.map((w) => ({ startUtc: toUtc(w.startUtc) ?? w.startUtc, endUtc: toUtc(w.endUtc) ?? w.endUtc, reason: w.reason.trim() })),
  })).sort((a, b) => a.objectId.localeCompare(b.objectId));
}

export function convexMessage(e: unknown): string {
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  if (e instanceof Error) {
    const line = e.message.split("\n").find((l) => l.trim()) ?? e.message;
    return line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 180);
  }
  return "Could not save the policy.";
}

export function serverToDraft(
  satellites: PolicySatellite[],
  settings: { language: Lang | null; contact: string | null },
  fleet: FleetSatellite[],
): PolicyDraft {
  const stored: StoredPolicy = {
    language: settings.language,
    contact: settings.contact ?? "",
    savedAt: null,
    satellites: satellites.map((s) => ({
      objectId: s.objectId,
      minFuelReserveKg: String(s.minFuelReserveKg),
      currentFuelKg: String(s.currentFuelKg),
      dryMassKg: String(s.dryMassKg),
      ispS: String(s.ispS),
      acceptablePc: String(s.acceptablePc),
      missionPriority: s.missionPriority,
      protectedWindows: s.protectedWindows,
      preferredWindows: s.preferredWindows,
    })),
  };
  return hydrate(stored, fleet);
}
