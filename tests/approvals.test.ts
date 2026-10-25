import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { FIXTURE_NOW } from "../fixtures/events";
import { advocateCandidates, advocateEvent, policyA } from "../fixtures/policies";
import { buildHostContext } from "../convex/lib/hostContext";
import { insertEvent, type Backend } from "./helpers";
import { as, code, companyA, fn, pick, seed, selection, tick, userId, withCard } from "./decision";

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
    expect(await read(t, "eye", eventId)).toMatchObject({ allRequiredApproved: true, deciding: false, turn: null, lastReset: null,
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

  it("lets a head of ops and the observer read status without control, and nobody else", async () => {
    const { t, eventId } = await selected();
    expect(await read(t, "head", eventId)).toMatchObject({ canAct: false, myTurn: false, mySide: "A", workflow: "bilateral" });
    expect(await read(t, "eye", eventId)).toMatchObject({ canAct: false, myTurn: false, mySide: null, turn: "A" });
    expect(await read(t, "unassigned", eventId)).toMatchObject({ canAct: false, mySide: "A" });
    expect(await code(read(t, "c", eventId))).toBe("FORBIDDEN");
    expect(await code(t.query(fn.status, { eventId }))).toBe("UNAUTHENTICATED");
    const text = JSON.stringify([await read(t, "b", eventId), await read(t, "eye", eventId)]);
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
    expect(await read(t, "b", eventId)).toMatchObject({ turn: "A", selectionGeneration: 2, approvals: { A: { status: "pending" } },
      lastReset: { reason: "assignment_revoked" } });
    expect(await code(as(t, "b").mutation(fn.approve, await tick(t, eventId)))).toBe("INVALID_STATE");
    expect(await as(t, "a").mutation(fn.approve, await tick(t, eventId))).toMatchObject({ allRequiredApproved: false });
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
    expect(await read(t, "eye", eventId)).toMatchObject({ selectionGeneration: 1, lastReset: null, approvals: { B: { status: "approved" } } });
    expect((await rows(t, eventId)).map(r => r.current)).toEqual([true, true]);
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
