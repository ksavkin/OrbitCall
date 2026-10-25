"use node";

import pg from "pg";
import { AnalystError } from "./analyst";

// Tiger Data (TimescaleDB) holds an analytics copy of observation history. It is rebuildable from
// identified source records and it owns no application state: nothing here reads or writes Convex
// tables, and no result of this module is an approval, a selection, or a proposal revision. A failed
// export or read is reported as a sanitized error and changes nothing else.

export const OBSERVATION_TABLE = "observations";
export const TIGER_SOURCES = ["celestrak_gp", "celestrak_supgp", "celestrak_satcat", "socrates", "simulated"] as const;
export type TigerSource = typeof TIGER_SOURCES[number];
export const MAX_WRITE_BATCH = 500;
export const MAX_SERIES_POINTS = 5_000;
const DEFAULT_SERIES_POINTS = 1_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Enforced by the client, so a black-holed connection fails too, and no startup parameter reaches a pooler.
const QUERY_TIMEOUT_MS = 20_000;

// One observation row. The key must identify the observation and include its time, so the same
// observation exported twice lands on the same (observation_key, observed_at) and is skipped.
export interface TigerObservation {
  observationKey: string;
  eventId: string;
  runId: string | null;
  observedAt: string;
  source: TigerSource;
  metric: string;
  value: number | null;
  evidenceVersion: string;
  simulated: boolean;
}
export interface TigerSeries { real: TigerObservation[]; simulated: TigerObservation[] }
export interface TigerWriteResult { written: number; skipped: number }
export interface SqlResult { rows: unknown[]; rowCount: number | null }

// The only thing the adapter needs from a connection: parameterized SQL in, rows out.
// Tests supply a recorder; production wraps a pg client.
export interface TigerSql { sql(text: string, values?: unknown[]): Promise<SqlResult> }
export interface TigerConnection extends TigerSql { end(): Promise<void> }

const invalid = (message: string) => new AnalystError("INVALID_INPUT", message);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n\u0000-\u001f\u007f]/.test(value);
const METRIC = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const isSource = (value: unknown): value is TigerSource => typeof value === "string" && (TIGER_SOURCES as readonly string[]).includes(value);

function utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes impossible dates such as February 30; reject those too.
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

// The exact object handed to pg.Client. The URL is parsed here and never passed through, because pg applies a
// connection string's own options (sslmode, host, statement_timeout, ...) on top of explicit settings.
export interface TigerClientConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: { rejectUnauthorized: true } | false;
  connectionTimeoutMillis: number;
  query_timeout: number;
}

const notConfigured = (message: string) => new AnalystError("HISTORY_NOT_CONFIGURED", message);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function tigerClientConfig(connectionString: string | undefined = process.env.TIGER_DATABASE_URL): TigerClientConfig {
  if (!connectionString) throw notConfigured("Set TIGER_DATABASE_URL in this Convex deployment.");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw notConfigured("TIGER_DATABASE_URL must be a postgres:// connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw notConfigured("TIGER_DATABASE_URL must be a postgres:// connection URL.");
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw notConfigured("TIGER_DATABASE_URL has an invalid port.");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.username || !database) throw notConfigured("TIGER_DATABASE_URL needs a user and a database name.");
  // Only sslmode may appear, and only with a value that keeps certificate verification on. A loopback database
  // may say sslmode=disable. Anything else (host=, options=, statement_timeout=, no-verify, prefer) is rejected
  // rather than silently weakening the connection.
  const params = [...url.searchParams.keys()];
  if (params.some(key => key !== "sslmode")) throw notConfigured("TIGER_DATABASE_URL may carry only the sslmode option.");
  const sslmode = url.searchParams.get("sslmode") ?? "verify-full";
  const loopback = LOOPBACK.includes(url.hostname);
  let ssl: TigerClientConfig["ssl"];
  if (["require", "verify-ca", "verify-full"].includes(sslmode)) ssl = { rejectUnauthorized: true };
  else if (sslmode === "disable" && loopback) ssl = false;
  else throw notConfigured("TIGER_DATABASE_URL must use TLS: sslmode=require or verify-full (disable is allowed on localhost only).");
  return {
    host: url.hostname, port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
    ssl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS,
  };
}

// What the adapter uses of a pg client. Tests substitute a fake; production passes pg.Client.
export interface TigerClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: "error", listener: (error: unknown) => void): unknown;
  query: (text: string, values?: unknown[]) => Promise<SqlResult>;
}
export type TigerClientFactory = (config: TigerClientConfig) => TigerClient;
const pgClient: TigerClientFactory = config => new pg.Client(config) as unknown as TigerClient;

