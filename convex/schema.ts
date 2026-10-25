import { defineSchema } from "convex/server";
import { dataTables } from "./schema/data";
import { agentTables } from "./schema/agents";
import { callTables } from "./schema/call";

export default defineSchema({ ...callTables, ...dataTables, ...agentTables });
