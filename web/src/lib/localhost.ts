"use client";

import { useSyncExternalStore } from "react";

/** True when this page was opened on the machine running the dev server. Deployed hosts are false. */
export function isLocalHost() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function subscribeHost() {
  return () => {};
}

/**
 * Null during server render, then the real hostname. The Dev switch stays hidden on a deployment
 * and appears only on localhost, without a hydration mismatch.
 */
export function useLocalhost(): boolean | null {
  return useSyncExternalStore(subscribeHost, isLocalHost, () => null);
}
