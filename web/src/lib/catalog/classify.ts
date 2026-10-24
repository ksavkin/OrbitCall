// Groups and categories shared by the Dev TLE catalog (build.ts, server) and the real-mode
// OMM catalog (omm.ts, browser), so both modes color the same object the same way.

import type { Category } from "./types";

/** CelesTrak GP groups we load. `active` covers every operating payload. */
export const GROUPS = {
  active: "active",
  stations: "stations",
  gnss: "gnss",
  debris: ["cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris"],
} as const;

export const ALL_GROUPS: string[] = [GROUPS.active, GROUPS.stations, GROUPS.gnss, ...GROUPS.debris];

/** Groups whose objects become catalog rows, in this order; every gnss object is also in active. */
export const ROW_GROUPS: string[] = [GROUPS.active, GROUPS.stations, ...GROUPS.debris];

export interface GroupSets {
  stations: Set<number>;
  gnss: Set<number>;
  debris: Set<number>;
}

export function classify(
  o: { name: string; norad: number; meanMotion: number; ecc: number; objectType?: string },
  sets: GroupSets,
): Category {
  if (sets.debris.has(o.norad) || o.objectType === "DEB") return "debris";
  if (sets.stations.has(o.norad)) return "station";
  if (sets.gnss.has(o.norad)) return "gnss";
  const n = o.name.toUpperCase();
  if (n.startsWith("STARLINK")) return "starlink";
  if (n.startsWith("ONEWEB")) return "oneweb";
  // Geosynchronous: ~1 rev per sidereal day, near-circular.
  if (Math.abs(o.meanMotion - 1.0027) < 0.05 && o.ecc < 0.05) return "geo";
  return "other";
}
