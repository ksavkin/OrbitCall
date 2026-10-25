// POST /call/phrase: the translation worker writes each phrase here (spec §5 step 5; Convex is the source of truth,
// livekit-lessons R6). Only the worker calls it: header `x-call-service-token` must equal env CALL_SERVICE_TOKEN.
// A phrase is upserted by segId while it is recognized, translated and voiced; a higher `rev` wins, an older or equal
// one is ignored (R10). Route line for convex/http.ts:
//   http.route({ path: "/call/phrase", method: "POST", handler: phrase });

import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { httpAction, internalMutation } from "../_generated/server";
import { lang, phraseErrors, protectedValue, translations, translationStatus } from "../schema/call";
import { callError, nowIso } from "./core";

export const MAX_TEXT = 2000;
export const MAX_VALUES = 64;
const MAX_SHORT = 200;
const MAX_REV = 1_000_000;
const STARTED_WINDOW_MS = 48 * 3600 * 1000; // startedAtMs: wall-clock epoch ms of the utterance start, within ±48 h of now
const PLACEHOLDER = /^\u27e6v\d{1,3}\u27e7$/; // the spec's placeholder form, e.g. the first value is v1 in white brackets
const MAX_ERROR = 500;
const LANGS = ["en", "ru", "zh"] as const;
const KINDS = ["number", "unit", "datetime", "timezone", "object_id", "sign"] as const;
const STATUSES = ["ok", "pending", "original_only"] as const;

const phraseArgs = {
  roomId: v.string(), eventId: v.union(v.string(), v.null()), segId: v.string(), rev: v.number(), speakerIdentity: v.string(),
  originalLang: lang, original: v.string(), translations, values: v.array(protectedValue), translationStatus, errors: phraseErrors,
  startedAtMs: v.number(),
};
type Phrase = { [K in keyof typeof phraseArgs]: (typeof phraseArgs)[K]["type"] };

export const upsertPhrase = internalMutation({
  args: phraseArgs,
  handler: async (ctx, p) => {
    if (!p.speakerIdentity.startsWith("user-")) callError("VALIDATION", "speakerIdentity must be user-<userId>");
    const userId = p.speakerIdentity.slice("user-".length);
    const member = await ctx.db.query("call_members").withIndex("by_room_user", (q) => q.eq("roomId", p.roomId).eq("userId", userId)).first();
    if (!member) callError("NOT_FOUND", "No such member in this room");
    if (member.lang !== p.originalLang) callError("VALIDATION", "originalLang differs from the speaker's language");
    if (member.role !== "operator") callError("VALIDATION", "An observer does not speak in the call");
    const speaker = { userId: member.userId, companyId: member.companyId, name: member.name, identity: p.speakerIdentity };
    const fields = { roomId: p.roomId, eventId: p.eventId, segId: p.segId, rev: p.rev, speaker, originalLang: p.originalLang,
      original: p.original, translations: p.translations, values: p.values, translationStatus: p.translationStatus, errors: p.errors,
      startedAtMs: p.startedAtMs, simulated: member.simulated };
    // Two first posts of one segId race on this read; Convex OCC serializes them, so the second sees the first.
    const existing = await ctx.db.query("call_phrases").withIndex("by_seg", (q) => q.eq("segId", p.segId)).first();
    if (!existing) {
      const at = nowIso();
      await ctx.db.insert("call_phrases", { ...fields, createdAt: at, updatedAt: at });
      return true;
    }
    if (existing.roomId !== p.roomId || existing.speaker.identity !== p.speakerIdentity) callError("VALIDATION", "segId belongs to another speaker or room");
    if (p.rev <= existing.rev) return false; // an older or repeated revision never overwrites a newer one
    await ctx.db.patch(existing._id, { ...fields, updatedAt: nowIso() });
    return true;
  },
});
const upsertRef = makeFunctionReference<"mutation", Phrase, boolean>("call/ingest:upsertPhrase");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (message: string) => json(400, { error: { code: "VALIDATION", message } });

/** Constant-time comparison of two secrets (equal-length SHA-256 digests compared without early exit). */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const isStr = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const isLang = (x: unknown): x is (typeof LANGS)[number] => typeof x === "string" && (LANGS as readonly string[]).includes(x);

