import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDroid } from "../src/droid.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function setup(mode = "write") {
  vi.stubEnv("FACTORY_API_KEY", "mock-secret-key"); vi.stubEnv("FACTORY_MODEL_ID", "fixed-model"); vi.stubEnv("DROID_EXEC_PATH", "/usr/bin/mock-droid");
  const cwd = await mkdtemp(join(tmpdir(), "factory-adapter-")); roots.push(cwd);
  const input = { cwd, home: cwd, file: join(cwd, "schedule.json"), expected: "exact schedule bytes\n" };
  let opts: any, disabled = false;
  const close = vi.fn(async () => {});
  const factory = vi.fn(async (options: any) => { opts = options; return { id: "real-sdk-session", close,
    listMcpTools: async () => [{ serverName: "orbitcall_schedule", name: "write_schedule", isEnabled: true }],
    listTools: async () => [
      { id: mode === "wrong-tool" ? "other_server___write_schedule" : "orbitcall_schedule___write_schedule",
        ...(mode === "with-source" ? { source: "mcp" } : mode === "wrong-source" ? { source: "native" } : {}), allowed: true },
      ...(mode === "duplicate" ? [{ id: "orbitcall_schedule___write_schedule", allowed: true }] : []),
      { id: "Execute", allowed: mode === "unsafe" || !disabled },
      { id: "ToolSearch", ...(mode === "foreign-search" ? { source: "mcp" } : {}), allowed: true },
    ],
    updateSettings: async (settings: any) => { expect(settings.disabledToolIds).toEqual(["Execute", "ToolSearch"]); disabled = true; },
    async *stream(prompt: string) { expect(disabled).toBe(true);
      const args = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)); expect(args).toEqual({ content: input.expected });
      if (["write", "with-source", "bad"].includes(mode)) await opts.mcpServers[0].tools[0].handler(mode === "bad" ? { content: "invented" } : args);
      yield { type: "result", success: true, subtype: "success" }; },
  }; });
  return { input, factory, close, options: () => opts };
}
it.each(["write", "with-source"])("binds the exact SDK tool identity, disables other tools and closes its session (%s)", async mode => {
  const t = await setup(mode); const receipt = await runDroid(t.input, t.factory as any);
  expect(receipt).toEqual({ sessionId: "real-sdk-session", modelId: "fixed-model", toolWrites: 1 });
  expect(await readFile(t.input.file, "utf8")).toBe(t.input.expected); expect(t.close).toHaveBeenCalledOnce();
  const options = t.options(); expect(options.autonomyLevel).toBe("off"); expect(options.disableBuiltinSkills).toBe(true);
  expect(options.permissionHandler({ toolUses: [{ details: { type: "exec" } }], options: [{ value: "proceed_once" }] })).toBe("cancel");
  expect(options.permissionHandler({ toolUses: [{ details: { type: "mcp_tool", serverName: "orbitcall_schedule", actualToolName: "write_schedule" } }], options: [{ value: "proceed_once" }] })).toBe("proceed_once");
});
it.each(["claim", "bad", "unsafe", "wrong-tool", "wrong-source", "duplicate", "foreign-search"])("rejects provider mode %s without success evidence", async mode => {
  const t = await setup(mode); await expect(runDroid(t.input, t.factory as any)).rejects.toThrow(); expect(t.close).toHaveBeenCalledOnce();
});
it("does not create a session when Factory is not configured", async () => {
  const t = await setup(); vi.stubEnv("FACTORY_API_KEY", ""); await expect(runDroid(t.input, t.factory as any)).rejects.toThrow(); expect(t.factory).not.toHaveBeenCalled();
});
