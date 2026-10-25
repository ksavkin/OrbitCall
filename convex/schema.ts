import { defineSchema } from "convex/server";
import { dataTables } from "./schema/data";
import { agentTables } from "./schema/agents";
import { callTables } from "./schema/call";
import { scanTables } from "./schema/scans";
import { roomTables } from "./schema/rooms";
import { scheduleTables } from "./schema/schedule";
import { recordTables } from "./schema/records";
import { demoTables } from "./schema/demo";

export default defineSchema({
  ...callTables, ...dataTables, ...agentTables,
  ...scanTables, ...roomTables, ...scheduleTables, ...recordTables, ...demoTables,
});
