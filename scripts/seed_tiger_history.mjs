#!/usr/bin/env node
// Load sourced or explicitly simulated chart observations through Convex's immutable observation ledger.
// node scripts/seed_tiger_history.mjs observations.json --dry-run
// node scripts/seed_tiger_history.mjs observations.json --apply --prod [--env-file path]
// node scripts/seed_tiger_history.mjs --example > observations.json
// Retry the same file after a failure: recordObservation deduplicates immutable observation keys. No automatic retry.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sources = new Set(["celestrak_gp", "celestrak_supgp", "socrates", "cdm_public", "gp_history", "keeptrack", "celestrak_satcat", "simulated"]);
const fail = message => { throw new Error(message); };
const part = (v, max = 128) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[|\u0000-\u001f\u007f]/.test(v);
const help = "usage: node scripts/seed_tiger_history.mjs <observations.json> [--dry-run | --apply (--prod | --deployment-name NAME)] [--env-file PATH]\n--example prints a labeled synthetic input template. Queued observations export to Tiger asynchronously.";

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--example") return { example: true };
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const file = args.shift();
  if (!file || file.startsWith("--")) fail(help);
  let apply = false, dry = false, target = false;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dry = true;
    else if (arg === "--prod") { if (target) fail("Choose exactly one deployment."); target = true; flags.push(arg); }
    else if (arg === "--deployment-name" || arg === "--env-file") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value.`);
      if (arg === "--deployment-name") { if (target) fail("Choose exactly one deployment."); target = true; }
      flags.push(arg, value);
    } else fail(`Unknown option: ${arg}`);
  }
  if (apply && dry) fail("Choose --apply or --dry-run.");
  if (apply && !target) fail("--apply requires --prod or --deployment-name NAME.");
  return { file, apply, flags };
}

function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.observations) || !data.observations.length || data.observations.length > 1000) fail("Expected {version:1, observations:[1..1000 rows]}.");
  const keys = new Map();
  const observations = data.observations.map((r, i) => {
    const bad = message => fail(`Observation ${i + 1}: ${message}`);
    if (!r || !part(r.eventId) || !part(r.evidenceVersion)) bad("eventId and evidenceVersion are required.");
    if (typeof r.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(r.observedAt) || !Number.isFinite(Date.parse(r.observedAt)) || new Date(r.observedAt).toISOString().slice(0, 19) !== r.observedAt.slice(0, 19)) bad("observedAt must be a valid UTC ISO timestamp.");
    if (!sources.has(r.source) || !["pc", "missKm"].includes(r.metric)) bad("Use a known source and metric pc or missKm.");
    if (r.value !== null && (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0 || (r.metric === "pc" && r.value > 1))) bad("value must be null or a valid nonnegative measurement (pc <= 1).");
    if (typeof r.simulated !== "boolean" || (r.source === "simulated" && !r.simulated)) bad("Simulated observations must be labeled simulated.");
    if (r.runId !== null && !part(r.runId)) bad("runId must be the demo run ID or explicit null.");
    if (!r.simulated && r.runId !== null) bad("Real observations cannot belong to a demo run.");
    if (!part(r.sourceRef, 1000)) bad("sourceRef must identify the source file/URL or explicitly describe the synthetic scenario.");
    if (r.simulated && r.source !== "simulated") bad("Seeded synthetic values must use source simulated.");
    const observedAt = new Date(r.observedAt).toISOString().replace(/\.000Z$/, "Z");
    const observation = { observedAt, source: r.source, metric: r.metric, value: r.value, evidenceVersion: r.evidenceVersion, simulated: r.simulated, runId: r.runId };
    const key = [r.eventId, r.runId ?? "", r.source, r.metric, r.evidenceVersion, observedAt].join("|");
    const value = JSON.stringify(observation);
    if (keys.has(key) && keys.get(key) !== value) bad("Conflicting values share one immutable observation key.");
    keys.set(key, value);
    return { eventId: r.eventId, observation, sourceRef: r.sourceRef };
  });
  return observations;
}

function run(fn, args, flags) {
  let out;
  try { out = execFileSync("npx", ["--no-install", "convex", "run", fn, JSON.stringify(args), ...flags], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { fail(`${fn} failed. Stopping without retry; previously queued records remain safe to replay with the same file.`); }
  const lines = out.trim().split("\n");
  for (let i = 0; i < lines.length; i++) { try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* skip CLI log lines */ } }
  fail(`${fn} returned unreadable data; stopping without retry.`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(help);
  else if (args.example) console.log(JSON.stringify({ version: 1, observations: [{ eventId: "REPLACE_WITH_EVENT_ID", observedAt: "2026-10-25T00:00:00Z", source: "simulated", metric: "missKm", value: 0.5, evidenceVersion: "synthetic-demo-v1", simulated: true, runId: null, sourceRef: "Synthetic demonstration of history rendering; not an observed orbit." }] }, null, 2));
  else {
    const raw = readFileSync(args.file, "utf8"), rows = validate(JSON.parse(raw));
    const manifest = { inputSha256: createHash("sha256").update(raw).digest("hex"), observations: rows.length, simulated: rows.filter(r => r.observation.simulated).length, sources: [...new Set(rows.map(r => r.sourceRef))] };
    if (!args.apply) console.log(JSON.stringify({ mode: "dry-run", ...manifest, message: "Validated locally; no requests sent." }, null, 2));
    else {
      // Complete deployment preflight for every incident before writing any observations. Each mutation rechecks
      // again, so a concurrent reset also fails closed rather than writing a closed run into the current chart.
      const scopes = new Map();
      for (const eventId of new Set(rows.map(r => r.eventId))) {
        const scope = run("history:seriesScope", { eventId }, args.flags);
        if (!scope || !Object.hasOwn(scope, "demoRunId")) fail("An incident is missing or belongs to a closed demonstration.");
        scopes.set(eventId, scope.demoRunId);
      }
      for (const row of rows) if (row.observation.simulated && row.observation.runId !== scopes.get(row.eventId)) fail("A simulated row does not match its incident's current demo run.");
      const counts = { queued: 0, unchanged: 0, retried: 0 };
      for (const { eventId, observation } of rows) {
        const result = run("history:recordObservation", { eventId, observation }, args.flags);
        if (!result || !Object.hasOwn(counts, result.status) || typeof result.observationKey !== "string") fail("Unexpected observation result; stopping without retry.");
        counts[result.status]++;
      }
      console.log(JSON.stringify({ mode: "applied", ...manifest, ...counts, message: "Recorded in Convex. Tiger export and chart refresh are asynchronous; this is not proof that the SQL export completed." }, null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? "Input is not valid JSON." : error instanceof Error ? error.message : "History seeding failed.");
  process.exitCode = 1;
}
