"use client";

import { useEffect } from "react";
import { isLocalHost } from "@/lib/localhost";
import { useOps } from "@/lib/ops/store";
import type { ConjunctionEvent, Reply } from "@/lib/ops/types";

// Dev-mode stand-in for `demo.publicView` (spec §3.1): the operator tab publishes the shared projection of the
// case it works on, and /observer in the same browser renders it. Only shared fields cross: the event (no
// policy fields exist on it), the explicit answers and the resolution time. Agent traces, logs, prompts and
// the people's private wording stay in the operator tab. Dev exists only on localhost, so only localhost posts;
// with the backend, /observer reads observer.publicView instead.

export const CHANNEL = "orbitcall.observer";

export interface PublicView {
  at: number;
  /** The operator tab runs the simulator: /observer follows this feed instead of the backend. */
  dev: boolean;
  event: ConjunctionEvent | null;
  answers: Pick<Reply, "eventId" | "side" | "decision" | "via" | "label" | "version" | "t">[];
  resolvedAt: number | null;
}

/** Mounted in the operator app: posts the current case at most every 300 ms while it changes. */
export function ObserverFeed() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined" || !isLocalHost()) return;
    const ch = new BroadcastChannel(CHANNEL);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const post = () => {
      timer = null;
      const s = useOps.getState();
      const id = s.incident ?? s.focusEvent;
      const e = s.dev && id ? (s.events.find((x) => x.id === id) ?? null) : null;
      const view: PublicView = {
        at: Date.now(),
        dev: s.dev,
        event: e,
        // answers only: who approved, vetoed or selected what. Notes and originals are room messages, not public.
        answers: e ? s.replies.filter((r) => r.eventId === e.id).map(({ eventId, side, decision, via, label, version, t }) => ({ eventId, side, decision, via, label, version, t })) : [],
        resolvedAt: e && s.resolved?.eventId === e.id ? s.resolved.at : null,
      };
      ch.postMessage(view);
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(post, 300);
    };
    // a new observer asks for the current state instead of waiting for the next change
    ch.onmessage = (m) => m.data === "hello" && post();
    const unsub = useOps.subscribe(schedule);
    post();
    const beat = setInterval(post, 5000);
    return () => {
      unsub();
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      ch.close();
    };
  }, []);
  return null;
}
