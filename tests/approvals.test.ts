import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent, policyA } from "../fixtures/policies";
import { buildHostContext } from "../convex/lib/hostContext";
import { decisionTurn } from "../convex/lib/decision";
import { insertEvent, type Backend } from "./helpers";
import { as, code, companyA, fn, pick, seed, selection, tick, token, userId, withCard } from "./decision";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

type Side = "A" | "B";
type Status = {
  workflow: string | null; requiredApprovalSides: Side[]; allRequiredApproved: boolean; deciding: boolean; turn: Side | null;
  mySide: Side | null; canAct: boolean; myTurn: boolean; selectionGeneration: number;
  selected: { label: string; revision: number; generation: number } | null;
  approvals: Partial<Record<Side, { status: string; byUserId: string | null; byName: string | null; revision: number | null }>>;
  lastReset: { at: string; reason: string } | null;
};
const read = (t: Backend, name: string, eventId: Id<"events">) => as(t, name).query(fn.status, { eventId }) as Promise<Status>;
const rows = (t: Backend, eventId: Id<"events">) => t.run(ctx => ctx.db.query("approvals").filter(q => q.eq(q.field("eventId"), eventId)).collect());
const eventRow = (t: Backend, eventId: Id<"events">) => t.run(ctx => ctx.db.get(eventId));
async function selected(name = "a") {
  const { t, eventId } = await seed();
  await pick(t, name, eventId, "P2");
  return { t, eventId };
}

describe("approvals.approve: bilateral, side A then side B", () => {
  it("needs both companies on the same selected revision, in turn", async () => {
    const { t, eventId } = await selected();
    expect(await read(t, "a", eventId)).toMatchObject({ deciding: true, turn: "A", myTurn: true, canAct: true, mySide: "A" });
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", myTurn: false, canAct: true, mySide: "B" });
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await code(as(t, "b").mutation(fn.veto, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toEqual({ allRequiredApproved: false, requiredApprovalSides: ["A", "B"] });
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "B", myTurn: true, allRequiredApproved: false,
      selected: { label: "P2", revision: 1, generation: 1 },
      approvals: { A: { status: "approved", byUserId: await userId(t, "a"), byName: "A", revision: 1 }, B: { status: "pending", byUserId: null } } });
    // Approving the same tick again is idempotent, even off turn.
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toEqual({ allRequiredApproved: false, requiredApprovalSides: ["A", "B"] });
    expect(await rows(t, eventId)).toHaveLength(1);
    expect(await as(t, "b").mutation(fn.approve, await tick(t, eventId))).toEqual({ allRequiredApproved: true, requiredApprovalSides: ["A", "B"] });
    expect(await read(t, "head", eventId)).toMatchObject({ allRequiredApproved: true, deciding: false, turn: null, lastReset: null,
      approvals: { A: { status: "approved" }, B: { status: "approved" } } });
    expect((await eventRow(t, eventId))!.status).toBe("approved");
    expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("ALREADY_DECIDED");
    // A later publication never silently replaces an agreed plan.
    expect(await code(t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false,
      candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }) }))).toBe("INVALID_STATE");
    expect(await read(t, "a", eventId)).toMatchObject({ allRequiredApproved: true, selected: { revision: 1, generation: 1 } });
  });

  it("rejects an unselected card, a stale revision, generation or rule version", async () => {
    const { t, eventId } = await seed();
    await pick(t, "a", eventId, "P2");
    const none = await tick(t, eventId);
    const a = as(t, "a");
    const P1 = (await t.run(async ctx => (await ctx.db.query("proposals").withIndex("by_event_candidate", q =>
      q.eq("eventId", eventId).eq("candidateId", "P1")).first())!._id));
    expect(await code(a.mutation(fn.approve, { ...none, proposalId: P1 }))).toBe("NOT_SELECTED");
    expect(await code(a.mutation(fn.approve, { ...none, revision: 2 }))).toBe("STALE_REVISION");
    expect(await code(a.mutation(fn.approve, { ...none, selectionGeneration: 0 }))).toBe("STALE_REVISION");
    expect(await code(a.mutation(fn.approve, { ...none, approvalRuleVersion: 2 }))).toBe("STALE_REVISION");
    expect(await rows(t, eventId)).toEqual([]);
    const fresh = await seed();
    const P2 = await fresh.t.run(async ctx => (await ctx.db.query("proposals").withIndex("by_event_candidate", q =>
      q.eq("eventId", fresh.eventId).eq("candidateId", "P2")).first())!._id);
    expect(await code(as(fresh.t, "a").mutation(fn.approve, { eventId: fresh.eventId, proposalId: P2, revision: 1, selectionGeneration: 0, approvalRuleVersion: 1 })))
      .toBe("NOT_SELECTED");
  });

  it("lets only an assigned operator of a required side decide", async () => {
    const { t, eventId } = await selected();
    const args = await tick(t, eventId);
    for (const name of ["head", "eye", "unassigned", "c"]) {
      expect(await code(as(t, name).mutation(fn.approve, args))).toBe("FORBIDDEN");
      expect(await code(as(t, name).mutation(fn.veto, args))).toBe("FORBIDDEN");
    }
    expect(await code(t.mutation(fn.approve, args))).toBe("UNAUTHENTICATED");
    expect(await rows(t, eventId)).toEqual([]);
  });

  it("lets a head of ops read status without control and sends observers to their dedicated projection", async () => {
    const { t, eventId } = await selected();
    expect(await read(t, "head", eventId)).toMatchObject({ canAct: false, myTurn: false, mySide: "A", workflow: "bilateral" });
    expect(await code(read(t, "eye", eventId))).toBe("FORBIDDEN");
    expect(await read(t, "unassigned", eventId)).toMatchObject({ canAct: false, mySide: "A" });
    expect(await code(read(t, "c", eventId))).toBe("FORBIDDEN");
    expect(await code(t.query(fn.status, { eventId }))).toBe("UNAUTHENTICATED");
    const text = JSON.stringify([await read(t, "b", eventId), await read(t, "head", eventId)]);
    expect(text).not.toContain("PRIVATE_A");
    expect(text).not.toContain("7.625");
  });
});

