"use client";

import { useQuery } from "convex/react";
import { useCallback, useEffect, useRef } from "react";
import { messagesListRef, roomByIdRef } from "@/lib/backend/api";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { setLiveError, useLive } from "@/lib/backend/live";
import type { EventId, RoomId } from "@/lib/backend/types";

type Part = "room" | "messages";
type Report = (part: Part, message: string | null) => void;

/**
 * rooms.byId and messages.list for the open case's room (wiring map §3). Messages cover the whole room; each view
 * filters by event. The two queries sit in their own boundaries, so one failing keeps the other's data; both report
 * under `errors.room`.
 */
export function RoomSync({ roomId }: { roomId: RoomId; eventId: EventId }) {
  const failed = useRef<Partial<Record<Part, string>>>({});
  const report = useCallback<Report>((part, message) => {
    if (message === null) delete failed.current[part];
    else failed.current[part] = message;
    setLiveError("room", failed.current.room ?? failed.current.messages ?? null);
  }, []);
  return (
    <>
      <QueryBoundary onError={(e) => report("room", briefError(e))}>
        <RoomById roomId={roomId} report={report} />
      </QueryBoundary>
      <QueryBoundary onError={(e) => report("messages", briefError(e))}>
        <RoomMessages roomId={roomId} report={report} />
      </QueryBoundary>
    </>
  );
}

function RoomById({ roomId, report }: { roomId: RoomId; report: Report }) {
  const room = useQuery(roomByIdRef, { roomId });
  useEffect(() => {
    if (room === undefined) return;
    useLive.setState({ room });
    report("room", null);
  }, [room, report]);
  // another room (or none) must not show this one's state
  useEffect(() => () => useLive.setState({ room: undefined }), []);
  return null;
}

function RoomMessages({ roomId, report }: { roomId: RoomId; report: Report }) {
  const messages = useQuery(messagesListRef, { roomId });
  useEffect(() => {
    if (messages === undefined) return;
    useLive.setState({ messages });
    report("messages", null);
  }, [messages, report]);
  useEffect(() => () => useLive.setState({ messages: undefined }), []);
  return null;
}
