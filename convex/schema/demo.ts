import { defineTable } from "convex/server";
import { v } from "convex/values";

// Demo runs and their per-run company memory (spec §3.2 demo.*, roadmap §10 Backboard and §14 reset contract).
// Reset closes a run: its simulated records leave queues and rooms, history stays tagged with the run.

export const demoTables = {
  demoRuns: defineTable({
    scenario: v.string(),
    state: v.union(v.literal("open"), v.literal("closed")),
    startedBy: v.union(v.id("users"), v.null()),
    // Model and voice IDs and provider readiness recorded for the run (roadmap §7 demo manifest).
    manifest: v.union(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null())), v.null()),
    startedAt: v.number(), closedAt: v.union(v.number(), v.null()),
  }).index("by_state", ["state"]),
  // One isolated Backboard assistant per company per run. Reset closes this run's assistants only.
  memoryAssistants: defineTable({
    demoRunId: v.id("demoRuns"), companyId: v.id("companies"), assistantId: v.string(),
    createdAt: v.number(), closedAt: v.union(v.number(), v.null()),
  }).index("by_run_company", ["demoRunId", "companyId"]).index("by_run", ["demoRunId"]),
  // Cross-laptop invite for the product recording (one active slot).
  smokeInvites: defineTable({
    slot: v.string(),
    eventId: v.string(),
    pair: v.string(),
    hostUserId: v.string(),
    eventJson: v.string(),
    openedAt: v.number(),
  }).index("by_slot", ["slot"]),
};
