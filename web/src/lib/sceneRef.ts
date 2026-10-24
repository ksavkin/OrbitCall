"use client";

import type { GlobeScene } from "@/components/globe/GlobeScene";

// The scene is imperative and lives outside React; UI controls reach it here.
let current: GlobeScene | null = null;

export const sceneRef = {
  get: () => current,
  set: (s: GlobeScene | null) => {
    current = s;
  },
};

/** Shared live stats that would be too chatty for the store. */
export const liveStats = {
  propagateMs: 0,
  invalid: 0,
  altKm: 0,
  cursor: null as { lat: number; lon: number } | null,
};
