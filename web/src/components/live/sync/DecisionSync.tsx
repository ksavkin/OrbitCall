"use client";

import { useQuery } from "convex/react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { approvalsStatusRef, logListRef, maneuverRef, proposalsListRef, rationaleListRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { setLiveError, useLive } from "@/lib/backend/live";
import type { EventId } from "@/lib/backend/types";

// The Decision Center's reads for the open case (wiring map §1.2-1.4). Each query sits in its own boundary, so one
// failure (log.list not deployed, NOT_FOUND "Candidate evidence is incomplete.") leaves the others running.
// `errors.decision` holds the first failure until that query has data again; a failed query's field goes back to
// undefined, so the panel never shows data the backend stopped serving.

type Part = "proposals" | "approvals" | "maneuver" | "rationale" | "log";
type Report = (part: Part, message: string | null) => void;
type Props = { eventId: EventId; report: Report };

const CLEARED: Record<Part, Partial<ReturnType<typeof useLive.getState>>> = {
  proposals: { proposals: undefined },
  approvals: { approvals: undefined },
  maneuver: { maneuver: undefined },
  rationale: { rationale: undefined },
  log: { log: undefined },
};

/** The backend's own message when the query threw a ConvexError, else the first line of the error. */
function readable(e: Error): string {
  const b = backendError(e);
  return b.code === "UNKNOWN" ? briefError(e) : b.message;
}

export function DecisionSync({ eventId }: { eventId: EventId }) {
  const failed = useRef<Partial<Record<Part, string>>>({});
  const report = useCallback<Report>((part, message) => {
    if (message === null) delete failed.current[part];
    else failed.current[part] = message;
    setLiveError("decision", Object.values(failed.current)[0] ?? null);
  }, []);

  return (
    <>
      <Boundary part="proposals" report={report}>
        <Proposals eventId={eventId} report={report} />
      </Boundary>
      <Boundary part="approvals" report={report}>
        <Approvals eventId={eventId} report={report} />
      </Boundary>
      <Boundary part="maneuver" report={report}>
        <ManeuverRow eventId={eventId} report={report} />
      </Boundary>
      <Boundary part="rationale" report={report}>
        <Rationale eventId={eventId} report={report} />
      </Boundary>
      <Boundary part="log" report={report}>
        <Log eventId={eventId} report={report} />
      </Boundary>
    </>
  );
}

function Boundary({ part, report, children }: { part: Part; report: Report; children: ReactNode }) {
  return (
    <QueryBoundary
      onError={(e) => {
        useLive.setState(CLEARED[part]);
        report(part, readable(e));
      }}
    >
      {children}
    </QueryBoundary>
  );
}

function Proposals({ eventId, report }: Props) {
  const proposals = useQuery(proposalsListRef, { eventId });
  useEffect(() => {
    if (proposals === undefined) return;
    useLive.setState({ proposals });
    report("proposals", null);
  }, [proposals, report]);
  return null;
}

function Approvals({ eventId, report }: Props) {
  const approvals = useQuery(approvalsStatusRef, { eventId });
  useEffect(() => {
    if (approvals === undefined) return;
    useLive.setState({ approvals });
    report("approvals", null);
  }, [approvals, report]);
  return null;
}

/** `maneuvers.get`: null until a preview row exists. The newest row can belong to an older card (see diffForSelection). */
function ManeuverRow({ eventId, report }: Props) {
  const maneuver = useQuery(maneuverRef, { eventId });
  useEffect(() => {
    if (maneuver === undefined) return;
    useLive.setState({ maneuver });
    report("maneuver", null);
  }, [maneuver, report]);
  return null;
}

function Rationale({ eventId, report }: Props) {
  const rationale = useQuery(rationaleListRef, { eventId });
  useEffect(() => {
    if (rationale === undefined) return;
    useLive.setState({ rationale });
    report("rationale", null);
  }, [rationale, report]);
  return null;
}

/** The first page of `log.list` (50 rows, newest first) is enough for the case's schedule_failed rows. */
function Log({ eventId, report }: Props) {
  const page = useQuery(logListRef, { eventId });
  const log = page?.entries;
  useEffect(() => {
    if (log === undefined) return;
    useLive.setState({ log });
    report("log", null);
  }, [log, report]);
  return null;
}
