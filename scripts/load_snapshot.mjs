#!/usr/bin/env node
// Loads data/snapshots/<id>/catalog-pairs.json into a Convex deployment through internal functions:
//   npm run load -- data/snapshots/<id>/catalog-pairs.json [--prod]
// Extra arguments go to every `npx convex run`. A reload keeps every event _id and starts no analyst;
// pairs the file no longer lists are retired (active=false), and the final recolor step sets colors
// and starts the analyst for the top red events.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BATCH = 100;
const RETIRE_BATCH = 200;
const [file, ...extra] = process.argv.slice(2);
if (!file || file.startsWith("--")) {
  console.error("usage: node scripts/load_snapshot.mjs <catalog-pairs.json> [convex run flags, e.g. --prod]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, "utf8"));
if (typeof data.snapshotId !== "string" || !Array.isArray(data.sources) || !Array.isArray(data.pairs)) {
  console.error(`${file}: expected { snapshotId, sources[], pairs[] }`);
  process.exit(2);
}

// convex run prints the result as JSON, possibly after log lines.
function run(fn, args) {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args), ...extra], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = out.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* skip log line */ }
  }
  if (lines.length === 1 && /^[\w-]+$/.test(lines[0])) return lines[0]; // a bare id
  throw new Error(`${fn}: unreadable result: ${out}`);
}

// Only the fields the Convex validators accept; extra fields in the file are ignored.
const source = s => ({ name: s.name, url: s.url ?? null, epochUtc: s.epochUtc ?? null, fetchedAt: s.fetchedAt ?? null });
const object = o => ({ objectId: String(o.objectId), name: o.name, country: o.country ?? null, launchDate: o.launchDate ?? null });
const pair = p => ({
  objectA: object(p.objectA), objectB: object(p.objectB), tcaUtc: p.tcaUtc,
  missKm: p.missKm, relSpeedKmS: p.relSpeedKmS, pcValue: p.pcValue ?? null,
});

// The OMM catalog the globe draws (build_catalog_pairs.py --gp); without it real mode waits for OMM.
const omm = typeof data.omm?.url === "string" ? { ommUrl: data.omm.url } : {};
const snapshot = run("ingest:register", { snapshotId: data.snapshotId, sources: data.sources.map(source), ...omm });
console.log(`snapshot ${data.snapshotId} -> ${snapshot}; ${data.pairs.length} pairs`);

const total = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
const errors = [];
for (let i = 0; i < data.pairs.length; i += BATCH) {
  const result = run("ingest:upsertBatch", { snapshot, pairs: data.pairs.slice(i, i + BATCH).map(pair) });
  for (const key of Object.keys(total)) total[key] += result[key];
  errors.push(...result.errors);
  console.log(`  ${Math.min(i + BATCH, data.pairs.length)}/${data.pairs.length}`);
}
console.log("loaded", JSON.stringify(total));
for (const message of errors) console.error(`skipped: ${message}`);

// Pairs of this snapshot that the file no longer lists leave the queue (their _id and history stay).
const keys = data.pairs.map(p => ({ objectA: String(p.objectA.objectId), objectB: String(p.objectB.objectId), tcaUtc: p.tcaUtc }));
let retired = 0, checked = 0;
for (;;) {
  const result = run("ingest:retireMissing", { snapshot, pairs: keys, limit: RETIRE_BATCH });
  retired += result.retired;
  checked = result.checked;
  if (result.retired < RETIRE_BATCH) break;
}
console.log(`retired ${retired} of ${checked} active pairs no longer in the file`);

console.log("recolor", JSON.stringify(run("riskMonitor:recolor", {})));
if (total.skipped > 0) {
  console.error(`${total.skipped} pairs were skipped as invalid (first ${errors.length} shown)`);
  process.exit(1);
}
