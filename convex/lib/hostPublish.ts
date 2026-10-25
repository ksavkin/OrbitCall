import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { CheckResult } from "./checker";
import type { HostContext, HostOutput, HostUnderstanding, Language } from "./host";

const invalid = (message: string): never => { throw new ConvexError({ code: "CONSTRAINT_CHECK_FAILED", message }); };
type Source = { id: string; kind: "message" | "voice_phrase"; companyId: string; userId: string | null;
  text: string; language: Language; eventId: string | null };

/** Resolve the real source table. Voice IDs are never cast to messages IDs. */
async function sourceOf(ctx: MutationCtx, run: Doc<"hostRuns">, id: string): Promise<Source> {
  const messageId = ctx.db.normalizeId("messages", id);
  const message = messageId && await ctx.db.get(messageId);
  if (message) {
    if (message.roomId !== run.roomId || message.demoRunId !== run.demoRunId || message.author.kind === "system" ||
      !message.author.companyId) return invalid("A cited message is outside the shared conversation.");
    return { id, kind: "message", companyId: message.author.companyId,
      userId: message.author.kind === "human" ? message.author.userId : null,
      text: message.originalText, language: message.originalLang, eventId: message.eventId };
  }
  const phraseId = ctx.db.normalizeId("call_phrases", id);
  const phrase = phraseId && await ctx.db.get(phraseId);
  if (!phrase || phrase.roomId !== run.roomId || phrase.rev < 2 ||
    Object.values(phrase.translationStatus).includes("pending")) return invalid("A cited voice phrase is missing, unfinished or outside the room.");
  return { id, kind: "voice_phrase", companyId: phrase.speaker.companyId, userId: phrase.speaker.userId,
    text: phrase.original, language: phrase.originalLang, eventId: phrase.eventId };
}

/** Constraints belong to the current human operator who stated them, never an agent or another company's voice. */
async function sourceSide(ctx: MutationCtx, context: HostContext, source: Source, eventId: Id<"events"> | null) {
  const userId = source.userId && ctx.db.normalizeId("users", source.userId);
  const user = userId && await ctx.db.get(userId);
  if (!user || user.role !== "operator" || user.companyId !== source.companyId) return invalid("Understood entries require a current operator's own statement.");
  if (source.eventId !== null && source.eventId !== eventId) return invalid("The statement belongs to a different incident.");
  const ids = eventId ? [eventId] : context.events.map(e => ctx.db.normalizeId("events", e.eventId));
  for (const id of ids) {
    const event = id && await ctx.db.get(id);
    if (!event) continue;
    for (const [side, objectId] of [["A", event.objectAId], ["B", event.objectBId]] as const) {
      const object = await ctx.db.get(objectId);
      if (!object) continue;
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", object.objectId)).unique();
      const assignment = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", user._id).eq("objectId", object.objectId)).unique();
      if (owner?.companyId === source.companyId && assignment?.active) return eventId ? side : null;
    }
  }
  return invalid("The speaker no longer represents this incident.");
}

// Historical source authority comes from the original human message or our immutable publication audit, not side alone.
async function originalCompany(ctx: MutationCtx, old: Doc<"understood">): Promise<string> {
  const message = await ctx.db.get(old.sourceMessageId);
  if (!message || message.roomId !== old.roomId || message.demoRunId !== old.demoRunId) return invalid("The prior interpretation has no valid source.");
  if (message.author.kind === "human") return message.author.companyId;
  if (message.author.kind !== "agent" || message.author.role !== "coordination_host" || !old.hostRunId) return invalid("The prior interpretation has no human provenance.");
  const run = await ctx.db.get(old.hostRunId);
  if (!run || run.status !== "succeeded" || run.roomId !== old.roomId || run.demoRunId !== old.demoRunId) return invalid("The prior interpretation's run is unavailable.");
  const history = await ctx.db.query("log").withIndex("by_event_at", q => q.eq("eventId", old.eventId)).order("desc").take(501);
  const line = history.find(l => l.action === "summary_posted" && l.roomId === old.roomId && l.demoRunId === old.demoRunId &&
    l.after?.hostRunId === old.hostRunId && l.after?.messageId === old.sourceMessageId && l.after?.understoodId === old._id);
  if (!line || typeof line.after?.sources !== "string") return invalid("The prior interpretation's source audit is unavailable.");
  try {
    const sources: unknown = JSON.parse(line.after.sources);
    if (Array.isArray(sources) && sources.length === 1 && typeof sources[0]?.companyId === "string") return sources[0].companyId;
  } catch { /* Fail closed on an incomplete historical audit. */ }
  return invalid("The prior interpretation's source audit is invalid.");
}

