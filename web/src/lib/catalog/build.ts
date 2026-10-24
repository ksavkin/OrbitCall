import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CATEGORY_INDEX,
  type CatalogPayload,
  type CatalogRow,
  type CatalogSource,
  type Category,
} from "./types";

const CELESTRAK = "https://celestrak.org";

/** CelesTrak GP groups we load. `active` covers every operating payload. */
export const GROUPS = {
  active: "active",
  stations: "stations",
  gnss: "gnss",
  debris: ["cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris"],
} as const;

const ALL_GROUPS = [
  GROUPS.active,
  GROUPS.stations,
  GROUPS.gnss,
  ...GROUPS.debris,
];

const SNAPSHOT_DIR = path.join(process.cwd(), "data", "snapshot");
const CACHE_DIR = path.join(process.cwd(), ".cache", "celestrak");
/** CelesTrak asks clients not to re-download a group more than once per 2h. */
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

interface Tle {
  name: string;
  l1: string;
  l2: string;
}

function parseTle(text: string): Tle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: Tle[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
    out.push({ name: name.trim(), l1, l2 });
  }
  return out;
}

const noradOf = (l1: string) => parseInt(l1.slice(2, 7), 10);

/** Minimal RFC 4180 CSV parser (SATCAT names can contain quoted commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface SatcatEntry {
  owner: string;
  launchDate: string;
  launchSite: string;
  objectType: string;
  rcs: number | null;
  apogee: number | null;
  perigee: number | null;
}

function parseSatcat(text: string): Map<number, SatcatEntry> {
  const rows = parseCsv(text);
  const hdr = rows[0];
  const col = (n: string) => hdr.indexOf(n);
  const iId = col("NORAD_CAT_ID");
  const iOwner = col("OWNER");
  const iLaunch = col("LAUNCH_DATE");
  const iSite = col("LAUNCH_SITE");
  const iType = col("OBJECT_TYPE");
  const iRcs = col("RCS");
  const iApo = col("APOGEE");
  const iPer = col("PERIGEE");
  const num = (s: string | undefined) => {
    if (!s) return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const map = new Map<number, SatcatEntry>();
  for (let r = 1; r < rows.length; r++) {
    const x = rows[r];
    const id = parseInt(x[iId], 10);
    if (!Number.isFinite(id)) continue;
    map.set(id, {
      owner: x[iOwner] ?? "",
      launchDate: x[iLaunch] ?? "",
      launchSite: x[iSite] ?? "",
      objectType: x[iType] ?? "",
      rcs: num(x[iRcs]),
      apogee: num(x[iApo]),
      perigee: num(x[iPer]),
    });
  }
  return map;
}

/** Mean motion (rev/day) and eccentricity straight from TLE line 2. */
function orbitOf(l2: string) {
  return {
    meanMotion: parseFloat(l2.slice(52, 63)),
    ecc: parseFloat("0." + l2.slice(26, 33).trim()),
  };
}

function classify(
  t: Tle,
  norad: number,
  sets: { stations: Set<number>; gnss: Set<number>; debris: Set<number> },
  satcat: SatcatEntry | undefined,
): Category {
  if (sets.debris.has(norad) || satcat?.objectType === "DEB") return "debris";
  if (sets.stations.has(norad)) return "station";
  if (sets.gnss.has(norad)) return "gnss";
  const n = t.name.toUpperCase();
  if (n.startsWith("STARLINK")) return "starlink";
  if (n.startsWith("ONEWEB")) return "oneweb";
  const { meanMotion, ecc } = orbitOf(t.l2);
  // Geosynchronous: ~1 rev per sidereal day, near-circular.
  if (Math.abs(meanMotion - 1.0027) < 0.05 && ecc < 0.05) return "geo";
  return "other";
}

function build(
  texts: Record<string, string>,
  satcatText: string,
  owners: Record<string, string>,
  source: CatalogSource,
  fetchedAt: string,
): CatalogPayload {
  const ids = (g: string) => new Set(parseTle(texts[g]).map((t) => noradOf(t.l1)));
  const sets = {
    stations: ids(GROUPS.stations),
    gnss: ids(GROUPS.gnss),
    debris: new Set(GROUPS.debris.flatMap((g) => [...ids(g)])),
  };
  const satcat = parseSatcat(satcatText);

  const seen = new Set<number>();
  const rows: CatalogRow[] = [];
  for (const g of [GROUPS.active, GROUPS.stations, ...GROUPS.debris]) {
    for (const t of parseTle(texts[g])) {
      const norad = noradOf(t.l1);
      if (seen.has(norad)) continue;
      seen.add(norad);
      const sc = satcat.get(norad);
      const cat = classify(t, norad, sets, sc);
      rows.push([
        norad,
        t.name,
        t.l1.slice(9, 17).trim(), // international designator, e.g. 98067A
        CATEGORY_INDEX[cat],
        t.l1,
        t.l2,
        sc?.owner ?? "",
        sc?.launchDate ?? "",
        sc?.launchSite ?? "",
        sc?.objectType ?? "",
        sc?.rcs ?? null,
        sc?.apogee ?? null,
        sc?.perigee ?? null,
      ]);
    }
  }
  return {
    meta: { source, fetchedAt, groups: ALL_GROUPS, count: rows.length },
    owners,
    rows,
  };
}

