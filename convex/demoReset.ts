import { ConvexError, v } from "convex/values";
import { makeFunctionReference as ref } from "convex/server";
import { mutation, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { requireUser } from "./session";
import { setActiveAssignments } from "./lib/accounts";
import { closeRunAssistant } from "./lib/backboard";
import { roomNameOf } from "./call/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const cleanRef = ref<"action">("demoReset:cleanup");
const scopeRef = ref<"query">("demoReset:cleanupScope");
const markRef = ref<"mutation">("demoReset:markCleanup");
const JOB_SCOPE_KEYS = new Set(["demoRunId", "runId", "hostRunId", "eventId", "roomId", "scanId", "maneuverId", "exportId"]);

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

// Manifest entries are server-written launch receipts. Malformed legacy entries must not prevent reset.
function launchRecords(run: Doc<"demoRuns">) {
  const records: { objectId: string; userId: string; companyId: string; replaceObjectId?: string }[] = [];
  for (const [key, value] of Object.entries(run.manifest ?? {})) {
    if (!key.startsWith("launch:") || typeof value !== "string") continue;
    try {
      const r = JSON.parse(value);
      if (r?.state === "completed" && typeof r.objectId === "string" && typeof r.userId === "string" && typeof r.companyId === "string") {
        records.push({ objectId: r.objectId, userId: r.userId, companyId: r.companyId,
          replaceObjectId: typeof r.input?.replaceObjectId === "string" ? r.input.replaceObjectId : undefined });
      }
    } catch { /* Preserve unreadable historical metadata. */ }
  }
  return records;
}

async function retireAssignments(ctx: MutationCtx, run: Doc<"demoRuns">, simIds: Set<string>) {
  // A legacy fixture may share a synthetic object with another open demo. Do not retire that run's fleet.
  for (const objectId of simIds) {
    const object = await ctx.db.query("spaceObjects").withIndex("by_object_id", q => q.eq("objectId", objectId)).unique();
    if (!object) continue;
    const linked = [
      ...await ctx.db.query("events").withIndex("by_pair_tca", q => q.eq("objectAId", object._id)).collect(),
      ...await ctx.db.query("events").withIndex("by_object_b_tca", q => q.eq("objectBId", object._id)).collect(),
    ];
    for (const event of linked) {
      if (!event.demoRunId || event.demoRunId === run._id) continue;
      const other = await ctx.db.get(event.demoRunId);
      if (other?.state === "open") { simIds.delete(objectId); break; }
    }
  }
  const launches = launchRecords(run);
  const affected = new Set<Id<"users">>();
  for (const objectId of simIds) {
    const rows = await ctx.db.query("fleetAssignments").withIndex("by_object", q => q.eq("objectId", objectId)).collect();
    for (const row of rows) if (row.active) affected.add(row.userId);
  }
  for (const userId of affected) {
    const user = await ctx.db.get(userId);
    if (!user) continue;
    const assignments = await ctx.db.query("fleetAssignments").withIndex("by_user_object", q => q.eq("userId", userId)).collect();
    const active = assignments.filter(a => a.active && !simIds.has(a.objectId)).map(a => a.objectId);
    const replaced = new Map(launches.filter(r => r.userId === userId && r.companyId === user.companyId)
      .map(r => [r.objectId, r.replaceObjectId]));
    // A second launch can replace the first SIM slot. Follow that chain to the original owned fleet slot.
    for (const assignment of assignments.filter(a => a.active && simIds.has(a.objectId))) {
      const seen = new Set<string>();
      let previous = replaced.get(assignment.objectId);
      while (previous && simIds.has(previous) && !seen.has(previous)) {
        seen.add(previous);
        previous = replaced.get(previous);
      }
      if (!previous || simIds.has(previous) || !assignments.some(a => a.objectId === previous)) continue;
      const owner = await ctx.db.query("satelliteOwners").withIndex("by_object", q => q.eq("objectId", previous!)).unique();
      if (owner?.companyId === user.companyId) active.push(previous);
    }
    await setActiveAssignments(ctx, user, active);
  }
}

export const reset = mutation({
  args: { demoRunId: v.optional(v.id("demoRuns")) },
  handler: async (ctx, { demoRunId }) => {
    if (process.env.DEMO_LAUNCH !== "on") fail("FEATURE_DISABLED", "Demo reset is disabled.");
    const { user } = await requireUser(ctx);
    if (user.role !== "operator") fail("FORBIDDEN", "Only operators can reset their demonstration.");
    const run = demoRunId ? await ctx.db.get(demoRunId) : await ctx.db.query("demoRuns")
      .withIndex("by_state", q => q.eq("state", "open"))
      .filter(q => q.eq(q.field("startedBy"), user._id)).order("desc").first();
    if (!run) return { closedRunId: null, assignmentVersion: user.assignmentVersion ?? 1 };
    if (run.startedBy !== user._id) fail("FORBIDDEN", "Only the operator who started this run can reset it.");
    if (run.state === "closed") {
      if (run.manifest?.memoryCleanupState !== "complete" || run.manifest?.voiceCleanupState !== "complete") {
        await ctx.scheduler.runAfter(0, cleanRef, { demoRunId: run._id });
      }
      return { closedRunId: run._id, assignmentVersion: user.assignmentVersion ?? 1 };
    }

    const now = Date.now();
    const events = await ctx.db.query("events").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).take(1001);
    const rooms = await ctx.db.query("rooms").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).take(101);
    if (events.length > 1000 || rooms.length > 100) fail("LIMIT_EXCEEDED", "This run exceeds the atomic reset limit.");
    await ctx.db.patch(run._id, { state: "closed", closedAt: now,
      manifest: { ...run.manifest, memoryCleanupState: "pending", voiceCleanupState: "pending" } });
    const ids = new Set<string>([run._id, ...events.map(e => e._id), ...rooms.map(r => r._id)]);
    const simIds = new Set<string>();
    for (const event of events) {
      if (event.simulated) await ctx.db.patch(event._id, { active: false, updatedAt: now });
      for (const objectId of [event.objectAId, event.objectBId]) {
        const object = await ctx.db.get(objectId);
        if (object?.objectId.startsWith("SIM-")) simIds.add(object.objectId);
      }
      const selection = await ctx.db.query("selections").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
      if (selection) await ctx.db.patch(selection._id, { proposalId: null, revision: null, generation: selection.generation + 1,
        lastReset: { at: now, reason: "Demo run closed" }, at: now });
      const set = await ctx.db.query("candidateSets").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
      if (set) await ctx.db.patch(set._id, { state: "closed" });
      for (const approval of await ctx.db.query("approvals").withIndex("by_event_current", q => q.eq("eventId", event._id).eq("current", true)).collect()) {
        await ctx.db.patch(approval._id, { current: false });
      }
      for (const agent of await ctx.db.query("agentRuns").withIndex("by_event", q => q.eq("eventId", event._id)).collect()) {
        ids.add(agent._id);
        if (agent.status === "running") await ctx.db.patch(agent._id, {
          status: "superseded", stage: undefined, finishedAt: now, lastProgressAt: now, stalled: false,
        });
      }
      const history = await ctx.db.query("historySeries").withIndex("by_event", q => q.eq("eventId", event._id)).unique();
      if (history && event.simulated) await ctx.db.patch(history._id, { stale: true, error: "Demo run closed" });
      await ctx.db.insert("log", { eventId: event._id, actor: { kind: "system" }, action: "status_changed",
        summary: "Demo run closed; its active work and authorizations were retired.", texts: null, before: null, after: null,
        proposalId: null, revision: null, roomId: null, demoRunId: run._id, simulated: event.simulated, at: now });
    }
    for (const room of rooms) {
      await ctx.db.patch(room._id, { state: "closed", closedAt: room.closedAt ?? now });
      for (const member of await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", room._id)).collect()) {
        await ctx.db.patch(member._id, { inRoom: false, inCall: false, updatedAt: now });
      }
      // Prevent new join requests and phrase writes. Caption and shared message records are retained.
      for (const member of await ctx.db.query("call_members").withIndex("by_room", q => q.eq("roomId", String(room._id))).collect()) {
        await ctx.db.delete(member._id);
      }
      for (const presence of await ctx.db.query("call_presence").withIndex("by_room_user", q => q.eq("roomId", String(room._id))).collect()) {
        await ctx.db.patch(presence._id, { inRoom: false, inCall: false, updatedAt: new Date(now).toISOString() });
      }
    }
    for (const scan of await ctx.db.query("scanRuns").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      ids.add(scan._id);
      if (scan.status === "queued" || scan.status === "running") await ctx.db.patch(scan._id, { status: "failed", phase: "failed",
        error: { code: "DEMO_RUN_CLOSED", message: "Demo run closed" }, finishedAt: now, updatedAt: now });
    }
    for (const host of await ctx.db.query("hostRuns").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      ids.add(host._id);
      if (host.status === "running") await ctx.db.patch(host._id, { status: "superseded", finishedAt: now });
    }
    for (const maneuver of await ctx.db.query("maneuvers").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      ids.add(maneuver._id);
      await ctx.db.patch(maneuver._id, { ...(maneuver.status === "committed" ? {} : { status: "failed" as const, error: "Demo run closed" }),
        reviewRequired: true, updatedAt: now });
    }
    for (const plan of await ctx.db.query("trajectoryPlans").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      await ctx.db.patch(plan._id, { state: "superseded", updatedAt: now });
    }
    for (const item of await ctx.db.query("inbox").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      await ctx.db.patch(item._id, { unread: false });
    }
    for (const memory of await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", run._id)).collect()) {
      await ctx.db.patch(memory._id, { closedAt: memory.closedAt ?? now });
    }
    for (const observation of await ctx.db.query("observationExports").withIndex("by_demo_run", q => q.eq("demoRunId", run._id)).collect()) {
      ids.add(observation._id);
      if (observation.exportState === "pending") await ctx.db.patch(observation._id, {
        exportState: "failed", lastError: "Demo run closed", updatedAt: now,
      });
    }

    // Cancel only pending jobs with an explicit scope ID from this run. Completed job history must not count.
    // The cap fails the entire mutation atomically instead of reporting a partial reset as successful.
    const jobs = await ctx.db.system.query("_scheduled_functions").filter(q => q.eq(q.field("state.kind"), "pending")).take(2001);
    if (jobs.length > 2000) fail("LIMIT_EXCEEDED", "Too many queued jobs for an atomic demo reset.");
    for (const job of jobs) {
      if (job.args.some(arg => arg && typeof arg === "object" && Object.entries(arg).some(([key, value]) =>
        JOB_SCOPE_KEYS.has(key) && typeof value === "string" && ids.has(value)))) await ctx.scheduler.cancel(job._id);
    }
    await retireAssignments(ctx, run, simIds);
    await ctx.scheduler.runAfter(0, cleanRef, { demoRunId: run._id });
    return { closedRunId: run._id, assignmentVersion: (await ctx.db.get(user._id))?.assignmentVersion ?? 1 };
  },
});

