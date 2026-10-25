"use client";

import { useEffect } from "react";
import { roomJoinRef, roomLeaveRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { useLive, useRealMode } from "@/lib/backend/live";
import { mutate } from "@/lib/backend/run";
import type { RoomId } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";

/**
 * Room presence is best effort: a closed room ("This room is closed."), a closed demo run and a head of ops ("Only
 * operators act in a room.") are expected and have nothing to show. Anything else is logged.
 */
export function bestEffort(write: Promise<unknown>) {
  write.catch((e) => {
    const { code, message } = backendError(e);
    if (code !== "INVALID_STATE" && code !== "FORBIDDEN") console.warn("[room presence]", code, message);
  });
}

const join = (roomId: RoomId) => bestEffort(mutate(roomJoinRef, { roomId }));
const leave = (roomId: RoomId) => bestEffort(mutate(roomLeaveRef, { roomId }));

/**
 * The open case's room presence (wiring map §3.2, call order 3): rooms.join once its room is known, rooms.leave when
 * the case or its room changes, this unmounts, or the tab closes (the server keeps `inRoom` until told). Leaving the
 * room also clears `inCall`. Real mode only. Renders nothing.
 */
export function RoomPresence() {
  const real = useRealMode();
  const eventId = useOps((s) => s.incident);
  const roomId = useLive((s) => s.roomId);

  useEffect(() => {
    if (!real || !eventId || !roomId) return;
    join(roomId);
    const bye = () => leave(roomId);
    window.addEventListener("beforeunload", bye);
    return () => {
      window.removeEventListener("beforeunload", bye);
      leave(roomId);
    };
  }, [real, eventId, roomId]);

  return null;
}
