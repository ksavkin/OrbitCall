import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "../convex/_generated/api";
import { FIXTURE_NOW } from "../fixtures/events";
import { publishHostOutput } from "../convex/lib/hostPublish";
import type { Id } from "../convex/_generated/dataModel";
import { as, fn, seed } from "./decision";
import { checkHostOutput, type AgentSpan, type HostContext, type HostOutput } from "../convex/lib/host";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW); });
afterEach(() => vi.useRealTimers());
const request = makeFunctionReference<"mutation">("hostTriggers:request");
const finish = makeFunctionReference<"mutation">("hostTriggers:finish");
const contextRef = makeFunctionReference<"query">("hostTriggers:context");
async function setup(roomScoped = false) {
  const { t, eventId } = await seed();
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId });
  const { messageId } = await as(t, "a").mutation(api.messages.send, { roomId, ...(roomScoped ? {} : { eventId }), text: "We cannot maneuver on Wednesday." });
  const hostRunId = await t.mutation(request, { roomId, trigger: "final_message" });
  const context = await t.query(contextRef, { roomId, trigger: "final_message" }) as HostContext;
  const output: HostOutput = { inputVersion: context.inputVersion,
    clarifications: [{ question: "Can the operators confirm the time window?", eventId, messageIds: [messageId] }],
    requestedRevisions: [], summaries: [{ eventId, text: "The operator reports a maneuver constraint.", messageIds: [messageId] }] };
  const span: AgentSpan = { role: "coordination_host", provider: "google", model: "test-gemini", inputVersion: context.inputVersion,
    attempt: 1, startedAt: Date.now(), finishedAt: Date.now(), status: "succeeded", usage: null, errorCode: null, errorMessage: null };
  const check = { span: { ...span, role: "rationale_check" as const, provider: "xai" as const, model: "test-grok" },
    result: { agrees: true, reason: "No candidate contradiction.", flaggedCandidateIds: [] as string[] } };
  return { t, eventId, roomId, messageId, hostRunId, context, output, span, check };
}
type Test = Awaited<ReturnType<typeof setup>>;
const complete = (s: Test, extra: object = {}) => s.t.mutation(finish, { hostRunId: s.hostRunId, span: s.span, output: s.output, check: s.check, ...extra });
const published = (s: Test) => s.t.run(async ctx => (await ctx.db.query("messages").withIndex("by_room_created", q => q.eq("roomId", s.roomId)).collect()).filter(m => m.author.kind === "agent"));