/** Called only by finish in the same transaction as the running→succeeded transition. No approvals or selections. */
export async function publishHostOutput(ctx: MutationCtx, run: Doc<"hostRuns">, context: HostContext, output: HostOutput, check: CheckResult | null) {
  const room = await ctx.db.get(run.roomId);
  if (!room || room.state !== "open" || room.closedAt !== null || room.demoRunId !== run.demoRunId) return invalid("The room closed before publication.");
  const sources = new Map<string, Source>();
  for (const id of new Set([
    ...output.clarifications.flatMap(c => c.messageIds), ...output.summaries.flatMap(s => s.messageIds),
    ...output.requestedRevisions.flatMap(r => r.messageIds), ...(output.understood ?? []).map(u => u.sourceMessageId),
  ])) {
    const expected = context.messages.find(m => m.messageId === id);
    const source = await sourceOf(ctx, run, id);
    if (!expected || expected.companyId !== source.companyId || expected.text !== source.text || expected.language !== source.language) {
      return invalid("A cited statement changed before publication.");
    }
    sources.set(id, source);
  }
  const eventIdOf = (id: string | null): Id<"events"> | null => {
    if (id === null) return null;
    const eventId = ctx.db.normalizeId("events", id);
    if (!eventId || !context.events.some(e => e.eventId === eventId)) return invalid("The output names an incident outside this room.");
    return eventId;
  };
  const interpretations: { item: HostUnderstanding; source: Source; eventId: Id<"events"> | null; side: "A" | "B" | null; old: Doc<"understood"> | null }[] = [];
  for (const item of output.understood ?? []) {
    const source = sources.get(item.sourceMessageId)!;
    const eventId = eventIdOf(item.eventId), side = await sourceSide(ctx, context, source, eventId);
    const oldId = item.correctsId && ctx.db.normalizeId("understood", item.correctsId);
    const old = oldId ? await ctx.db.get(oldId) : null;
    if (item.correctsId && (!old || old.status !== "active" || old.roomId !== room._id || old.demoRunId !== run.demoRunId ||
      old.eventId !== eventId || old.side !== side || await originalCompany(ctx, old) !== source.companyId)) {
      return invalid("A correction must replace the same company's active interpretation in this incident.");
    }
    interpretations.push({ item, source, eventId, side, old });
  }
  const now = Date.now();
  const post = async (text: string, eventId: Id<"events"> | null, kind: "text" | "summary", role: "coordination_host" | "second_model", language: Language) =>
    ctx.db.insert("messages", { roomId: room._id, eventId, author: { kind: "agent", role, companyId: null }, kind,
      originalText: text, originalLang: language, translations: {}, translationStatus: {}, values: [],
      refs: eventId ? { eventId } : {}, form: null, demoRunId: run.demoRunId, simulated: room.simulated, createdAt: now });
  const audit = async (messageId: Id<"messages">, eventId: Id<"events"> | null, text: string, ids: string[], kind: string, understoodId: Id<"understood"> | null = null) => {
    const provenance = ids.map(id => sources.get(id)!);
    await ctx.db.insert("log", { eventId, actor: { kind: "agent", role: kind === "disagreement" ? "second_model" : "coordination_host", companyId: null, side: null },
      action: "summary_posted", summary: text, texts: null, before: null,
      // Exact IDs are audit evidence, not invented links in messages.refs. Voice stays in its own table.
      after: { hostRunId: run._id, messageId, kind, understoodId, sourceMessageIds: JSON.stringify(ids), sources: JSON.stringify(provenance) },
      proposalId: null, revision: null, roomId: room._id, demoRunId: run.demoRunId, simulated: room.simulated, at: now });
  };
  for (const item of output.clarifications) {
    const eventId = eventIdOf(item.eventId), id = await post(item.question, eventId, "text", "coordination_host", "en");
    await audit(id, eventId, item.question, item.messageIds, "clarification");
  }
  for (const item of output.summaries) {
    const eventId = eventIdOf(item.eventId), id = await post(item.text, eventId, "summary", "coordination_host", "en");
    await audit(id, eventId, item.text, item.messageIds, "summary");
  }
  for (const { item, source, eventId, side, old } of interpretations) {
    const messageId = await post(item.text, eventId, "text", "coordination_host", source.language);
    const id = await ctx.db.insert("understood", { roomId: room._id, eventId, kind: item.kind, hard: item.hard, text: item.text,
      originalLang: source.language, side, sourceMessageId: messageId, status: "active", correctedById: null,
      hostRunId: run._id, demoRunId: run.demoRunId, createdAt: now });
    if (old) await ctx.db.patch(old._id, { status: "corrected", correctedById: id });
    await audit(messageId, eventId, item.text, [source.id], "understood", id);
  }
  if (check && !check.agrees) {
    // The checker reason is retained in the trace. Only checked Host prose or this deterministic notice is published.
    const text = "The independent rationale check disagrees with the summary. Review the candidate facts before deciding.";
    const id = await post(text, null, "text", "second_model", "en");
    await audit(id, null, text, [], "disagreement");
  }
}
