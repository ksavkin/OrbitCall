"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { catalogPairsRef, catalogSnapshotRef } from "@/lib/backend/api";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { useOps } from "@/lib/ops/store";

/**
 * Convex → ops store, for the backend half of the Dev Switch (dev off). Renders nothing.
 * Mounted only when a Convex client exists and dev is off, so no query runs outside the
 * provider and none runs in synthetic mode. Each query has its own boundary: a query that
 * is not deployed yet shows an error in the queue instead of crashing the app, and a
 * missing snapshot does not take the queue down with it.
 */
export function BackendSync() {
  const epoch = useOps((s) => s.backendEpoch);

  useEffect(
    () => () => {
      // dev switched on (or app torn down): leave nothing of the backend in the synthetic view
      const s = useOps.getState();
      const focusIsBackend = s.focusEvent !== null && s.backendRows?.some((r) => r.eventId === s.focusEvent);
      useOps.setState({
        backendRows: undefined,
        backendSnapshot: undefined,
        backendError: null,
        ...(focusIsBackend ? { focusEvent: null } : {}),
      });
    },
    [],
  );

  return (
    <>
      <QueryBoundary
        key={`pairs-${epoch}`}
        onError={(e) => useOps.setState({ backendRows: undefined, backendError: briefError(e) })}
      >
        <OmmPairsSync />
      </QueryBoundary>
      <QueryBoundary key={`snapshot-${epoch}`} onError={() => useOps.setState({ backendSnapshot: "error" })}>
        <SnapshotSync />
      </QueryBoundary>
    </>
  );
}

function OmmPairsSync() {
  const snapshot = useOps((s) => s.backendSnapshot);
  if (!snapshot || snapshot === "error" || !snapshot.ommUrl) return null;
  return <PairsSync />;
}

function PairsSync() {
  // the whole active queue (the backend caps it); the list filters and pages it in the browser
  const rows = useQuery(catalogPairsRef, {});
  useEffect(() => {
    useOps.setState({ backendRows: rows, backendError: null });
  }, [rows]);
  return null;
}

function SnapshotSync() {
  const snapshot = useQuery(catalogSnapshotRef, {});
  useEffect(() => {
    useOps.setState({ backendSnapshot: snapshot });
  }, [snapshot]);
  return null;
}
