"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { inboxListRef } from "@/lib/backend/api";
import { setLiveError, useLive } from "@/lib/backend/live";

/**
 * `inbox.list` for the Inbox and the Navbar badge (wiring map §6): one entry per fleet event, newest update first.
 * An observer has no fleet and gets FORBIDDEN, which lands in `errors.inbox`; the Inbox screen does not mount for them.
 */
export function InboxSync() {
  const inbox = useQuery(inboxListRef, {});
  useEffect(() => {
    if (inbox === undefined) return;
    useLive.setState({ inbox });
    setLiveError("inbox", null);
  }, [inbox]);
  return null;
}
