"use client";

import { Auth0Provider } from "@auth0/auth0-react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth0 } from "convex/react-auth0";
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

// Auth0 (spec §1). Domain and client ID are public values; Next inlines them at build time.
const AUTH0_DOMAIN = process.env.NEXT_PUBLIC_AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID;

/** True when a Convex client exists, so `useQuery` may run. */
export const CONVEX_ENABLED = client !== null;

/** True when the Auth0 tenant is configured for this build: the sign-in button and session.me work. */
export const AUTH0_ENABLED = !!AUTH0_DOMAIN && !!AUTH0_CLIENT_ID;

/**
 * True once the provider below carries a sign-in (ConvexProviderWithAuth0). Until then `useConvexAuth` has no
 * auth context and throws, so components that read the signed-in identity must check this first.
 */
export const CONVEX_AUTH = CONVEX_ENABLED && AUTH0_ENABLED;

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!client) return <>{children}</>;
  if (!AUTH0_ENABLED) return <ConvexProvider client={client}>{children}</ConvexProvider>;
  // Convex reads the Auth0 ID token; the refresh token keeps the session across reloads without a redirect.
  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN!}
      clientId={AUTH0_CLIENT_ID!}
      authorizationParams={{ redirect_uri: typeof window === "undefined" ? undefined : window.location.origin }}
      useRefreshTokens
      cacheLocation="localstorage"
    >
      <ConvexProviderWithAuth0 client={client}>{children}</ConvexProviderWithAuth0>
    </Auth0Provider>
  );
}
