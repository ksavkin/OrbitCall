// @vitest-environment node
// `pg` needs Node sockets and TLS, and the adapter runs in a `"use node"` Convex action, so this file runs in Node.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SERIES_POINTS, MAX_WRITE_BATCH, OBSERVATION_TABLE, TIGER_SOURCES, ensureObservationTable, observationKey, readSeries,
  safeTigerFailure, tigerConfig, validateObservation, withTiger, writeObservations,
  type SqlResult, type TigerConnection, type TigerObservation,
} from "../convex/lib/tiger";

const URL_WITH_SECRET = "postgres://tsdbadmin:SECRET-password@abc123.x.tsdb.cloud.timescale.com:34567/tsdb?sslmode=require";
const observation: TigerObservation = {
  observationKey: "event-1|socrates|missKm|evidence-v3|2026-10-24T10:30:00Z", eventId: "event-1", runId: null,
  observedAt: "2026-10-24T10:30:00Z", source: "socrates", metric: "missKm", value: 0.18, evidenceVersion: "evidence-v3", simulated: false,
};
const simulatedObservation: TigerObservation = {
  ...observation, observationKey: "event-1|simulated|pc|evidence-v3|2026-10-24T11:00:00Z", runId: "run-7",
  observedAt: "2026-10-24T11:00:00Z", source: "simulated", metric: "pc", value: null, simulated: true,
};

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

