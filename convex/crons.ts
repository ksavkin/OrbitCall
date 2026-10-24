import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("recolor catalog events", { minutes: 5 }, internal.riskMonitor.recolor, {});
export default crons;