async function readSnapshot(dir: string) {
  const texts: Record<string, string> = {};
  for (const g of ALL_GROUPS) texts[g] = await fs.readFile(path.join(dir, `${g}.tle`), "utf8");
  const satcat = await fs.readFile(path.join(dir, "satcat.csv"), "utf8");
  const fetchedAt = (await fs.readFile(path.join(dir, "fetched_at.txt"), "utf8")).trim();
  return { texts, satcat, fetchedAt };
}

async function download(): Promise<{ texts: Record<string, string>; satcat: string }> {
  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: { "User-Agent": "OrbitCall/0.1 (Cal Hacks 13.0)" },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const text = await res.text();
    // CelesTrak answers rate-limited or unknown groups with a plain-text notice.
    if (url.includes("gp.php") && !text.includes("\n1 ")) throw new Error(`${url} → no TLE data`);
    return text;
  };
  const texts: Record<string, string> = {};
  await Promise.all(
    ALL_GROUPS.map(async (g) => {
      texts[g] = await get(`${CELESTRAK}/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
    }),
  );
  const satcat = await get(`${CELESTRAK}/pub/satcat.csv`);
  return { texts, satcat };
}

let memo: { payload: CatalogPayload; json: string; at: number } | null = null;
let inflight: Promise<CatalogPayload> | null = null;

/**
 * Live CelesTrak data, cached on disk for 2h. Falls back to the cache, then to
 * the committed snapshot in data/snapshot when CelesTrak is unreachable.
 */
export async function getCatalog(): Promise<CatalogPayload> {
  // Also after a failed download: CelesTrak blocks IPs that keep retrying.
  if (memo && Date.now() - memo.at < CACHE_TTL_MS) return memo.payload;
  if (inflight) return inflight;
  inflight = (async () => {
    const owners = JSON.parse(
      await fs.readFile(path.join(SNAPSHOT_DIR, "owners.json"), "utf8"),
    ) as Record<string, string>;

    // 1. Fresh disk cache.
    try {
      const at = (await fs.readFile(path.join(CACHE_DIR, "fetched_at.txt"), "utf8")).trim();
      if (Date.now() - Date.parse(at) < CACHE_TTL_MS) {
        const c = await readSnapshot(CACHE_DIR);
        return build(c.texts, c.satcat, owners, "celestrak-cache", c.fetchedAt);
      }
    } catch {}

    // 2. Live download.
    if (process.env.ORBITCALL_OFFLINE !== "1") {
      try {
        const { texts, satcat } = await download();
        const fetchedAt = new Date().toISOString();
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await Promise.all([
          ...Object.entries(texts).map(([g, t]) => fs.writeFile(path.join(CACHE_DIR, `${g}.tle`), t)),
          fs.writeFile(path.join(CACHE_DIR, "satcat.csv"), satcat),
          fs.writeFile(path.join(CACHE_DIR, "fetched_at.txt"), fetchedAt),
        ]);
        return build(texts, satcat, owners, "celestrak-live", fetchedAt);
      } catch (e) {
        console.warn("[catalog] CelesTrak download failed, using fallback:", (e as Error).message);
      }
    }

    // 3. Stale cache, then the committed snapshot.
    for (const [dir, source] of [
      [CACHE_DIR, "celestrak-cache"],
      [SNAPSHOT_DIR, "snapshot"],
    ] as const) {
      try {
        const c = await readSnapshot(dir);
        return build(c.texts, c.satcat, owners, source, c.fetchedAt);
      } catch {}
    }
    throw new Error("No catalog data available");
  })();
  try {
    const payload = await inflight;
    memo = { payload, json: JSON.stringify(payload), at: Date.now() };
    return payload;
  } finally {
    inflight = null;
  }
}

/** Serialized once per refresh; the payload is ~4 MB. */
export async function getCatalogJson(): Promise<string> {
  await getCatalog();
  return memo!.json;
}
