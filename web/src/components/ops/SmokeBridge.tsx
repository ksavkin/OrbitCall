"use client";

import { useEffect } from "react";
import { useMe } from "@/components/auth/session";
import { ensureSmokeDev, isSmokeDemo, smokeSideFor } from "@/lib/ops/smoke";
import { useOps } from "@/lib/ops/store";

/** Maps the signed-in account to actAs and keeps the recording case path on. */
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
      // RU joins for visibility and voice; A/B approve turns stay with US / CN
      if (useOps.getState().actAs !== null) useOps.getState().set({ actAs: null, autopilot: true });
    }
  }, [me?.userId]);
  return null;
}