describe("approval resets", () => {
  it("resets on a new selection, and switching back never revives the approval", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await pick(t, "b", eventId, "P3");
    expect(await read(t, "a", eventId)).toMatchObject({ turn: "A", approvals: { A: { status: "pending" } },
      lastReset: { reason: "selection_changed", at: expect.stringMatching(/^2026-10-24T12:00:00/) } });
    expect(await pick(t, "a", eventId, "P2")).toBe(3);
    expect((await read(t, "a", eventId)).approvals.A?.status).toBe("pending");
    expect((await rows(t, eventId)).map(r => r.current)).toEqual([false]);
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    expect((await read(t, "a", eventId)).approvals.A).toMatchObject({ status: "approved" });
    expect(await rows(t, eventId)).toHaveLength(2);
  });

  it("resets when the selected card gets a new revision, and the old revision is stale", async () => {
    const { t, eventId } = await selected();
    const old = await tick(t, eventId);
    await as(t, "a").mutation(fn.approve, old);
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false, candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }) });
    expect(await code(as(t, "b").mutation(fn.approve, old))).toBe("STALE_REVISION");
    expect(await read(t, "b", eventId)).toMatchObject({ selected: { revision: 2, generation: 2 }, turn: "A",
      approvals: { A: { status: "pending" } }, lastReset: { reason: "revision_changed" } });
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    expect(await as(t, "b").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: true });
  });

  it("vetoes in turn: approvals reset, the card stays selected and the event returns to the agents", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    expect(await as(t, "b").mutation(fn.veto, { ...await tick(t, eventId), reason: "Burn overlaps our downlink." })).toBeNull();
    expect(await read(t, "a", eventId)).toMatchObject({ selected: { label: "P2", generation: 2 }, approvals: { A: { status: "pending" } },
      lastReset: { reason: "vetoed" } });
    expect((await eventRow(t, eventId))!.status).toBe("agents");
    expect((await rows(t, eventId)).map(r => [r.side, r.status, r.current, r.reason])).toEqual([
      ["A", "approved", false, null], ["B", "vetoed", false, "Burn overlaps our downlink."]]);
    expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await code(as(t, "a").mutation(fn.veto, { ...await tick(t, eventId), reason: "x".repeat(501) }))).toBe("VALIDATION");
    // The agents' revision brings the event back to a decision on the new revision.
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false, candidates: withCard("P2", { revision: 2, missAfterKm: 2.4 }) });
    expect((await eventRow(t, eventId))!.status).toBe("proposal");
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
  });

  it("stops counting an approval when the approver's assignment is revoked", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await t.mutation(internal.operators.provision, companyA([]));
    expect(await read(t, "b", eventId)).toMatchObject({ allRequiredApproved: false, approvals: { A: { status: "pending" } } });
  });

  it("never revives a revoked approval when the assignment comes back, and keeps A's turn", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await t.mutation(internal.operators.provision, companyA([]));
    await t.mutation(internal.operators.provision, companyA());
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", selectionGeneration: 3, approvals: { A: { status: "pending" } },
      lastReset: { reason: "assignment_changed" } });
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
  });

  it("stops counting an approval the revalidation sweep missed once the approver's assignments changed", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    const a = await userId(t, "a");
    // An assignment change the sweep never saw: only the version moves; the row stays current and exact.
    await t.run(async ctx => { await ctx.db.patch(a, { assignmentVersion: 9 }); });
    expect(await t.run(async ctx => decisionTurn(ctx, (await ctx.db.get(eventId))!))).toMatchObject({ turn: "A" });
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", approvals: { A: { status: "pending" } } });
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
  });

  it("resets approvals on a policy edit and refuses decisions on stale evidence", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await as(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, minFuelReserveKg: 7.5 }] });
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", approvals: { A: { status: "pending" } }, lastReset: { reason: "policy_changed" } });
    await t.run(ctx => ctx.db.patch(eventId, { missKm: 0.3 }));
    expect(await code(as(t, "a").mutation(fn.approve, await tick(t, eventId)))).toBe("STALE_REVISION");
    expect(await rows(t, eventId)).toHaveLength(1);
  });

  it("resets approvals when the same cards are recomputed on new evidence", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await t.run(ctx => ctx.db.patch(eventId, { pcValue: 3e-4 }));
    expect(await t.mutation(internal.candidates.publish, { eventId, baseVersion: 1, start: false, candidates: advocateCandidates }))
      .toMatchObject({ version: 2, changed: true });
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", selected: { revision: 1, generation: 2 },
      approvals: { A: { status: "pending" } }, lastReset: { reason: "evidence_changed" } });
  });

  it("resets the approvals of an inactive but undecided incident, so a reactivated one starts over", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await t.run(ctx => ctx.db.patch(eventId, { active: false }));
    await as(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, minFuelReserveKg: 7.5 }] });
    await t.run(ctx => ctx.db.patch(eventId, { active: true }));
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", approvals: { A: { status: "pending" } }, lastReset: { reason: "policy_changed" } });
  });

  it("flags an agreed plan for review instead of undoing it on a policy edit or revocation", async () => {
    const { t, eventId } = await selected();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await as(t, "b").mutation(fn.approve, await tick(t, eventId));
    await as(t, "a").mutation(api.policies.update, { satellites: [{ ...policyA, minFuelReserveKg: 7.5 }] });
    await t.mutation(internal.operators.provision, companyA([]));
    expect(await read(t, "head", eventId)).toMatchObject({ selectionGeneration: 3, lastReset: { reason: "assignment_changed" },
      reviewRequired: true, deciding: false, turn: null, canAct: false, allRequiredApproved: false, approvals: { B: { status: "pending" } } });
    expect((await rows(t, eventId)).map(r => r.current)).toEqual([false, false]);
    expect((await eventRow(t, eventId))!.status).toBe("approved");
    expect(await t.run(async ctx => (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique())!.reviewRequired))
      .toBe(true);
  });
});

