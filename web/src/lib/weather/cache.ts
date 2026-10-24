import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".cache", "weather");
const SNAPSHOT_DIR = path.join(process.cwd(), "data", "weather");

export interface Cached<T> {
  data: T;
  /** When we fetched it (ISO). */
  fetchedAt: string;
  source: "live" | "cache" | "snapshot";
}

const memo = new Map<string, { value: Cached<unknown>; at: number }>();
const inflight = new Map<string, Promise<Cached<unknown>>>();

/**
 * Memory → fresh disk cache → live fetch → stale disk cache → committed snapshot.
 * Serializers let binary payloads (PNG) and JSON share one path.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  codec: { ext: string; encode: (v: T) => Buffer | string; decode: (b: Buffer) => T } = jsonCodec<T>(),
): Promise<Cached<T>> {
  const m = memo.get(key);
  if (m && Date.now() - m.at < ttlMs) return m.value as Cached<T>;
  const running = inflight.get(key);
  if (running) return running as Promise<Cached<T>>;

  const file = (dir: string) => path.join(dir, `${key}.${codec.ext}`);
  const meta = (dir: string) => path.join(dir, `${key}.meta.json`);
  const readFrom = async (dir: string, source: Cached<T>["source"]) => {
    const [buf, m] = await Promise.all([fs.readFile(file(dir)), fs.readFile(meta(dir), "utf8")]);
    return { data: codec.decode(buf), fetchedAt: JSON.parse(m).fetchedAt as string, source } satisfies Cached<T>;
  };

  const p = (async (): Promise<Cached<T>> => {
    try {
      const c = await readFrom(CACHE_DIR, "cache");
      if (Date.now() - Date.parse(c.fetchedAt) < ttlMs) return c;
    } catch {}
    if (process.env.ORBITCALL_OFFLINE !== "1") {
      try {
        const data = await fetcher();
        const fetchedAt = new Date().toISOString();
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await Promise.all([
          fs.writeFile(file(CACHE_DIR), codec.encode(data)),
          fs.writeFile(meta(CACHE_DIR), JSON.stringify({ fetchedAt })),
        ]);
        return { data, fetchedAt, source: "live" };
      } catch (e) {
        console.warn(`[weather:${key}] live fetch failed:`, (e as Error).message);
      }
    }
    try {
      return await readFrom(CACHE_DIR, "cache");
    } catch {}
    return readFrom(SNAPSHOT_DIR, "snapshot");
  })();

  inflight.set(key, p);
  try {
    const value = await p;
    memo.set(key, { value, at: Date.now() });
    return value;
  } finally {
    inflight.delete(key);
  }
}

export function jsonCodec<T>() {
  return {
    ext: "json",
    encode: (v: T) => JSON.stringify(v),
    decode: (b: Buffer) => JSON.parse(b.toString("utf8")) as T,
  };
}

// NWS asks for an identifying User-Agent; no personal contact details are sent.
export const UA = { "User-Agent": "OrbitCall/0.1 (Cal Hacks 13.0 hackathon project)" };

export async function getText(url: string, timeoutMs = 30_000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

export async function getJson<T>(url: string, timeoutMs = 30_000) {
  return JSON.parse(await getText(url, timeoutMs)) as T;
}
