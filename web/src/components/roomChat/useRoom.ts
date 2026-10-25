"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { messagesListRef, roomByIdRef } from "@/lib/backend/api";
import { useLive, useRealMode } from "@/lib/backend/live";
import type { RoomId } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";
import type { StageChat } from "./live";

/**
 * A room's projection and lines. The open case's room comes from useLive (RoomSync); any other room subscribes here.
 * Real mode only, inside a QueryBoundary: the subscription throws on FORBIDDEN.
 */
export function useRoomFeed(roomId: RoomId) {
  const own = useLive((s) => s.roomId) !== roomId;
  const ownRoom = useQuery(roomByIdRef, own ? { roomId } : "skip");
  const ownMessages = useQuery(messagesListRef, own ? { roomId } : "skip");
  const room = useLive((s) => s.room);
  const messages = useLive((s) => s.messages);
  const error = useLive((s) => s.errors.room);
  return own ? { room: ownRoom, messages: ownMessages, error: undefined } : { room, messages, error };
}

/** The backend room a call stage writes in: the one it was given, else (docked in a case) the open case's. Null in dev mode. */
export function useStageChat(given: StageChat | undefined, docked: boolean): StageChat | null {
  const real = useRealMode();
  const roomId = useLive((s) => s.roomId);
  const eventId = useOps((s) => s.incident);
  if (!real) return null;
  if (given) return given;
  return docked && roomId ? { roomId, eventId } : null;
}

/**
 * Keeps a scroll box on its newest line while the reader is at the bottom, including when a line grows after it
 * arrives; someone who scrolled up to read is left where they are. A new `repin` value pins again.
 */
export function usePinnedScroll(repin?: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    const inner = list.current;
    if (!el || !inner) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    };
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    ro.observe(el);
    follow();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    if (repin === undefined) return;
    pinned.current = true;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [repin]);
  return { box, list };
}
