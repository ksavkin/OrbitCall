import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { HostContext, HostOutput } from "../convex/lib/host";
import type { CandidatesRequest } from "../convex/lib/orbitClient";
import { callClaude } from "../convex/lib/claude";
import { FIXTURE_NOW } from "../fixtures/events";
import { policyB } from "../fixtures/policies";
import { as, fn, pick, seed, selection, tick } from "./decision";
import type { Backend } from "./helpers";

// Only provider transports are mocked. Scheduled callbacks below dispatch the actual exported Convex functions,
// including Host checking/publication, revisions, canonical candidate publication, Advocates and rationale checks.
vi.mock("../convex/lib/claude", async original => ({ ...await original<typeof import("../convex/lib/claude")>(), callClaude: vi.fn() }));
const NEW_TIME = "2026-10-24T20:17:00Z";
const CONSTRAINT = `Move SIM-1001 only; burn after ${NEW_TIME}; delta-v at most 0.1 m/s; use retrograde`;
const CORRECTION = "Actually, we prefer to maneuver later.";
const MUTATIONS = new Set(["messages:hostDebounce", "hostTriggers:request", "advocates:publicationFollowups"]);
const ORDER = ["messages:hostDebounce", "hostTriggers:request", "hostTriggers:run", "revisions:fromHost",
  "agents/advocate:negotiate", "agents/advocate:start", "advocates:publicationFollowups", "agents/rationale:start"];

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(FIXTURE_NOW);
  for (const [name, value] of Object.entries({ ANTHROPIC_API_KEY: "fixture", ANTHROPIC_MODEL: "test-claude",
    GEMINI_API_KEY: "fixture", GEMINI_HOST_MODEL: "test-gemini", XAI_API_KEY: "fixture", XAI_CHECKER_MODEL: "test-grok",
    ORBIT_SERVICE_URL: "https://orbit.test", ORBIT_SERVICE_TOKEN: "fixture" })) vi.stubEnv(name, value);
  vi.mocked(callClaude).mockReset().mockImplementation(async prompt => {
    const input = JSON.parse(prompt.user);
    return { raw: JSON.stringify(input.templates ? { template: input.templates[0] } : { preferredCandidateId: null }),
      model: "test-claude", usage: { inputTokens: 17, outputTokens: 9 } };
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function pending(t: Backend, name?: string) {
  return t.run(async ctx => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter(j => j.state.kind === "pending" && (!name || j.name === name)));
}
async function cancelInitialWork(t: Backend) {
  await t.run(async ctx => { for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
    if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
  } });
}

/** Deterministic queue transport: claim/cancel each pending entry, then execute its real callback and args.
 * Ignore unrelated translation, speech and watchdog jobs; those have separate service integration tests. */
async function drain(t: Backend, allowed = ORDER) {
  const executed: { name: string; result: unknown }[] = [];
  for (let attempts = 0; attempts < 40; attempts++) {
    const jobs = (await pending(t)).filter(j => allowed.includes(j.name)).sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
    const job = jobs[0]; if (!job) return executed;
    await t.run(ctx => ctx.scheduler.cancel(job._id));
    const args = job.args[0] as Record<string, unknown>;
    const result = MUTATIONS.has(job.name)
      ? await t.mutation(makeFunctionReference<"mutation", Record<string, unknown>>(job.name), args)
      : await t.action(makeFunctionReference<"action", Record<string, unknown>>(job.name), args);
    executed.push({ name: job.name, result });
  }
  throw new Error("The checked discussion loop did not settle within forty callbacks.");
}

async function setup() {
  const { t, eventId } = await seed();
  await as(t, "b").mutation(api.policies.update, { satellites: [policyB] });
  const { roomId } = await as(t, "a").mutation(fn.startWorkflow, { eventId }) as { roomId: Id<"rooms"> };
  await cancelInitialWork(t);
  await pick(t, "a", eventId, "P1");
  const before = (await t.query(internal.hostTriggers.context, { roomId, trigger: "final_message" }))!;
  expect(before.events.flatMap(e => e.candidates.map(c => c.burnTimeUtc))).not.toContain(NEW_TIME);
  const { messageId } = await as(t, "a").mutation(api.messages.send, { roomId, eventId, text: CONSTRAINT });
  // The earlier human approval exists when the Host computes its result and must be retired by the new revision.
  await as(t, "a").mutation(fn.approve, await tick(t, eventId));
  return { t, eventId, roomId, messageId };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function currentCards(s: Setup) {
  return s.t.run(async ctx => {
    const set = (await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", s.eventId)).unique())!;
    return Promise.all(set.candidateRevisionIds.map(async id => (await ctx.db.get(id))!));
  });
}
const hostRuns = (s: Setup) => s.t.run(ctx => ctx.db.query("hostRuns").withIndex("by_room_created", q => q.eq("roomId", s.roomId)).collect());

function hostAnswer(context: HostContext): HostOutput {
  const output: HostOutput = { inputVersion: context.inputVersion, clarifications: [], summaries: [], requestedRevisions: [] };
  if (context.trigger === "candidates_changed") return output;
  const source = context.messages.at(-1)!;
  const event = context.events[0], prior = context.understood?.find(u => u.hard && u.kind === "constraint");
  if (source.text === CORRECTION && prior) {
    output.understood = [{ eventId: event.eventId, kind: "correction", hard: false, text: source.text,
      sourceMessageId: source.messageId, correctsId: prior.understoodId }];
    output.requestedRevisions = [{ eventId: event.eventId, candidateId: event.candidates[0].candidateId,
      reason: "Reconsider the options after the operator corrected the constraint.", messageIds: [source.messageId] }];
  } else if (source.text === CONSTRAINT) {
    output.understood = [{ eventId: event.eventId, kind: "constraint", hard: true, text: source.text,
      sourceMessageId: source.messageId, correctsId: null }];
    output.requestedRevisions = [{ eventId: event.eventId, candidateId: event.candidates.find(c => c.label === "P1")!.candidateId,
      reason: "The operator requested a revised maneuver.", messageIds: [source.messageId] }];
  }
  return output;
}
function numericalAnswer(req: CandidatesRequest) {
  const info = (objectId: string) => ({ objectId, name: objectId, kind: "payload", maneuverability: "maneuverable",
    classificationBasis: "simulation", operationalStatus: null, group: "sim", simulated: true });
  const common = { missBeforeKm: 0.18, estimatedFuelKg: null, indicative: true, simulated: true };
  const grid = [["A", 12, 0.02, "prograde", 1.3], ["B", 12, 0.02, "retrograde", 1.2],
    ["A", 6, 0.05, "prograde", 1.9], ["A", 6, 0.2, "retrograde", 2.5], ["A", 3, 0.1, "retrograde", 2.4]] as const;
  return { snapshotId: req.snapshotId, evidenceVersion: req.evidenceVersion, objectA: req.objectA, objectB: req.objectB,
    objects: { [req.objectA]: info(req.objectA), [req.objectB]: info(req.objectB) }, notMovable: [],
    tcaUtc: req.tcaUtc, tcaInputUtc: req.tcaUtc, missBeforeKm: 0.18, relSpeedKmS: 7.6, simulated: true,
    candidates: grid.map(([side, leadH, deltaVMs, direction, missAfterKm], i) => ({ ...common, candidateId: `grid-${i}`,
      kind: "maneuver", movingSide: side, movingObjectId: side === "A" ? req.objectA : req.objectB,
      burnTimeUtc: new Date(Date.parse(req.tcaUtc) - leadH * 3_600_000).toISOString().replace(".000Z", "Z"), leadH,
      deltaVMs, direction, deltaAKm: 0.04, missAfterKm, tcaAfterUtc: req.tcaUtc, relSpeedKmS: 7.6, passesPairThreshold: true, rank: i + 1 })),
    wait: { ...common, candidateId: "wait", kind: "wait", movingSide: null, movingObjectId: null, burnTimeUtc: null, leadH: null,
      deltaVMs: null, direction: null, deltaAKm: null, missAfterKm: null, tcaAfterUtc: null, relSpeedKmS: null, passesPairThreshold: false, rank: null },
    failed: [], assumptions: ["Indicative simulated geometry; no covariance."], method: "SGP4 fixture grid" };
}
function providers(options: { hostFailure?: boolean; duringHost?: () => Promise<void> } = {}) {
  const calls = { host: [] as HostContext[], orbit: [] as CandidatesRequest[], grok: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const context = JSON.parse(body.contents[0].parts[0].text) as HostContext;
      calls.host.push(context); await options.duringHost?.();
      if (options.hostFailure) return Response.json({ error: { code: 503, message: "Synthetic unavailable provider", status: "UNAVAILABLE" } }, { status: 503 });
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(hostAnswer(context)) }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 19 }, modelVersion: "test-gemini" });
    }
    if (String(url) === "https://orbit.test/candidates") { calls.orbit.push(body); return Response.json(numericalAnswer(body)); }
    if (String(url) === "https://api.x.ai/v1/chat/completions") {
      calls.grok++;
      return Response.json({ model: "test-grok", choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify({ agrees: true, reason: "The candidate facts match.", flaggedCandidateIds: [] }) } }],
        usage: { prompt_tokens: 23, completion_tokens: 11 } });
    }
    throw new Error(`Unexpected transport in discussion loop: ${String(url)}`);
  }));
  return calls;
}

