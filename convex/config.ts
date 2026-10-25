import { v } from "convex/values";
import { query } from "./_generated/server";
import { scheduleConfig } from "./lib/scheduleClient";

// Which optional integrations this deployment has configured (spec §3.1), so the UI hides what is off: no launch form,
// no call button, no wait for a schedule diff. Booleans only; no configuration value ever leaves the backend.
const set = (name: string) => !!process.env[name]?.trim();

export const flags = query({
  args: {},
  returns: v.object({ demoLaunch: v.boolean(), voice: v.boolean(), droid: v.boolean(), secondModel: v.boolean() }),
  handler: async () => {
    let droid = true;
    try { scheduleConfig(); } catch { droid = false; }
    return { demoLaunch: process.env.DEMO_LAUNCH === "on", voice: set("LIVEKIT_URL") && set("LIVEKIT_API_KEY") && set("LIVEKIT_API_SECRET"),
      droid, secondModel: set("XAI_API_KEY") };
  },
});