/** Checks and normalizes the worker's body; returns an error message or the phrase. */
export function parsePhrase(body: unknown): string | Phrase {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (!isStr(b.roomId, MAX_SHORT)) return "roomId";
  if (b.eventId !== undefined && b.eventId !== null && !isStr(b.eventId, MAX_SHORT)) return "eventId";
  if (!isStr(b.segId, MAX_SHORT)) return "segId";
  if (typeof b.rev !== "number" || !Number.isInteger(b.rev) || b.rev < 0 || b.rev > MAX_REV) return `rev must be an integer 0..${MAX_REV}`;
  if (!isStr(b.speakerIdentity, MAX_SHORT)) return "speakerIdentity";
  // segId = <roomId>:<identity>:<epoch>:<n> (contract, R10): a segment can never collide across rooms or speakers.
  if (!b.segId.startsWith(`${b.roomId}:${b.speakerIdentity}:`)) return "segId must start with <roomId>:<speakerIdentity>:";
  if (!isLang(b.originalLang)) return "originalLang must be en, ru or zh";
  if (!isStr(b.original, MAX_TEXT)) return `original must be 1..${MAX_TEXT} characters`;
  if (typeof b.startedAtMs !== "number" || !Number.isFinite(b.startedAtMs) || b.startedAtMs < 0 ||
    Math.abs(b.startedAtMs - Date.now()) > STARTED_WINDOW_MS) {
    return "startedAtMs must be the utterance start in epoch milliseconds, within 48 h of now";
  }
  const tr = (b.translations ?? {}) as Record<string, unknown>;
  const st = (b.translationStatus ?? {}) as Record<string, unknown>;
  if (typeof tr !== "object" || typeof st !== "object" || Array.isArray(tr) || Array.isArray(st)) return "translations / translationStatus must be objects";
  const translations: Phrase["translations"] = {}, translationStatus: Phrase["translationStatus"] = {};
  for (const k of Object.keys(st)) {
    if (!isLang(k)) return `translationStatus: unknown language ${k}`;
    if (!(STATUSES as readonly unknown[]).includes(st[k])) return `translationStatus.${k} must be ok, pending or original_only`;
    translationStatus[k] = st[k] as (typeof STATUSES)[number];
  }
  for (const k of Object.keys(tr)) {
    if (!isLang(k)) return `translations: unknown language ${k}`;
    if (!isStr(tr[k], MAX_TEXT)) return `translations.${k} must be 1..${MAX_TEXT} characters`;
    if (!translationStatus[k]) return `translations.${k} has no translationStatus.${k}`;
    // a translation that failed its check is never stored: nobody can later "fix" the status without re-checking
    if (translationStatus[k] !== "original_only") translations[k] = tr[k] as string;
  }
  for (const k of LANGS) if (translationStatus[k] === "ok" && !translations[k]) return `translationStatus.${k} is ok but translations.${k} is missing`;
  const er = (b.errors ?? {}) as Record<string, unknown>;
  if (typeof er !== "object" || Array.isArray(er)) return "errors must be an object";
  const errors: Phrase["errors"] = {};
  for (const k of Object.keys(er)) {
    if (!isLang(k)) return `errors: unknown language ${k}`;
    const e = (typeof er[k] === "object" && er[k] !== null ? er[k] : {}) as Record<string, unknown>;
    if (!isStr(e.code, MAX_SHORT) || !isStr(e.message, MAX_ERROR)) return `errors.${k} must be { code, message } (message at most ${MAX_ERROR} characters)`;
    errors[k] = { code: e.code, message: e.message };
  }
  const raw = b.values ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_VALUES) return `values must be an array of at most ${MAX_VALUES}`;
  const values: Phrase["values"] = [];
  for (const item of raw) {
    // Tolerant: `token` is accepted as the placeholder and a missing kind means "number"; stored in the spec shape.
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const placeholder = o.placeholder ?? o.token, kind = o.kind ?? "number";
    if (!isStr(placeholder, MAX_SHORT) || !isStr(o.text, MAX_SHORT)) return "values: placeholder and text required (at most 200 characters)";
    if (!PLACEHOLDER.test(placeholder)) return "values: placeholder must be the spec form (white square brackets around v<n>)";
    if (!(KINDS as readonly unknown[]).includes(kind)) return `values: unknown kind ${String(kind)}`;
    values.push({ placeholder, kind: kind as (typeof KINDS)[number], text: o.text });
  }
  return { roomId: b.roomId, eventId: (b.eventId as string | null | undefined) ?? null, segId: b.segId, rev: b.rev,
    speakerIdentity: b.speakerIdentity, originalLang: b.originalLang, original: b.original, translations, values, translationStatus,
    errors, startedAtMs: b.startedAtMs };
}

export const phrase = httpAction(async (ctx, req) => {
  const expected = process.env.CALL_SERVICE_TOKEN;
  if (!expected) return json(503, { error: { code: "FEATURE_DISABLED", message: "CALL_SERVICE_TOKEN is not set" } });
  if (!(await sameSecret(req.headers.get("x-call-service-token") ?? "", expected))) return json(401, { error: { code: "UNAUTHENTICATED", message: "Bad service token" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body is not JSON");
  }
  const parsed = parsePhrase(body);
  if (typeof parsed === "string") return bad(parsed);
  try {
    return json(200, { ok: true, applied: await ctx.runMutation(upsertRef, parsed) });
  } catch (e) {
    const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string }) : null;
    if (data?.code === "NOT_FOUND") return json(404, { error: data });
    if (data?.code === "VALIDATION") return json(400, { error: data });
    throw e;
  }
});
