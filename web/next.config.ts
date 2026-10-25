import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  turbopack: {
    // The repo root has its own package-lock.json (Convex backend). Without this, Next picks the
    // repo root as the workspace root and the Tailwind loader fails to load (globals.css 500s).
    root: path.join(__dirname),
    resolveAlias: {
      // `next build` (Turbopack) never finishes while it bundles satellite.js's pthreads WASM build, and
      // the app never creates the multi-thread runtime. Point that dynamic import at the single-thread
      // build, which satellite.js already ships, so the production build can complete.
      "#wasm-multi-thread": "./node_modules/satellite.js/wasm-build/base-release/index.js",
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
