"use client";

import { useAuth0 } from "@auth0/auth0-react";
import { useEffect } from "react";
import { useSession } from "./session";

// Mirrors the Auth0 login into the session store (email, name, logout), so components outside the Auth0
// provider's hooks can show and end it. Render only under Auth0Provider (CONVEX_AUTH).
export function Auth0Bridge() {
  const { isAuthenticated, user, logout } = useAuth0();
  useEffect(() => {
    useSession.setState({
      auth0: isAuthenticated
        ? { email: user?.email ?? null, name: user?.name ?? null, logout: () => void logout({ logoutParams: { returnTo: window.location.origin } }) }
        : null,
    });
  }, [isAuthenticated, user, logout]);
  return null;
}
