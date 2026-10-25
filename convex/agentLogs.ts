import { v } from "convex/values";
import { query } from "./_generated/server";
import { listSafeLogs, logView, traceArgs } from "./spans";

// Appendix C requires api.agentLogs.list; share the exact scope and allowlist with spans.list.
export const list = query({ args: traceArgs, returns: v.array(logView), handler: listSafeLogs });
