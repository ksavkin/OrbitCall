"use client";

import { create } from "zustand";
import type { EventRow, MyQueueRow } from "@/lib/backend/types";

// What part of the backend queue the dispatcher is looking at: a search, filters and a sort over the rows
// `events.catalogPairs` returned. "Queue order" is the backend's own (severity, then earliest closest approach,
// spec §3.2) and stays the default; every other order is an explicit choice in the Sort menu.
// The operator's own queue (`myQueue.myQueue`) is shown as the backend sections and ranks it: `queueSections`.

export type Sort = "queue" | "tca" | "pc" | "miss";
export type Severity = "all" | "red" | "yellow";
export type Within = "all" | "24h" | "72h" | "7d";
export type Objects = "all" | "payloads" | "debris";

export interface QueueView {
  search: string;
  sort: Sort;
  severity: Severity;
  within: Within;
  objects: Objects;
  mine: boolean;
}

const DEFAULT: QueueView = { search: "", sort: "queue", severity: "all", within: "all", objects: "all", mine: false };

export const useQueueView = create<QueueView & { set: (p: Partial<QueueView>) => void; reset: () => void }>((set) => ({
  ...DEFAULT,
  set: (p) => set(p),
  reset: () => set({ ...DEFAULT }),
}));

/** Filters that differ from the default, for the count on the Filters button and the chips. */
export function activeFilters(v: QueueView): { key: keyof QueueView; label: string }[] {
  const out: { key: keyof QueueView; label: string }[] = [];
  if (v.severity !== "all") out.push({ key: "severity", label: v.severity === "red" ? "Red only" : "Yellow only" });
  if (v.within !== "all") out.push({ key: "within", label: `Within ${v.within === "7d" ? "7 days" : v.within}` });
  if (v.objects !== "all") out.push({ key: "objects", label: v.objects === "payloads" ? "Satellites only" : "Involves debris" });
  return out;
}

const DEBRIS = /\bDEB\b|R\/B|\bROCKET\b/i;
const isDebris = (name: string) => DEBRIS.test(name);
const WITHIN_MS: Record<Within, number> = { all: Infinity, "24h": 24 * 3600_000, "72h": 72 * 3600_000, "7d": 7 * 24 * 3600_000 };

const pcOf = (r: EventRow) => (r.pc.value !== null && Number.isFinite(r.pc.value) ? r.pc.value : -1);
const tcaOf = (r: EventRow) => Date.parse(r.tcaUtc);

export function applyView(rows: EventRow[], v: QueueView, fleet: ReadonlySet<string>, now: number): EventRow[] {
  const q = v.search.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (v.severity !== "all" && r.color !== v.severity) return false;
    if (v.within !== "all") {
      const left = tcaOf(r) - now;
      if (!(left >= 0 && left <= WITHIN_MS[v.within])) return false;
    }
    if (v.objects === "payloads" && (isDebris(r.objectA.name) || isDebris(r.objectB.name))) return false;
    if (v.objects === "debris" && !isDebris(r.objectA.name) && !isDebris(r.objectB.name)) return false;
    if (v.mine && !fleet.has(r.objectA.objectId) && !fleet.has(r.objectB.objectId)) return false;
    if (q) {
      const hay = `${r.objectA.name} ${r.objectB.name} ${r.objectA.objectId} ${r.objectB.objectId} ${r.eventId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (v.sort === "tca") out.sort((a, b) => tcaOf(a) - tcaOf(b));
  else if (v.sort === "pc") out.sort((a, b) => pcOf(b) - pcOf(a));
  else if (v.sort === "miss") out.sort((a, b) => (Number.isFinite(a.missKm) ? a.missKm : Infinity) - (Number.isFinite(b.missKm) ? b.missKm : Infinity));
  return out;
}

export type QueueSection = MyQueueRow["queueSection"];

/** The operator's queue by section (active, data review, history), each in the backend's rank (spec §3.2). */
export function queueSections(rows: MyQueueRow[]): Record<QueueSection, MyQueueRow[]> {
  const out: Record<QueueSection, MyQueueRow[]> = { active: [], data_review: [], history: [] };
  // a section this client does not know yet (follow-up) is left out rather than shown in the wrong place
  for (const r of rows) out[r.queueSection]?.push(r);
  for (const list of Object.values(out)) list.sort((a, b) => a.rank - b.rank);
  return out;
}
