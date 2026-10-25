import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { fail } from "./protocol.js";
import type { Provider } from "./engine.js";

export async function readiness() {
  if (!process.env.FACTORY_API_KEY || !process.env.FACTORY_MODEL_ID || !process.env.DROID_EXEC_PATH || !isAbsolute(process.env.DROID_EXEC_PATH)) return false;
  try { await access(process.env.DROID_EXEC_PATH, constants.X_OK); return true; } catch { return false; }
}
export const factoryProvider: Provider = async input => {
  if (!await readiness()) return fail("FACTORY_UNAVAILABLE", "Factory key, fixed model and installed CLI are required.", 503);
  return new Promise((resolve, reject) => {
    // SDK merges process.env into the CLI environment. This separate child receives an explicit allowlist first.
    const child = spawn(process.execPath, [fileURLToPath(new URL("./droidRunner.js", import.meta.url))], {
      cwd: input.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: input.home, TMPDIR: input.home,
        FACTORY_API_KEY: process.env.FACTORY_API_KEY, FACTORY_MODEL_ID: process.env.FACTORY_MODEL_ID,
        DROID_EXEC_PATH: process.env.DROID_EXEC_PATH, NODE_ENV: "production",
      },
    });
    let output = "", settled = false;
    const finish = (error?: unknown, receipt?: any) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(receipt); };
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
    const timer = setTimeout(() => { kill(); finish(new Error("Factory timed out")); }, 100_000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 16_000) { kill(); finish(new Error("Invalid Factory receipt")); } });
    child.stderr.resume(); // Never forward provider errors, CLI diagnostics or session output to application logs.
    child.on("error", () => finish(new Error("Factory process unavailable")));
    child.stdin.on("error", () => {});
    child.on("exit", code => {
      try { const result = JSON.parse(output); if (code !== 0 || !result.receipt || result.receipt.toolWrites !== 1 || typeof result.receipt.sessionId !== "string" || result.receipt.modelId !== process.env.FACTORY_MODEL_ID) throw new Error(); finish(undefined, result.receipt); }
      catch { finish(new Error("Factory did not return a valid receipt")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
};