describe("approval workflows", () => {
  it("needs only the active operator against confirmed debris, with no B entry", async () => {
    const { t } = await seed();
    const eventId = await insertEvent(t, { ...advocateEvent, objectB: { ...advocateEvent.objectA, objectId: "SIM-7001", name: "Debris fixture" } });
    // A trusted classifier (ingestion or the demo seed) stores confirmed debris; ownership alone never infers it.
    await t.run(ctx => ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["A"], approvalRuleVersion: 1 }));
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, start: false,
      candidates: advocateCandidates.filter(c => c.movingSide !== "B") });
    await pick(t, "a", eventId, "P1");
    const s = await read(t, "a", eventId);
    expect(s).toMatchObject({ workflow: "unilateral_debris", requiredApprovalSides: ["A"], turn: "A", myTurn: true });
    expect("B" in s.approvals).toBe(false);
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("FORBIDDEN");
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toEqual({ allRequiredApproved: true, requiredApprovalSides: ["A"] });
  });

  it("never reaches a decision with an unregistered side or within one company", async () => {
    const { t } = await seed();
    const unowned = await insertEvent(t, { ...advocateEvent, objectB: { ...advocateEvent.objectA, objectId: "SIM-7002", name: "Unowned" } });
    expect(await code(t.mutation(internal.candidates.publish, { eventId: unowned, baseVersion: null, start: false,
      candidates: advocateCandidates.filter(c => c.movingSide !== "B") })))
      .toBe("INVALID_STATE");
    expect(await read(t, "a", unowned)).toMatchObject({ workflow: null, requiredApprovalSides: [], canAct: false, allRequiredApproved: false });
    const internalEvent = await insertEvent(t, { ...advocateEvent, objectB: { ...advocateEvent.objectA, objectId: "SIM-1005", name: "Second A" } });
    await t.mutation(internal.operators.provision, companyA(["SIM-1001"], ["SIM-1001", "SIM-1005"]));
    expect(await read(t, "a", internalEvent)).toMatchObject({ mySide: null, canAct: false, allRequiredApproved: false });
  });
});

