import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { Engine } from "./engine.js";
import { fail, safeError, WorkerError } from "./protocol.js";

export function httpServer(engine: Engine, token: string, ready: () => Promise<boolean>) {
  if (token.length < 32) throw new Error("A schedule-service credential of at least 32 characters is required.");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
    try {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ""), digest(`Bearer ${token}`))) return reply(401, { error: { code: "UNAUTHORIZED", message: "Schedule-service authorization is required." } });
      if (req.method === "GET" && req.url === "/health") {
        const configured = await ready(); return reply(configured ? 200 : 503, { ready: configured, service: "orbitcall-scheduler", sdkVersion: "0.10.0", providerVerified: false });
      }
      if (req.method === "GET" && /^\/jobs\/[a-f0-9]{64}$/.test(req.url ?? "")) {
        const job = await engine.get(req.url!.slice(6)); return job ? reply(200, job) : reply(404, { error: { code: "NOT_FOUND", message: "Schedule job not found." } });
      }
      const retry = /^\/jobs\/([a-f0-9]{64})\/retry$/.exec(req.url ?? "");
      if (req.method !== "POST" || !(["/prepare", "/commit"].includes(req.url ?? "") || retry)) return reply(404, { error: { code: "NOT_FOUND", message: "Route not found." } });
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") fail("VALIDATION", "A JSON request is required.", 415);
      let body = "", size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16_000) fail("LIMIT_EXCEEDED", "Request exceeds the schedule command limit.", 413); body += chunk; }
      let value: unknown; try { value = JSON.parse(body); } catch { fail("VALIDATION", "Malformed schedule request.", 400); }
      const job = retry ? await engine.retry(retry[1], value) : req.url === "/prepare" ? await engine.prepare(value) : await engine.commit(value);
      reply(job.status === "queued" || job.status === "running" ? 202 : 200, job);
    } catch (error) { if (!res.headersSent) reply(error instanceof WorkerError ? error.status : 500, { error: safeError(error) }); }
  });
}