describe("stored discussion to checked candidate loop", () => {
  it("executes a new quoted UTC window through Host, revision, Advocate and double-checked rationale callbacks once", async () => {
    const s = await setup(), calls = providers();
    await drain(s.t, ["messages:hostDebounce", "hostTriggers:request", "hostTriggers:run"]);
    const [host] = await hostRuns(s);
    expect(host).toMatchObject({ status: "succeeded", span: { model: "test-gemini", usage: { inputTokens: 31, outputTokens: 19 } } });
    expect((await pending(s.t, "revisions:fromHost")).map(j => j.args[0])).toEqual([{ hostRunId: host._id }]);
    expect(await currentCards(s)).toHaveLength(4);
    // Re-delivering completion cannot dispatch another revision action.
    await s.t.mutation(internal.hostTriggers.finish, { hostRunId: host._id, span: host.span, output: host.output, check: host.check });
    expect(await pending(s.t, "revisions:fromHost")).toHaveLength(1);
    const executed = await drain(s.t);
    expect(executed.map(j => j.name)).toEqual(expect.arrayContaining(["revisions:fromHost", "agents/advocate:negotiate",
      "agents/advocate:start", "advocates:publicationFollowups", "agents/rationale:start", "hostTriggers:request", "hostTriggers:run"]));
    const cards = await currentCards(s);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ candidateId: "P1", revision: 2, direction: "retrograde", deltaVMs: 0.1, missAfterKm: 2.4 });
    expect(cards[1].kind).toBe("wait");
    expect(await selection(s.t, s.eventId)).toMatchObject({ generation: 2, revision: 2, lastReset: { reason: "revision_changed" } });
    const approvals = await s.t.run(ctx => ctx.db.query("approvals").collect());
    expect(approvals).toEqual([expect.objectContaining({ current: false, revision: 1, status: "approved" })]);
    const agents = await s.t.run(ctx => ctx.db.query("agentRuns").collect());
    expect(agents.filter(a => a.role === "operator_advocate").map(a => a.status)).toEqual(["succeeded", "succeeded"]);
    const rationales = await as(s.t, "a").query(api.lib.rationale.list, { eventId: s.eventId });
    expect(rationales).toHaveLength(2);
    expect(rationales.every(r => r.rationale?.numbersChecked && r.rationale.secondModel?.agrees)).toBe(true);
    expect(calls.grok).toBe(2); expect(calls.orbit).toHaveLength(1); expect(callClaude).toHaveBeenCalledTimes(4);
    expect(calls.host.some(c => c.trigger === "candidates_changed" && c.events[0].candidates.some(card => card.revision === 2))).toBe(true);
    expect((await hostRuns(s)).every(r => r.status === "succeeded")).toBe(true);
    expect(await s.t.run(ctx => ctx.db.query("maneuvers").collect())).toEqual([]);
    const providerCalls = { host: calls.host.length, claude: vi.mocked(callClaude).mock.calls.length, grok: calls.grok };
    expect(await s.t.action(internal.revisions.fromHost, { hostRunId: host._id })).toEqual([{ eventId: s.eventId, status: "published", changed: false, version: 2 }]);
    expect(await drain(s.t)).toEqual([]);
    expect(calls.orbit).toHaveLength(1);
    expect({ host: calls.host.length, claude: vi.mocked(callClaude).mock.calls.length, grok: calls.grok }).toEqual(providerCalls);
    expect(await s.t.run(ctx => ctx.db.query("approvals").collect())).toEqual(approvals);
  });

  it("runs a real checked hard-to-soft correction and expands options without reviving old human signatures", async () => {
    const s = await setup(), calls = providers(); await drain(s.t);
    expect(await currentCards(s)).toHaveLength(2);
    const before = (await s.t.run(ctx => ctx.db.query("understood").collect()))[0];
    vi.setSystemTime(FIXTURE_NOW + 1000);
    const { messageId } = await as(s.t, "a").mutation(api.messages.send, { roomId: s.roomId, eventId: s.eventId, text: CORRECTION });
    const executed = await drain(s.t);
    expect(executed.map(j => j.name)).toContain("revisions:fromHost");
    const cards = await currentCards(s);
    expect(cards).toHaveLength(4);
    expect(cards.some(c => c.burnTimeUtc && Date.parse(c.burnTimeUtc) < Date.parse(NEW_TIME))).toBe(true);
    const understood = await s.t.run(ctx => ctx.db.query("understood").collect());
    expect(understood.find(row => row._id === before._id)).toMatchObject({ status: "corrected" });
    expect(understood.find(row => row.status === "active")).toMatchObject({ kind: "correction", hard: false, text: CORRECTION });
    const host = (await hostRuns(s)).find(h => h.output?.understood?.some(u => u.kind === "correction"))!;
    expect(host.output!.requestedRevisions[0].messageIds).toEqual([messageId]);
    const revisions = await s.t.run(ctx => ctx.db.query("proposalRevisions").collect());
    expect(revisions.some(r => r.changeSummary?.includes("corrected a hard constraint"))).toBe(true);
    expect((await as(s.t, "a").query(api.lib.rationale.list, { eventId: s.eventId })).every(r => r.rationale?.numbersChecked)).toBe(true);
    expect(calls.orbit).toHaveLength(2); expect(calls.grok).toBe(6);
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect())).map(a => a.current)).toEqual([false]);
    expect(await s.t.run(ctx => ctx.db.query("maneuvers").collect())).toEqual([]);
  });

  it.each(["failed", "stale"])("does not queue revisions or change signatures after a %s Host call", async condition => {
    const s = await setup(), before = await currentCards(s);
    const calls = providers({ hostFailure: condition === "failed", ...(condition === "stale" ? { duringHost: () => s.t.run(ctx =>
      ctx.db.patch(s.messageId, { originalText: "The original statement changed while the Host was responding." })) } : {}) });
    await drain(s.t, ["messages:hostDebounce", "hostTriggers:request", "hostTriggers:run"]);
    expect(await pending(s.t, "revisions:fromHost")).toEqual([]);
    expect((await hostRuns(s))[0].status).toBe(condition === "failed" ? "failed" : "superseded");
    expect(await currentCards(s)).toEqual(before); expect(calls.orbit).toEqual([]);
    expect((await s.t.run(ctx => ctx.db.query("approvals").collect())).map(a => a.current)).toEqual([true]);
    expect(callClaude).not.toHaveBeenCalled(); expect(calls.grok).toBe(0);
  });
});
