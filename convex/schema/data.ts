import { defineTable } from "convex/server";
import { v } from "convex/values";
import { eventFacts } from "../lib/validators";

// Minimal integration seam. Kostya owns the catalog/event tables in this file.
export const dataTables = {
  events: defineTable({
    ...eventFacts.fields,
    sourceKey: v.string(),
    color: v.union(v.literal("red"), v.literal("yellow"), v.literal("none")),
    status: v.union(v.literal("new"), v.literal("agents"), v.literal("proposal"),
      v.literal("communication"), v.literal("approved"), v.literal("scheduled"),
      v.literal("monitoring"), v.literal("awaiting_verification_data"),
      v.literal("verified"), v.literal("flagged"), v.literal("no_action_needed")),
    agentsWorking: v.boolean(), agentsStalled: v.boolean(),
    updatedAt: v.string(),
  }).index("by_source_key", ["sourceKey"]),
  // Minimal identity records for protected read/retry endpoints; no policy or login flow.
  companies: defineTable({ name: v.string() }),
  users: defineTable({
    authSubject: v.string(), companyId: v.id("companies"),
    role: v.union(v.literal("operator"), v.literal("head_of_ops")),
  }).index("by_auth_subject", ["authSubject"]),
};
