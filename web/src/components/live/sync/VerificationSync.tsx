"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { create } from "zustand";
import { historySeriesRef, verificationRef } from "@/lib/backend/api";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { setLiveError, useLive } from "@/lib/backend/live";
import type { EventId } from "@/lib/backend/types";

/**
 * A failed history.series read, with the case it belongs to. `LiveKey` has no "history" key, and the chart must not
 * show the verification panel's error, nor the other way round.
 */
export const useHistoryError = create<{ eventId: EventId | null; message: string | null }>(() => ({ eventId: null, message: null }));

/** verifications.get → useLive.verification, history.series → useLive.history (wiring map §9). Each in its own boundary. */
export function VerificationSync({ eventId }: { eventId: EventId }) {
  return (
    <>
      <QueryBoundary onError={(e) => setLiveError("verification", briefError(e))}>
        <VerificationRead eventId={eventId} />
      </QueryBoundary>
      <QueryBoundary onError={(e) => useHistoryError.setState({ eventId, message: briefError(e) })}>
        <HistoryRead eventId={eventId} />
      </QueryBoundary>
    </>
  );
}

/** null until a committed schedule of this case has a recorded result. */
function VerificationRead({ eventId }: { eventId: EventId }) {
  const verification = useQuery(verificationRef, { eventId });
  useEffect(() => {
    if (verification === undefined) return;
    useLive.setState({ verification });
    setLiveError("verification", null);
  }, [verification]);
  return null;
}

/** Real and simulated observations, kept apart, with the cache state (stale, error). */
function HistoryRead({ eventId }: { eventId: EventId }) {
  const history = useQuery(historySeriesRef, { eventId });
  useEffect(() => {
    if (history === undefined) return;
    useLive.setState({ history });
    useHistoryError.setState({ eventId, message: null });
  }, [history, eventId]);
  return null;
}
