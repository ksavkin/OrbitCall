"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { advocatesListRef } from "@/lib/backend/api";
import { setLiveError, useLive } from "@/lib/backend/live";
import type { EventId } from "@/lib/backend/types";

/**
 * advocates.list, operators of a party side only (wiring map §5.3). A head of ops gets FORBIDDEN: the boundary records
 * it in `errors.advocates`, this unmounts, and the chips and the situation line stay hidden.
 */
export function AdvocatesSync({ eventId }: { eventId: EventId }) {
  const advocates = useQuery(advocatesListRef, { eventId });
  useEffect(() => {
    if (advocates === undefined) return;
    useLive.setState({ advocates });
    setLiveError("advocates", null);
  }, [advocates]);
  // A query that starts failing (an assignment revoked mid-case) must not leave the last assessments on the cards.
  useEffect(() => () => useLive.setState({ advocates: undefined }), []);
  return null;
}