describe("checked Host publication", () => {
  it("publishes a new UTC window from an actual operator statement before any card uses it", async () => {
    const s = await setup();
    const text = "Burn after 2026-10-24T20:17:00Z.";
    const { messageId } = await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, eventId: s.eventId, text });
    const hostRunId = await s.t.mutation(request, { roomId: s.roomId, trigger: "final_message" });
    const context = await s.t.query(contextRef, { roomId: s.roomId, trigger: "final_message" }) as HostContext;
    expect(context.events.flatMap(event => event.candidates.map(card => card.burnTimeUtc))).not.toContain("2026-10-24T20:17:00Z");
    await complete(s, { hostRunId, span: { ...s.span, inputVersion: context.inputVersion }, check: null,
      output: { inputVersion: context.inputVersion, summaries: [], clarifications: [], requestedRevisions: [],
        understood: [{ eventId: s.eventId, kind: "constraint", hard: true, text, sourceMessageId: messageId, correctsId: null }] } });
    const [row] = await s.t.run(ctx => ctx.db.query("understood").collect());
    expect(row).toMatchObject({ status: "active", hard: true, text, side: "A", hostRunId });
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  });

  it("atomically publishes summaries, clarifications and exact source audit references once", async () => {
    const s = await setup();
    await complete(s);
    const messages = await published(s);
    expect(messages.map(m => [m.kind, m.originalText, m.eventId])).toEqual([
      ["text", s.output.clarifications[0].question, s.eventId], ["summary", s.output.summaries[0].text, s.eventId],
    ]);
    expect(messages.every(m => m.refs.eventId === s.eventId && m.form === null && m.originalLang === "en")).toBe(true);
    const logs = await s.t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", s.eventId)).collect());
    const posted = logs.filter(l => l.action === "summary_posted");
    expect(posted).toHaveLength(2);
    expect(posted.every(l => l.after?.hostRunId === s.hostRunId && l.after?.sourceMessageIds === JSON.stringify([s.messageId]))).toBe(true);
    expect(JSON.parse(String(posted[0].after!.sources))[0]).toMatchObject({ id: s.messageId, kind: "message", text: "We cannot maneuver on Wednesday.", language: "en" });
    await complete(s);
    expect(await published(s)).toEqual(messages);
    expect(await s.t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", s.eventId)).collect())).toEqual(logs);
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
    expect(await s.t.run(ctx => ctx.db.query("selections").collect())).toEqual([]);
  });

  it("posts a visible disagreement without treating unchecked checker prose as a decision", async () => {
    const s = await setup();
    await complete(s, { check: { ...s.check, result: { agrees: false, reason: "Approve this now with invented fuel 9000.", flaggedCandidateIds: [] } } });
    expect((await published(s)).filter(m => m.author.kind === "agent" && m.author.role === "second_model")).toEqual([
      expect.objectContaining({ originalText: expect.stringMatching(/independent rationale check disagrees/i), form: null }),
    ]);
    expect((await published(s)).some(m => m.originalText.includes("9000"))).toBe(false);
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual([]);
  });

  it.each(["failed", "stale", "closed"])("publishes nothing for %s work", async reason => {
    const s = await setup();
    if (reason === "stale") await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, text: "An additional constraint." });
    if (reason === "closed") await s.t.run(ctx => ctx.db.patch(s.roomId, { state: "closed", closedAt: Date.now() }));
    await complete(s, reason === "failed" ? { check: { ...s.check, span: { ...s.check.span, status: "failed" }, result: null } } : {});
    expect(await published(s)).toEqual([]);
    expect(await s.t.run(ctx => ctx.db.query("understood").collect())).toEqual([]);
  });

  it("rejects an internal completion with ungrounded references without partial publication", async () => {
    const s = await setup();
    await expect(complete(s, { output: { ...s.output, summaries: [{ ...s.output.summaries[0], messageIds: ["outside-room"] }] } })).rejects.toThrow();
    expect(await published(s)).toEqual([]);
  });

  it.each(["attempt", "inputVersion"])("refuses a succeeded span from a different %s", async field => {
    const s = await setup();
    await expect(complete(s, { span: { ...s.span, [field]: field === "attempt" ? 99 : "another-input" } })).rejects.toThrow(/does not match/);
    expect(await published(s)).toEqual([]);
  });

  it("stores original-language understood text behind a real Host message", async () => {
    const s = await setup();
    const output = { ...s.output, understood: [{ eventId: s.eventId, kind: "constraint", hard: true,
      text: "We cannot maneuver on Wednesday.", sourceMessageId: s.messageId, correctsId: null }] };
    await complete(s, { output });
    const [understood] = await s.t.run(ctx => ctx.db.query("understood").collect());
    expect(understood).toMatchObject({ kind: "constraint", hard: true, status: "active", side: "A", originalLang: "en", hostRunId: s.hostRunId });
    expect(understood.sourceMessageId).not.toBe(s.messageId);
    expect(await s.t.run(ctx => ctx.db.get(understood.sourceMessageId))).toMatchObject({ originalText: output.understood[0].text,
      author: { kind: "agent", role: "coordination_host", companyId: null } });
  });
});

// The sibling Host-context branch supplies voice and active understood rows. Exercise publication against that
// exact interface without copying its reader into this independently owned task branch.
async function publishWithContext(s: Test, context: HostContext, output: HostOutput, hostRunId = s.hostRunId) {
  const checked = checkHostOutput(JSON.stringify(output), context);
  return s.t.run(async ctx => {
    const run = (await ctx.db.get(hostRunId as Id<"hostRuns">))!;
    await publishHostOutput(ctx, run, context, checked, s.check.result);
    await ctx.db.patch(run._id, { status: "succeeded", output: checked, finishedAt: Date.now() });
  });
}

