// Real mode (Dev off): the pinned OMM catalog the backend names in catalog.snapshot.ommUrl.
// The index (scripts/build_omm_catalog.py) lists CelesTrak's group files, served byte for byte as
// downloaded, plus SATCAT metadata; each file is checked against its pinned sha256 before use.

import type { OmmRecord } from "@/lib/orbit/elements";
import { classify, GROUPS, ROW_GROUPS } from "./classify";
import { makeCatalog, satObject, type Catalog, type SatObject } from "./client";

export const OMM_INDEX_FORMAT = "orbitcall-omm-catalog/1";

type SatcatRow = [owner: string, launchDate: string, launchSite: string, objectType: string, rcs: number | null];

export interface OmmCatalogIndex {
  format: typeof OMM_INDEX_FORMAT;
  snapshotId: string;
  takenAt: string;
  groups: { group: string; file: string; url: string; fetchedAt: string; sha256: string; bytes: number; records: number }[];
  satcat: { snapshotId: string; fetchedAt: string; rows: Record<string, SatcatRow> };
  owners: Record<string, string>;
}

async function sha256(buf: ArrayBuffer): Promise<string | null> {
  // crypto.subtle exists only in secure contexts (https, localhost).
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** OMM EPOCH is UTC without a zone and with microseconds. */
function epochOf(epoch: string): Date {
  const [whole, frac = ""] = epoch.replace(/Z$/, "").split(".");
  return new Date(`${whole}.${frac.padEnd(3, "0").slice(0, 3)}Z`);
}

const finite = (v: unknown) => v !== "" && v !== null && Number.isFinite(Number(v));

export async function loadOmmCatalog(url: string, signal: AbortSignal): Promise<Catalog> {
  const indexUrl = new URL(url, window.location.href);
  const res = await fetch(indexUrl, { signal });
  if (!res.ok) throw new Error(`OMM catalog index: HTTP ${res.status}`);
  const index = (await res.json()) as OmmCatalogIndex;
  if (index?.format !== OMM_INDEX_FORMAT) throw new Error(`Unexpected OMM catalog format at ${url}`);

  const records = new Map<string, OmmRecord[]>();
  await Promise.all(
    index.groups.map(async (g) => {
      const r = await fetch(new URL(g.file, indexUrl), { signal });
      if (!r.ok) throw new Error(`${g.file}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      const hash = await sha256(buf);
      if (hash !== null && hash !== g.sha256) throw new Error(`${g.file} does not match the pinned snapshot`);
      const list = JSON.parse(new TextDecoder().decode(buf)) as OmmRecord[];
      if (!Array.isArray(list) || list.length !== g.records) throw new Error(`${g.file}: expected ${g.records} OMM records`);
      records.set(g.group, list);
    }),
  );
  for (const g of [...ROW_GROUPS, GROUPS.gnss]) {
    if (!records.has(g)) throw new Error(`The OMM snapshot has no ${g} group`);
  }

  const ids = (g: string) => new Set(records.get(g)!.map((r) => Number(r.NORAD_CAT_ID)));
  const sets = {
    stations: ids(GROUPS.stations),
    gnss: ids(GROUPS.gnss),
    debris: new Set(GROUPS.debris.flatMap((g) => [...ids(g)])),
  };

  const seen = new Set<number>();
  const objects: SatObject[] = [];
  for (const g of ROW_GROUPS) {
    for (const rec of records.get(g)!) {
      const norad = Number(rec.NORAD_CAT_ID);
      if (!Number.isInteger(norad) || seen.has(norad)) continue;
      if (![rec.MEAN_MOTION, rec.ECCENTRICITY, rec.INCLINATION].every(finite)) continue;
      seen.add(norad);
      const sc = index.satcat.rows[String(norad)];
      const meanMotion = Number(rec.MEAN_MOTION);
      const eccentricity = Number(rec.ECCENTRICITY);
      objects.push(
        satObject({
          index: objects.length,
          norad,
          name: rec.OBJECT_NAME,
          cospar: rec.OBJECT_ID, // already "1998-067A"
          category: classify({ name: rec.OBJECT_NAME, norad, meanMotion, ecc: eccentricity, objectType: sc?.[3] }, sets),
          elements: { format: "omm", record: rec },
          owner: sc?.[0] ?? "",
          launchDate: sc?.[1] ?? "",
          launchSite: sc?.[2] ?? "",
          objectType: sc?.[3] ?? "",
          rcs: sc?.[4] ?? null,
          inclination: Number(rec.INCLINATION),
          eccentricity,
          meanMotion,
          epoch: epochOf(rec.EPOCH),
        }),
      );
    }
  }
  const meta = {
    source: "omm-snapshot" as const,
    fetchedAt: index.takenAt,
    groups: index.groups.map((g) => g.group),
    count: objects.length,
  };
  return makeCatalog(meta, index.owners, objects);
}
