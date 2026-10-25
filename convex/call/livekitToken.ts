// LiveKit access token (JWT, HS256) signed with Web Crypto, so it runs in the default Convex runtime without the
// Node server SDK. Claim layout as livekit-server-sdk writes it: iss = API key, sub = identity, nbf/exp in seconds,
// `video` grant, `name`, `attributes` (spec §5: { lang, companyId }); `canUpdateOwnMetadata: false` keeps the
// participant from rewriting its own language or company (livekit-lessons R7).

export interface CallGrant {
  room: string; roomJoin: true; canPublish: boolean; canPublishSources: string[]; canSubscribe: boolean;
  canPublishData: boolean; canUpdateOwnMetadata: false;
}

export interface TokenInput {
  apiKey: string; apiSecret: string; identity: string; name: string; room: string;
  attributes: Record<string, string>; ttlS: number; nowS: number; canPublish?: boolean;
  /** Agent dispatched when the room is created by this join (explicit dispatch, livekit-lessons R5). */
  agentName?: string;
}

const enc = new TextEncoder();
/** Valid from a few seconds back: a Convex clock slightly ahead of the LiveKit server must not yield "not yet valid". */
export const NBF_SKEW_S = 5;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (value: unknown) => b64url(enc.encode(JSON.stringify(value)));

/** The grant of a call member: join this one room, publish only the microphone (an observer publishes nothing),
 * subscribe, no data channel. */
export const callGrant = (room: string, canPublish = true): CallGrant => ({
  room, roomJoin: true, canPublish, canPublishSources: canPublish ? ["microphone"] : [], canSubscribe: true,
  canPublishData: false, canUpdateOwnMetadata: false,
});

export async function mintLiveKitToken(t: TokenInput): Promise<string> {
  if (!t.apiKey || !t.apiSecret) throw new Error("LiveKit API key and secret are required");
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: t.apiKey, sub: t.identity, jti: t.identity, nbf: t.nowS - NBF_SKEW_S, exp: t.nowS + t.ttlS,
    name: t.name, video: callGrant(t.room, t.canPublish ?? true), attributes: t.attributes,
    // RoomConfiguration in protobuf JSON (camelCase), as livekit-server-sdk serializes ClaimGrants.roomConfig
    ...(t.agentName ? { roomConfig: { agents: [{ agentName: t.agentName }] } } : {}),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(t.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${b64url(signature)}`;
}
