// Host speech entry of the voice path (roadmap: "Generate canonical host text, then use Claude translation and the
// selected Cartesia/Grok TTS routes for each listener. Host speech cannot create an approval.").
//
// `speak` takes one checked text of a succeeded Coordination Host run (a summary or a clarification question, in
// canonical English) and hands it to the room's translation worker as one reliable LiveKit data packet: server API
// `RoomService/SendData` to the participant `translator`, topic `orbit.host-speech`. The worker accepts a packet only
// when it has no sending participant (a server SDK sent it) and this topic, translates it for every listener language
// and voices it on `host:<lang>` tracks from a second connection with identity `host`. Nothing here writes a table or
// creates an approval. A caller schedules it from a mutation:
//   await ctx.scheduler.runAfter(0, speakRef, { roomId, hostRunId, text, expectedInputVersion });

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { HostOutput } from "../lib/host";
import { buildHostContext } from "../lib/hostContext";
import { roomNameOf } from "./core";
import { MAX_TEXT } from "./ingest";
import { STALE_MS } from "./presence";

export const HOST_SPEECH_TOPIC = "orbit.host-speech";
export const HOST_SPEECH_VERSION = 1;
/** The worker's identity in every coordination room (services/voice/orbit_voice/agent.py). */
export const TRANSLATOR_IDENTITY = "translator";
/** The server API token only has to outlive one request. */
const TOKEN_TTL_S = 120;
const NBF_SKEW_S = 5;
const FETCH_TIMEOUT_MS = 10_000;

export type HostSpeechRejection = "not_found" | "not_succeeded" | "wrong_room" | "closed" | "unchecked_text" | "too_long" | "stale";
export type HostSpeechResult =
  | { status: "sent"; httpStatus: number; id: string }
  | { status: "failed"; httpStatus: number | null; id: string | null; reason: string }
  | { status: "no_listeners" }
  | { status: "disabled" }
  | { status: "rejected"; reason: HostSpeechRejection };

/** What "checked host text" means: the run's summaries, then its clarification questions. Requested revisions are
 * for the trace and are never spoken. */
export function checkedTexts(output: HostOutput | null): string[] {
  if (!output) return [];
  return [...output.summaries.map(s => s.text), ...output.clarifications.map(c => c.question)];
}

// The same rule as hostTriggers' isOpen: a closed room or a reset demo run takes no host work.
async function isOpen(ctx: QueryCtx, room: Doc<"rooms">): Promise<boolean> {
  if (room.state !== "open" || room.closedAt !== null) return false;
  if (room.demoRunId === null) return true;
  const demo = await ctx.db.get(room.demoRunId);
  return demo !== null && demo.state === "open" && demo.closedAt === null;
}

// Someone is in the call: a call_presence row with a heartbeat within STALE_MS (what the web writes today), or a
// roomMembers row in the room and the call (rooms.setInCall, spec section 5; it has no heartbeat, so no age limit).
// The worker picks the listener languages from LiveKit itself, so an extra packet costs nothing, while a missed
// listener would drop the host's speech.
async function anyoneInCall(ctx: QueryCtx, roomId: Id<"rooms">): Promise<boolean> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString(); // ISO UTC strings order like the instants
  const calls = await ctx.db.query("call_presence").withIndex("by_room_user", q => q.eq("roomId", String(roomId))).collect();
  if (calls.some(r => r.inCall && r.updatedAt >= cutoff)) return true;
  const members = await ctx.db.query("roomMembers").withIndex("by_room", q => q.eq("roomId", roomId)).collect();
  return members.some(m => m.inRoom && m.inCall);
}

type Prepared = { ok: true; listeners: boolean } | { ok: false; reason: HostSpeechRejection };
type SpeechArgs = { roomId: Id<"rooms">; hostRunId: Id<"hostRuns">; text: string; expectedInputVersion: string };
const speakArgs = { roomId: v.id("rooms"), hostRunId: v.id("hostRuns"), text: v.string(), expectedInputVersion: v.string() };

