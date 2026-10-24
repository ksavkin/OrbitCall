"use client";

import { create } from "zustand";
import type { Catalog } from "@/lib/catalog/client";
import { CATEGORIES, type Category } from "@/lib/catalog/types";
import type { ViewMode } from "@/components/globe/shaders";

export type LoadStage = "catalog" | "parse" | "propagate" | "textures" | "ready" | "error";

interface OrbitState {
  catalog: Catalog | null;
  stage: LoadStage;
  error: string | null;
  viewMode: ViewMode;
  enabled: Record<Category, boolean>;
  hovered: number | null;
  selected: number | null;
  following: boolean;
  speed: number;
  paused: boolean;
  autoRotate: boolean;
  soundOn: boolean;
  searchOpen: boolean;
  showGroundTrack: boolean;
  set: (p: Partial<OrbitState>) => void;
  toggleCategory: (c: Category) => void;
  soloCategory: (c: Category) => void;
}

export const useOrbit = create<OrbitState>((set, get) => ({
  catalog: null,
  stage: "catalog",
  error: null,
  viewMode: "realistic",
  enabled: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>,
  hovered: null,
  selected: null,
  following: false,
  speed: 1,
  paused: false,
  autoRotate: false,
  soundOn: true,
  searchOpen: false,
  showGroundTrack: false,
  set: (p) => set(p),
  toggleCategory: (c) => set({ enabled: { ...get().enabled, [c]: !get().enabled[c] } }),
  soloCategory: (c) => {
    const e = get().enabled;
    const onlyThis = CATEGORIES.every((k) => e[k] === (k === c));
    set({
      enabled: Object.fromEntries(CATEGORIES.map((k) => [k, onlyThis ? true : k === c])) as Record<Category, boolean>,
    });
  },
}));
