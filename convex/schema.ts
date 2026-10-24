import { defineSchema } from "convex/server";
import { dataTables } from "./schema/data";
import { agentTables } from "./schema/agents";

export default defineSchema({ ...dataTables, ...agentTables });
