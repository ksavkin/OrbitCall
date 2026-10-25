"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { agentSummaryRef, summaryGetRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { setLiveError, useLive, type LiveKey } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { EventId, RoomId } from "@/lib/backend/types";

/**
 * The summary form's own error key, so a failing summary.get (FORBIDDEN for an operator without a current assignment)
 * does not hide the analyst summary, and the other way round.
 */
export const SUMMARY_FORM_KEY: LiveKey = "summaryForm";

/** A query error as one line: the backend's own message when it sent one, else the first line of the error. */
function queryError(e: Error): string {
  const b = backendError(e);
  return b.code === "UNKNOWN" ? briefError(e) : b.message;
}

/** agentSummaries.get → `useLive.summary`, summary.get → `useLive.summaryForm` (wiring map §5.1, §5.4). */
export function SummarySync({ eventId }: { eventId: EventId; roomId: RoomId | null }) {
  return (
    <>
      <QueryBoundary onError={(e) => setLiveError("summary", queryError(e))}>
        <AnalystSummary eventId={eventId} />
      </QueryBoundary>
      <QueryBoundary
        onError={(e) => {
          // a stale form could still say canEdit: drop it with the error
          useLive.setState({ summaryForm: undefined });
          setLiveError(SUMMARY_FORM_KEY, queryError(e));
        }}
      >
        <SummaryFormState eventId={eventId} />
      </QueryBoundary>
    </>
  );
}

/** The Incident Analyst's five lines and its run state. */
function AnalystSummary({ eventId }: { eventId: EventId }) {
  const summary = useQuery(agentSummaryRef, { eventId });
  useEffect(() => {
    if (summary === undefined) return;
    useLive.setState({ summary });
    setLiveError("summary", null);
  }, [summary]);
  return null;
}

/** The selected card as a summary form, whether this operator may edit it, and the latest edit job. */
function SummaryFormState({ eventId }: { eventId: EventId }) {
  const form = useQuery(summaryGetRef, { eventId });
  useEffect(() => {
    if (form === undefined) return;
    useLive.setState({ summaryForm: form });
    setLiveError(SUMMARY_FORM_KEY, null);
  }, [form]);
  return null;
}