export const cleanupScope = internalQuery({
  args: { demoRunId: v.id("demoRuns") },
  handler: async (ctx, { demoRunId }) => {
    const run = await ctx.db.get(demoRunId);
    if (!run || run.state !== "closed") return null;
    return {
      assistants: await ctx.db.query("memoryAssistants").withIndex("by_run", q => q.eq("demoRunId", demoRunId)).collect(),
      rooms: await ctx.db.query("rooms").withIndex("by_demo_run", q => q.eq("demoRunId", demoRunId)).collect(),
      memoryDone: run.manifest?.memoryCleanupState === "complete", voiceDone: run.manifest?.voiceCleanupState === "complete",
    };
  },
});

export const markCleanup = internalMutation({
  args: { demoRunId: v.id("demoRuns"), memory: v.boolean(), voice: v.boolean() },
  handler: async (ctx, { demoRunId, memory, voice }) => {
    const run = await ctx.db.get(demoRunId);
    if (run?.state !== "closed") return;
    // Concurrent retries may finish out of order. A later failure cannot undo a recorded successful cleanup.
    await ctx.db.patch(demoRunId, { manifest: { ...run.manifest,
      memoryCleanupState: memory || run.manifest?.memoryCleanupState === "complete" ? "complete" : "failed",
      voiceCleanupState: voice || run.manifest?.voiceCleanupState === "complete" ? "complete" : "failed",
    } });
  },
});

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// Web Crypto avoids Node-only SDK code in a file that also exports mutations. Grant matches SDK DeleteRoom.
// Deleting the room disconnects current participants; this does not claim to revoke already issued bearer tokens.
async function closeVoice(room: string) {
  const url = process.env.LIVEKIT_URL, key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) throw new Error("Voice cleanup unavailable");
  const enc = new TextEncoder(), now = Math.floor(Date.now() / 1000);
  const json = (value: unknown) => encode(enc.encode(JSON.stringify(value)));
  const input = `${json({ alg: "HS256", typ: "JWT" })}.${json({ iss: key, nbf: now - 5, exp: now + 60, video: { roomCreate: true } })}`;
  const signing = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const token = `${input}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", signing, enc.encode(input))))}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url.replace(/^ws/, "http").replace(/\/+$/, "") + "/twirp/livekit.RoomService/DeleteRoom", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ room }), signal: controller.signal,
    });
    if (!response.ok && response.status !== 404) throw new Error("Voice cleanup failed");
  } finally { clearTimeout(timer); }
}

// Provider failures are retryable; no provider body or credential is persisted. Bound concurrent calls to four.
async function cleanAll<T>(items: T[], remove: (item: T) => Promise<unknown>) {
  let complete = true;
  for (let offset = 0; offset < items.length; offset += 4) {
    const outcomes = await Promise.allSettled(items.slice(offset, offset + 4).map(remove));
    if (outcomes.some(outcome => outcome.status === "rejected")) complete = false;
  }
  return complete;
}

export const cleanup = internalAction({
  args: { demoRunId: v.id("demoRuns") },
  handler: async (ctx, { demoRunId }) => {
    const scope = await ctx.runQuery(scopeRef, { demoRunId }) as {
      assistants: Doc<"memoryAssistants">[]; rooms: Doc<"rooms">[]; memoryDone: boolean; voiceDone: boolean;
    } | null;
    if (!scope) return;
    const [memory, voice] = await Promise.all([
      scope.memoryDone ? true : cleanAll(scope.assistants, item => closeRunAssistant(item.assistantId)),
      scope.voiceDone ? true : cleanAll(scope.rooms, room => closeVoice(roomNameOf(String(room._id)))),
    ]);
    await ctx.runMutation(markRef, { demoRunId, memory, voice });
  },
});
