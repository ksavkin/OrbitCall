"use client";

import { CONVEX_ENABLED } from "@/lib/backend/provider";
import { QueryBoundary, briefError } from "@/lib/backend/QueryBoundary";
import { CallPanel } from "@/call/CallPanel";
import { enableCallDebug } from "@/call/debug";

// The test page exposes window.__callDebug for end-to-end checks (tracks heard, publish options, first audio).
enableCallDebug();

// Without NEXT_PUBLIC_CONVEX_URL the app renders no Convex provider, and the call hook would throw. A failing query
// (FORBIDDEN for a wrong token, functions not deployed) stays inside the boundary. The key remounts the panel (one
// hook, one LiveKit Room) when the room or the token changes.
export function CallGate({ roomId, devToken }: { roomId: string | undefined; devToken: string | undefined }) {
  if (!CONVEX_ENABLED) return <p className="p-4 text-sm opacity-70">The call needs the backend (NEXT_PUBLIC_CONVEX_URL).</p>;
  if (!roomId) return <p className="p-4 text-sm opacity-70">Open /call?room=&lt;roomId&gt;&amp;token=&lt;devToken&gt;.</p>;
  return (
    <QueryBoundary key={`${roomId}:${devToken ?? ""}`} fallback={(e) => <p className="p-4 text-sm text-red-500" role="alert">{briefError(e)}</p>}>
      <CallPanel roomId={roomId} devToken={devToken} />
    </QueryBoundary>
  );
}
