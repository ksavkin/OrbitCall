import { EARTH_RADIUS_KM, MU_EARTH } from "@/lib/orbit/constants";
import { CATEGORIES, type CatalogPayload, type CatalogRow, type Category } from "./types";

export interface SatObject {
  index: number;
  norad: number;
  name: string;
  cospar: string;
  category: Category;
  line1: string;
  line2: string;
  owner: string;
  launchDate: string;
  launchSite: string;
  objectType: string;
  rcs: number | null;
  /** Derived from the element set (TLE line 2). */
  inclination: number; // deg
  eccentricity: number;
  meanMotion: number; // rev/day
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
  epoch: Date;
  regime: "LEO" | "MEO" | "GEO" | "HEO";
  searchKey: string;
}

export interface Catalog {
  meta: CatalogPayload["meta"];
  owners: Record<string, string>;
  objects: SatObject[];
  counts: Record<Category, number>;
  regimes: Record<SatObject["regime"], number>;
}

function epochOf(l1: string): Date {
  const yy = parseInt(l1.slice(18, 20), 10);
  const day = parseFloat(l1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}

function toObject(r: CatalogRow, index: number): SatObject {
  const [norad, name, cospar, cat, l1, l2, owner, launchDate, launchSite, objectType, rcs] = r;
  const inclination = parseFloat(l2.slice(8, 16));
  const eccentricity = parseFloat("0." + l2.slice(26, 33).trim());
  const meanMotion = parseFloat(l2.slice(52, 63));
  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU_EARTH / (n * n)); // km
  const apogeeKm = a * (1 + eccentricity) - EARTH_RADIUS_KM;
  const perigeeKm = a * (1 - eccentricity) - EARTH_RADIUS_KM;
  const periodMin = 1440 / meanMotion;
  let regime: SatObject["regime"];
  if (eccentricity > 0.25) regime = "HEO";
  else if (apogeeKm < 2000) regime = "LEO";
  else if (Math.abs(periodMin - 1436) < 90) regime = "GEO";
  else regime = "MEO";
  return {
    index,
    norad,
    name,
    cospar,
    category: CATEGORIES[cat],
    line1: l1,
    line2: l2,
    owner,
    launchDate,
    launchSite,
    objectType,
    rcs,
    inclination,
    eccentricity,
    meanMotion,
    periodMin,
    apogeeKm,
    perigeeKm,
    epoch: epochOf(l1),
    regime,
    searchKey: `${name} ${norad} ${cospar}`.toLowerCase(),
  };
}

export function parseCatalog(p: CatalogPayload): Catalog {
  const objects = p.rows.map(toObject);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const regimes = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  for (const o of objects) {
    counts[o.category]++;
    regimes[o.regime]++;
  }
  return { meta: p.meta, owners: p.owners, objects, counts, regimes };
}

/** International designator 98067A → 1998-067A. */
export function formatCospar(c: string) {
  if (!/^\d{5}/.test(c)) return c;
  const yy = parseInt(c.slice(0, 2), 10);
  return `${yy < 57 ? 2000 + yy : 1900 + yy}-${c.slice(2)}`;
}
