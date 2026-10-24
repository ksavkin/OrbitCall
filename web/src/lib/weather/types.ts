export interface WindGrid {
  validAt: string;
  model: string;
  nx: number;
  ny: number;
  lat0: number;
  lon0: number;
  step: number;
  /** m/s, row-major from lat0 upward, lon from lon0 eastward */
  u: number[];
  v: number[];
}

export interface CurrentsGrid {
  validAt: string;
  model: string;
  step: number;
  /** [lat, lon, u m/s (east), v m/s (north)] on ocean points only */
  points: [number, number, number, number][];
}

export interface Storm {
  id: string;
  name: string;
  kind: string;
  /** Saffir-Simpson, 0 below hurricane strength */
  category: number;
  windKt: number | null;
  pressureMb: number | null;
  lat: number;
  lon: number;
  movementDir: number | null;
  movementKt: number | null;
  updated: string;
  source: string;
  url: string;
}

export interface TornadoData {
  warnings: { id: string; event: string; headline: string; area: string; sent: string; expires: string; rings: number[][][] }[];
  reports: { time: string; scale: string; location: string; county: string; state: string; lat: number; lon: number }[];
}

export interface SpaceWeather {
  observedAt: string;
  forecastAt: string;
  /** 360 × 181 aurora probability %, lon -180..179, lat -90..90 */
  aurora: number[];
  kp: number;
  kpTime: string;
  kpHistory: { t: string; kp: number }[];
}

export interface WeatherMeta<T> {
  data: T;
  fetchedAt: string;
  source: "live" | "cache" | "snapshot";
}
