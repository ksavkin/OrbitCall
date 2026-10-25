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

export type PolicyPriority = "low" | "normal" | "high";
export type CompanyLang = "en" | "ru" | "zh";

export interface PolicyWindow {
  startUtc: ISODate;
  endUtc: ISODate;
  reason: string;
}

/** One satellite on the caller's company policy (spec §2.5, policies.getMine). */
export interface PolicySatellite {
  objectId: ObjectId;
  minFuelReserveKg: number;
  currentFuelKg: number;
  dryMassKg: number;
  ispS: number;
  protectedWindows: PolicyWindow[];
  preferredWindows: PolicyWindow[];
  acceptablePc: number;
  missionPriority: PolicyPriority;
}

export interface PolicyMine {
  satellites: PolicySatellite[];
  revision: number;
  updatedAt: ISODate | null;
  simulated: boolean;
}

export interface CompanySettings {
  language: CompanyLang | null;
  contact: string | null;
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

/* ---------------------------------------------------------------- real mode: the rest of the backend (wiring map §12) */

export type Id = string;
export type RoomId = Id;
export type ProposalId = Id;
export type ManeuverId = Id;
export type ScanId = Id;
export type DemoRunId = Id;
export type Side = "A" | "B";
export type Workflow = "bilateral" | "unilateral_debris" | "internal_review";
export type Lang = "en" | "ru" | "zh";

/** `config.flags`: which optional integrations this deployment has. Public, no sign-in. */
export interface ConfigFlags {
  demoLaunch: boolean;
  voice: boolean;
  /** The Factory worker is configured: Approve waits for the schedule diff (wiring map §1.4). */
  droid: boolean;
  secondModel: boolean;
}

export interface Revision {
  proposalId: ProposalId;
  label: string;
  revision: number;
  createdAt: ISODate;
  kind: "maneuver" | "wait";
  movingSide: Side | null;
  movingObjectId: ObjectId | null;
  burnTimeUtc: ISODate | null;
  deltaVMs: number | null;
  direction: "prograde" | "retrograde" | null;
  estimatedFuelKg: number | null;
  missBeforeKm: number;
  missAfterKm: number | null;
  indicative: true;
  assumptions: string[];
  simulated: boolean;
  candidateId: string;
  changeSummary: string | null;
  sourceMessageIds: Id[];
  /** Only a checked explanation reaches a card (AGT-5). */
  rationale: { text: string; numbersChecked: true; secondModel: { agrees: boolean; note: string } | null } | null;
  /** The schedule diff prepared for this revision (ROOM-9), or null. */
  schedulePreviewDiff: string | null;
}

export interface ProposalCard {
  proposalId: ProposalId;
  label: string;
  latest: Revision;
  revisionCount: number;
  isSelected: boolean;
}

export interface SideApproval {
  status: "pending" | "approved" | "vetoed";
  byUserId: Id | null;
  byName: string | null;
  at: ISODate | null;
  proposalId: ProposalId | null;
  revision: number | null;
  selectionGeneration: number | null;
  approvalRuleVersion: number;
}

export interface ApprovalStatus {
  eventId: EventId;
  workflow: Workflow | null;
  requiredApprovalSides: Side[];
  approvalRuleVersion: number | null;
  selectionGeneration: number;
  selected: { proposalId: ProposalId; label: string; revision: number; generation: number } | null;
  approvals: Partial<Record<Side, SideApproval>>;
  allRequiredApproved: boolean;
  reviewRequired: boolean;
  deciding: boolean;
  turn: Side | null;
  lastReset: { at: ISODate; reason: string } | null;
  mySide: Side | null;
  /** Meaningful only once `selected !== null` (wiring map §1.3 point 3). */
  canAct: boolean;
  myTurn: boolean;
  simulated: boolean;
}

/** Exactly what approve and veto take, always from the current `approvals.status`. */
export type DecisionArgs = {
  eventId: EventId;
  proposalId: ProposalId;
  revision: number;
  selectionGeneration: number;
  approvalRuleVersion: number;
};

export type ManeuverStatus = "preview" | "rescreening" | "refused" | "committing" | "committed" | "failed";

export interface Rescreen {
  snapshotId: string;
  passed: boolean;
  objectsChecked: number;
  horizonH: number;
  originalMissAfterKm: number | null;
  newConjunctions: { objectId: ObjectId; name: string; tcaUtc: ISODate; missKm: number }[];
  refusalReason: string | null;
}

export interface Maneuver {
  maneuverId: ManeuverId;
  refs: { eventId: EventId; proposalId: ProposalId; revision: number; selectionGeneration: number }[];
  intentKey: string;
  status: ManeuverStatus;
  filePath: string;
  diff: string | null;
  commitSha: string | null;
  writtenBy: "droid" | "backend";
  rescreen: Rescreen | null;
  error: string | null;
  reviewRequired: boolean;
  simulated: boolean;
  demoRunId: DemoRunId | null;
  updatedAt: ISODate;
  execution: "not_verified";
}

export interface RoomEvent {
  eventId: EventId;
  objectIds: ObjectId[];
  tcaUtc: ISODate;
  color: Color;
  active: boolean;
  status: EventStatus;
  simulated: boolean;
  mySide: Side | null;
  workflow: Workflow | null;
  requiredApprovalSides: Side[];
  canAct: boolean;
  deciding: boolean;
  turn: Side | null;
  myTurn: boolean;
}

export interface RoomProjection {
  roomId: RoomId;
  state: "open" | "closed";
  createdAt: ISODate;
  closedAt: ISODate | null;
  simulated: boolean;
  companies: { companyId: Id; name: string; simulated: boolean }[];
  myCompanyId: Id;
  members: { userId: Id; companyId: Id; name: string | null; inRoom: boolean; inCall: boolean; updatedAt: ISODate }[];
  linkedEvents: RoomEvent[];
}

/** `rooms.forEvent`: the incident's latest room, open or closed, to find a closed room after a reload. */
export interface RoomRef {
  roomId: RoomId;
  state: "open" | "closed";
  closedAt: ISODate | null;
}

export interface ProtectedValue {
  placeholder: string;
  kind: "number" | "unit" | "datetime" | "timezone" | "object_id" | "sign";
  text: string;
}

export interface SummaryForm {
  proposalId: ProposalId;
  revision: number;
  movingSide: Side | null;
  burnTimeUtc: ISODate | null;
  deltaVMs: number | null;
  direction: "prograde" | "retrograde" | null;
  note: string;
}

export type AgentRole =
  | "risk_monitor"
  | "incident_analyst"
  | "operator_advocate"
  | "coordination_host"
  | "maneuver_scheduler"
  | "maneuver_verifier"
  | "second_model";

export interface RoomMessage {
  messageId: Id;
  roomId: RoomId;
  eventId: EventId | null;
  at: ISODate;
  author:
    | { kind: "human"; userId: Id; companyId: Id; name: string }
    | { kind: "agent"; role: AgentRole; companyId: Id | null }
    | { kind: "system" };
  kind: "text" | "voice" | "negotiation" | "system" | "summary";
  /** The viewer's language when `translationStatus === "ok"`, else the original. */
  text: string;
  originalText: string;
  originalLang: Lang;
  translationStatus: "ok" | "pending" | "original_only";
  values: ProtectedValue[];
  refs: { eventId?: EventId; proposalId?: ProposalId; revision?: number };
  form: SummaryForm | null;
  simulated: boolean;
}

export interface CardRationale {
  proposalId: ProposalId;
  candidateId: string;
  revision: number;
  rationale: { text: string; numbersChecked: boolean; secondModel: { agrees: boolean; note: string } | null } | null;
}

export interface Evaluation {
  candidateId: string;
  revision: number;
  outcome: "feasible" | "infeasible" | "preferred" | "pending";
  categories: ("fuel" | "mission_window" | "risk" | "priority" | "other")[];
  recommended: boolean;
}

export interface AdvocateRun {
  status: string;
  stage: string;
  memory: unknown;
  startedAt: ISODate;
  lastProgressAt: ISODate;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AdvocatesView {
  eventId: EventId;
  version: number;
  state: string;
  reviewRequired: boolean;
  evidenceCurrent: boolean;
  simulated: boolean;
  candidates: unknown[];
  assessments: Record<Side, Evaluation[]>;
  mutuallyAcceptable: string[];
  reviewCandidates: string[];
  runs: Record<Side, AdvocateRun | null>;
  situation:
    | "scheduled_review_required"
    | "stale_candidates"
    | "no_candidates"
    | "awaiting_advocates"
    | "needs_operator_decision"
    | "needs_more_data"
    | "no_mutually_acceptable_option";
  agentsWorking: boolean;
  agentsStalled: boolean;
  messages: { messageId: Id; side: Side; kind: string; entries: Evaluation[]; categories: string[]; createdAt: ISODate; current: boolean }[];
}

export interface SummaryState {
  form: SummaryForm | null;
  selectionGeneration: number;
  canEdit: boolean;
  edit: { jobId: Id; state: string; errorCode: string | null } | null;
}

export type SummaryChanges = Partial<Pick<SummaryForm, "movingSide" | "burnTimeUtc" | "deltaVMs" | "direction" | "note">>;

export interface PublicSpan {
  id: string;
  parent: string | null;
  eventId: EventId | null;
  agent: string;
  target: string;
  kind: "llm" | "check" | "handoff";
  name: string;
  status: "running" | "ok" | "error" | "waiting";
  t0: number;
  t1?: number;
  ms?: number;
  progress: null;
  model?: string;
  provider?: "anthropic" | "google" | "xai";
  tokensIn?: number;
  tokensOut?: number;
  costUsd: null;
  output: {
    runStatus: "running" | "succeeded" | "failed" | "superseded";
    stage?: string;
    stalled?: boolean;
    simulated: boolean;
    trigger?: string;
    callStatus?: "succeeded" | "failed";
    candidateId?: string;
    attempt?: number;
    numbersChecked?: true;
    details: "not_exposed";
  };
  error?: string;
}

export interface AgentLog {
  id: string;
  t: number;
  level: "info" | "warn" | "error";
  source: string;
  msg: string;
  spanId: string;
  eventId?: EventId;
}

export interface HostTriggerRow {
  hostRunId: Id;
  trigger: string;
  inputVersion: string;
  attempt: number;
  status: string;
  span: unknown;
  output: unknown;
  check: unknown;
  createdAt: number;
  finishedAt: number | null;
}

/** `log.list` row: the shared audit record (spec §3.6). Newest first, 50 per page. */
export interface LogEntry {
  logId: Id;
  at: ISODate;
  eventId: EventId | null;
  actor:
    | { kind: "human"; userId: Id; name: string; side: Side | null }
    | { kind: "agent"; role: string; side: Side | null }
    | { kind: "system" };
  /** e.g. "schedule_failed", "schedule_committed", "verified", "approvals_reset". */
  action: string;
  summary: string;
  texts: Record<string, string> | null;
  before: Record<string, number | string | null> | null;
  after: Record<string, number | string | null> | null;
  proposalId: ProposalId | null;
  revision: number | null;
  simulated: boolean;
}

export interface InboxEntry {
  eventId: EventId;
  unread: boolean;
  section: "attention" | "watch" | "previous";
  /** "A-name × B-name", my side first. */
  title: string;
  color: Color;
  status: EventStatus;
  situation: Situation;
  tcaUtc: ISODate;
  missKm: number;
  relSpeedKmS: number;
  pc: Pc;
  sources: SourceRef[];
  simulated: boolean;
  mySide: Side | null;
  workflow: Workflow | null;
  lastUpdateAt: ISODate;
  /** The notice text: "You were added…", "Side A approved P2 revision 1. It is your turn to decide." */
  lastUpdateSummary: string;
  sides: {
    side: Side;
    mine: boolean;
    object: SpaceObject;
    owner: { companyId: Id; name: string; country: string | null; language: Lang | null; contact: string | null; simulated: boolean } | null;
  }[];
  missing: string[];
  room: { roomId: RoomId; joined: boolean; otherSideJoined: boolean; otherSidePresenceAt: ISODate | null } | null;
}

export interface ScanRun {
  scanId: ScanId;
  requestId: string;
  assignmentVersion: number;
  primaryObjectIds: ObjectId[];
  snapshotId: string;
  fromMs: number;
  toMs: number;
  status: "queued" | "running" | "completed" | "failed";
  phase: "queued" | "loading" | "screening" | "matching_sources" | "publishing" | "done" | "failed";
  progress: number | null;
  counts: { primaryObjects: number; catalogObjects: number; primariesCompleted: number; pairsChecked: number; eventsFound: number };
  coverage: {
    complete: boolean;
    catalogScope: string;
    excludedObjects: number;
    reasons: { reason: string; count: number }[];
    missingPrimaryIds: ObjectId[];
  };
  jobId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: { code: string; message: string } | null;
  demoRunId: DemoRunId | null;
  updatedAt: number;
}

export interface MyQueueRow extends EventRow {
  myObjectIds: ObjectId[];
  /** Hard-coded by `myQueue` (never debris); trust `approvals.status` for decisions (wiring map §7). */
  workflow: "bilateral" | "internal_review";
  requiredApprovalSides: Side[];
  canAct: boolean;
  queueSection: "active" | "data_review" | "history";
  rank: number;
  priorityReason: string;
}

export interface FleetMine {
  assignmentVersion: number | null;
  satellites: {
    object: SpaceObject;
    assignedAt: ISODate;
    position: null;
    orbitEpochUtc: null;
    freshness: "unknown";
    unresolvedIncidentCount: number;
    lastScanId: null;
    scanCoverage: "not_scanned";
  }[];
}

export interface ObserverCard {
  proposalId: ProposalId;
  candidateId: string;
  revision: number;
  label: string;
  kind: "maneuver" | "wait";
  movingObjectId: ObjectId | null;
  burnTimeUtc: ISODate | null;
  deltaVMs: number | null;
  direction: "prograde" | "retrograde" | null;
  missAfterKm: number | null;
  simulated: boolean;
}

export interface ObserverView {
  demoRunId: DemoRunId;
  scenario: string;
  state: "open" | "closed";
  truncated: boolean;
  events: {
    eventId: EventId;
    objects: ({ objectId: ObjectId; name: string } | null)[];
    tcaUtc: ISODate;
    missKm: number;
    probability: number | null;
    status: EventStatus;
    simulated: boolean;
    candidates: ObserverCard[];
    selection: ObserverCard | null;
    approval: { approved: number; required: number; allRequiredApproved: boolean };
    jobs: {
      maneuverId: ManeuverId;
      status: ManeuverStatus;
      reviewRequired: boolean;
      rescreen: { passed: boolean; objectsChecked: number; horizonH: number } | null;
      commitSha: string | null;
    }[];
    verification: { kind: "live" | "replay"; result: VerificationResult; label: string; simulated: boolean; elementSetCount: number } | null;
  }[];
  scans: Pick<ScanRun, "scanId" | "status" | "phase" | "progress" | "counts" | "coverage">[];
}

export interface Verification {
  verificationId: Id;
  kind: "live" | "replay";
  result: VerificationResult;
  label: string;
  expected: { deltaAKm: number; sign: 1 | -1 };
  observed: { deltaAKm: number; z: number; epochUtc: ISODate } | null;
  elementSetCount: number;
  series: { epochUtc: ISODate; smaKm: number }[];
  thresholds: { z: number; minDeltaAKm: number; sizeTolerance: number; minSets: number };
  method: string;
  limitations: string[];
  missing: string[];
  sources: SourceRef[];
  simulated: boolean;
  createdAt: ISODate;
  /** Present on verifications.get, absent on replay. */
  reviewRequired?: boolean;
}

export type SeriesPoint = { atUtc: ISODate; pc: number | null; missKm: number | null; source: SourceName };

export interface HistorySeries {
  real: SeriesPoint[];
  simulated: SeriesPoint[];
  stale: boolean;
  error: string | null;
  fetchedAt: number | null;
  seriesVersion: number | null;
}

export interface ReportPreview {
  companyId: Id;
  companyName: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  records: Record<string, unknown>[];
  [key: string]: unknown;
}

/** `demoLaunch.launchDefaults`: suggestions; launch re-checks everything server-side. */
export interface LaunchDefaults {
  name: string;
  ownerName: string;
  ownerCountry: string;
  targetObjectId: ObjectId | null;
  tcaUtc: ISODate;
  scenarioPc: number;
}

export type LaunchInput = {
  name: string;
  ownerName: string;
  ownerCountry: string;
  targetObjectId: ObjectId;
  tcaUtc: ISODate;
  scenarioPc: number;
  requestId?: string;
  replaceObjectId?: string;
};
