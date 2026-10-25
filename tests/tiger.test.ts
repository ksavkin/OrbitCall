// @vitest-environment node
// `pg` needs Node sockets and TLS, and the adapter runs in a `"use node"` Convex action, so this file runs in Node.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SERIES_POINTS, MAX_WRITE_BATCH, OBSERVATION_TABLE, SETUP_LOCK_KEY, TIGER_SOURCES, canonicalUtc, connectTiger,
  ensureObservationTable, observationKey, readSeries, safeTigerFailure, tigerClientConfig, validateObservation, withTiger,
  writeObservations, type SqlResult, type TigerClient, type TigerClientConfig, type TigerConnection, type TigerObservation,
} from "../convex/lib/tiger";
import { sourceName } from "../convex/lib/validators";
import { AnalystError } from "../convex/lib/analyst";

const URL_WITH_SECRET = "postgres://tsdbadmin:SECRET-password@abc123.x.tsdb.cloud.timescale.com:34567/tsdb?sslmode=require";
const CLOUD_CONFIG: TigerClientConfig = {
  host: "abc123.x.tsdb.cloud.timescale.com", port: 34567, user: "tsdbadmin", password: "SECRET-password", database: "tsdb",
  ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10_000, query_timeout: 20_000,
};

// Fixture rows carry the key observationKey() builds for them.
const keyed = (row: Omit<TigerObservation, "observationKey"> & { observationKey?: string }): TigerObservation =>
  ({ ...row, observationKey: observationKey(row) });
const observation = keyed({
  eventId: "event-1", runId: null, observedAt: "2026-10-24T10:30:00Z", source: "socrates", metric: "missKm", value: 0.18,
  evidenceVersion: "evidence-v3", simulated: false,
});
const simulatedObservation = keyed({
  eventId: "event-1", runId: "run-7", observedAt: "2026-10-24T11:00:00Z", source: "simulated", metric: "pc", value: null,
  evidenceVersion: "evidence-v3", simulated: true,
});
// A real observation `minutes` after the fixture, or a simulated one when `simulated` is set.
const at = (minutes: number, simulated = false) => keyed({
  ...(simulated ? simulatedObservation : observation),
  observedAt: new Date(Date.parse("2026-10-24T10:00:00Z") + minutes * 60_000).toISOString().replace(".000Z", "Z"),
});

