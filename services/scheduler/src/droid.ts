import { open } from "node:fs/promises";
import { z } from "zod";
import { AutonomyLevel, createSdkMcpServer, createSession, DroidInteractionMode, DroidMessageType, ToolConfirmationOutcome, ToolConfirmationType, tool } from "@factory/droid-sdk/node";
import { fail, MAX_BYTES, type Receipt } from "./protocol.js";
import type { Provider } from "./engine.js";

const serverName = "orbitcall_schedule", toolName = "write_schedule";
/** This module runs only in the credential-filtered child process, never the HTTP service process. */
export async function runDroid(input: Parameters<Provider>[0], sessionFactory = createSession): Promise<Receipt> {
  if (!process.env.FACTORY_API_KEY || !process.env.FACTORY_MODEL_ID || !process.env.DROID_EXEC_PATH) return fail("FACTORY_UNAVAILABLE", "Factory key, fixed model and CLI must be configured.", 503);
  let writes = 0;
  const mcp = createSdkMcpServer({ name: serverName, tools: [tool(toolName,
    "Write the exact schedule bytes supplied in the instruction. No plan selection or numeric changes are permitted.",
    { content: z.string().max(MAX_BYTES) }, async ({ content }) => {
      if (content !== input.expected) return fail("FACTORY_ARTIFACT_INVALID", "The requested file differs from the immutable plan.");
      if (!writes) { const fd = await open(input.file, "wx", 0o600); try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); } writes++; }
      return "Exact checked schedule written.";
    }, { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } })] });
  const session = await sessionFactory({ cwd: input.cwd, execPath: process.env.DROID_EXEC_PATH, apiKey: process.env.FACTORY_API_KEY,
    modelId: process.env.FACTORY_MODEL_ID, interactionMode: DroidInteractionMode.Auto, autonomyLevel: AutonomyLevel.Off,
    disableBuiltinSkills: true, mcpServers: [mcp], abortSignal: AbortSignal.timeout(90_000),
    systemPrompt: "You are an artifact writer. You may use ToolSearch only to load orbitcall_schedule___write_schedule. Call write_schedule with the exact supplied bytes. Never choose a plan, change any value, use another tool or claim a write without calling write_schedule.",
    askUserHandler: () => ({ cancelled: true, answers: [] }),
    permissionHandler: ({ toolUses, options }) => {
      const safe = toolUses.length > 0 && toolUses.every(({ details }) => details.type === ToolConfirmationType.McpTool &&
        details.serverName === serverName && (details.actualToolName === toolName || details.toolName === toolName));
      return safe && options.some(o => o.value === ToolConfirmationOutcome.ProceedOnce) ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
    }, observability: { logger: { log: () => {} } },
  });
  try {
    const mcpTools = await session.listMcpTools();
    if (mcpTools.length !== 1 || mcpTools[0].serverName !== serverName || mcpTools[0].name !== toolName || !mcpTools[0].isEnabled) return fail("FACTORY_TOOL_CONTRACT", "Factory did not expose the restricted schedule tool.");
    const tools = await session.listTools();
    // Droid 0.249.0 omits the optional source field. Bind the tool to the exact
    // server/name identity already verified above, never to an arbitrary MCP tool.
    const expectedToolId = `${serverName}___${toolName}`;
    const allowed = tools.filter(t => t.id === expectedToolId && (t.source === undefined || t.source === "mcp"));
    if (allowed.length !== 1) return fail("FACTORY_TOOL_CONTRACT", "Factory tool discovery is ambiguous.");
    await session.updateSettings({ disabledToolIds: tools.filter(t => t.id !== allowed[0].id).map(t => t.id) });
    // The pinned CLI retains its schema-discovery helper even when disabled.
    // It may load the sole registered MCP tool; it is not a writer or a receipt.
    const checkTools = async () => {
      const checked = await session.listTools();
      if (!checked.some(t => t.id === expectedToolId && t.allowed) || checked.some(t => t.allowed && t.id !== expectedToolId &&
        !(t.id === "ToolSearch" && (t.source === undefined || t.source === "native")))) return fail("FACTORY_TOOL_CONTRACT", "Factory could not restrict its tool set.");
    };
    await checkTools();
    let succeeded = false;
    for await (const message of session.stream(`Write these exact UTF-8 bytes using write_schedule once:\n${input.expected}`, { abortSignal: AbortSignal.timeout(90_000) })) {
      if (message.type === DroidMessageType.Result) succeeded = message.success && message.subtype === "success";
    }
    await checkTools();
    if (!succeeded || writes !== 1) return fail("FACTORY_FAILED", "Factory did not complete a checked artifact write.");
    return { sessionId: session.id, modelId: process.env.FACTORY_MODEL_ID, toolWrites: writes };
  } finally { await session.close(); }
}
