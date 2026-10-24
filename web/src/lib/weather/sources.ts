import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cached, getJson, getText, UA } from "./cache";
import type { CurrentsGrid, SpaceWeather, Storm, TornadoData, WindGrid } from "./types";

const MIN = 60_000;

/* ------------------------------------------------------------- clouds */

const EUM_WMS = "https://view.eumetsat.int/geoserver/wms";
const CLOUD_LAYER = "mumi:worldcloudmap_ir108";

/** Latest frame time of EUMETSAT's geostationary-ring IR mosaic (3-hourly). */
async function latestCloudTime(): Promise<string> {
  const caps = await getText(`${EUM_WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, 60_000);
  const i = caps.indexOf(`<Name>${CLOUD_LAYER}</Name>`);
  if (i < 0) throw new Error("cloud layer missing from capabilities");
  const dim = caps.slice(i, i + 4000).match(/<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/);
  if (!dim) throw new Error("no time dimension");
  // "start/end/PT3H" or a comma list
  const v = dim[1].trim();
  const end = v.includes("/") ? v.split("/")[1] : v.split(",").pop()!;
  return end.trim();
}

export function getClouds() {
  return cached<{ png: Buffer; observedAt: string }>(
    "clouds",
    30 * MIN,
    async () => {
      const time = await latestCloudTime();
      const url =
        `${EUM_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${CLOUD_LAYER}&STYLES=` +
        `&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=3072&HEIGHT=1536&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${time}`;
      // 3072 px is the largest size this WMS renders (4096 → HTTP 500); it takes ~1 min.
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000), cache: "no-store" });
      if (!res.ok || !res.headers.get("content-type")?.includes("image/png")) throw new Error(`clouds HTTP ${res.status}`);
      return { png: Buffer.from(await res.arrayBuffer()), observedAt: time };
    },
    {
      ext: "bin",
      // [32-byte space-padded time string][png]
      encode: (v) => Buffer.concat([Buffer.from(v.observedAt.padEnd(32)), v.png]),
      decode: (b) => ({ observedAt: b.subarray(0, 32).toString().trim(), png: b.subarray(32) }),
    },
  );
}

/* --------------------------------------------------------------- wind */

// GFS 0.5° via the PacIOOS ERDDAP (NOAA CoastWatch federates to it), strided to 2°.
const GFS = "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/ncep_global.csv";

export function getWind() {
  return cached<WindGrid>("wind", 60 * MIN, async () => {
    const t = new Date();
    t.setUTCMinutes(0, 0, 0);
    const T = t.toISOString().replace(".000", "");
    const sel = `[(${T})][(-90):4:(90)][(0):4:(359.5)]`;
    const csv = await getText(`${GFS}?ugrd10m${encodeURIComponent(sel)},vgrd10m${encodeURIComponent(sel)}`, 90_000);
    const lines = csv.trim().split("\n").slice(2);
    const nx = 180;
    const ny = 91;
    const u = new Array<number>(nx * ny).fill(0);
    const v = new Array<number>(nx * ny).fill(0);
    let validAt = "";
    for (const line of lines) {
      const [time, lat, lon, uu, vv] = line.split(",");
      validAt = time;
      const j = Math.round((Number(lat) + 90) / 2);
      const i = Math.round(Number(lon) / 2);
      const k = j * nx + i;
      u[k] = Math.round(Number(uu) * 10) / 10 || 0;
      v[k] = Math.round(Number(vv) * 10) / 10 || 0;
    }
    return { validAt, model: "NOAA GFS 0.5° (10 m wind), sampled every 2°", nx, ny, lat0: -90, lon0: 0, step: 2, u, v };
  });
}

/* ----------------------------------------------------------- currents */

const MARINE = "https://marine-api.open-meteo.com/v1/marine";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getCurrents() {
  return cached<CurrentsGrid>("currents", 12 * 60 * MIN, async () => {
    const { step, points } = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "data", "weather", "ocean-points.json"), "utf8"),
    ) as { step: number; points: [number, number][] };
    const out: CurrentsGrid["points"] = [];
    let validAt = "";
    // Open-Meteo counts every location as one call (600/min on the free tier), so
    // 150 points every 20 s keeps us at ~450/min. First fetch takes ~3.5 min.
    type Row = { current: { time: string; ocean_current_velocity: number | null; ocean_current_direction: number | null } };
    for (let b = 0; b < points.length; b += 150) {
      const batch = points.slice(b, b + 150);
      const url =
        `${MARINE}?latitude=${batch.map((p) => p[0]).join(",")}&longitude=${batch.map((p) => p[1]).join(",")}` +
        `&current=ocean_current_velocity,ocean_current_direction`;
      let res: Row[];
      try {
        res = await getJson<Row[]>(url, 60_000);
      } catch (e) {
        if (!String((e as Error).message).includes("429")) throw e;
        await sleep(65_000); // rate-limited: wait out the minute window once
        res = await getJson<Row[]>(url, 60_000);
      }
      res.forEach((r, k) => {
        const s = r.current.ocean_current_velocity;
        const d = r.current.ocean_current_direction;
        validAt = r.current.time;
        if (s === null || d === null) return;
        // km/h → m/s; direction is where the current flows towards (0° = north)
        const ms = s / 3.6;
        const rad = (d * Math.PI) / 180;
        out.push([batch[k][0], batch[k][1], Math.round(ms * Math.sin(rad) * 100) / 100, Math.round(ms * Math.cos(rad) * 100) / 100]);
      });
      if (b + 150 < points.length) await sleep(20_000);
    }
    return { validAt: validAt + "Z", model: "MeteoFrance SMOC via Open-Meteo Marine", step, points: out };
  });
}

/* ------------------------------------------------------------- storms */

interface NhcStorm {
  id: string;
  name: string;
  classification: string;
  intensity: string;
  pressure: string;
  latitudeNumeric: number;
  longitudeNumeric: number;
  movementDir: number;
  movementSpeed: number;
  lastUpdate: string;
  publicAdvisory?: { url?: string };
}

const NHC_CLASS: Record<string, string> = {
  TD: "Tropical depression",
  TS: "Tropical storm",
  HU: "Hurricane",
  STD: "Subtropical depression",
  STS: "Subtropical storm",
  PTC: "Post-tropical cyclone",
  PC: "Potential tropical cyclone",
  TY: "Typhoon",
};

/** Saffir-Simpson category from 1-min sustained wind in knots. */
function category(kt: number) {
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  if (kt >= 64) return 1;
  return 0;
}

async function nhcStorms(): Promise<Storm[]> {
  const d = await getJson<{ activeStorms: NhcStorm[] }>("https://www.nhc.noaa.gov/CurrentStorms.json");
  return d.activeStorms.map((s) => {
    const kt = Number(s.intensity);
    return {
      id: s.id,
      name: s.name,
      kind: NHC_CLASS[s.classification] ?? s.classification,
      category: category(kt),
      windKt: kt,
      pressureMb: Number(s.pressure) || null,
      lat: s.latitudeNumeric,
      lon: s.longitudeNumeric,
      movementDir: s.movementDir,
      movementKt: s.movementSpeed,
      updated: s.lastUpdate,
      source: "NOAA NHC",
      url: s.publicAdvisory?.url ?? "https://www.nhc.noaa.gov/",
    };
  });
}

interface GdacsFeature {
  geometry: { type: string; coordinates: number[] };
  properties: {
    eventid: number;
    name: string;
    iscurrent: string | boolean;
    todate: string;
    alertlevel: string;
    severitydata?: { severity: number; severitytext: string; severityunit: string };
    url?: { report?: string };
  };
}

/** GDACS covers every basin (incl. West Pacific and Indian Ocean). Slow API, so long cache. */
async function gdacsStorms(): Promise<Storm[]> {
  const d = await getJson<{ features: GdacsFeature[] }>(
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC",
    90_000,
  );
  return d.features
    .filter((f) => String(f.properties.iscurrent) === "true" && f.geometry.type === "Point")
    .map((f) => {
      const p = f.properties;
      const kmh = p.severitydata?.severityunit === "km/h" ? p.severitydata.severity : null;
      const kt = kmh !== null ? Math.round(kmh / 1.852) : null;
      return {
        id: `gdacs-${p.eventid}`,
        name: p.name.replace(/^Tropical Cyclone /, ""),
        kind: p.severitydata?.severitytext?.split(" (")[0] ?? "Tropical cyclone",
        category: kt !== null ? category(kt) : 0,
        windKt: kt,
        pressureMb: null,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        movementDir: null,
        movementKt: null,
        updated: p.todate.endsWith("Z") ? p.todate : p.todate + "Z",
        source: `GDACS (${p.alertlevel} alert)`,
        url: p.url?.report ?? "https://www.gdacs.org/",
      } satisfies Storm;
    });
}

// GDACS takes ~1 min to answer, so it refreshes on its own and never blocks NHC.
let gdacsLast: Storm[] = [];
let gdacsRunning: Promise<void> | null = null;
function refreshGdacs() {
  if (gdacsRunning) return gdacsRunning;
  gdacsRunning = cached<Storm[]>("storms-gdacs", 60 * MIN, gdacsStorms)
    .then((c) => {
      gdacsLast = c.data;
    })
    .catch((e) => console.warn("[weather:storms] GDACS failed:", (e as Error).message))
    .finally(() => {
      gdacsRunning = null;
    });
  return gdacsRunning;
}

export async function getStorms() {
  const pending = refreshGdacs();
  // wait briefly in case GDACS is already cached on disk
  await Promise.race([pending, new Promise((r) => setTimeout(r, 300))]);
  const nhc = await cached<Storm[]>("storms-nhc", 15 * MIN, nhcStorms);
  // NHC is authoritative for its basins; GDACS fills the rest (West Pacific, Indian Ocean, ...)
  const names = new Set(nhc.data.map((s) => s.name.toLowerCase()));
  const merged = [...nhc.data, ...gdacsLast.filter((s) => !names.has(s.name.toLowerCase().replace(/-\d+$/, "")))];
  return { ...nhc, data: merged };
}

/* ------------------------------------------------------------ tornado */

interface NwsAlert {
  geometry: { type: string; coordinates: number[][][] } | null;
  properties: { id: string; event: string; headline: string; areaDesc: string; sent: string; expires: string; severity: string };
}

export function getTornado() {
  return cached<TornadoData>("tornado", 2 * MIN, async () => {
    const [alerts, reports] = await Promise.all([
      getJson<{ features: NwsAlert[] }>("https://api.weather.gov/alerts/active?event=Tornado%20Warning,Tornado%20Watch"),
      getText("https://www.spc.noaa.gov/climo/reports/today_torn.csv"),
    ]);
    const warnings = alerts.features.map((f) => ({
      id: f.properties.id,
      event: f.properties.event,
      headline: f.properties.headline,
      area: f.properties.areaDesc,
      sent: f.properties.sent,
      expires: f.properties.expires,
      // polygons as [lon, lat] rings; watches are often zone-based without geometry
      rings: f.geometry?.type === "Polygon" ? f.geometry.coordinates : [],
    }));
    const rows = reports.trim().split("\n").slice(1).filter(Boolean);
    const reportsOut = rows.map((r) => {
      const c = r.split(",");
      return { time: c[0], scale: c[1], location: c[2], county: c[3], state: c[4], lat: Number(c[5]), lon: Number(c[6]) };
    });
    return { warnings, reports: reportsOut };
  });
}

/* ------------------------------------------------------ space weather */

export function getSpaceWeather() {
  return cached<SpaceWeather>("space", 5 * MIN, async () => {
    const [ov, kp] = await Promise.all([
      getJson<{ "Observation Time": string; "Forecast Time": string; coordinates: [number, number, number][] }>(
        "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
      ),
      getJson<{ time_tag: string; Kp: number }[]>("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
    ]);
    // 360 × 181 grid, lon 0..359, lat -90..90 → row-major by lat, lon shifted to -180..179
    const aurora = new Array<number>(360 * 181).fill(0);
    for (const [lon, lat, p] of ov.coordinates) {
      const i = (lon + 180) % 360;
      const j = lat + 90;
      aurora[j * 360 + i] = p;
    }
    const last = kp[kp.length - 1];
    return {
      observedAt: ov["Observation Time"],
      forecastAt: ov["Forecast Time"],
      aurora,
      kp: last.Kp,
      kpTime: last.time_tag + "Z",
      kpHistory: kp.slice(-24).map((k) => ({ t: k.time_tag + "Z", kp: k.Kp })),
    };
  });
}
