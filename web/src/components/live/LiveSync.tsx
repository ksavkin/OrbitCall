"use client";

import type { ReactNode } from "react";
import { useSession } from "@/components/auth/session";
import { backendError } from "@/lib/backend/errors";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { setLiveError, useLive, type LiveKey } from "@/lib/backend/live";
import { useOps } from "@/lib/ops/store";
import { RoomPresence } from "./RoomPresence";
import { AdvocatesSync } from "./sync/AdvocatesSync";
import { AgentsSync } from "./sync/AgentsSync";
import { CaseSync } from "./sync/CaseSync";
import { DecisionSync } from "./sync/DecisionSync";
import { FlagsSync } from "./sync/FlagsSync";
import { InboxSync } from "./sync/InboxSync";
import { QueueSync } from "./sync/QueueSync";
import { RoomSync } from "./sync/RoomSync";
import { ScanSync } from "./sync/ScanSync";
import { SummarySync } from "./sync/SummarySync";
import { VerificationSync } from "./sync/VerificationSync";

/**
 * Convex → useLive for real mode. Renders nothing. Mounted beside BackendSync, only with a Convex client and dev off.
 * Each sync sits in its own boundary, so one failing query (FORBIDDEN for a head of ops, a function not deployed)
 * leaves the others running; the error lands in `useLive.errors[key]` for the panel that shows it.
 *
 * Only `config.flags` is public. The rest wait for session.me: Convex sets the sign-in in an effect after the first
 * render, and a query sent before it fails UNAUTHENTICATED and would stay in its boundary until a retry.
 */
export function LiveSync() {
  const userId = useSession((s) => (s.backend?.status === "ok" ? s.backend.me.userId : null));
  const eventId = useOps((s) => s.incident);
  const roomId = useLive((s) => s.roomId);
  const epoch = useLive((s) => s.epoch);
  // the caller's own reads outlive a case change; the case's reads start again with each case
  const mine = `${epoch}-${userId}`;
  const at = `${mine}-${eventId ?? "none"}`;

  return (
    <>
      <Guard id="flags" at={`${epoch}`}>
        <FlagsSync />
      </Guard>
      {userId && (
        <>
          <RoomPresence />
          <Guard id="inbox" at={mine}>
            <InboxSync />
          </Guard>
          <Guard id="queue" at={mine}>
            <QueueSync />
          </Guard>
          <Guard id="scan" at={mine}>
            <ScanSync />
          </Guard>
          {eventId && (
            <>
              <Guard id="case" at={at}>
                <CaseSync eventId={eventId} />
              </Guard>
              <Guard id="decision" at={at}>
                <DecisionSync eventId={eventId} />
              </Guard>
              <Guard id="advocates" at={at}>
                <AdvocatesSync eventId={eventId} />
              </Guard>
              <Guard id="agents" at={at}>
                <AgentsSync eventId={eventId} />
              </Guard>
              <Guard id="summary" at={at}>
                <SummarySync eventId={eventId} roomId={roomId} />
              </Guard>
              <Guard id="verification" at={at}>
                <VerificationSync eventId={eventId} />
              </Guard>
              {roomId && (
                <Guard id="room" at={`${at}-${roomId}`}>
                  <RoomSync roomId={roomId} eventId={eventId} />
                </Guard>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** The backend's own message for a ConvexError, else the first line of the error. */
function readable(e: Error): string {
  const b = backendError(e);
  return b.code === "UNKNOWN" ? briefError(e) : b.message;
}

function Guard({ id, at, children }: { id: LiveKey; at: string; children: ReactNode }) {
  return (
    <QueryBoundary key={`${id}-${at}`} onError={(e) => setLiveError(id, readable(e))}>
      {children}
    </QueryBoundary>
  );
}
