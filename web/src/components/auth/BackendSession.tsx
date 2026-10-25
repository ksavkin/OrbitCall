"use client";

import { useConvex, useConvexAuth } from "convex/react";
import { anyApi } from "convex/server";
import { useEffect } from "react";
import { useSession, type BackendAccount, type ServerMe } from "./session";

// Reads `session.me` (convex/session.ts) while Convex has a signed-in identity and puts the answer in the session
// store, where it replaces the demo account. Without an identity (Auth0 not wired yet) it does nothing. Render it
// only under a Convex client.

function codeOf(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string" ? data.code : undefined;
}

export function BackendSession() {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const setBackend = useSession((s) => s.setBackend);

  useEffect(() => {
    if (!isAuthenticated) {
      setBackend(null);
      return;
    }
    const watch = convex.watchQuery(anyApi.session.me, {});
    const read = () => {
      let next: BackendAccount;
      try {
        const me = watch.localQueryResult() as ServerMe | undefined;
        if (me === undefined) return;
        next = { status: "ok", me };
      } catch (error) {
        next = { status: codeOf(error) === "FORBIDDEN" ? "forbidden" : "error" };
      }
      setBackend(next);
    };
    read();
    const stop = watch.onUpdate(read);
    return () => {
      stop();
      setBackend(null);
    };
  }, [convex, isAuthenticated, setBackend]);

  return null;
}
