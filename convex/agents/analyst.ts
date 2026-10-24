import { internalAction } from "../_generated/server";
import { v } from "convex/values";

// Stable integration entry point for the event-ingestion pipeline.
export const start = internalAction({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async () => null,
});