// Records every statement. Results are served in order; the last one repeats.
function recorder(...results: (SqlResult | Error)[]) {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  let index = 0;
  return {
    calls,
    async sql(text: string, values?: unknown[]): Promise<SqlResult> {
      calls.push({ text, values });
      const result = results[Math.min(index++, results.length - 1)] ?? { rows: [], rowCount: 0 };
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
const pgError = (code: string, message = `connection to server at "abc123.x.tsdb.cloud.timescale.com" failed: ${URL_WITH_SECRET}`) =>
  Object.assign(new Error(message), { code });
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
// The rejection of a promise that must reject; a resolved promise fails the test instead of looking like an error.
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  let error: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (thrown) {
    error = thrown;
    rejected = true;
  }
  if (!rejected) throw new Error("expected the operation to fail, but it resolved");
  return error;
}
// The operation's own error, which must already be a sanitized AnalystError; nothing is sanitized on the way.
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(AnalystError);
  const { code, message } = error as AnalystError;
  return { code, message };
}

beforeEach(() => { vi.stubEnv("TIGER_DATABASE_URL", URL_WITH_SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Tiger client configuration", () => {
  it("builds the exact pg.Client object from TIGER_DATABASE_URL, with TLS verification on and no connection string", () => {
    const config = tigerClientConfig();
    expect(config).toEqual(CLOUD_CONFIG);
    expect(Object.keys(config)).not.toContain("connectionString");
    expect(Object.keys(config)).not.toContain("statement_timeout");
  });

  it("defaults the port, decodes user and password, and accepts verify-full and verify-ca", () => {
    expect(tigerClientConfig("postgresql://us%40er:p%40ss%2Fword@db.example.com/orbit?sslmode=verify-full")).toEqual({
      ...CLOUD_CONFIG, host: "db.example.com", port: 5432, user: "us@er", password: "p@ss/word", database: "orbit",
    });
    expect(tigerClientConfig("postgres://u:p@db.example.com/orbit?sslmode=verify-ca").ssl).toEqual({ rejectUnauthorized: true });
    expect(tigerClientConfig("postgres://u:p@db.example.com/orbit").ssl).toEqual({ rejectUnauthorized: true });
  });

  it("allows plaintext only for a loopback database that asks for it", () => {
    expect(tigerClientConfig("postgres://dev:dev@localhost:5432/orbitcall?sslmode=disable").ssl).toBe(false);
    expect(tigerClientConfig("postgres://dev:dev@127.0.0.1/orbitcall?sslmode=disable").ssl).toBe(false);
    expect(tigerClientConfig("postgres://dev:dev@[::1]/orbitcall?sslmode=disable")).toMatchObject({ host: "::1", ssl: false });
  });

  it("hands pg a bare IPv6 address, not the bracketed URL form", () => {
    expect(tigerClientConfig("postgres://u:p@[2001:db8::10]:5433/orbit")).toMatchObject({ host: "2001:db8::10", port: 5433, ssl: { rejectUnauthorized: true } });
    expect(tigerClientConfig("postgres://u:p@[::1]/orbit").ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each([
    ["an empty value", ""],
    ["a non-URL", "not a url"],
    ["a non-postgres scheme", "https://db.example.com/db"],
    ["a missing host", "postgres:///nohost"],
    ["a missing database", "postgres://u:p@db.example.com/"],
    ["a missing user", "postgres://db.example.com/db"],
    ["an invalid port", "postgres://u:p@db.example.com:99999/db"],
    ["sslmode=disable on a remote host", "postgres://u:p@db.internal:5432/orbitcall?sslmode=disable"],
    ["sslmode=no-verify", "postgres://u:p@db.example.com/db?sslmode=no-verify"],
    ["sslmode=prefer", "postgres://u:p@db.example.com/db?sslmode=prefer"],
    ["a host override", "postgres://u:p@localhost/db?host=remote.example.com&sslmode=disable"],
    ["a statement_timeout override", `${URL_WITH_SECRET}&statement_timeout=0`],
    ["an options override", `${URL_WITH_SECRET}&options=-c%20statement_timeout%3D0`],
    ["libpq compatibility mode", `${URL_WITH_SECRET}&uselibpqcompat=true`],
  ])("rejects %s as not configured without naming the host", (_name, value) => {
    const error = (() => { try { tigerClientConfig(value); return null; } catch (error) { return error; } })();
    expect(safeTigerFailure(error).code).toBe("HISTORY_NOT_CONFIGURED");
    expect(safeTigerFailure(error).message).not.toContain("example.com");
    expect(safeTigerFailure(error).message).not.toContain("SECRET");
  });

  it("reads the environment when no value is passed and fails closed without it", () => {
    vi.stubEnv("TIGER_DATABASE_URL", "");
    expect(() => tigerClientConfig()).toThrow("TIGER_DATABASE_URL");
  });
});

// A pg.Client stand-in: records the config it was built with, the listeners, and the statements.
function fakeClient(results: (SqlResult | Error)[] = [], connectError?: Error) {
  const listeners: Record<string, ((error: unknown) => void)[]> = {};
  const db = recorder(...results);
  const state = { config: null as TigerClientConfig | null, connected: 0, ended: 0, listeners, calls: db.calls };
  const factory = (config: TigerClientConfig): TigerClient => {
    state.config = config;
    return {
      async connect() { state.connected += 1; if (connectError) throw connectError; },
      async end() { state.ended += 1; },
      on(event, listener) { (listeners[event] ??= []).push(listener); return this; },
      query: (text, values) => db.sql(text, values),
    };
  };
  return { factory, state, emitError: (error: unknown) => listeners.error?.forEach(listener => listener(error)) };
}

describe("connectTiger", () => {
  it("builds the client from the parsed configuration, listens for connection errors, and connects once", async () => {
    const { factory, state, emitError } = fakeClient();
    const connection = await connectTiger(factory);
    expect(state.config).toEqual(CLOUD_CONFIG);
    expect(state.connected).toBe(1);
    expect(state.listeners.error).toHaveLength(1);
    // A dropped connection emits "error"; with the listener in place it is not an uncaught exception.
    expect(() => emitError(pgError("ECONNRESET"))).not.toThrow();
    await connection.end();
    expect(state.ended).toBe(1);
  });

  it("sanitizes every statement failure before a caller can catch it inside the work", async () => {
    const { factory } = fakeClient([pgError("42P01", `relation "x" does not exist at ${URL_WITH_SECRET}`)]);
    const connection = await connectTiger(factory);
    const error = await connection.sql("SELECT 1").catch(error => error);
    expect(error.name).toBe("AnalystError");
    expect(error.code).toBe("HISTORY_QUERY_REJECTED");
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("does not exist");
  });

  it("does not build a client when the URL is not configured", async () => {
    vi.stubEnv("TIGER_DATABASE_URL", "postgres://u:p@db.internal/db?sslmode=disable");
    const { factory, state } = fakeClient();
    expect((await failure(connectTiger(factory))).code).toBe("HISTORY_NOT_CONFIGURED");
    expect(state.config).toBeNull();
    expect(state.connected).toBe(0);
  });

  it("closes the client and rejects with a sanitized error when the handshake fails, even without withTiger", async () => {
    for (const [code, expected] of [["28P01", "HISTORY_ACCESS_DENIED"], ["ECONNREFUSED", "UPSTREAM_UNAVAILABLE"], ["ERR_TLS_CERT_ALTNAME_INVALID", "HISTORY_ACCESS_DENIED"]]) {
      const { factory, state } = fakeClient([], pgError(code, `password authentication failed for user "tsdbadmin" at ${URL_WITH_SECRET}`));
      const error = await rejection(connectTiger(factory));
      expect(error).toBeInstanceOf(AnalystError);
      expect((error as AnalystError).code).toBe(expected);
      expect((error as AnalystError).message).not.toContain("SECRET");
      expect((error as AnalystError).message).not.toContain("tsdbadmin");
      expect(state.connected).toBe(1);
      expect(state.ended).toBe(1);
    }
  });

  it("sanitizes a client construction failure", async () => {
    const error = await rejection(connectTiger(() => { throw pgError("ERR_INVALID_ARG_TYPE", `bad option for ${URL_WITH_SECRET}`); }));
    expect(error).toBeInstanceOf(AnalystError);
    expect((error as AnalystError).message).not.toContain("SECRET");
  });
});

describe("withTiger", () => {
  const connection = (db = recorder(), end = vi.fn().mockResolvedValue(undefined)) =>
    ({ connect: vi.fn().mockResolvedValue({ sql: db.sql, end } as TigerConnection), db, end });

  it("opens one connection, runs the work on it, and closes it", async () => {
    const { connect, db, end } = connection();
    await expect(withTiger(tiger => tiger.sql("SELECT 1").then(() => "done"), connect)).resolves.toBe("done");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(db.calls.map(call => call.text)).toEqual(["SELECT 1"]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runs through a real client factory: connect, work, end, in that order", async () => {
    const { factory, state } = fakeClient([{ rows: [{ one: 1 }], rowCount: 1 }]);
    const result = await withTiger(tiger => tiger.sql("SELECT 1"), () => connectTiger(factory));
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(state.connected).toBe(1);
    expect(state.ended).toBe(1);
  });

  it("closes the connection when the work fails and hides the database error", async () => {
    const { connect, end } = connection(recorder(pgError("57014")));
    const error = await withTiger(tiger => tiger.sql("SELECT pg_sleep(100)"), connect).catch(error => error);
    expect(end).toHaveBeenCalledTimes(1);
    expect(safeTigerFailure(error)).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("timed out") });
    expect(String(error.message)).not.toContain("SECRET");
    expect(String(error.message)).not.toContain("timescale");
  });

  it("reports a refused, unauthenticated, or unverifiable connection without the URL", async () => {
    for (const [code, expected] of [
      ["ECONNREFUSED", "UPSTREAM_UNAVAILABLE"], ["28P01", "HISTORY_ACCESS_DENIED"], ["53300", "RATE_LIMITED"],
      ["SELF_SIGNED_CERT_IN_CHAIN", "HISTORY_ACCESS_DENIED"], ["3D000", "HISTORY_NOT_CONFIGURED"],
    ]) {
      const { factory, state } = fakeClient([], pgError(code));
      const result = await failure(withTiger(async () => "unreachable", () => connectTiger(factory)));
      expect(state.connected).toBe(1);
      expect(result.code).toBe(expected);
      expect(result.message).not.toContain("SECRET");
      expect(result.message).not.toContain("tsdb");
    }
  });
});

describe("ensureObservationTable", () => {
  it("creates the table with a key that includes the time partition, then the hypertable, inside one locked transaction", async () => {
    const db = recorder();
    await ensureObservationTable(db);
    const statements = db.calls.map(call => normalize(call.text));
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(db.calls[1].values).toEqual([SETUP_LOCK_KEY]);
    expect(statements[2]).toContain(`CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE} (`);
    expect(statements[2]).toContain("PRIMARY KEY (observation_key, observed_at)");
    expect(statements[2]).toContain("observed_at timestamptz NOT NULL");
    expect(statements[2]).toContain("value double precision,");
    expect(statements[2]).toContain("simulated boolean NOT NULL");
    expect(statements[3]).toBe(`SELECT create_hypertable('${OBSERVATION_TABLE}', 'observed_at', if_not_exists => TRUE)`);
    expect(statements[4]).toContain("CREATE INDEX IF NOT EXISTS");
    expect(statements[5]).toBe("COMMIT");
  });

  it("rolls back and rethrows when a setup statement fails", async () => {
    const db = recorder({ rows: [], rowCount: null }, { rows: [], rowCount: null }, pgError("42501"), { rows: [], rowCount: null });
    // The recorder is a bare connection, so the raw driver error comes back and is mapped by the caller.
    const error = await rejection(ensureObservationTable(db));
    expect(safeTigerFailure(error).code).toBe("HISTORY_QUERY_REJECTED");
    expect(db.calls.map(call => normalize(call.text).split(" ")[0])).toEqual(["BEGIN", "SELECT", "CREATE", "ROLLBACK"]);
  });
});

describe("canonicalUtc", () => {
  it("gives one spelling per instant and rejects more than millisecond precision", () => {
    expect(canonicalUtc("2026-10-24T10:30:00Z")).toBe("2026-10-24T10:30:00Z");
    expect(canonicalUtc("2026-10-24T10:30:00.000Z")).toBe("2026-10-24T10:30:00Z");
    expect(canonicalUtc("2026-10-24T10:30:00.1Z")).toBe("2026-10-24T10:30:00.100Z");
    expect(canonicalUtc("2026-10-24T10:30:00.250Z")).toBe("2026-10-24T10:30:00.250Z");
    for (const bad of ["2026-10-24T10:30:00.1234Z", "2026-10-24T10:30:00.123456Z", "2026-10-24T10:30:00+00:00", "2026-10-24 10:30:00", "2026-02-30T10:30:00Z", 1_761_300_000_000, null]) {
      expect(canonicalUtc(bad)).toBeNull();
    }
  });
});

describe("observationKey", () => {
  it("is deterministic and includes event, run, source, metric, evidence version and canonical time", () => {
    const key = observationKey(observation);
    expect(key).toBe("event-1||socrates|missKm|evidence-v3|2026-10-24T10:30:00Z");
    expect(observationKey(simulatedObservation)).toBe("event-1|run-7|simulated|pc|evidence-v3|2026-10-24T11:00:00Z");
    expect(observationKey({ ...observation, observedAt: "2026-10-24T10:30:00.000Z" })).toBe(key);
    expect(observationKey({ ...observation, observedAt: "2026-10-24T10:30:00.250Z" })).not.toBe(key);
    expect(observationKey({ ...observation, evidenceVersion: "evidence-v4" })).not.toBe(key);
    expect(observationKey({ ...observation, runId: "run-8" })).not.toBe(key);
  });

  it("cannot collide when a part contains the delimiter, because such parts are rejected", () => {
    expect(() => observationKey({ ...observation, eventId: "evt|celestrak_gp" })).toThrow('"|"');
    expect(() => observationKey({ ...observation, evidenceVersion: "pc|v1" })).toThrow('"|"');
    expect(() => observationKey({ ...observation, runId: "run|7" })).toThrow('"|"');
  });

  it("rejects an unknown source, a non-UTC time, and sub-millisecond precision", () => {
    expect(() => observationKey({ ...observation, source: "spacetrack" as TigerObservation["source"] })).toThrow("source");
    expect(() => observationKey({ ...observation, observedAt: "2026-10-24 10:30" })).toThrow("UTC");
    expect(() => observationKey({ ...observation, observedAt: "2026-10-24T10:30:00.123456Z" })).toThrow("millisecond");
  });
});

describe("validateObservation", () => {
  it("accepts a real and a simulated observation and keeps a missing value null", () => {
    expect(validateObservation(observation)).toEqual(observation);
    expect(validateObservation(simulatedObservation)).toEqual(simulatedObservation);
    expect(validateObservation(simulatedObservation).value).toBeNull();
  });

  it("returns the time in canonical form so the stored time matches the key", () => {
    const row = { ...observation, observedAt: "2026-10-24T10:30:00.000Z" };
    expect(validateObservation(row)).toEqual(observation);
    expect(validateObservation(row).observationKey.endsWith(validateObservation(row).observedAt)).toBe(true);
  });

  it("rejects a key that observationKey() would not build for the row", () => {
    expect(() => validateObservation({ ...observation, observationKey: "foo" })).toThrow("observationKey()");
    expect(() => validateObservation({ ...observation, observationKey: observationKey(simulatedObservation) })).toThrow("observationKey()");
    expect(() => validateObservation({ ...observation, observedAt: "2026-10-24T10:31:00Z" })).toThrow("observationKey()");
  });

  it.each([
    ["missing key", { observationKey: "" }, "observationKey()"],
    ["missing event", { eventId: " " }, "event ID"],
    ["non-UTC time", { observedAt: "2026-10-24T10:30:00+02:00" }, "UTC"],
    ["impossible date", { observedAt: "2026-02-30T10:30:00Z" }, "UTC"],
    ["unknown source", { source: "spacetrack" }, "source"],
    ["metric with spaces", { metric: "miss km" }, "metric"],
    ["NaN value", { value: Number.NaN }, "value"],
    ["string value", { value: "0.18" }, "value"],
    ["missing evidence version", { evidenceVersion: "" }, "evidence version"],
    ["simulated flag as string", { simulated: "yes" }, "simulated"],
    ["undefined run id", { runId: undefined }, "run ID"],
  ])("rejects %s", (_name, patch, message) => {
    expect(() => validateObservation({ ...observation, ...patch })).toThrow(message);
  });

  it("rejects simulated evidence labeled real, and a real source labeled simulated stays allowed", () => {
    expect(() => validateObservation(keyed({ ...observation, source: "simulated", simulated: false }))).toThrow("labeled simulated");
    // A simulated spacecraft screened against a real catalog object is simulated evidence from a real source.
    expect(validateObservation(keyed({ ...observation, simulated: true })).simulated).toBe(true);
  });

  it("covers exactly the source names the event validators know", () => {
    const known = sourceName.members.map(member => member.value).sort();
    expect([...TIGER_SOURCES].sort()).toEqual(known);
  });
});

describe("writeObservations", () => {
  it("writes a batch with one parameterized INSERT and skips rows that already exist", async () => {
    const db = recorder({ rows: [], rowCount: 1 });
    await expect(writeObservations(db, [observation, simulatedObservation])).resolves.toEqual({ written: 1, skipped: 1 });
    expect(db.calls).toHaveLength(1);
    const { text, values } = db.calls[0];
    expect(normalize(text)).toBe(
      `INSERT INTO ${OBSERVATION_TABLE} (observation_key, event_id, run_id, observed_at, source, metric, value, evidence_version, simulated) ` +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18) " +
      "ON CONFLICT (observation_key, observed_at) DO NOTHING",
    );
    expect(values).toEqual([
      observation.observationKey, "event-1", null, "2026-10-24T10:30:00Z", "socrates", "missKm", 0.18, "evidence-v3", false,
      simulatedObservation.observationKey, "event-1", "run-7", "2026-10-24T11:00:00Z", "simulated", "pc", null, "evidence-v3", true,
    ]);
    // No value travels inside the statement text.
    expect(text).not.toContain("event-1");
    expect(text).not.toContain("0.18");
    expect(text).not.toContain("2026-10-24");
  });

  // A table stand-in that enforces the primary key the way ON CONFLICT (observation_key, observed_at) DO NOTHING does.
  function conflictingTable() {
    const stored = new Set<string>();
    return {
      stored,
      async sql(_text: string, values: unknown[] = []): Promise<SqlResult> {
        let inserted = 0;
        for (let i = 0; i < values.length; i += 9) {
          const pair = `${String(values[i])}\u0000${String(values[i + 3])}`;
          if (!stored.has(pair)) { stored.add(pair); inserted += 1; }
        }
        return { rows: [], rowCount: inserted };
      },
    };
  }

  it("is idempotent: re-exporting rows skips the ones whose key and time already exist", async () => {
    const table = conflictingTable();
    await expect(writeObservations(table, [observation, simulatedObservation])).resolves.toEqual({ written: 2, skipped: 0 });
    await expect(writeObservations(table, [observation, simulatedObservation])).resolves.toEqual({ written: 0, skipped: 2 });
    await expect(writeObservations(table, [observation, at(5)])).resolves.toEqual({ written: 1, skipped: 1 });
    expect(table.stored.size).toBe(3);
  });

  it("keeps observations of different demo runs apart", async () => {
    const table = conflictingTable();
    const otherRun = keyed({ ...simulatedObservation, runId: "run-8" });
    await expect(writeObservations(table, [simulatedObservation])).resolves.toEqual({ written: 1, skipped: 0 });
    await expect(writeObservations(table, [otherRun])).resolves.toEqual({ written: 1, skipped: 0 });
    expect(table.stored.size).toBe(2);
  });

  it("writes the canonical time, so two spellings of one instant are one row", async () => {
    const db = recorder({ rows: [], rowCount: 1 });
    const spelled = { ...observation, observedAt: "2026-10-24T10:30:00.000Z" };
    expect((await failure(writeObservations(db, [observation, spelled]))).code).toBe("INVALID_INPUT");
    expect(db.calls).toHaveLength(0);
    await writeObservations(db, [spelled]);
    expect(db.calls[0].values?.[3]).toBe("2026-10-24T10:30:00Z");
  });

  it("writes nothing when any row is invalid or the batch repeats a key and time", async () => {
    const db = recorder({ rows: [], rowCount: 1 });
    expect((await failure(writeObservations(db, [observation, { ...simulatedObservation, value: Number.POSITIVE_INFINITY }]))).code).toBe("INVALID_INPUT");
    const repeated = await failure(writeObservations(db, [observation, { ...observation, value: 0.2 }]));
    expect(repeated.code).toBe("INVALID_INPUT");
    expect(repeated.message).toContain("repeat");
    const tooMany = await failure(writeObservations(db, Array.from({ length: MAX_WRITE_BATCH + 1 }, (_, i) => at(i))));
    expect(tooMany.code).toBe("INVALID_INPUT");
    expect(tooMany.message).toContain(String(MAX_WRITE_BATCH));
    expect(db.calls).toHaveLength(0);
  });

  it("writes nothing for an empty batch", async () => {
    const db = recorder();
    await expect(writeObservations(db, [])).resolves.toEqual({ written: 0, skipped: 0 });
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an impossible or missing write count instead of inventing a result", async () => {
    expect((await failure(writeObservations(recorder({ rows: [], rowCount: 5 }), [observation]))).code).toBe("HISTORY_INVALID_RESPONSE");
    expect((await failure(writeObservations(recorder({ rows: [], rowCount: null }), [observation]))).code).toBe("HISTORY_INVALID_RESPONSE");
  });

  it("surfaces a database failure through a connection as a sanitized error and nothing else", async () => {
    const { factory } = fakeClient([pgError("42P01", `relation "${OBSERVATION_TABLE}" does not exist at ${URL_WITH_SECRET}`)]);
    const db = await connectTiger(factory);
    const result = await failure(writeObservations(db, [observation]));
    expect(result.code).toBe("HISTORY_QUERY_REJECTED");
    expect(result.message).toContain("42P01");
    expect(result.message).not.toContain("SECRET");
    expect(result.message).not.toContain("does not exist");
  });
});

describe("readSeries", () => {
  const row = (point: TigerObservation, observed_at: Date | string = new Date(point.observedAt)) => ({
    observation_key: point.observationKey, event_id: point.eventId, run_id: point.runId, observed_at,
    source: point.source, metric: point.metric, value: point.value, evidence_version: point.evidenceVersion, simulated: point.simulated,
  });
  const SELECT = "SELECT observation_key, event_id, run_id, observed_at, source, metric, value, evidence_version, simulated";
  const RANKED = "row_number() OVER (PARTITION BY simulated ORDER BY observed_at DESC, source DESC, metric DESC, observation_key DESC) AS newest";
  const TAIL = "ORDER BY observed_at ASC, source ASC, metric ASC, observation_key ASC";

  it("queries one event with parameters only, newest points per series, oldest first, split into real and simulated", async () => {
    const db = recorder({ rows: [row(observation), row(simulatedObservation)], rowCount: 2 });
    const series = await readSeries(db, { eventId: "event-1" });
    expect(series).toEqual({ real: [observation], simulated: [simulatedObservation], truncated: { real: false, simulated: false } });
    expect(db.calls).toHaveLength(1);
    const { text, values } = db.calls[0];
    expect(normalize(text)).toBe(
      `${SELECT} FROM (${SELECT}, ${RANKED} FROM ${OBSERVATION_TABLE} WHERE event_id = $1) AS ranked WHERE newest <= $2 ${TAIL}`,
    );
    expect(values).toEqual(["event-1", 1001]);
    expect(text).not.toContain("event-1");
  });

  it("filters by metric and by demo run, and bounds the limit", async () => {
    const db = recorder({ rows: [], rowCount: 0 });
    await readSeries(db, { eventId: "event-1", metric: "pc", runId: "run-7", limit: 25 });
    expect(normalize(db.calls[0].text)).toContain("WHERE event_id = $1 AND metric = $2 AND run_id = $3) AS ranked WHERE newest <= $4");
    expect(db.calls[0].values).toEqual(["event-1", "pc", "run-7", 26]);
    await readSeries(db, { eventId: "event-1", runId: null });
    expect(normalize(db.calls[1].text)).toContain("WHERE event_id = $1 AND run_id IS NULL) AS ranked WHERE newest <= $2");
    expect(db.calls[1].values).toEqual(["event-1", 1001]);
    for (const input of [
      { eventId: "" }, { eventId: "event-1", metric: "miss km" }, { eventId: "event-1", metric: null }, { eventId: "event-1", runId: "" },
      { eventId: "event-1", limit: 0 }, { eventId: "event-1", limit: MAX_SERIES_POINTS + 1 }, { eventId: "event-1", limit: 1.5 }, null,
    ]) {
      expect((await failure(readSeries(db, input as never))).code).toBe("INVALID_INPUT");
    }
    expect(db.calls).toHaveLength(2);
  });

  it("keeps the newest points of each series separately and marks a cut series truncated", async () => {
    // Three real points and four simulated ones, limit two: the database returns at most three (limit + 1) per series.
    const real = [at(0), at(1), at(2)];
    const simulated = [at(0, true), at(1, true), at(2, true)];
    const db = recorder({ rows: [...real, ...simulated].map(point => row(point)), rowCount: 6 });
    const series = await readSeries(db, { eventId: "event-1", limit: 2 });
    expect(series.real).toEqual([real[1], real[2]]);
    expect(series.simulated).toEqual([simulated[1], simulated[2]]);
    expect(series.truncated).toEqual({ real: true, simulated: true });
    // A full simulated series does not hide a short real one.
    const sparse = recorder({ rows: [row(real[0]), ...simulated.map(point => row(point))], rowCount: 4 });
    const mixed = await readSeries(sparse, { eventId: "event-1", limit: 2 });
    expect(mixed.real).toEqual([real[0]]);
    expect(mixed.truncated).toEqual({ real: false, simulated: true });
  });

  it("keeps missing values null and converts database timestamps to the canonical UTC strings the keys use", async () => {
    const quarter = keyed({ ...observation, observedAt: "2026-10-24T10:30:00.250Z" });
    const db = recorder({ rows: [
      row({ ...observation, value: null }, new Date("2026-10-24T10:30:00.000Z")),
      row(quarter, new Date("2026-10-24T10:30:00.250Z")),
    ], rowCount: 2 });
    const series = await readSeries(db, { eventId: "event-1" });
    expect(series.real).toHaveLength(2);
    expect(series.real[0].value).toBeNull();
    expect(series.real[0].observedAt).toBe("2026-10-24T10:30:00Z");
    expect(series.real[1].observedAt).toBe("2026-10-24T10:30:00.250Z");
    expect(series.real.every(point => point.observationKey.endsWith(point.observedAt))).toBe(true);
    expect(series.simulated).toEqual([]);
  });

  it("accepts numeric text for a value but never turns an empty string into zero", async () => {
    const numeric = recorder({ rows: [{ ...row(observation), value: "0.18" }], rowCount: 1 });
    expect((await readSeries(numeric, { eventId: "event-1" })).real[0].value).toBe(0.18);
    const empty = recorder({ rows: [{ ...row(observation), value: "" }], rowCount: 1 });
    expect((await failure(readSeries(empty, { eventId: "event-1" }))).code).toBe("HISTORY_INVALID_RESPONSE");
  });

  it("rejects a malformed row instead of charting it", async () => {
    for (const malformed of [
      { ...row(observation), simulated: "false" },
      { ...row(observation), source: "spacetrack" },
      { ...row(observation), value: "not a number" },
      { ...row(observation), observation_key: "foreign-key" },
      { ...row(observation), observed_at: "2026-10-24 10:30:00+00" },
      { ...row(simulatedObservation), simulated: false },
      "not a row",
    ]) {
      const db = recorder({ rows: [malformed], rowCount: 1 });
      expect((await failure(readSeries(db, { eventId: "event-1" }))).code).toBe("HISTORY_INVALID_RESPONSE");
    }
  });
});

describe("safeTigerFailure", () => {
  it.each([
    ["28P01", "HISTORY_ACCESS_DENIED"], ["28000", "HISTORY_ACCESS_DENIED"], ["42883", "HISTORY_QUERY_REJECTED"],
    ["42601", "HISTORY_QUERY_REJECTED"], ["23505", "HISTORY_QUERY_REJECTED"], ["22P02", "HISTORY_QUERY_REJECTED"],
    ["0A000", "HISTORY_QUERY_REJECTED"], ["3D000", "HISTORY_NOT_CONFIGURED"],
    ["53300", "RATE_LIMITED"], ["57014", "UPSTREAM_UNAVAILABLE"], ["57P01", "UPSTREAM_UNAVAILABLE"], ["ECONNREFUSED", "UPSTREAM_UNAVAILABLE"],
    ["ENOTFOUND", "UPSTREAM_UNAVAILABLE"], ["ETIMEDOUT", "UPSTREAM_UNAVAILABLE"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "HISTORY_ACCESS_DENIED"], ["ERR_TLS_CERT_ALTNAME_INVALID", "HISTORY_ACCESS_DENIED"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "HISTORY_ACCESS_DENIED"],
  ])("maps code %s to %s without the provider message", (code, expected) => {
    const result = safeTigerFailure(pgError(code));
    expect(result.code).toBe(expected);
    expect(result.message).not.toContain("SECRET");
    expect(result.message).not.toContain("connection to server");
  });

  it("does not treat a look-alike code as a SQLSTATE and never echoes it", () => {
    for (const code of ["42", "42P01-extra", "23505 SECRET", "4", "ECONNRESET"]) {
      const result = safeTigerFailure(pgError(code));
      expect(result.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(result.message).not.toContain(code);
    }
  });

  it("names TimescaleDB only when the hypertable function itself is missing", () => {
    expect(safeTigerFailure(pgError("42883", "function create_hypertable(unknown, ...) does not exist")).message).toContain("TimescaleDB");
    const other = safeTigerFailure(pgError("42883", "function secret_fn(text) does not exist"));
    expect(other.message).not.toContain("TimescaleDB");
    expect(other.message).not.toContain("secret_fn");
    expect(other.code).toBe("HISTORY_QUERY_REJECTED");
  });

  it("treats unknown errors as unavailable", () => {
    expect(safeTigerFailure(new TypeError("fetch failed")).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(safeTigerFailure("string").code).toBe("UPSTREAM_UNAVAILABLE");
    expect(safeTigerFailure(undefined).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("approval boundary", () => {
  // The adapter takes SQL connections, never a Convex context, so it has no path to any table. The round 2 history
  // task asserts the approvals table itself; this checks that the adapter's code gives it no way to reach one.
  it("imports nothing from Convex and names no mutation, scheduler, or approval", () => {
    const source = readFileSync(new URL("../convex/lib/tiger.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/_generated\//);
    expect(code).not.toMatch(/from "convex\//);
    expect(code).not.toMatch(/ctx\.|runMutation|runQuery|runAction|scheduler|internalMutation|mutation\(/);
    expect(code).not.toMatch(/approv/i);
  });
});
