// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

let dir: string;
const row = () => ({ eventId: "event-a", observedAt: "2026-10-25T00:00:00Z", source: "simulated", metric: "missKm", value: 0.5, evidenceVersion: "sim-v1", simulated: true, runId: null, sourceRef: "Synthetic test observation" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-history-seed-"));
  writeFileSync(join(dir, "npx"), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2); fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args)+'\\n');
if (process.env.TEST_FAIL === args[3]) { console.error('private upstream details'); process.exit(1); }
console.log(JSON.stringify(args[3] === 'history:seriesScope' ? {demoRunId: process.env.TEST_RUN || null} : {status:'queued', observationKey:'key'}));
`, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(rows: unknown[], flags: string[] = [], env: Record<string, string> = {}) {
  const file = join(dir, "observations.json"); writeFileSync(file, JSON.stringify({ version: 1, observations: rows }));
  return spawnSync(process.execPath, [resolve("scripts/seed_tiger_history.mjs"), file, ...flags], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_CALLS: join(dir, "calls"), ...env } });
}
const calls = () => { try { return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]); } catch { return []; } };

describe("Tiger history seed CLI", () => {
  it("defaults to local validation with a provenance manifest and no requests", () => {
    const result = run([row()]); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "dry-run", observations: 1, simulated: 1, sources: ["Synthetic test observation"] });
    expect(calls()).toEqual([]);
  });
  it.each([{ simulated: false }, { value: -1 }, { metric: "pc", value: 2 }, { observedAt: "2026-02-30T00:00:00Z" }, { sourceRef: "" }, { source: "made_up" }])("rejects malformed provenance or measurement before requests: %j", patch => {
    expect(run([{ ...row(), ...patch }], ["--apply", "--prod"]).status).toBe(1); expect(calls()).toEqual([]);
  });
  it("rejects conflicting duplicate keys before any request", () => {
    expect(run([row(), { ...row(), value: 0.9 }], ["--apply", "--prod"]).status).toBe(1); expect(calls()).toEqual([]);
  });
  it("requires an explicit deployment for apply", () => {
    expect(run([row()], ["--apply"]).status).toBe(1); expect(calls()).toEqual([]);
  });
  it("preflights every incident before queuing and forwards only mutation fields", () => {
    const result = run([row(), { ...row(), eventId: "event-b" }], ["--apply", "--prod"]);
    expect(result.status).toBe(0);
    expect(calls().map(c => c[3])).toEqual(["history:seriesScope", "history:seriesScope", "history:recordObservation", "history:recordObservation"]);
    expect(JSON.parse(calls()[2][4])).toEqual({ eventId: "event-a", observation: expect.objectContaining({ source: "simulated", simulated: true }) });
    expect(calls()[2][4]).not.toContain("sourceRef"); expect(JSON.parse(result.stdout).queued).toBe(2);
  });
  it("refuses a mismatched run after reads and before any writes", () => {
    expect(run([row()], ["--apply", "--prod"], { TEST_RUN: "another-run" }).status).toBe(1);
    expect(calls().map(c => c[3])).toEqual(["history:seriesScope"]);
  });
  it("stops after one failed write without retry or raw provider error", () => {
    const result = run([row(), { ...row(), observedAt: "2026-10-25T01:00:00Z" }], ["--apply", "--prod"], { TEST_FAIL: "history:recordObservation" });
    expect(result.status).toBe(1); expect(result.stderr).not.toContain("private upstream");
    expect(calls().map(c => c[3])).toEqual(["history:seriesScope", "history:recordObservation"]);
  });
});
