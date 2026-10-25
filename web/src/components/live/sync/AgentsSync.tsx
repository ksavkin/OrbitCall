"use client";

import { useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { agentLogsListRef, inboxGetRef, spansListRef } from "@/lib/backend/api";
import { setLiveError, useLive } from "@/lib/backend/live";
import { QueryBoundary } from "@/lib/backend/QueryBoundary";
import { companySides, isLiveLog, isLiveSpan, sameSides, toLogLines, toSpans, type CompanySides } from "@/lib/backend/spans";
import type { EventId } from "@/lib/backend/types";
import { useOps } from "@/lib/ops/store";

const LIMIT = 100;
const NO_SIDES: CompanySides = new Map();

/**
 * spans.list and agentLogs.list for the open case (wiring map §4) → `useLive.spans` / `agentLogs`, and in simulator
 * shape → `useOps.spans` / `logs`, which the agent graph, trace and log views read. Advocate spans name their company:
 * the case's inbox entry tells its side, so the simulator copy waits for it (and puts advocates on the generic node if
 * it fails). The copy is removed when the case closes or dev turns on, both of which unmount this.
 */
export function AgentsSync({ eventId }: { eventId: EventId }) {
  // one log line per span: the same limit keeps the log as long as the trace
  const spans = useQuery(spansListRef, { eventId, limit: LIMIT });
  const logs = useQuery(agentLogsListRef, { eventId, limit: LIMIT });
  const [sides, setSides] = useState<CompanySides>();
  const keep = useCallback((next: CompanySides) => setSides((prev) => (sameSides(prev, next) ? prev : next)), []);

  useEffect(() => {
    if (spans === undefined || logs === undefined) return;
    useLive.setState({ spans, agentLogs: logs });
    setLiveError("agents", null);
  }, [spans, logs]);

  useEffect(() => {
    if (spans === undefined || logs === undefined || sides === undefined || useOps.getState().dev) return;
    useOps.setState({ spans: toSpans(spans, sides), logs: toLogLines(logs, sides) });
  }, [spans, logs, sides]);

  useEffect(
    () => () =>
      useOps.setState((s) => ({ spans: s.spans.filter((x) => !isLiveSpan(x)), logs: s.logs.filter((l) => !isLiveLog(l)) })),
    [],
  );

  return (
    <QueryBoundary onError={() => keep(NO_SIDES)}>
      <CaseSides eventId={eventId} onSides={keep} />
    </QueryBoundary>
  );
}

function CaseSides({ eventId, onSides }: { eventId: EventId; onSides: (sides: CompanySides) => void }) {
  const entry = useQuery(inboxGetRef, { eventId });
  useEffect(() => {
    if (entry !== undefined) onSides(companySides(entry));
  }, [entry, onSides]);
  return null;
}
