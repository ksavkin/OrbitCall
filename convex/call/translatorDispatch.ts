// Explicit translator dispatch (livekit-lessons R5). The join token's roomConfig dispatches the agent only when that
// join creates the room. A case's room keeps one name for its whole life, so a room that outlived a worker restart, or
// whose job was refused, never got a translator back, and members of different languages heard nothing from each
// other. Before a join, ask LiveKit whether the room exists and has the translator; if it exists without one and no
// translator job is pending or running, create a dispatch. The worker refuses a second translator on its own, so a
// rare duplicate is harmless. Best effort: a LiveKit hiccup never blocks the join.

import { httpBase, roomAdminToken, TRANSLATOR_IDENTITY } from "./hostSpeech";

const TIMEOUT_MS = 3000;

export type DispatchResult = "no_room" | "present" | "pending" | "dispatched" | "failed";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Participant { identity?: string }
interface Job { state?: { status?: string | number } }
interface Dispatch { agentName?: string; agent_name?: string; state?: { jobs?: Job[] } }

// JobStatus: JS_PENDING = 0, JS_RUNNING = 1 (protobuf JSON gives the name or the number)
const live = (job: Job) => {
  const status = job.state?.status;
  return status === undefined || status === 0 || status === 1 || status === "JS_PENDING" || status === "JS_RUNNING";
};

export async function ensureTranslator(opts: {
  serverUrl: string; apiKey: string; apiSecret: string; room: string; agentName: string; nowS: number; fetch?: Fetch;
}): Promise<DispatchResult> {
  const call = opts.fetch ?? fetch;
  const base = httpBase(opts.serverUrl);
  const token = await roomAdminToken(opts.apiKey, opts.apiSecret, opts.room, opts.nowS);
  const post = async (path: string, body: unknown) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      return await call(`${base}/twirp/${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const people = await post("livekit.RoomService/ListParticipants", { room: opts.room });
    // no such room yet: this join creates it, and the token's roomConfig dispatches the translator
    if (people.status === 404) return "no_room";
    if (!people.ok) return "failed";
    const { participants = [] } = (await people.json()) as { participants?: Participant[] };
    if (participants.some(p => p.identity === TRANSLATOR_IDENTITY)) return "present";
    const listed = await post("livekit.AgentDispatchService/ListDispatch", { room: opts.room });
    if (listed.ok) {
      const { agentDispatches = [], agent_dispatches = [] } = (await listed.json()) as { agentDispatches?: Dispatch[]; agent_dispatches?: Dispatch[] };
      const ours = [...agentDispatches, ...agent_dispatches].filter(d => (d.agentName ?? d.agent_name) === opts.agentName);
      if (ours.some(d => (d.state?.jobs ?? []).some(live) || !(d.state?.jobs ?? []).length)) return "pending";
    }
    const created = await post("livekit.AgentDispatchService/CreateDispatch", { room: opts.room, agentName: opts.agentName });
    return created.ok ? "dispatched" : "failed";
  } catch {
    return "failed";
  }
}