export const prepare = internalQuery({
  args: speakArgs,
  handler: async (ctx, { roomId, hostRunId, text, expectedInputVersion }): Promise<Prepared> => {
    const run = await ctx.db.get(hostRunId);
    if (!run) return { ok: false, reason: "not_found" };
    if (run.roomId !== roomId) return { ok: false, reason: "wrong_room" };
    if (run.status !== "succeeded") return { ok: false, reason: "not_succeeded" };
    const room = await ctx.db.get(roomId);
    if (!room) return { ok: false, reason: "not_found" };
    // An old run's host job must not publish into a new run (roadmap section 14).
    if (room.demoRunId !== run.demoRunId || !await isOpen(ctx, room)) return { ok: false, reason: "closed" };
    if (!checkedTexts(run.output).includes(text) || !text.trim()) return { ok: false, reason: "unchecked_text" };
    if (text.length > MAX_TEXT) return { ok: false, reason: "too_long" };
    // Pin the context AFTER publication: this run's own understood rows are part of the baseline.
    // A later message, correction, selection, evidence or responsibility change cancels queued speech.
    if ((await buildHostContext(ctx, room, run.trigger)).inputVersion !== expectedInputVersion) return { ok: false, reason: "stale" };
    return { ok: true, listeners: await anyoneInCall(ctx, roomId) };
  },
});
const prepareRef = makeFunctionReference<"query", SpeechArgs, Prepared>(
  "call/hostSpeech:prepare");

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (value: unknown) => b64url(enc.encode(JSON.stringify(value)));
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

/** A LiveKit server API token (HS256, Web Crypto) that may administer this one room; it joins nothing. */
export async function roomAdminToken(apiKey: string, apiSecret: string, room: string, nowS: number): Promise<string> {
  const payload = { iss: apiKey, nbf: nowS - NBF_SKEW_S, exp: nowS + TOKEN_TTL_S, video: { roomAdmin: true, room } };
  const signingInput = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(payload)}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${signingInput}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput))))}`;
}

export const httpBase = (wsUrl: string) =>
  wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/+$/, "");

/** A stable id per run and text, so the worker drops a repeated delivery. */
export async function speechId(hostRunId: string, text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return `${hostRunId}:${hex(digest).slice(0, 16)}`;
}

export const speak = internalAction({
  args: speakArgs,
  handler: async (ctx, { roomId, hostRunId, text, expectedInputVersion }): Promise<HostSpeechResult> => {
    // Never throws: a scheduled caller gets a result, whatever fails (the query, hashing, signing or the network).
    let id: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const prepared = await ctx.runQuery(prepareRef, { roomId, hostRunId, text, expectedInputVersion });
      if (!prepared.ok) return { status: "rejected", reason: prepared.reason };
      if (!prepared.listeners) return { status: "no_listeners" };
      const serverUrl = process.env.LIVEKIT_URL, apiKey = process.env.LIVEKIT_API_KEY, apiSecret = process.env.LIVEKIT_API_SECRET;
      if (!serverUrl || !apiKey || !apiSecret) return { status: "disabled" };
      const room = roomNameOf(String(roomId));
      id = await speechId(String(hostRunId), text);
      const payload = { v: HOST_SPEECH_VERSION, id, roomId: String(roomId), hostRunId: String(hostRunId), lang: "en", text };
      const token = await roomAdminToken(apiKey, apiSecret, room, Math.floor(Date.now() / 1000));
      const abort = new AbortController();
      timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${httpBase(serverUrl)}/twirp/livekit.RoomService/SendData`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ room, data: b64(enc.encode(JSON.stringify(payload))), kind: "RELIABLE",
          destinationIdentities: [TRANSLATOR_IDENTITY], topic: HOST_SPEECH_TOPIC }),
        signal: abort.signal,
      });
      // The body is released unread: an error answer may echo request data.
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { status: "sent", httpStatus: res.status, id };
      console.warn(`host speech ${id}: LiveKit SendData answered ${res.status}`);
      return { status: "failed", httpStatus: res.status, id, reason: `http_${res.status}` };
    } catch (error) {
      const name = error instanceof Error ? error.name : "error";
      console.warn(`host speech ${id ?? String(hostRunId)}: failed (${name})`);
      return { status: "failed", httpStatus: null, id, reason: name };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
});

/** For callers before codegen lists this module (internal.call.hostSpeech.speak afterwards). */
export const speakRef = makeFunctionReference<"action", SpeechArgs, HostSpeechResult>(
  "call/hostSpeech:speak");
