"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// One client for the page. Without NEXT_PUBLIC_CONVEX_URL (or with an unusable one) there is
// no client and the app runs in dev / synthetic mode only; nothing here may throw.
function makeClient(): ConvexReactClient | null {
  // Must be this literal expression: Next inlines it at build time.
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  try {
    return new ConvexReactClient(url);
  } catch (e) {
    console.error("NEXT_PUBLIC_CONVEX_URL is not usable, running without the backend:", e);
    return null;
  }
}

const client = makeClient();

/** True when a Convex client exists, so `useQuery` may run. */
export const CONVEX_ENABLED = client !== null;

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return client ? <ConvexProvider client={client}>{children}</ConvexProvider> : <>{children}</>;
}
