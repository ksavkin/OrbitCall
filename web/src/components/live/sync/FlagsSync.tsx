"use client";

import { useQuery } from "convex/react";
import { useEffect } from "react";
import { configFlagsRef } from "@/lib/backend/api";
import { setLiveError, useLive } from "@/lib/backend/live";

/** `config.flags`: public, read once per page. */
export function FlagsSync() {
  const flags = useQuery(configFlagsRef, {});
  useEffect(() => {
    if (flags === undefined) return;
    useLive.setState({ flags });
    setLiveError("flags", null);
  }, [flags]);
  return null;
}
