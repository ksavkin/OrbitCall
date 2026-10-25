"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { useSession } from "@/components/auth/session";
import { scanMineRef } from "@/lib/backend/api";
import { backendError } from "@/lib/backend/errors";
import { setLiveError, useLive } from "@/lib/backend/live";
import { briefError, QueryBoundary } from "@/lib/backend/QueryBoundary";
import type { ScanId } from "@/lib/backend/types";

/**
 * `scans.getMine` (wiring map §7.2): the run this screen started, or the caller's latest while it started none.
 * Only with a provisioned sign-in; without one there is no run to read. Each run has its own boundary, so a thrown
 * STALE_ASSIGNMENT or FORBIDDEN for one run lands in `errors.scan` and the next Run scan subscribes afresh.
 */
export function ScanSync() {
  const signedIn = useSession((s) => s.backend?.status === "ok");
  const scanId = useLive((s) => s.scanId);
  if (!signedIn) return null;
  return (
    <QueryBoundary
      key={scanId ?? "latest"}
      onError={(e) => {
        const b = backendError(e);
        useLive.setState({ scan: undefined });
        setLiveError("scan", b.code === "UNKNOWN" ? briefError(e) : b.message);
      }}
    >
      <ScanRunSync scanId={scanId} />
    </QueryBoundary>
  );
}

function ScanRunSync({ scanId }: { scanId: ScanId | null }) {
  const scan = useQuery(scanMineRef, scanId ? { scanId } : {});
  useEffect(() => {
    if (scan === undefined) return;
    useLive.setState({ scan });
    setLiveError("scan", null);
  }, [scan]);
  return null;
}
