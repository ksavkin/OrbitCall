"use client";

import { create } from "zustand";
import type { Catalog } from "@/lib/catalog/client";
import { CATEGORIES, type Category } from "@/lib/catalog/types";
import type { ViewMode } from "@/components/globe/shaders";
import type { Storm, TornadoData } from "@/lib/weather/types";
import type { AltitudeBin } from "@/components/globe/density";

export type WxLayer = "clouds" | "wind" | "currents" | "storms" | "tornado" | "aurora" | "traffic" | "debris";
export type DataLayer = Exclude<WxLayer, "traffic" | "debris">;

export interface WxStatus {
  state: "idle" | "loading" | "ready" | "error";
  /** When the data describes (observation / model valid time), ISO. */
  validAt?: string;
  source?: "live" | "cache" | "snapshot";
  error?: string;
}

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
  colorBy: "category" | "country";
  /** SATCAT owner codes hidden by the country filter. */
  hiddenOwners: string[];
  wx: Record<WxLayer, boolean>;
  wxStatus: Partial<Record<WxLayer | "space", WxStatus>>;
  storms: Storm[];
  tornado: TornadoData | null;
  kp: { now: number; time: string; history: { t: string; kp: number }[] } | null;
  density: { bins: AltitudeBin[]; top: AltitudeBin[]; at: number } | null;
  setWx: (layer: WxLayer, on: boolean) => void;
  setWxStatus: (layer: WxLayer | "space", st: WxStatus) => void;
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
  colorBy: "category",
  hiddenOwners: [],
  wx: { clouds: true, wind: true, currents: true, storms: false, tornado: false, aurora: true, traffic: true, debris: false },
  wxStatus: {},
  storms: [],
  tornado: null,
  kp: null,
  density: null,
  setWx: (layer, on) => set({ wx: { ...get().wx, [layer]: on } }),
  setWxStatus: (layer, st) => set({ wxStatus: { ...get().wxStatus, [layer]: st } }),
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
