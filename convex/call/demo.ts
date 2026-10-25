// Demo seed: one coordination room with three dispatchers (English / US, Russian / RU, Mandarin / CN, the main demo
// of the master roadmap) and a read-only observer, each with a secret dev token for CALL_DEV_IDENTITY=on. Tokens are
// keyed en / ru / zh / observer. The dispatchers carry a voice gender for their translated tracks (US female, RU male,
// CN female); the observer never speaks and has none. Companies and people are labeled
// simulated; they make no claim to represent real operators.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

type DemoMember = {
  key: string; lang: "en" | "ru" | "zh"; role: "operator" | "observer"; name: string; companyId: string; companyName: string;
  voice?: "male" | "female";
};

const DEMO_MEMBERS: DemoMember[] = [
  { key: "en", lang: "en", role: "operator", name: "Dispatcher US", companyId: "demo-company-us", companyName: "Northwind Orbital (simulated)", voice: "female" },
  { key: "ru", lang: "ru", role: "operator", name: "Dispatcher RU", companyId: "demo-company-ru", companyName: "Polar Sat (simulated)", voice: "male" },
  { key: "zh", lang: "zh", role: "operator", name: "Dispatcher CN", companyId: "demo-company-cn", companyName: "Jade Orbit (simulated)", voice: "female" },
  // the fourth screen: a read-only observer display (master roadmap §2)
  { key: "observer", lang: "en", role: "observer", name: "Observer display", companyId: "demo-observer", companyName: "Demo observer (simulated)" },
];

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const seed = internalMutation({
  args: { roomId: v.optional(v.string()) },
  handler: async (ctx, { roomId: given }) => {
    const roomId = given ?? `demo-${randomHex(6)}`;
    const existing = await ctx.db.query("call_members").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    if (existing.length) {
      // Tokens are handed out once, when the room's members are created. A room seeded before the voice gender existed
      // still gets it here, so reseeding is enough: no new room, no new tokens.
      for (const m of DEMO_MEMBERS) {
        const row = existing.find((e) => e.companyId === m.companyId && e.role === m.role);
        if (m.voice && row && row.voice === undefined) await ctx.db.patch(row._id, { voice: m.voice });
      }
      return { roomId, tokens: null };
    }
    const tokens: Record<string, string> = {};
    for (const m of DEMO_MEMBERS) {
      tokens[m.key] = randomHex(32);
      await ctx.db.insert("call_members", { roomId, subject: `demo|${m.key}-${randomHex(6)}`, userId: `demo-${m.key}-${randomHex(4)}`,
        companyId: m.companyId, name: m.name, lang: m.lang, role: m.role, ...(m.voice ? { voice: m.voice } : {}),
        devToken: tokens[m.key], simulated: true });
    }
    return { roomId, tokens, companies: Object.fromEntries(DEMO_MEMBERS.map((m) => [m.key, m.companyName])) };
  },
});