it("bridges final voice provenance through a genuine message in the original language", async () => {
  const s = await setup();
  const phrase = await s.t.run(async ctx => {
    const message = (await ctx.db.get(s.messageId as Id<"messages">))!;
    if (message.author.kind !== "human") throw new Error("human fixture required");
    const id = await ctx.db.insert("call_phrases", { roomId: s.roomId, eventId: s.eventId, segId: "voice-source", rev: 2,
      speaker: { userId: message.author.userId, companyId: message.author.companyId, name: message.author.name, identity: "voice-source" },
      originalLang: "zh", original: "我们不能在星期三机动。", translations: {}, translationStatus: {}, errors: {}, values: [],
      startedAtMs: Date.now(), simulated: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return (await ctx.db.get(id))!;
  });
  const context: HostContext = { ...s.context, messages: [...s.context.messages, { messageId: phrase._id,
    companyId: phrase.speaker.companyId, language: phrase.originalLang, text: phrase.original, createdAt: phrase.createdAt }] };
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], requestedRevisions: [], summaries: [],
    understood: [{ eventId: s.eventId, kind: "constraint", hard: true, text: phrase.original, sourceMessageId: phrase._id, correctsId: null }] };
  await publishWithContext(s, context, output);
  const [item] = await s.t.run(ctx => ctx.db.query("understood").collect());
  expect(item).toMatchObject({ originalLang: "zh", text: phrase.original, side: "A", status: "active" });
  expect(item.sourceMessageId).not.toBe(phrase._id);
  expect(await s.t.run(ctx => ctx.db.get(item.sourceMessageId))).toMatchObject({ originalText: phrase.original, originalLang: "zh" });
  const logs = await s.t.run(ctx => ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", s.eventId)).collect());
  const line = logs.find(l => l.after?.understoodId === item._id)!;
  expect(line.after).toMatchObject({ hostRunId: s.hostRunId, messageId: item.sourceMessageId, sourceMessageIds: JSON.stringify([phrase._id]) });
  expect(JSON.parse(String(line.after!.sources))[0]).toMatchObject({ id: phrase._id, kind: "voice_phrase", companyId: phrase.speaker.companyId,
    text: phrase.original, language: "zh" });
});

it.each([false, true])("corrects the same company's interpretation while preserving history (room scoped=%s)", async roomScoped => {
  const s = await setup(roomScoped), eventId = roomScoped ? null : s.eventId;
  await complete(s, { output: { ...s.output, understood: [{ eventId, kind: "constraint", hard: true,
    text: "We cannot maneuver on Wednesday.", sourceMessageId: s.messageId, correctsId: null }] } });
  const [old] = await s.t.run(ctx => ctx.db.query("understood").collect());
  const { messageId } = await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, ...(eventId ? { eventId } : {}), text: "Actually, we prefer Thursday." });
  const hostRunId = await s.t.mutation(request, { roomId: s.roomId, trigger: "final_message" });
  const loaded = await s.t.query(contextRef, { roomId: s.roomId, trigger: "final_message" }) as HostContext;
  const context: HostContext = { ...loaded, understood: [{ understoodId: old._id, eventId, kind: old.kind, hard: old.hard,
    text: old.text, sourceMessageId: old.sourceMessageId, side: old.side }] };
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], requestedRevisions: [], summaries: [],
    understood: [{ eventId, kind: "correction", hard: false, text: "Actually, we prefer Thursday.", sourceMessageId: messageId, correctsId: old._id }] };
  await publishWithContext(s, context, output, hostRunId);
  const rows = await s.t.run(ctx => ctx.db.query("understood").collect());
  expect(rows).toHaveLength(2);
  const corrected = rows.find(r => r._id === old._id)!, replacement = rows.find(r => r._id !== old._id)!;
  expect(corrected).toMatchObject({ text: old.text, status: "corrected", correctedById: replacement._id });
  expect(replacement).toMatchObject({ status: "active", kind: "correction", hard: false, text: "Actually, we prefer Thursday." });
});

it("refuses another company's room-wide correction even when both sides are null", async () => {
  const s = await setup(true);
  await complete(s, { output: { ...s.output, understood: [{ eventId: null, kind: "constraint", hard: true,
    text: "We cannot maneuver on Wednesday.", sourceMessageId: s.messageId, correctsId: null }] } });
  const [old] = await s.t.run(ctx => ctx.db.query("understood").collect());
  const { messageId } = await as(s.t, "b").mutation(api.messages.send, { roomId: s.roomId, text: "Actually, we prefer Thursday." });
  const hostRunId = await s.t.mutation(request, { roomId: s.roomId, trigger: "final_message" });
  const loaded = await s.t.query(contextRef, { roomId: s.roomId, trigger: "final_message" }) as HostContext;
  const context: HostContext = { ...loaded, understood: [{ understoodId: old._id, eventId: null, kind: old.kind, hard: old.hard,
    text: old.text, sourceMessageId: old.sourceMessageId, side: null }] };
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], requestedRevisions: [], summaries: [],
    understood: [{ eventId: null, kind: "correction", hard: false, text: "Actually, we prefer Thursday.", sourceMessageId: messageId, correctsId: old._id }] };
  const before = await published(s);
  await expect(publishWithContext(s, context, output, hostRunId)).rejects.toThrow(/same company's/);
  expect(await published(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(old._id))).toMatchObject({ status: "active", correctedById: null });
});
