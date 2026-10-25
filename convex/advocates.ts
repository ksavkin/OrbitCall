import { internalMutation, internalQuery, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { side } from "./lib/policyValidators";
import { STALLED_AFTER_MS, inputKey } from "./lib/analyst";
import { loadFacts } from "./lib/events";
import { advocateKey, companyOf, currentAssessment, currentEvidenceKey, latestAdvocate, loadCandidates, requiredSides } from "./lib/coordination";
import { checkRecommendation, evaluateCandidates, shareEvaluations } from "./lib/advocate";
import { requireParty } from "./lib/operatorAccess";
import { runFlags, stageOf, supersede } from "./lib/runs";

export const begin = internalMutation({
  args: { eventId: v.id("events"), side },
  handler: async (ctx, { eventId, side }) => {
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    const event = await ctx.db.get(eventId);
    if (!set || !event || set.state !== "open" || set.candidateRevisionIds.length === 0) return null;
    const facts = await loadFacts(ctx, event);
    if (set.evidenceKey !== inputKey(facts)) return null;
    const companyId = companyOf(set, side);
    if (!companyId) return null;
    // Only this company's policy is read; the other side enters as checked shareable messages.
    const policyRow = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", companyId)).unique();
    const policyRevision = policyRow?.revision ?? 0;
    const key = advocateKey(set, side, policyRevision);
    const previous = await latestAdvocate(ctx, eventId, companyId);
    if (previous?.inputKey === key && ["running", "succeeded"].includes(previous.status)) return null;
    if (previous?.status === "running") await supersede(ctx, previous._id);
    const candidates = await loadCandidates(ctx, set);
    const objectId = side === "A" ? facts.objectA.objectId : facts.objectB.objectId;
    const policy = policyRow?.satellites.find(p => p.objectId === objectId) ?? null;
    const other = await currentAssessment(ctx, set, side === "A" ? "B" : "A", set.evidenceKey);
    const runId = await ctx.db.insert("agentRuns", {
      eventId, role: "operator_advocate", companyId, inputKey: key, status: "running", stage: "loading",
      lastProgressAt: Date.now(), stalled: false,
    });
    await ctx.db.insert("advocateContexts", {
      runId, side, policyId: policyRow?._id ?? null, policyRevision,
      candidateSetId: set._id, candidateVersion: set.version, evidenceKey: set.evidenceKey,
    });
    await ctx.scheduler.runAfter(STALLED_AFTER_MS, internal.agentRuns.watchdog, { runId });
    return { runId, input: { facts, candidates, side, policy, evaluations: evaluateCandidates(facts, candidates, side, policy, Date.now()),
      counterpart: (other?.entries ?? []).map(({ candidateId, outcome, categories, recommended }) => ({ candidateId, outcome, categories, recommended })) } };
  },
});

export const finish = internalMutation({
  args: { runId: v.id("agentRuns"), raw: v.string(), model: v.string(), usage: v.object({ inputTokens: v.number(), outputTokens: v.number() }) },
  handler: async (ctx, { runId, raw, model, usage }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.role !== "operator_advocate" || run.status !== "running" || !run.companyId) return { published: false };
    const context = await ctx.db.query("advocateContexts").withIndex("by_run", q => q.eq("runId", runId)).unique();
    const set = context && await ctx.db.get(context.candidateSetId);
    const event = await ctx.db.get(run.eventId);
    const latest = await latestAdvocate(ctx, run.eventId, run.companyId);
    const policyRow = await ctx.db.query("policies").withIndex("by_company", q => q.eq("companyId", run.companyId!)).unique();
    const facts = event && await loadFacts(ctx, event);
    if (!context || !set || !facts || set.state !== "open" || latest?._id !== runId ||
      set.version !== context.candidateVersion || set.evidenceKey !== inputKey(facts) ||
      (policyRow?.revision ?? 0) !== context.policyRevision || (policyRow?._id ?? null) !== context.policyId ||
      advocateKey(set, context.side, context.policyRevision) !== run.inputKey) {
      await supersede(ctx, runId); return { published: false };
    }
    const policy = policyRow?.satellites.find(p => p.objectId === (context.side === "A" ? facts.objectA.objectId : facts.objectB.objectId)) ?? null;
    const evaluations = evaluateCandidates(facts, await loadCandidates(ctx, set), context.side, policy, Date.now());
    const other = await currentAssessment(ctx, set, context.side === "A" ? "B" : "A", set.evidenceKey);
    const recommendation = checkRecommendation(raw, evaluations, Boolean(policy), other?.entries ?? []);
    await ctx.db.insert("negotiationMessages", {
      eventId: run.eventId, side: context.side, kind: "assessment", runId,
      entries: shareEvaluations(evaluations, recommendation), categories: [],
      candidateVersion: set.version, evidenceKey: set.evidenceKey,
    });
    await ctx.db.patch(runId, { status: "succeeded", stage: undefined, finishedAt: Date.now(), stalled: false, model, usage });
    if (context.side === "A" && set.companyBId) {
      // B may have started before A finished, or answered while A's previous attempt failed.
      // Invalidate that response atomically and give B the newly published shared outcomes.
      const response = await latestAdvocate(ctx, run.eventId, set.companyBId);
      if (response && ["running", "succeeded"].includes(response.status)) await supersede(ctx, response._id);
      await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId: run.eventId, side: "B" });
    }
    return { published: true };
  },
});

