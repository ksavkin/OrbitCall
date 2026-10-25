"use client";

import { useEffect, useRef } from "react";
import { useOps } from "@/lib/ops/store";
import { sfx } from "@/lib/sound";

// The end of the loop has no pop-up: the closing report is the last entry of the case's meeting in the Decision
// Center. This only marks the moment: a short sound, and the Decision Center comes forward so the report is seen.

export function ResolutionCue() {
  const resolved = useOps((s) => s.resolved);
  const played = useRef<string | null>(null);
  useEffect(() => {
    if (!resolved || played.current === `${resolved.eventId}:${resolved.at}`) return;
    played.current = `${resolved.eventId}:${resolved.at}`;
    sfx.resolved();
    const st = useOps.getState();
    if (st.incident === resolved.eventId && st.tab === "orbit") st.set({ tab: "decision" });
  }, [resolved]);
  return null;
}
