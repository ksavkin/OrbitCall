"use client";

import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { rowFromInbox, rowFromQueue, toEvent, upsertCaseEvent, useCaseRow } from "@/lib/backend/adapt";
import { inboxGetRef, roomByEventRef, roomForEventRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { setCaseRoom, setLiveError, useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { EventId } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";
import { useOrbit } from "@/lib/store";

/**
 * The open case (wiring map §1.5, §6.2): its row from inbox.get (the queue row when the inbox cannot be read), its room
 * while useLive has none, and the ConjunctionEvent the shell renders (lib/backend/adapt.ts). Each query sits in its own
 * boundary, so a room lookup that fails never hides the case.
 */
export function CaseSync({ eventId }: { eventId: EventId }) {
  const roomId = useLive((s) => s.roomId);
  const [inboxError, setInboxError] = useState<string | null>(null);
  return (
    <>
      {inboxError === null ? (
        <QueryBoundary onError={(e) => setInboxError(userMessage(e))}>
          <InboxRow eventId={eventId} />
        </QueryBoundary>
      ) : (
        <QueueRow eventId={eventId} error={inboxError} />
      )}
      {roomId === null && (
        <>
          <QueryBoundary>
            <OpenRoom eventId={eventId} />
          </QueryBoundary>
          <QueryBoundary>
            <LatestRoom eventId={eventId} />
          </QueryBoundary>
        </>
      )}
      <CaseEvent eventId={eventId} />
    </>
  );
}

function userMessage(e: Error): string {
  const err = backendError(e);
  return err.code === "UNKNOWN" ? briefError(e) : err.message;
}

function InboxRow({ eventId }: { eventId: EventId }) {
  const entry = useQuery(inboxGetRef, { eventId });
  useEffect(() => {
    if (!entry) return;
    useCaseRow.setState({ row: rowFromInbox(entry) });
    setLiveError("case", null);
  }, [entry]);
  return null;
}

/** inbox.get failed: the queue row has the facts but no owners. With neither, the case reports the inbox error. */
function QueueRow({ eventId, error }: { eventId: EventId; error: string }) {
  const mine = useLive((s) => s.myQueue?.find((r) => r.eventId === eventId));
  const pair = useOps((s) => s.backendRows?.find((r) => r.eventId === eventId));
  const row = mine ?? pair;
  useEffect(() => {
    if (row) useCaseRow.setState({ row: rowFromQueue(row) });
    setLiveError("case", row ? null : error);
  }, [row, error]);
  return null;
}

/** rooms.get: the open room, null before startWorkflow and after the room closes. */
function OpenRoom({ eventId }: { eventId: EventId }) {
  const room = useQuery(roomByEventRef, { eventId });
  useEffect(() => {
    if (room) setCaseRoom(eventId, room.roomId);
  }, [eventId, room]);
  return null;
}

/** rooms.forEvent: the latest room, open or closed, so a closed room is found again after a reload. */
function LatestRoom({ eventId }: { eventId: EventId }) {
  const room = useQuery(roomForEventRef, { eventId });
  useEffect(() => {
    if (room) setCaseRoom(eventId, room.roomId);
  }, [eventId, room]);
  return null;
}

/** Keeps the case's ConjunctionEvent in useOps.events in step with the row, the room, the approvals and the analyst. */
function CaseEvent({ eventId }: { eventId: EventId }) {
  const row = useCaseRow((s) => s.row);
  const room = useLive((s) => s.room);
  const approvals = useLive((s) => s.approvals);
  const summary = useLive((s) => s.summary);
  const catalog = useOrbit((s) => s.catalog);
  useEffect(() => {
    const e = row?.eventId === eventId ? toEvent(row, { room, approvals, summary }, catalog) : null;
    if (e) upsertCaseEvent(e);
  }, [eventId, row, room, approvals, summary, catalog]);
  return null;
}
