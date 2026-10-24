"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { sceneRef } from "@/lib/sceneRef";
import { useOrbit, type DataLayer, type WxLayer } from "@/lib/store";
import type { CurrentsGrid, SpaceWeather, Storm, TornadoData, WeatherMeta, WindGrid } from "@/lib/weather/types";

const MIN = 60_000;

// Each layer: how often to refresh (the server caches longer; this only polls it).
const REFRESH: Record<DataLayer | "space", number> = {
  clouds: 15 * MIN,
  wind: 30 * MIN,
  currents: 60 * MIN,
  storms: 10 * MIN,
  tornado: 2 * MIN,
  aurora: 5 * MIN,
  space: 5 * MIN,
};

async function getJson<T>(layer: string): Promise<WeatherMeta<T>> {
  const res = await fetch(`/api/weather/${layer}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as WeatherMeta<T>;
}

async function load(layer: DataLayer | "space") {
  const s = useOrbit.getState();
  const scene = sceneRef.get();
  if (!scene) return;
  s.setWxStatus(layer, { ...s.wxStatus[layer], state: "loading" });
  try {
    if (layer === "clouds") {
      const res = await fetch("/api/weather/clouds");
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const tex = await new THREE.TextureLoader().loadAsync(url);
      URL.revokeObjectURL(url);
      scene.setLiveClouds(tex);
      useOrbit.getState().setWxStatus("clouds", {
        state: "ready",
        validAt: res.headers.get("X-Observed-At") ?? undefined,
        source: (res.headers.get("X-Source") as "live") ?? undefined,
      });
    } else if (layer === "wind") {
      const r = await getJson<WindGrid>("wind");
      scene.weather.setWind(r.data);
      useOrbit.getState().setWxStatus("wind", { state: "ready", validAt: r.data.validAt, source: r.source });
    } else if (layer === "currents") {
      const r = await getJson<CurrentsGrid>("currents");
      scene.weather.setCurrents(r.data);
      useOrbit.getState().setWxStatus("currents", { state: "ready", validAt: r.data.validAt, source: r.source });
    } else if (layer === "storms") {
      const r = await getJson<Storm[]>("storms");
      scene.weather.setStorms(r.data);
      useOrbit.getState().set({ storms: r.data });
      useOrbit.getState().setWxStatus("storms", { state: "ready", validAt: r.fetchedAt, source: r.source });
    } else if (layer === "tornado") {
      const r = await getJson<TornadoData>("tornado");
      scene.weather.setTornado(r.data);
      useOrbit.getState().set({ tornado: r.data });
      useOrbit.getState().setWxStatus("tornado", { state: "ready", validAt: r.fetchedAt, source: r.source });
    } else {
      // aurora and Kp come from the same SWPC request
      const r = await getJson<SpaceWeather>("space");
      scene.weather.setAurora(r.data);
      useOrbit.getState().set({ kp: { now: r.data.kp, time: r.data.kpTime, history: r.data.kpHistory } });
      const st = { state: "ready" as const, validAt: r.data.observedAt, source: r.source };
      useOrbit.getState().setWxStatus("aurora", st);
      useOrbit.getState().setWxStatus("space", { ...st, validAt: r.data.kpTime });
    }
  } catch (e) {
    useOrbit.getState().setWxStatus(layer, { state: "error", error: (e as Error).message });
  }
}

/** Loads enabled weather layers, keeps them fresh, and mirrors toggles into the scene. */
export function WeatherSync() {
  const wx = useOrbit((s) => s.wx);
  const ready = useOrbit((s) => s.stage === "ready");

  useEffect(() => {
    const scene = sceneRef.get();
    if (!scene || !ready) return;
    scene.setCloudsOn(wx.clouds);
    Object.assign(scene.weather.vis, {
      wind: wx.wind,
      currents: wx.currents,
      storms: wx.storms,
      tornado: wx.tornado,
      aurora: wx.aurora,
    });
    Object.assign(scene.density.vis, { traffic: wx.traffic, debris: wx.debris });
    const timers: ReturnType<typeof setInterval>[] = [];
    // traffic/debris density are computed locally from the catalog; nothing to fetch
    const layers = (Object.keys(wx) as WxLayer[])
      .filter((k): k is DataLayer => wx[k] && k !== "traffic" && k !== "debris")
      .map((k) => (k === "aurora" ? "space" : k));
    // space weather feeds the info card even with the aurora layer off
    if (!layers.includes("space")) layers.push("space");
    for (const layer of layers) {
      const st = useOrbit.getState().wxStatus[layer];
      if (!st || st.state === "error") void load(layer);
      timers.push(setInterval(() => void load(layer), REFRESH[layer]));
    }
    return () => timers.forEach(clearInterval);
  }, [wx, ready]);

  return null;
}
