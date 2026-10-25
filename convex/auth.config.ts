import type { AuthConfig } from "convex/server";

// Auth0 is the locked identity provider (spec §1, roadmap §13). Sign-ups are disabled in the tenant;
// accounts are pre-created and linked to a company by operators.provision, never by the browser.
// AUTH0_DOMAIN is the tenant host without a scheme, for example "orbitcall.us.auth0.com".
// Convex evaluates this with the deployment's environment, not the shell's. If either value is unset there,
// the push is refused with AuthConfigMissingEnvironmentVariable, so set both with `convex env set` first.
export default {
  providers: [{ domain: process.env.AUTH0_DOMAIN!, applicationID: process.env.AUTH0_CLIENT_ID! }],
} satisfies AuthConfig;
