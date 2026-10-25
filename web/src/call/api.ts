import { anyApi, type FunctionReference } from "convex/server";

// Refs to the call module's functions by name (anyApi), without importing convex/_generated: this folder copies as is
// into a frontend that is its own package (web/ in the team repo). Shapes follow convex/call/*.ts and the team spec
// (§2 Message / ProtectedValue, §3.4 coordination room, §5 live call). Every function takes an optional `devToken`
// until sign-in exists (CALL_DEV_IDENTITY=on on a development deployment only).

export type Lang = "en" | "ru" | "zh";
export type RoomId = string;

/** `call/join:join`: a 2 h LiveKit token for the coordination room; language, company and role come from the server. */
export type JoinResult = {
  serverUrl: string;
  token: string;
  roomName: string; // "coordination-<roomId>"
  identity: string; // "user-<userId>"
  language: Lang;
  /** An observer's token has canPublish false: listen and read captions only. */
  role: "operator" | "observer";
};

/** A value protected from translation (spec ProtectedValue): shown in monospace, never altered. */
export type ProtectedValue = {
  placeholder: string; // "⟦v1⟧"
  kind: "number" | "unit" | "datetime" | "timezone" | "object_id" | "sign";
  text: string;
};

/** One voice phrase as `call/messages:list` returns it (spec Message subset, kind "voice"). */
export type CallMessage = {
  messageId: string;
  roomId: RoomId;
  eventId: string | null;
  at: string;
  author:
    | { kind: "human"; userId: string; companyId: string; name: string; side: null }
    | { kind: "agent"; role: string; side: null }
    | { kind: "system" };
  kind: "voice";
  /** The viewer's language; equals originalText when the viewer speaks the original or the translation failed. */
  text: string;
  originalText: string;
  originalLang: Lang;
  /** For the viewer's language: "pending" while translating, "original_only" when the value check failed (not voiced). */
  translationStatus: "ok" | "pending" | "original_only";
  values: ProtectedValue[];
  /** Why the viewer's language is "original_only" (provider failure, the value check, or NOT_TRANSLATED: the viewer
   * joined after this phrase, so no translation into their language exists); null otherwise. */
  translationError?: { code: string; message: string } | null;
  /** The text is translated but the voice for the viewer's language failed (shown as text only); null otherwise. */
  voiceError?: { code: string; message: string } | null;
  refs: { eventId?: string; proposalId?: string; revision?: number };
  form: null;
  simulated: boolean;
  segId: string;
  rev: number;
};

export type CallErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "FEATURE_DISABLED" | "UPSTREAM_UNAVAILABLE"
  // client-side
  | "MIC_DENIED" | "MIC_UNAVAILABLE" | "CONNECT_FAILED" | "DISCONNECTED" | "UNKNOWN";
export type CallError = { code: CallErrorCode | string; message: string };

type Args = Record<string, unknown>;
type Query<A extends Args, Result> = FunctionReference<"query", "public", A, Result>;
type Mutation<A extends Args, Result> = FunctionReference<"mutation", "public", A, Result>;
type Action<A extends Args, Result> = FunctionReference<"action", "public", A, Result>;
type Auth = { devToken?: string };
type ByRoom = { roomId: RoomId } & Auth;

export const callApi = {
  join: anyApi.call.join.join as unknown as Action<ByRoom, JoinResult>,
  presence: {
    join: anyApi.call.presence.join as unknown as Mutation<ByRoom, null>,
    leave: anyApi.call.presence.leave as unknown as Mutation<ByRoom, null>,
    setInCall: anyApi.call.presence.setInCall as unknown as Mutation<ByRoom & { inCall: boolean }, null>,
  },
  messages: {
    list: anyApi.call.messages.list as unknown as Query<ByRoom & { eventId?: string; limit?: number }, CallMessage[]>,
  },
};
