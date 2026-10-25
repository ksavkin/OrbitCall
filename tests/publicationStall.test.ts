import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { getCandidates, OrbitServiceError } from "../convex/lib/orbitClient";
import { FIXTURE_NOW } from "../fixtures/events";
import { seed } from "./decision";
import type { Backend } from "./helpers";

vi.mock("../convex/lib/orbitClient", async importOriginal => ({
  ...await importOriginal<typeof import("../convex/lib/orbitClient")>(), getCandidates: vi.fn(),
}));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); vi.mocked(getCandidates).mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const stalls = (t: Backend) => t.run(async ctx => (await ctx.db.query("log").collect()).filter(row => row.after?.kind === "candidate_publication"));
const said = (t: Backend) => t.run(async ctx => (await ctx.db.query("messages").collect()).filter(m => m.kind === "negotiation"));
async function room(t: Backend, eventId: Id<"events">, fields: Partial<Doc<"rooms">> = {}) {
  return t.run(async ctx => {
    const id = await ctx.db.insert("rooms", { state: "open", companyIds: [], demoRunId: null, simulated: true, createdAt: FIXTURE_NOW, closedAt: null, ...fields });
    await ctx.db.insert("roomEvents", { roomId: id, eventId, linkedAt: FIXTURE_NOW });
    return id;
  });
}

describe("a candidate publication that leaves the case without options says why", () => {
  it("logs a missing orbit service once and says it in the case's open rooms", async () => {
    vi.stubEnv("ORBIT_SERVICE_URL", ""); vi.stubEnv("ORBIT_SERVICE_TOKEN", "");
    const { t, eventId } = await seed();
    const open = await room(t, eventId);
    await room(t, eventId, { state: "closed", closedAt: FIXTURE_NOW });
    expect(await t.action(internal.advocates.publishFromOrbit, { eventId })).toEqual({ status: "skipped", reason: "ORBIT_NOT_CONFIGURED" });
    const [row, ...more] = await stalls(t);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ eventId, action: "negotiation", after: { kind: "candidate_publication", state: "stalled", code: "ORBIT_NOT_CONFIGURED" } });
    expect(row.summary).toMatch(/^No maneuver options for this case yet \(ORBIT_NOT_CONFIGURED\)\. The orbit service is not configured/);
    const messages = await said(t);
    expect(messages.map(m => m.roomId)).toEqual([open]);
    expect(messages[0].originalText).toBe(row.summary);
    // the same reason on the same evidence is said once
    await t.action(internal.advocates.publishFromOrbit, { eventId });
    expect(await stalls(t)).toHaveLength(1);
    expect(await said(t)).toHaveLength(1);
  });

  it("logs an orbit service failure with its sanitized code", async () => {
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.invalid"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-token");
    vi.mocked(getCandidates).mockRejectedValue(new OrbitServiceError("UPSTREAM_UNAVAILABLE", "The orbit service is unavailable."));
    const { t, eventId } = await seed();
    const outcome = await t.action(internal.advocates.publishFromOrbit, { eventId });
    expect(outcome).toMatchObject({ status: "failed" });
    const code = (outcome as { code: string }).code;
    expect((await stalls(t)).map(row => row.after?.code)).toEqual([code]);
  });

  it("stays quiet when the case simply moved on", async () => {
    vi.stubEnv("ORBIT_SERVICE_URL", "https://orbit.invalid"); vi.stubEnv("ORBIT_SERVICE_TOKEN", "test-token");
    const { t, eventId } = await seed();
    await t.run(ctx => ctx.db.patch(eventId, { active: false }));
    expect(await t.action(internal.advocates.publishFromOrbit, { eventId })).toEqual({ status: "skipped", reason: "EVENT_INACTIVE" });
    expect(await stalls(t)).toEqual([]);
    expect(getCandidates).not.toHaveBeenCalled();
  });
});
