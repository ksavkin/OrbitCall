import type { Pc, SourceName } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 24 03:12 UTC" from an ISO timestamp; "—" when missing or unparsable. */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** "5 min ago" style age for a past duration in ms. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function pcMetric(pc: Pc): { short: string; long: string } {
  return pc.metric === "max_prob"
    ? { short: "max", long: pc.source === "socrates" ? "SOCRATES maximum probability" : "Maximum probability" }
    : { short: "Pc", long: "Probability of collision" };
}

const PC_SOURCE: Record<Pc["source"], string> = { cdm: "CDM", socrates: "SOCRATES", simulated: "OrbitCall screening" };

export function pcSource(pc: Pc): string {
  return PC_SOURCE[pc.source] ?? pc.source;
}

export const SOURCE_LABEL: Record<SourceName, string> = {
  celestrak_gp: "CelesTrak GP",
  celestrak_supgp: "CelesTrak SupGP",
  socrates: "SOCRATES",
  cdm_public: "Public CDM",
  gp_history: "GP history",
  keeptrack: "KeepTrack",
  simulated: "OrbitCall screening",
  celestrak_satcat: "CelesTrak SATCAT",
};

/** Links come from the backend: only plain web URLs are rendered as links. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

/** Catalog numbers read as "#25544"; reserved operator ids ("SIM-0001") as OrbitCall designators ("OC-0001"). */
export function fmtObjectId(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id.replace(/^SIM-/, "OC-");
}
