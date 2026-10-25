import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { httpServer } from "./http.js";
import { factoryProvider, readiness } from "./provider.js";

const root = process.env.SCHEDULE_DATA_DIR ?? "/data";
if (!isAbsolute(root)) throw new Error("SCHEDULE_DATA_DIR must be an absolute isolated directory.");
if (!process.argv.includes("--locked")) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Linux flock holds the exclusive OS lock across process crashes and releases it automatically on exit.
  const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", join(root, ".writer.lock"), process.execPath, fileURLToPath(import.meta.url), "--locked"], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", () => { process.stderr.write("Scheduler requires Linux flock for exclusive durable writes.\n"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else {
  const token = process.env.SCHEDULE_SERVICE_TOKEN ?? "";
  if (token.length < 32) throw new Error("SCHEDULE_SERVICE_TOKEN must contain at least 32 characters.");
  const engine = await Engine.open(root, factoryProvider);
  const server = httpServer(engine, token, readiness);
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT ?? 8090), "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.close(); void engine.idle().then(() => process.exit(0)); });
}
