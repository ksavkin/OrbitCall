"use client";

import { useEffect } from "react";
import { useMe } from "@/components/auth/session";
import { ensureSmokeDev, isSmokeDemo, smokeSideFor, subscribeSmokeInvites } from "@/lib/ops/smoke";
import { useOps } from "@/lib/ops/store";

/** Maps the signed-in demo account to actAs and keeps smoke Dev on. */
export function SmokeBridge() {
  const me = useMe();
  useEffect(() => {
    if (!isSmokeDemo()) return;
    ensureSmokeDev();
  }, []);
  useEffect(() => {
    if (!isSmokeDemo() || !me?.userId) return;
    const side = smokeSideFor(me.userId);
    if (side === "a" || side === "b") {
      if (useOps.getState().actAs !== side) useOps.getState().set({ actAs: side, autopilot: false });
    } else if (side === "affected") {
      // RU is invited for visibility and voice; they do not take A/B approve turns
      if (useOps.getState().actAs !== null) useOps.getState().set({ actAs: null, autopilot: true });
    }
  }, [me?.userId]);
  useEffect(() => {
    if (!isSmokeDemo()) return;
    return subscribeSmokeInvites(() => {
      // invite landed in storage; Inbox Notices re-reads via its own subscription
    });
  }, []);
  return null;
}