export const fail = internalMutation({
  args: { runId: v.id("agentRuns"), code: v.string(), message: v.string() },
  handler: async (ctx, { runId, code, message }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.role !== "operator_advocate" || run.status !== "running") return;
    await ctx.db.patch(runId, { status: "failed", stage: undefined, finishedAt: Date.now(), stalled: false,
      errorCode: code, errorMessage: message });
    const context = await ctx.db.query("advocateContexts").withIndex("by_run", q => q.eq("runId", runId)).unique();
    const set = context && await ctx.db.get(context.candidateSetId);
    if (context?.side === "A" && set?.companyBId) await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId: run.eventId, side: "B" });
  },
});

// The side that opens a round: A for a pair, the only registered side for debris; null without a candidate set.
export const openingSide = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", eventId)).unique();
    return set ? requiredSides(set)[0] ?? null : null;
  },
});

export const list = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const { candidateSet: set } = await requireParty(ctx, eventId);
    const key = await currentEvidenceKey(ctx, set);
    const [a, b] = await Promise.all([currentAssessment(ctx, set, "A", key ?? ""), currentAssessment(ctx, set, "B", key ?? "")]);
    // Only the workflow's required sides decide: debris has one Advocate and no assessment for the debris side.
    const required = requiredSides(set).map(s => s === "A" ? a : b);
    const candidates = await loadCandidates(ctx, set);
    const companies = await Promise.all(requiredSides(set).map(s => ctx.db.get(companyOf(set, s)!)));
    const accepted = (value: string) => value === "feasible" || value === "preferred";
    const mutuallyAcceptable = candidates.filter(c => required.every(m => accepted(m?.entries.find(e => e.candidateId === c.candidateId)?.outcome ?? "")))
      .map(c => c.candidateId);
    const reviewCandidates = candidates.filter(c => required.every(m => m?.entries.some(e => e.candidateId === c.candidateId && e.outcome !== "infeasible"))).map(c => c.candidateId);
    const messages = await ctx.db.query("negotiationMessages").withIndex("by_event", q => q.eq("eventId", eventId)).order("desc").take(50);
    const runStates = await Promise.all((["A", "B"] as const).map(async s => {
      const companyId = companyOf(set, s);
      const run = companyId && await latestAdvocate(ctx, eventId, companyId);
      return run ? { status: run.status, stage: stageOf(run), startedAt: new Date(run._creationTime).toISOString(),
        lastProgressAt: new Date(run.lastProgressAt).toISOString(), errorCode: run.errorCode ?? null, errorMessage: run.errorMessage ?? null } : null;
    }));
    return {
      eventId, version: set.version, state: set.state, reviewRequired: set.reviewRequired, evidenceCurrent: key === set.evidenceKey,
      simulated: companies.some(c => c?.simulated) || candidates.some(c => c.simulated),
      candidates, assessments: { A: a?.entries ?? [], B: b?.entries ?? [] }, mutuallyAcceptable, reviewCandidates,
      runs: { A: runStates[0], B: runStates[1] },
      situation: set.reviewRequired ? "scheduled_review_required" : key !== set.evidenceKey ? "stale_candidates" : candidates.length === 0 ? "no_candidates" : required.some(m => !m) ? "awaiting_advocates" : mutuallyAcceptable.length ? "needs_operator_decision" : reviewCandidates.length ? "needs_more_data" : "no_mutually_acceptable_option",
      ...await runFlags(ctx, eventId),
      messages: messages.reverse().map(m => ({ messageId: m._id, side: m.side, kind: m.kind, entries: m.entries, categories: m.categories,
        createdAt: new Date(m._creationTime).toISOString(), current: m._id === a?._id || m._id === b?._id })),
    };
  },
});

export const rerun = mutation({
  args: { eventId: v.id("events") }, returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const { user, candidateSet: set, side } = await requireParty(ctx, eventId);
    if (set.state !== "open" || await currentEvidenceKey(ctx, set) !== set.evidenceKey) throw new ConvexError({ code: "INVALID_STATE", message: "Current open candidate evidence is required." });
    const run = await latestAdvocate(ctx, eventId, user.companyId);
    if (run && ((run.status === "running" && !run.stalled) || run.status === "succeeded")) throw new ConvexError({ code: "INVALID_STATE", message: "Retry only a failed or stalled Advocate." });
    if (run?.status === "running") await supersede(ctx, run._id);
    await ctx.scheduler.runAfter(0, internal.agents.advocate.start, { eventId, side });
    return null;
  },
});
