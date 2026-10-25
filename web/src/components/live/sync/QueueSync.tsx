"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { create } from "zustand";
import { fleetMineRef, myQueueRef } from "@/lib/backend/api";
import { backendError, type BackendError } from "@/lib/backend/errors";
import { setLiveError, useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import { useSession } from "@/components/auth/session";

// myQueue.myQueue → useLive.myQueue and fleetQuery.listMine → useLive.fleet (wiring map §7.2). Each query has its own
// boundary, so one failing (FORBIDDEN, not deployed) keeps the other's data. The Guard around this sync has a single
// error key, so both errors are kept here with their code; the queue's is mirrored to `useLive.errors.queue`.

type Part = "myQueue" | "fleet";

interface QueueSyncState {
  errors: Record<Part, BackendError | null>;
  /** Bumped by Retry: both queries run again. */
  attempt: number;
}

export const useQueueSync = create<QueueSyncState>(() => ({ errors: { myQueue: null, fleet: null }, attempt: 0 }));

function setError(part: Part, error: BackendError | null) {
  if (useQueueSync.getState().errors[part] !== error) useQueueSync.setState((s) => ({ errors: { ...s.errors, [part]: error } }));
  const message = error?.message ?? null;
  if (part === "myQueue" && (useLive.getState().errors.queue ?? null) !== message) setLiveError("queue", message);
}

/** Clear both errors and run both queries again. */
export function retryQueueSync() {
  setError("myQueue", null);
  setError("fleet", null);
  useQueueSync.setState((s) => ({ attempt: s.attempt + 1 }));
}

/** The backend's own message for a ConvexError, the first line of anything else. */
function readable(e: Error): BackendError {
  const error = backendError(e);
  return error.code === "UNKNOWN" ? { code: "UNKNOWN", message: briefError(e) } : error;
}

/**
 * The signed-in account whose fleet and queue these queries read: a provisioned operator or head of ops, once
 * session.me has answered (so the client already carries the sign-in). Null otherwise; an observer has no fleet.
 */
export function useFleetAccount(): string | null {
  return useSession((s) => (s.backend?.status === "ok" && s.backend.me.role !== "demo_observer" ? s.backend.me.userId : null));
}

export function QueueSync() {
  const userId = useFleetAccount();
  const attempt = useQueueSync((s) => s.attempt);
  if (!userId) return null;
  return (
    <>
      <QueryBoundary key={`queue-${userId}-${attempt}`} onError={(e) => setError("myQueue", readable(e))}>
        <MyQueueQuery />
      </QueryBoundary>
      <QueryBoundary key={`fleet-${userId}-${attempt}`} onError={(e) => setError("fleet", readable(e))}>
        <FleetQuery />
      </QueryBoundary>
    </>
  );
}

function MyQueueQuery() {
  const rows = useQuery(myQueueRef, {});
  useEffect(() => {
    if (rows === undefined) return;
    useLive.setState({ myQueue: rows });
    setError("myQueue", null);
  }, [rows]);
  return null;
}

function FleetQuery() {
  const fleet = useQuery(fleetMineRef, {});
  useEffect(() => {
    if (fleet === undefined) return;
    useLive.setState({ fleet });
    setError("fleet", null);
  }, [fleet]);
  return null;
}
