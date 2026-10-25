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
      // RU watches and can talk; treat as side b for turn UI so Approve stays on CN
      if (useOps.getState().actAs !== "b") useOps.getState().set({ actAs: "b", autopilot: false });
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