export async function connectTiger(createClient: TigerClientFactory = pgClient): Promise<TigerConnection> {
  const client = createClient(tigerClientConfig());
  // A dropped connection makes pg emit "error" besides rejecting the pending statement. Without a listener that
  // event is an uncaught exception outside every try/catch, carrying the raw driver message. The rejection is
  // the signal callers get; the next statement on a broken client fails too.
  client.on("error", () => undefined);
  await client.connect();
  const run = client.query.bind(client);
  return {
    // Every statement failure is sanitized here, so a caller catching inside `work` never sees a driver message.
    sql: (text, values) => run(text, values).catch((error: unknown) => { throw toTigerError(error); }),
    end: () => client.end(),
  };
}

// One connection per action call, always closed. Convex actions are short-lived, so a pool gains nothing.
export async function withTiger<T>(work: (db: TigerSql) => Promise<T>, connect: () => Promise<TigerConnection> = connectTiger): Promise<T> {
  let db: TigerConnection;
  try {
    db = await connect();
  } catch (error) {
    throw toTigerError(error);
  }
  try {
    return await work(db);
  } catch (error) {
    throw toTigerError(error);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// Idempotent on every call. The primary key includes the partition column, as a hypertable requires.
export async function ensureObservationTable(db: TigerSql): Promise<void> {
  await db.sql(`CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE} (
    observation_key text NOT NULL,
    event_id text NOT NULL,
    run_id text,
    observed_at timestamptz NOT NULL,
    source text NOT NULL,
    metric text NOT NULL,
    value double precision,
    evidence_version text NOT NULL,
    simulated boolean NOT NULL,
    exported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (observation_key, observed_at)
  )`);
  await db.sql(`SELECT create_hypertable('${OBSERVATION_TABLE}', by_range('observed_at'), if_not_exists => TRUE)`);
  await db.sql(`CREATE INDEX IF NOT EXISTS ${OBSERVATION_TABLE}_event_idx ON ${OBSERVATION_TABLE} (event_id, observed_at)`);
}

// A deterministic key for one observation. It includes the observation time, so it can be the dedupe key
// in Convex and the conflict target in Tiger at the same time.
export function observationKey(input: Pick<TigerObservation, "eventId" | "source" | "metric" | "evidenceVersion" | "observedAt">): string {
  const key = [input.eventId, input.source, input.metric, input.evidenceVersion, input.observedAt].join("|");
  validateObservation({ ...input, observationKey: key, runId: null, value: null, simulated: input.source === "simulated" });
  return key;
}

export function validateObservation(row: unknown): TigerObservation {
  if (!isRecord(row)) throw invalid("An observation must be an object.");
  const { observationKey, eventId, runId, observedAt, source, metric, value, evidenceVersion, simulated } = row;
  if (!singleLine(observationKey, 512)) throw invalid("An observation needs a single-line observation key.");
  if (!singleLine(eventId, 128)) throw invalid("An observation needs its event ID.");
  if (runId !== null && !singleLine(runId, 128)) throw invalid("A demo run ID must be null or a single-line value.");
  if (!utc(observedAt)) throw invalid("Observation times must be UTC ISO strings.");
  if (!isSource(source)) throw invalid("An observation needs a known source name.");
  if (typeof metric !== "string" || !METRIC.test(metric)) throw invalid("An observation metric must be a short identifier.");
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw invalid("An observation value must be null or a finite number.");
  if (!singleLine(evidenceVersion, 128)) throw invalid("An observation needs its evidence version.");
  if (typeof simulated !== "boolean") throw invalid("An observation must say whether it is simulated.");
  if (source === "simulated" && !simulated) throw invalid("Simulated evidence must be labeled simulated.");
  return { observationKey, eventId, runId, observedAt, source, metric, value, evidenceVersion, simulated };
}

const COLUMNS = ["observation_key", "event_id", "run_id", "observed_at", "source", "metric", "value", "evidence_version", "simulated"] as const;
const rowValues = (row: TigerObservation): unknown[] =>
  [row.observationKey, row.eventId, row.runId, row.observedAt, row.source, row.metric, row.value, row.evidenceVersion, row.simulated];

// One parameterized INSERT per batch. A batch with any invalid row writes nothing. A row whose key and
// time already exist is skipped, so repeating an export is safe.
export async function writeObservations(db: TigerSql, rows: readonly unknown[]): Promise<TigerWriteResult> {
  if (!Array.isArray(rows)) throw invalid("Observations must be a list.");
  if (rows.length > MAX_WRITE_BATCH) throw invalid(`Write at most ${MAX_WRITE_BATCH} observations per batch.`);
  const checked = rows.map(validateObservation);
  const keys = new Set(checked.map(row => `${row.observationKey}\u0000${row.observedAt}`));
  if (keys.size !== checked.length) throw invalid("A batch must not repeat an observation key and time.");
  if (checked.length === 0) return { written: 0, skipped: 0 };
  const width = COLUMNS.length;
  const tuples = checked.map((_, i) => `(${COLUMNS.map((_, j) => `$${i * width + j + 1}`).join(", ")})`);
  const text = `INSERT INTO ${OBSERVATION_TABLE} (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ` +
    "ON CONFLICT (observation_key, observed_at) DO NOTHING";
  const result = await db.sql(text, checked.flatMap(rowValues));
  const written = result.rowCount ?? 0;
  if (!Number.isInteger(written) || written < 0 || written > checked.length) {
    throw new AnalystError("HISTORY_INVALID_RESPONSE", "The history database returned an unexpected write result.");
  }
  return { written, skipped: checked.length - written };
}

function toObservation(row: unknown): TigerObservation {
  if (!isRecord(row)) throw new AnalystError("HISTORY_INVALID_RESPONSE", "The history database returned an unexpected row.");
  // Domain timestamps are UTC ISO strings; a whole-second time comes back without a fractional part.
  const observedAt = row.observed_at instanceof Date ? row.observed_at.toISOString().replace(/\.000Z$/, "Z") : row.observed_at;
  const value = row.value === null || row.value === undefined ? null : typeof row.value === "string" ? Number(row.value) : row.value;
  try {
    return validateObservation({
      observationKey: row.observation_key, eventId: row.event_id, runId: row.run_id ?? null, observedAt,
      source: row.source, metric: row.metric, value, evidenceVersion: row.evidence_version, simulated: row.simulated,
    });
  } catch {
    throw new AnalystError("HISTORY_INVALID_RESPONSE", "The history database returned an unexpected row.");
  }
}

// Observations for one event, oldest first. Real and simulated points come back as separate series and a
// missing value stays null. This is history only: no forecast, no interpolation.
export async function readSeries(
  db: TigerSql, input: { eventId: string; metric?: string; limit?: number },
): Promise<TigerSeries> {
  if (!singleLine(input.eventId, 128)) throw invalid("A series needs its event ID.");
  if (input.metric !== undefined && !METRIC.test(input.metric)) throw invalid("A series metric must be a short identifier.");
  const limit = input.limit ?? DEFAULT_SERIES_POINTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SERIES_POINTS) throw invalid(`A series limit must be an integer from 1 to ${MAX_SERIES_POINTS}.`);
  const values: unknown[] = [input.eventId];
  let where = "WHERE event_id = $1";
  if (input.metric !== undefined) {
    values.push(input.metric);
    where += ` AND metric = $${values.length}`;
  }
  values.push(limit);
  const text = `SELECT ${COLUMNS.join(", ")} FROM ${OBSERVATION_TABLE} ${where} ` +
    `ORDER BY observed_at ASC, source ASC, metric ASC LIMIT $${values.length}`;
  const result = await db.sql(text, values);
  if (!Array.isArray(result.rows)) throw new AnalystError("HISTORY_INVALID_RESPONSE", "The history database returned an unexpected result.");
  const points = result.rows.map(toObservation);
  return { real: points.filter(point => !point.simulated), simulated: points.filter(point => point.simulated) };
}

// pg errors carry a SQLSTATE in `code`; connection errors carry a Node errno code. Their messages can name
// hosts, users and statements, so only our own text is ever kept.
const TLS_CODES = /^(ERR_TLS_|CERT_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER)/;
function toTigerError(error: unknown): AnalystError {
  if (error instanceof AnalystError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  if (code === "28P01" || code === "28000") return new AnalystError("HISTORY_ACCESS_DENIED", "The configured account cannot access the history database.");
  if (TLS_CODES.test(code)) return new AnalystError("HISTORY_ACCESS_DENIED", "The history database's TLS certificate could not be verified.");
  if (code === "3D000") return new AnalystError("HISTORY_NOT_CONFIGURED", "The configured history database does not exist.");
  // The driver text is only matched here, never kept.
  if (code === "42883" && /create_hypertable/.test(message)) return new AnalystError("HISTORY_QUERY_REJECTED", "The history database does not provide TimescaleDB.");
  if (/^(42|22|23|0A)[0-9A-Z]{3}$/.test(code)) return new AnalystError("HISTORY_QUERY_REJECTED", `The history database rejected the statement (SQLSTATE ${code}).`);
  if (code === "53300") return new AnalystError("RATE_LIMITED", "The history database has no free connections. Retry later.");
  return new AnalystError("UPSTREAM_UNAVAILABLE", "The history database could not complete this request. Retry later.");
}

export function safeTigerFailure(error: unknown): { code: string; message: string } {
  const { code, message } = toTigerError(error);
  // Never persist raw provider errors, statements, connection strings, or credentials.
  return { code, message };
}
