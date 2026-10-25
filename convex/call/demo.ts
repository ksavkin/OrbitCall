// Demo seed: one coordination room with three dispatchers (English / US, Russian / RU, Mandarin / CN, the main demo
// of the master roadmap) and a read-only observer, each with a secret dev token for CALL_DEV_IDENTITY=on. Tokens are
// keyed en / ru / zh / observer. Companies and people are labeled
// simulated; they make no claim to represent real operators.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const DEMO_MEMBERS = [
  { key: "en", lang: "en" as const, role: "operator" as const, name: "Dispatcher US", companyId: "demo-company-us", companyName: "Northwind Orbital (simulated)" },
  { key: "ru", lang: "ru" as const, role: "operator" as const, name: "Dispatcher RU", companyId: "demo-company-ru", companyName: "Polar Sat (simulated)" },
  { key: "zh", lang: "zh" as const, role: "operator" as const, name: "Dispatcher CN", companyId: "demo-company-cn", companyName: "Jade Orbit (simulated)" },
  // the fourth screen: a read-only observer display (master roadmap §2)
  { key: "observer", lang: "en" as const, role: "observer" as const, name: "Observer display", companyId: "demo-observer", companyName: "Demo observer (simulated)" },
];

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const seed = internalMutation({
  args: { roomId: v.optional(v.string()) },
  handler: async (ctx, { roomId: given }) => {
    const roomId = given ?? `demo-${randomHex(6)}`;
    const existing = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", roomId)).first();
    if (existing) return { roomId, tokens: null }; // tokens are handed out once, when the room's members are created
    const tokens: Record<string, string> = {};
    for (const m of DEMO_MEMBERS) {
      tokens[m.key] = randomHex(32);
      await ctx.db.insert("call_members", { roomId, subject: `demo|${m.key}-${randomHex(6)}`, userId: `demo-${m.key}-${randomHex(4)}`,
        companyId: m.companyId, name: m.name, lang: m.lang, role: m.role, devToken: tokens[m.key], simulated: true });
    }
    return { roomId, tokens, companies: Object.fromEntries(DEMO_MEMBERS.map((m) => [m.key, m.companyName])) };
  },
});
