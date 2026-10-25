"use client";

import type { ProposalId } from "@/lib/backend/types";

/** The checked rationale on one card, and the independent check when it disagrees (wiring map §5.2). Placeholder. */
export function CardRationale(_props: { proposalId: ProposalId; revision: number }) {
  return null;
}

/** Per-side feasibility and "recommended by A/B" on one card (wiring map §5.3). Placeholder. */
export function AdvocateChips(_props: { proposalId: ProposalId }) {
  return null;
}

/** advocates.situation as the panel subtitle (AGT-3). Placeholder. */
export function AdvocatesSituation() {
  return null;
}
