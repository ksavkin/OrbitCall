"use client";

import type { EventId } from "@/lib/backend/types";

/** "Your turn to decide" / "Side B is deciding" and the status line "P2 · R2 · A approved · waiting for B" (wiring map §1.3 points 5-6). Placeholder. */
export function TurnStatus(_props: { eventId: EventId }) {
  return null;
}

/** Debris ("Single-operator avoidance") and internal review notes (wiring map §1.3 points 7-8). Placeholder. */
export function WorkflowNote(_props: { eventId: EventId }) {
  return null;
}

/** The reset banner from approvals.status.lastReset (wiring map §1.3 point 9, "Shared maneuvers"). Placeholder. */
export function ResetBanner(_props: { eventId: EventId }) {
  return null;
}