beforeEach(() => { vi.stubEnv("TIGER_DATABASE_URL", URL_WITH_SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Tiger configuration", () => {
  it("reads TIGER_DATABASE_URL and keeps TLS on for a cloud database", () => {
    expect(tigerConfig()).toEqual({ connectionString: URL_WITH_SECRET, ssl: true });
  });

  it("fails as not configured without a postgres URL and opens no connection", async () => {
    for (const value of ["", "not a url", "https://example.com/db", "postgres:///nohost"]) {
      vi.stubEnv("TIGER_DATABASE_URL", value);
      const error = (() => { try { tigerConfig(); return null; } catch (error) { return error; } })();
      expect(safeTigerFailure(error).code).toBe("HISTORY_NOT_CONFIGURED");
      expect(safeTigerFailure(error).message).not.toContain("example.com");
    }
  });

  it("keeps TLS on unless a loopback database asks for sslmode=disable", () => {
    vi.stubEnv("TIGER_DATABASE_URL", "postgres://dev:dev@localhost:5432/orbitcall?sslmode=disable");
    expect(tigerConfig().ssl).toBe(false);
    vi.stubEnv("TIGER_DATABASE_URL", "postgres://dev:dev@db.internal:5432/orbitcall?sslmode=disable");
    expect(tigerConfig().ssl).toBe(true);
    vi.stubEnv("TIGER_DATABASE_URL", "postgres://dev:dev@localhost:5432/orbitcall");
    expect(tigerConfig().ssl).toBe(true);
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

  it("closes the connection when the work fails and hides the database error", async () => {
    const { connect, end } = connection(recorder(pgError("57014")));
    const error = await withTiger(tiger => tiger.sql("SELECT pg_sleep(100)"), connect).catch(error => error);
    expect(end).toHaveBeenCalledTimes(1);
    expect(safeTigerFailure(error)).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("Retry later") });
    expect(String(error.message)).not.toContain("SECRET");
    expect(String(error.message)).not.toContain("timescale");
  });

  it("reports a refused or unauthenticated connection without the URL", async () => {
    for (const [code, expected] of [["ECONNREFUSED", "UPSTREAM_UNAVAILABLE"], ["28P01", "HISTORY_ACCESS_DENIED"], ["53300", "RATE_LIMITED"]]) {
      const connect = vi.fn().mockRejectedValue(pgError(code));
      const error = await withTiger(async () => "unreachable", connect).catch(error => error);
      expect(safeTigerFailure(error).code).toBe(expected);
      expect(safeTigerFailure(error).message).not.toContain("SECRET");
      expect(safeTigerFailure(error).message).not.toContain("tsdb");
    }
  });
});

describe("ensureObservationTable", () => {
  it("creates the table with a key that includes the time partition, then the hypertable, idempotently", async () => {
    const db = recorder();
    await ensureObservationTable(db);
    const statements = db.calls.map(call => normalize(call.text));
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(`CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE} (`);
    expect(statements[0]).toContain("PRIMARY KEY (observation_key, observed_at)");
    expect(statements[0]).toContain("observed_at timestamptz NOT NULL");
    expect(statements[0]).toContain("value double precision,");
    expect(statements[0]).toContain("simulated boolean NOT NULL");
    expect(statements[1]).toBe(`SELECT create_hypertable('${OBSERVATION_TABLE}', by_range('observed_at'), if_not_exists => TRUE)`);
    expect(statements[2]).toContain("CREATE INDEX IF NOT EXISTS");
    expect(db.calls.every(call => call.values === undefined)).toBe(true);
  });
});

describe("observationKey", () => {
  it("is deterministic and includes the observation time and evidence version", () => {
    const key = observationKey(observation);
    expect(key).toBe(observationKey({ ...observation }));
    expect(key).toContain("2026-10-24T10:30:00Z");
    expect(key).toContain("evidence-v3");
    expect(observationKey({ ...observation, observedAt: "2026-10-24T10:31:00Z" })).not.toBe(key);
    expect(observationKey({ ...observation, evidenceVersion: "evidence-v4" })).not.toBe(key);
  });

  it("rejects an unknown source or a non-UTC time", () => {
    expect(() => observationKey({ ...observation, source: "spacetrack" as TigerObservation["source"] })).toThrow("source");
    expect(() => observationKey({ ...observation, observedAt: "2026-10-24 10:30" })).toThrow("UTC");
  });
});

describe("validateObservation", () => {
  it("accepts a real and a simulated observation and keeps a missing value null", () => {
    expect(validateObservation(observation)).toEqual(observation);
    expect(validateObservation(simulatedObservation)).toEqual(simulatedObservation);
    expect(validateObservation(simulatedObservation).value).toBeNull();
  });

  it.each([
    ["missing key", { observationKey: "" }, "observation key"],
    ["key with a newline", { observationKey: "a\nb" }, "observation key"],
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
    ["simulated source labeled real", { source: "simulated", simulated: false }, "labeled simulated"],
  ])("rejects %s", (_name, patch, message) => {
    expect(() => validateObservation({ ...observation, ...patch })).toThrow(message);
  });

  it("covers every source name the event validators know", () => {
    expect([...TIGER_SOURCES].sort()).toEqual(["celestrak_gp", "celestrak_satcat", "celestrak_supgp", "simulated", "socrates"]);
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

  it("is idempotent: the same rows written again report everything skipped", async () => {
    const db = recorder({ rows: [], rowCount: 2 }, { rows: [], rowCount: 0 });
    await expect(writeObservations(db, [observation, simulatedObservation])).resolves.toEqual({ written: 2, skipped: 0 });
    await expect(writeObservations(db, [observation, simulatedObservation])).resolves.toEqual({ written: 0, skipped: 2 });
    expect(db.calls[0].text).toBe(db.calls[1].text);
    expect(db.calls[0].values).toEqual(db.calls[1].values);
  });

  it("writes nothing when any row is invalid or the batch repeats a key and time", async () => {
    const db = recorder({ rows: [], rowCount: 1 });
    const bad = await writeObservations(db, [observation, { ...simulatedObservation, value: Number.POSITIVE_INFINITY }]).catch(error => error);
    expect(safeTigerFailure(bad).code).toBe("INVALID_INPUT");
    const repeated = await writeObservations(db, [observation, { ...observation, value: 0.2 }]).catch(error => error);
    expect(safeTigerFailure(repeated).code).toBe("INVALID_INPUT");
    expect(repeated.message).toContain("repeat");
    const tooMany = await writeObservations(db, Array.from({ length: MAX_WRITE_BATCH + 1 }, (_, i) =>
      ({ ...observation, observationKey: `key-${i}` }))).catch(error => error);
    expect(safeTigerFailure(tooMany).code).toBe("INVALID_INPUT");
    expect(db.calls).toHaveLength(0);
  });

  it("writes nothing for an empty batch", async () => {
    const db = recorder();
    await expect(writeObservations(db, [])).resolves.toEqual({ written: 0, skipped: 0 });
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an impossible write count instead of inventing a result", async () => {
    const db = recorder({ rows: [], rowCount: 5 });
    const error = await writeObservations(db, [observation]).catch(error => error);
    expect(safeTigerFailure(error).code).toBe("HISTORY_INVALID_RESPONSE");
  });

  it("surfaces a database failure as a sanitized error and nothing else", async () => {
    const db = recorder(pgError("42P01", `relation "${OBSERVATION_TABLE}" does not exist at ${URL_WITH_SECRET}`));
    const error = await writeObservations(db, [observation]).catch(error => error);
    const failure = safeTigerFailure(error);
    expect(failure.code).toBe("HISTORY_QUERY_REJECTED");
    expect(failure.message).toContain("42P01");
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("does not exist");
  });
});

describe("readSeries", () => {
  const row = (point: TigerObservation, observed_at: Date | string = new Date(point.observedAt)) => ({
    observation_key: point.observationKey, event_id: point.eventId, run_id: point.runId, observed_at,
    source: point.source, metric: point.metric, value: point.value, evidence_version: point.evidenceVersion, simulated: point.simulated,
  });

  it("queries one event with parameters only, oldest first, and splits real from simulated points", async () => {
    const db = recorder({ rows: [row(observation), row(simulatedObservation)], rowCount: 2 });
    const series = await readSeries(db, { eventId: "event-1" });
    expect(series).toEqual({ real: [observation], simulated: [simulatedObservation] });
    expect(db.calls).toHaveLength(1);
    const { text, values } = db.calls[0];
    expect(normalize(text)).toBe(
      `SELECT observation_key, event_id, run_id, observed_at, source, metric, value, evidence_version, simulated FROM ${OBSERVATION_TABLE} ` +
      "WHERE event_id = $1 ORDER BY observed_at ASC, source ASC, metric ASC LIMIT $2",
    );
    expect(values).toEqual(["event-1", 1000]);
    expect(text).not.toContain("event-1");
  });

  it("filters by metric and bounds the limit", async () => {
    const db = recorder({ rows: [], rowCount: 0 });
    await expect(readSeries(db, { eventId: "event-1", metric: "pc", limit: 25 })).resolves.toEqual({ real: [], simulated: [] });
    expect(normalize(db.calls[0].text)).toContain("WHERE event_id = $1 AND metric = $2 ORDER BY observed_at ASC, source ASC, metric ASC LIMIT $3");
    expect(db.calls[0].values).toEqual(["event-1", "pc", 25]);
    for (const input of [{ eventId: "" }, { eventId: "event-1", metric: "miss km" }, { eventId: "event-1", limit: 0 }, { eventId: "event-1", limit: MAX_SERIES_POINTS + 1 }, { eventId: "event-1", limit: 1.5 }]) {
      const error = await readSeries(db, input).catch(error => error);
      expect(safeTigerFailure(error).code).toBe("INVALID_INPUT");
    }
    expect(db.calls).toHaveLength(1);
  });

  it("keeps missing values null and converts database timestamps to UTC strings", async () => {
    const db = recorder({ rows: [
      row({ ...observation, value: null }, new Date("2026-10-24T10:30:00.000Z")),
      row({ ...observation, observationKey: "k2", observedAt: "2026-10-24T10:30:00.250Z" }, new Date("2026-10-24T10:30:00.250Z")),
    ], rowCount: 2 });
    const series = await readSeries(db, { eventId: "event-1" });
    expect(series.real).toHaveLength(2);
    expect(series.real[0].value).toBeNull();
    expect(series.real[0].observedAt).toBe("2026-10-24T10:30:00Z");
    expect(series.real[1].observedAt).toBe("2026-10-24T10:30:00.250Z");
    expect(series.simulated).toEqual([]);
  });

  it("rejects a malformed row instead of charting it", async () => {
    for (const malformed of [
      { ...row(observation), simulated: "false" },
      { ...row(observation), source: "spacetrack" },
      { ...row(observation), value: "not a number" },
      { ...row(simulatedObservation), simulated: false },
      "not a row",
    ]) {
      const db = recorder({ rows: [malformed], rowCount: 1 });
      const error = await readSeries(db, { eventId: "event-1" }).catch(error => error);
      expect(safeTigerFailure(error).code).toBe("HISTORY_INVALID_RESPONSE");
    }
  });
});

describe("safeTigerFailure", () => {
  it.each([
    ["28P01", "HISTORY_ACCESS_DENIED"], ["28000", "HISTORY_ACCESS_DENIED"], ["42883", "HISTORY_QUERY_REJECTED"],
    ["42601", "HISTORY_QUERY_REJECTED"], ["23505", "HISTORY_QUERY_REJECTED"], ["22P02", "HISTORY_QUERY_REJECTED"],
    ["53300", "RATE_LIMITED"], ["57P01", "UPSTREAM_UNAVAILABLE"], ["ECONNREFUSED", "UPSTREAM_UNAVAILABLE"],
    ["ENOTFOUND", "UPSTREAM_UNAVAILABLE"], ["ETIMEDOUT", "UPSTREAM_UNAVAILABLE"],
  ])("maps code %s to %s without the provider message", (code, expected) => {
    const failure = safeTigerFailure(pgError(code));
    expect(failure.code).toBe(expected);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("connection to server");
  });

  it("names TimescaleDB when the hypertable function is missing", () => {
    expect(safeTigerFailure(pgError("42883")).message).toContain("TimescaleDB");
  });

  it("treats unknown errors as unavailable", () => {
    expect(safeTigerFailure(new TypeError("fetch failed")).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(safeTigerFailure("string").code).toBe("UPSTREAM_UNAVAILABLE");
    expect(safeTigerFailure(undefined).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("approval boundary", () => {
  it("has no path to Convex tables: the adapter takes SQL connections, never a Convex context", () => {
    // Comments may explain the boundary; the code must not cross it.
    const code = readFileSync(new URL("../convex/lib/tiger.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/_generated\//);
    expect(code).not.toMatch(/ctx\.db|runMutation|runQuery|internalMutation|mutation\(/);
    expect(code).not.toMatch(/approv/i);
  });

  it("a failed export produces a sanitized failure and no result that could be read as an approval", async () => {
    const db = recorder(pgError("ECONNRESET"));
    const outcome = await writeObservations(db, [observation]).then(result => ({ result }), error => ({ failure: safeTigerFailure(error) }));
    expect(outcome).toEqual({ failure: { code: "UPSTREAM_UNAVAILABLE", message: expect.any(String) } });
    expect(Object.keys(outcome)).toEqual(["failure"]);
  });
});
