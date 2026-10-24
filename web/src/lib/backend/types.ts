// Backend response shapes, declared locally from docs/specification.md §2.2 and
// docs/phase1-andrew.md ("Adil's summary integration"). The web app deploys on its own
// (Vercel builds only web/), so it never imports from the root convex/ package.

export type ISODate = string;
export type ObjectId = string;
/** A Convex document id, opaque to the browser. */
export type EventId = string;

export type Color = "red" | "yellow" | "none";

export type EventStatus =
  | "new"
  | "agents"
  | "proposal"
  | "communication"
  | "approved"
  | "scheduled"
  | "monitoring"
  | "awaiting_verification_data"
  | "verified"
  | "flagged"
  | "no_action_needed";

export type Situation = "needs_operator_decision" | "waiting_for_operator" | null;
export type VerificationResult = "awaiting_data" | "consistent" | "mismatch";

export type SourceName =
  | "celestrak_gp"
  | "celestrak_supgp"
  | "socrates"
  | "cdm_public"
  | "gp_history"
  | "keeptrack"
  | "simulated"
  | "celestrak_satcat";

export interface SourceRef {
  name: SourceName;
  url: string | null;
  epochUtc: ISODate | null;
  fetchedAt: ISODate | null;
}

export interface SpaceObject {
  objectId: ObjectId;
  name: string;
  ownerName: string | null;
  ownerCompanyId: string | null;
  country: string | null;
  purpose: string | null;
  launchDate: string | null;
  simulated: boolean;
  celestrakUrl: string | null;
}

/** Supplied by a source, never computed here. `value: null` is unavailable, never zero. */
export interface Pc {
  value: number | null;
  /** SOCRATES reports a maximum probability, not a collision probability. */
  metric: "pc" | "max_prob";
  source: "cdm" | "socrates" | "simulated";
  epochUtc: ISODate | null;
  sourceUrl: string | null;
  emergencyReportable: boolean | null;
}

export interface EventRow {
  eventId: EventId;
  objectA: SpaceObject;
  objectB: SpaceObject;
  mySide: "A" | "B" | null;
  tcaUtc: ISODate;
  missKm: number;
  relSpeedKmS: number;
  pc: Pc;
  color: Color;
  status: EventStatus;
  situation: Situation;
  agentsWorking: boolean;
  /** Working with no progress for 60 s. */
  agentsStalled: boolean;
  selected: { proposalId: string; label: string; revision: number } | null;
  outcome: VerificationResult | null;
  reviewRequired: boolean;
  roomOpen: boolean;
  sources: SourceRef[];
  simulated: boolean;
  updatedAt: ISODate;
}

export interface CatalogSnapshot {
  snapshotId: string;
  takenAt: ISODate;
  ommUrl: string | null;
  gpUrl: string | null;
  sources: SourceRef[];
}

export interface AgentRunInfo {
  status: "running" | "succeeded" | "failed" | "superseded";
  stage: string;
  attempt: number;
  startedAt: ISODate;
  lastProgressAt: ISODate;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AgentSummary {
  eventId: EventId;
  /** Exactly five lines, or [] until a current checked summary exists. */
  summaryLines: string[];
  numbersChecked: boolean;
  originalLang: "en";
  createdAt: ISODate | null;
  simulated: boolean;
  agentsWorking: boolean;
  agentsStalled: boolean;
  run: AgentRunInfo | null;
}
