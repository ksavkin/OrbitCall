// Shared catalog types. The server builds this from CelesTrak GP element sets
// and SATCAT; the client propagates the element sets with SGP4.

export type Category =
  | "station"
  | "starlink"
  | "oneweb"
  | "gnss"
  | "geo"
  | "other"
  | "debris";

export const CATEGORIES: Category[] = [
  "station",
  "starlink",
  "oneweb",
  "gnss",
  "geo",
  "other",
  "debris",
];

export const CATEGORY_INDEX: Record<Category, number> = Object.fromEntries(
  CATEGORIES.map((c, i) => [c, i]),
) as Record<Category, number>;

/** Compact row: keeps the payload small for ~19k objects. */
export type CatalogRow = [
  norad: number,
  name: string,
  cospar: string,
  category: number, // index into CATEGORIES
  line1: string,
  line2: string,
  owner: string, // SATCAT owner code, e.g. "US", "PRC", "SPCX"
  launchDate: string,
  launchSite: string,
  objectType: string, // PAY, R/B, DEB, UNK
  rcs: number | null, // radar cross-section, m^2
  apogee: number | null, // km, from SATCAT
  perigee: number | null, // km, from SATCAT
];

/** `omm-snapshot`: real mode, the pinned OMM catalog named by the backend's catalog.snapshot. */
export type CatalogSource = "celestrak-live" | "celestrak-cache" | "snapshot" | "omm-snapshot";

export interface CatalogPayload {
  meta: {
    source: CatalogSource;
    /** When the element sets were downloaded from CelesTrak (ISO). */
    fetchedAt: string;
    groups: string[];
    count: number;
  };
  owners: Record<string, string>;
  rows: CatalogRow[];
}