describe("approvals and the coordination room", () => {
  it("posts the reset line in the room and closes it on consensus; the host sees the recorded approvals", async () => {
    const { t, eventId } = await selected();
    const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
    const lines = () => t.run(async ctx => (await ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", roomId)).collect())
      .filter(m => m.kind === "system").map(m => m.originalText));
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    // The approval this module wrote is the one the Coordination Host's context reports (hostContext.recordedApprovals).
    const host = await t.run(async ctx => buildHostContext(ctx, (await ctx.db.get(roomId))!, "final_message"));
    const companyAId = await t.run(async ctx => (await ctx.db.query("companies").withIndex("by_key", q => q.eq("key", "a")).unique())!._id);
    expect(host.events[0].approvals).toEqual([expect.objectContaining({ companyId: companyAId, revision: 1 })]);
    await pick(t, "b", eventId, "P3");
    expect(await lines()).toEqual(["Both approvals reset."]);
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    await as(t, "b").mutation(fn.approve, await tick(t, eventId));
    expect(await t.run(async ctx => (await ctx.db.get(roomId))!.state)).toBe("closed");
    expect((await lines()).at(-1)).toBe("Every linked incident is resolved; the room is closed.");
    expect((await selection(t, eventId))!.generation).toBe(2);
  });
});

// Inbox notices from approve and veto (issue #6 round 3). Every operator of a required side ends on the new state.
// Colleagues receive it unread. The actor's existing row gets the same summary and stays read. a2 is a second
// operator on A's object. c is another company's operator with an active assignment on that same object.
const NOT_NOTIFIED = ["unassigned", "head", "eye", "c"];
async function withSecondA(t: Backend) {
  const base = companyA();
  await t.mutation(internal.operators.provision, { ...base, members: [...base.members,
    { tokenIdentifier: token("a2"), role: "operator" as const, assignedObjectIds: ["SIM-1001"], name: "A2" }] });
}
async function foreignOnSameObject(t: Backend) {
  await t.run(async ctx => {
    const c = (await ctx.db.query("users").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", token("c"))).unique())!;
    await ctx.db.insert("fleetAssignments", { userId: c._id, objectId: "SIM-1001", active: true });
  });
}
/** Every inbox row of the event, by user name. */
const notices = (t: Backend, eventId: Id<"events">) => t.run(async ctx => {
  const rows = (await ctx.db.query("inbox").collect()).filter(r => r.eventId === eventId);
  return Object.fromEntries(await Promise.all(rows.map(async r => [(await ctx.db.get(r.userId))!.name!.toLowerCase(),
    { unread: r.unread, at: r.lastUpdateAt, summary: r.lastUpdateSummary }] as const)));
});
const later = (ms = 1000) => vi.setSystemTime(Date.now() + ms);
const shown = async (t: Backend, who: string, eventId: Id<"events">) =>
  await as(t, who).query(api.inbox.get, { eventId }) as { unread: boolean; lastUpdateSummary: string };

describe("approval inbox notices", () => {
  it("tells the side in turn after an approval and every required side on consensus, once", async () => {
    const { t, eventId } = await seed();
    await withSecondA(t);
    await foreignOnSameObject(t);
    await pick(t, "a", eventId, "P2");
    later();
    const before = await notices(t, eventId);
    // Refused calls write nothing: off turn, stale revision.
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await code(as(t, "a").mutation(fn.approve, { ...await tick(t, eventId), revision: 2 }))).toBe("STALE_REVISION");
    expect(await notices(t, eventId)).toEqual(before);

    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    const turn = "Side A approved P2 revision 1. It is your turn to decide.";
    const waiting = "Side A approved P2 revision 1. Waiting for side B.";
    expect(await shown(t, "b", eventId)).toMatchObject({ unread: true, lastUpdateSummary: turn });
    expect(await shown(t, "a2", eventId)).toMatchObject({ unread: true, lastUpdateSummary: waiting });
    const afterA = await notices(t, eventId);
    // A's colleague hears that A is waiting. A had no inbox row, so none is created. c still has none.
    expect(afterA.a2.summary).toBe(waiting);
    expect(afterA.a2.unread).toBe(true);
    expect(afterA.a2.at).toBeGreaterThan(before.a2.at);
    expect(afterA.a).toBeUndefined();
    for (const name of NOT_NOTIFIED) expect(afterA[name]).toBeUndefined();

    later();
    // Approving the same tick again changes nothing, the notice included.
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    expect(await notices(t, eventId)).toEqual(afterA);

    await as(t, "b").mutation(fn.approve, await tick(t, eventId));
    const agreed = "Both sides approved P2 revision 1. The plan is agreed.";
    expect(await shown(t, "a", eventId)).toMatchObject({ unread: true, lastUpdateSummary: agreed });
    expect(await shown(t, "a2", eventId)).toMatchObject({ unread: true, lastUpdateSummary: agreed });
    const final = await notices(t, eventId);
    // B already had a row. It now says the plan is agreed, and it stays read.
    expect(final.b).toMatchObject({ unread: false, summary: agreed });
    expect(final.b.at).toBeGreaterThan(afterA.b.at);
    for (const name of NOT_NOTIFIED) expect(final[name]).toBeUndefined();

    later();
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("ALREADY_DECIDED");
    expect(await notices(t, eventId)).toEqual(final);
  });

  it("tells every required side of a veto without its reason", async () => {
    const { t, eventId } = await seed();
    await withSecondA(t);
    await foreignOnSameObject(t);
    await pick(t, "a", eventId, "P2");
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    later();
    const before = await notices(t, eventId);
    expect(await code(as(t, "a").mutation(fn.veto, { ...await tick(t, eventId), reason: "Off turn." }))).toBe("INVALID_STATE");
    expect(await notices(t, eventId)).toEqual(before);

    const reason = "Our fuel floor is 3.1 kg on SIM-1002.";
    await as(t, "b").mutation(fn.veto, { ...await tick(t, eventId), reason });
    const vetoed = "Side B vetoed P2 revision 1. Approvals were reset and the incident is back with the agents.";
    expect(await shown(t, "a", eventId)).toMatchObject({ unread: true, lastUpdateSummary: vetoed });
    expect(await shown(t, "a2", eventId)).toMatchObject({ unread: true, lastUpdateSummary: vetoed });
    const after = await notices(t, eventId);
    // B's own row takes the same summary and stays read. The reason is not in it.
    expect(after.b).toMatchObject({ unread: false, summary: vetoed });
    expect(after.b.at).toBeGreaterThan(before.b.at);
    for (const name of NOT_NOTIFIED) expect(after[name]).toBeUndefined();
    for (const row of Object.values(after)) expect(row.summary).not.toMatch(/fuel|3\.1/);
  });

  it("against debris notifies only the required side, and the first approval agrees the plan", async () => {
    const { t } = await seed();
    await withSecondA(t);
    const eventId = await insertEvent(t, { ...advocateEvent, objectB: { ...advocateEvent.objectA, objectId: "SIM-7001", name: "Debris fixture" } });
    await t.run(ctx => ctx.db.patch(eventId, { workflow: "unilateral_debris", requiredApprovalSides: ["A"], approvalRuleVersion: 1 }));
    await t.mutation(internal.candidates.publish, { eventId, baseVersion: null, start: false,
      candidates: advocateCandidates.filter(c => c.movingSide !== "B") });
    await pick(t, "a", eventId, "P1");
    later();
    await as(t, "a").mutation(fn.approve, await tick(t, eventId));
    expect(await shown(t, "a2", eventId)).toMatchObject({ unread: true, lastUpdateSummary: "Side A approved P1 revision 1. The plan is agreed." });
    expect(Object.keys(await notices(t, eventId))).toEqual(["a2"]);
  });
});
