import { currentProposal } from "./currentDecision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { backend, catalogObject, pair, registerSnapshot, type Backend } from "./helpers";

// messages.ts and rooms.ts are new function files and convex/_generated is regenerated on main only (#6), so the
// tests reference them by path.
const send = makeFunctionReference<"mutation">("messages:send");
const list = makeFunctionReference<"query">("messages:list");
const startWorkflow = makeFunctionReference<"mutation">("rooms:startWorkflow");
const closeIfResolved = makeFunctionReference<"mutation">("rooms:closeIfResolved");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

const token = (name: string) => `https://orbitcall.us.auth0.com/|${name}`;
const as = (t: Backend, name: string) =>
  t.withIdentity({ tokenIdentifier: token(name), subject: name, issuer: "https://orbitcall.us.auth0.com/" });
const code = async (p: Promise<unknown>) => {
  const outcome = await p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  if (outcome.ok) throw new Error(`Expected a failure, got ${JSON.stringify(outcome.value)}`);
  return (outcome.error as { data?: { code?: string } }).data?.code;
};

type View = { messageId: string; at: string; text: string; translationStatus: string; author: Record<string, unknown> };

// North operates 48211/48212 (Ana, Hoa head of ops, Eye observer); South operates 25544 (Bo); East operates 60001 (Cy).
async function seed() {
  const t = backend();
  await t.run(async ctx => {
    for (const id of ["48211", "48212", "25544", "60001", "40009"]) await ctx.db.insert("spaceObjects", catalogObject(id));
  });
  await t.mutation(internal.operators.provision, {
    key: "north", name: "North Orbital", simulated: false, objectIds: ["48211", "48212"],
    members: [
      { tokenIdentifier: token("ana"), role: "operator", assignedObjectIds: ["48211", "48212"], name: "Ana Ortiz", language: "en" },
      { tokenIdentifier: token("hoa"), role: "head_of_ops", assignedObjectIds: [] },
      { tokenIdentifier: token("eye"), role: "demo_observer", assignedObjectIds: [] },
    ],
  });
  await t.mutation(internal.operators.provision, {
    key: "south", name: "South Space", simulated: false, objectIds: ["25544"],
    members: [{ tokenIdentifier: token("bo"), role: "operator", assignedObjectIds: ["25544"], language: "ru" }],
  });
  await t.mutation(internal.operators.provision, {
    key: "east", name: "East Sky", simulated: false, objectIds: ["60001"],
    members: [{ tokenIdentifier: token("cy"), role: "operator", assignedObjectIds: ["60001"] }],
  });
  const snapshotId = await registerSnapshot(t);
  const cross = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...pair(48211, 25544, 15, 1.5e-4) });
  const east = await t.mutation(internal.events.ingest, { snapshotId, simulated: false, ...pair(60001, 40009, 9, 2e-4) });
  const { roomId } = await as(t, "ana").mutation(startWorkflow, { eventId: cross.eventId });
  return { t, roomId, crossId: cross.eventId as Id<"events">, eastId: east.eventId as Id<"events"> };
}
const texts = async (t: Backend, args: Record<string, unknown>) => ((await as(t, "bo").query(list, args)) as View[]).map(m => m.text);
const proposalFor = (t: Backend, eventId: Id<"events">) =>
  t.run(ctx => currentProposal(ctx, eventId));

