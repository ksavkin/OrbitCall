import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference as ref } from "convex/server";
import { api } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import type { AgentSpan, HostContext, HostOutput } from "../convex/lib/host";
import { as, fn, pick, seed, userId } from "./decision";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const request = ref<"mutation">("hostTriggers:request"), finish = ref<"mutation">("hostTriggers:finish");
const contextRef = ref<"query">("hostTriggers:context");
async function setup() {
  const { t, eventId } = await seed();
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId });
  const { messageId } = await as(t, "a").mutation(api.messages.send, { roomId, eventId, text: "Please review our options." });
  const hostRunId = await t.mutation(request, { roomId, trigger: "final_message" });
  const context = await t.query(contextRef, { roomId, trigger: "final_message" }) as HostContext;
  const span: AgentSpan = { role: "coordination_host", provider: "google", model: "fixture", inputVersion: context.inputVersion,
    attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
  const output: HostOutput = { inputVersion: context.inputVersion,
    summaries: [{ eventId, text: "The operators are reviewing the options.", messageIds: [messageId] }],
    clarifications: [{ eventId, question: "Which option should be reconsidered?", messageIds: [messageId] }],
    requestedRevisions: [] };
  const check = { span: { ...span, role: "rationale_check" as const, provider: "xai" as const },
    result: { agrees: true, reason: "Grounded explanation.", flaggedCandidateIds: [] as string[] } };
  await t.run(async ctx => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  const complete = (extra = {}) => t.mutation(finish, { hostRunId, span, output, check, ...extra });
  const jobs = () => t.run(async ctx => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter(job => job.name === "call/hostSpeech:speak"));
  return { t, eventId, roomId, messageId, hostRunId, span, output, check, complete, jobs };
}

describe("checked Host speech wiring", () => {
  it("queues only checked summaries and questions once, without creating a human decision", async () => {
    const s = await setup();
    await s.complete(); await s.complete();
    const jobs = await s.jobs();
    expect(jobs.map(job => job.args[0])).toEqual([
      { roomId: s.roomId, hostRunId: s.hostRunId, text: s.output.summaries[0].text, expectedInputVersion: expect.any(String) },
      { roomId: s.roomId, hostRunId: s.hostRunId, text: s.output.clarifications[0].question, expectedInputVersion: expect.any(String) },
    ]);
    expect(await s.t.run(ctx => ctx.db.get(s.hostRunId))).toMatchObject({ status: "succeeded" });
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(await s.t.run(ctx => ctx.db.query("selections").collect())).toEqual([]);
  });

  it("deduplicates identical checked text and never voices raw checker explanations", async () => {
    const s = await setup();
    await s.complete({ output: { ...s.output, clarifications: [{ ...s.output.clarifications[0], question: s.output.summaries[0].text }] },
      check: { ...s.check, result: { agrees: false, reason: "Unchecked diagnostic prose.", flaggedCandidateIds: [] } } });
    expect(await s.jobs()).toHaveLength(1);
    expect(JSON.stringify(await s.jobs())).not.toContain("Unchecked diagnostic");
  });

  it.each(["failed", "stale", "closed"])("queues no speech from %s work", async reason => {
    const s = await setup();
    if (reason === "stale") await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, text: "New information." });
    if (reason === "closed") await s.t.run(ctx => ctx.db.patch(s.roomId, { state: "closed", closedAt: Date.now() }));
    await s.complete(reason === "failed" ? { check: { ...s.check, span: { ...s.check.span, status: "failed" }, result: null } } : {});
    expect(await s.jobs()).toEqual([]);
  });

  it.each(["message", "evidence", "selection", "assignment"])("rejects queued speech after a later %s change", async change => {
    const s = await setup();
    await s.complete();
    const [job] = await s.jobs();
    if (change === "message") await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, eventId: s.eventId, text: "Actually, please reconsider that." });
    if (change === "evidence") await s.t.run(ctx => ctx.db.patch(s.eventId, { missKm: 0.7 }));
    if (change === "selection") await pick(s.t, "a", s.eventId, "P1");
    if (change === "assignment") {
      const id = await userId(s.t, "a");
      await s.t.run(ctx => ctx.db.patch(id, { assignmentVersion: 2 }));
    }
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await s.t.action(ref<"action">("call/hostSpeech:speak"), job.args[0])).toEqual({ status: "rejected", reason: "stale" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await s.t.run(ctx => ctx.db.get(s.hostRunId))).toMatchObject({ status: "succeeded" });
  });

  it("pins its own newly published understanding without making that speech stale", async () => {
    const s = await setup();
    await s.complete({ output: { ...s.output, understood: [{ eventId: s.eventId, kind: "preference", hard: false,
      text: "Please review our options.", sourceMessageId: s.messageId, correctsId: null }] } });
    expect(await s.t.run(ctx => ctx.db.query("understood").collect())).toHaveLength(1);
    const [job] = await s.jobs();
    expect(job.args[0].expectedInputVersion).not.toBe(s.output.inputVersion);
    expect(await s.t.query(ref<"query">("call/hostSpeech:prepare"), job.args[0])).toMatchObject({ ok: true });
  });

  it("keeps the written result when queued voice delivery fails", async () => {
    const s = await setup();
    const uid = await userId(s.t, "a");
    await s.t.run(async ctx => {
      const member = (await ctx.db.query("roomMembers").withIndex("by_room_user", q => q.eq("roomId", s.roomId).eq("userId", uid)).first())!;
      await ctx.db.patch(member._id, { inRoom: true, inCall: true });
    });
    vi.stubEnv("LIVEKIT_URL", "wss://fixture.invalid"); vi.stubEnv("LIVEKIT_API_KEY", "fixture"); vi.stubEnv("LIVEKIT_API_SECRET", "fixture");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await s.complete(); await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await s.t.run(ctx => ctx.db.get(s.hostRunId))).toMatchObject({ status: "succeeded" });
      const messages = await s.t.run(ctx => ctx.db.query("messages").collect());
      expect(messages.filter(message => message.author.kind === "agent")).toHaveLength(2);
      expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
      expect(await s.t.run(ctx => ctx.db.query("call_phrases").collect())).toEqual([]);
    } finally { warning.mockRestore(); }
  });
});
