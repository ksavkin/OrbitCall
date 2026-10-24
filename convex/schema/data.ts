import { defineTable } from "convex/server";
import { v } from "convex/values";

// Minimal integration seam. Kostya owns the catalog/event tables in this file.
export const dataTables = {
  events: defineTable({ name: v.string() }),
};