describe("messages", () => {
  it("lets a room operator post a line every member reads back", async () => {
    const { t, roomId } = await seed();
    const { messageId } = await as(t, "ana").mutation(send, { roomId, text: "We can move 0.2 m/s" });
    const { ana, north } = await t.run(async ctx => ({
      ana: (await ctx.db.query("users").collect()).find(u => u.tokenIdentifier === token("ana"))!,
      north: (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "north")).unique())!,
    }));
    const [row] = await as(t, "bo").query(list, { roomId }) as View[];
    expect(row).toEqual({
      messageId, roomId, eventId: null, at: expect.stringMatching(/^2026-10-24T12:00:00/),
      author: { kind: "human", userId: ana._id, companyId: north._id, name: "Ana Ortiz" },
      kind: "text", text: "We can move 0.2 m/s", originalText: "We can move 0.2 m/s", originalLang: "en",
      translationStatus: "original_only", values: [], refs: {}, form: null, simulated: false,
    });
    expect(((await as(t, "ana").query(list, { roomId })) as View[])[0].translationStatus).toBe("ok");
    expect(await as(t, "hoa").query(list, { roomId })).toHaveLength(1);   // a head of ops reads
  });

  it("refuses callers who are not operators of the room", async () => {
    const { t, roomId } = await seed();
    expect(await code(t.mutation(send, { roomId, text: "hi" }))).toBe("UNAUTHENTICATED");
    expect(await code(t.query(list, { roomId }))).toBe("UNAUTHENTICATED");
    for (const who of ["stranger", "cy"]) {
      expect(await code(as(t, who).mutation(send, { roomId, text: "hi" }))).toBe("FORBIDDEN");
      expect(await code(as(t, who).query(list, { roomId }))).toBe("FORBIDDEN");
    }
    expect(await code(as(t, "eye").query(list, { roomId }))).toBe("FORBIDDEN");
    expect(await code(as(t, "hoa").mutation(send, { roomId, text: "hi" }))).toBe("FORBIDDEN");
  });

  it("bounds text at 2000 characters and trims it", async () => {
    const { t, roomId } = await seed();
    expect(await code(as(t, "ana").mutation(send, { roomId, text: "   " }))).toBe("VALIDATION");
    expect(await code(as(t, "ana").mutation(send, { roomId, text: "x".repeat(2001) }))).toBe("VALIDATION");
    await as(t, "ana").mutation(send, { roomId, text: "x".repeat(2000) });
    await as(t, "ana").mutation(send, { roomId, text: " padded " });
    expect((await t.run(ctx => ctx.db.query("messages").collect())).map(m => m.originalText.length)).toEqual([2000, 6]);
  });

  it("accepts only events and proposals of the room and filters on the event", async () => {
    const { t, roomId, crossId, eastId } = await seed();
    expect(await code(as(t, "ana").mutation(send, { roomId, eventId: eastId, text: "elsewhere" }))).toBe("VALIDATION");
    const foreign = await proposalFor(t, eastId);
    expect(await code(as(t, "ana").mutation(send, { roomId, text: "P1?", refs: { proposalId: foreign, revision: 1 } }))).toBe("VALIDATION");
    const own = await proposalFor(t, crossId);
    await as(t, "ana").mutation(send, { roomId, text: "general" });
    await as(t, "ana").mutation(send, { roomId, eventId: crossId, text: "about P1", refs: { proposalId: own, revision: 1 } });
    expect(await texts(t, { roomId, eventId: crossId })).toEqual(["about P1"]);
    expect(await texts(t, { roomId })).toEqual(["general", "about P1"]);
    const [, withRefs] = await as(t, "bo").query(list, { roomId }) as { refs: unknown }[];
    expect(withRefs.refs).toEqual({ eventId: crossId, proposalId: own, revision: 1 });
  });

  it("pages oldest first with a clamped limit and a before cursor", async () => {
    const { t, roomId } = await seed();
    for (const [i, text] of ["one", "two", "three"].entries()) {
      vi.setSystemTime(FIXTURE_NOW + i * 1000);
      await as(t, "ana").mutation(send, { roomId, text });
    }
    expect(await texts(t, { roomId })).toEqual(["one", "two", "three"]);
    expect(await texts(t, { roomId, limit: 2 })).toEqual(["two", "three"]);
    const three = ((await as(t, "bo").query(list, { roomId })) as View[])[2];
    expect(await texts(t, { roomId, before: three.at })).toEqual(["one", "two"]);
    expect(await texts(t, { roomId, limit: 0 })).toHaveLength(1);
    expect(await code(as(t, "bo").query(list, { roomId, limit: Number.NaN }))).toBe("VALIDATION");
    expect(await code(as(t, "bo").query(list, { roomId, before: "yesterday" }))).toBe("VALIDATION");
  });

  it("writes one messages row and nothing else: no caption, no agent or host run, nothing scheduled", async () => {
    const { t, roomId } = await seed();
    const counts = () => t.run(async ctx => ({
      call_phrases: (await ctx.db.query("call_phrases").collect()).length,
      negotiationMessages: (await ctx.db.query("negotiationMessages").collect()).length,
      agentRuns: (await ctx.db.query("agentRuns").collect()).length,
      hostRuns: (await ctx.db.query("hostRuns").collect()).length,
      approvals: (await ctx.db.query("approvals").collect()).length,
      messages: (await ctx.db.query("messages").collect()).length,
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
    }));
    const before = await counts();
    await as(t, "ana").mutation(send, { roomId, text: "Holding for the screen" });
    expect(await counts()).toEqual({ ...before, messages: before.messages + 1 });
  });

  it("lets everyone discuss until a decision opens, then only the side in turn", async () => {
    const { t, roomId, crossId } = await seed();
    const ids = await t.run(async ctx => {
      const users = await ctx.db.query("users").collect();
      const companies = await ctx.db.query("companies").collect();
      const u = (n: string) => users.find(x => x.tokenIdentifier === token(n))!;
      return { ana: u("ana"), north: companies.find(c => c.key === "north")!._id };
    });
    await t.run(ctx => ctx.db.patch(crossId, { workflow: "bilateral", requiredApprovalSides: ["A", "B"], approvalRuleVersion: 1 }));
    await as(t, "bo").mutation(send, { roomId, text: "before" });
    const proposalId = await proposalFor(t, crossId);
    await t.run(ctx => ctx.db.insert("selections", { eventId: crossId, proposalId, revision: 1, generation: 1, by: { kind: "agents" }, at: FIXTURE_NOW, lastReset: null }));
    expect(await code(as(t, "bo").mutation(send, { roomId, text: "my view" }))).toBe("INVALID_STATE");
    await as(t, "ana").mutation(send, { roomId, text: "A decides" });
    await t.run(ctx => ctx.db.insert("approvals", {
      eventId: crossId, side: "A", status: "approved", userId: ids.ana._id, companyId: ids.north, proposalId, revision: 1,
      selectionGeneration: 1, approvalRuleVersion: 1, trajectoryPlanId: null, trajectoryPlanVersion: null, reason: null,
      demoRunId: null, current: true, at: Date.now(),
    }));
    expect(await code(as(t, "ana").mutation(send, { roomId, text: "more" }))).toBe("INVALID_STATE");
    await as(t, "bo").mutation(send, { roomId, text: "B decides" });
    // The turn is per incident: a line filed under a decided incident's sibling still needs that incident's turn.
    expect(await code(as(t, "ana").mutation(send, { roomId, eventId: crossId, text: "about cross" }))).toBe("INVALID_STATE");
    expect(await texts(t, { roomId })).toEqual(["before", "A decides", "B decides"]);
  });

  it("refuses new lines in a closed room and keeps its history readable", async () => {
    const { t, roomId, crossId } = await seed();
    await as(t, "ana").mutation(send, { roomId, text: "agreed" });
    await t.run(ctx => ctx.db.patch(crossId, { status: "approved" }));
    await t.mutation(closeIfResolved, { eventId: crossId });
    expect(await code(as(t, "ana").mutation(send, { roomId, text: "late" }))).toBe("INVALID_STATE");
    expect(await texts(t, { roomId })).toEqual(["agreed", "Every linked incident is resolved; the room is closed."]);
  });
});
