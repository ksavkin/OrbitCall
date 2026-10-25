import { anyApi, type FunctionReference } from "convex/server";
import type {
  AdvocatesView,
  AgentLog,
  AgentSummary,
  ApprovalStatus,
  CardRationale,
  CatalogSnapshot,
  CompanyLang,
  CompanySettings,
  ConfigFlags,
  DecisionArgs,
  DemoRunId,
  EventId,
  EventRow,
  FleetMine,
  HistorySeries,
  HostTriggerRow,
  Id,
  InboxEntry,
  ISODate,
  LaunchDefaults,
  LaunchInput,
  LogEntry,
  Maneuver,
  MyQueueRow,
  ObjectId,
  ObserverView,
  PolicyMine,
  PolicySatellite,
  ProposalCard,
  ProposalId,
  PublicSpan,
  ReportPreview,
  RoomId,
  RoomMessage,
  RoomProjection,
  RoomRef,
  ScanId,
  ScanRun,
  Side,
  SummaryChanges,
  SummaryState,
  Verification,
} from "./types";

// References by name through anyApi: no import from the root convex/_generated package.
// Types are the ones declared in ./types.ts.
type Query<Args extends Record<string, unknown>, Result> = FunctionReference<"query", "public", Args, Result>;
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<"mutation", "public", Args, Result>;
type Action<Args extends Record<string, unknown>, Result> = FunctionReference<"action", "public", Args, Result>;
type None = Record<string, never>;
type ByEvent = { eventId: EventId };
type ByRoom = { roomId: RoomId };

/** Every active real catalog pair, already in queue order (spec §3.2); the UI filters. */
export const catalogPairsRef = anyApi.events.catalogPairs as unknown as Query<{ limit?: number }, EventRow[]>;

/** Latest catalog snapshot, or null before the first one. */
export const catalogSnapshotRef = anyApi.catalog.snapshot as unknown as Query<None, CatalogSnapshot | null>;

/** Incident Analyst summary and run state for one event. Public in Phase 1. */
export const agentSummaryRef = anyApi.agentSummaries.get as unknown as Query<ByEvent, AgentSummary>;

/** The caller's company policy. Operators only; raw values never leave the company (POL-1, POL-2). */
export const policyMineRef = anyApi.policies.getMine as unknown as Query<None, PolicyMine>;
export const policyUpdateRef = anyApi.policies.update as unknown as Mutation<{ satellites: PolicySatellite[] }, null>;

/** Shareable company language and contact, stored apart from the policy. */
export const settingsMineRef = anyApi.session.getMySettings as unknown as Query<None, CompanySettings>;
export const settingsUpdateRef = anyApi.session.updateMySettings as unknown as Mutation<{ language?: CompanyLang; contact?: string }, null>;

/** Which optional integrations this deployment has (public, no sign-in). */
export const configFlagsRef = anyApi.config.flags as unknown as Query<None, ConfigFlags>;

/** Decision Center (spec §3.4, §4.1; wiring map §1). */
export const proposalsListRef = anyApi.proposals.list as unknown as Query<ByEvent, ProposalCard[]>;
export const proposalsSelectRef = anyApi.proposals.select as unknown as Mutation<
  ByEvent & { proposalId: ProposalId; revision: number; expectedGeneration: number },
  null
>;
export const approvalsStatusRef = anyApi.approvals.status as unknown as Query<ByEvent, ApprovalStatus>;
export const approvalsApproveRef = anyApi.approvals.approve as unknown as Mutation<
  DecisionArgs,
  { allRequiredApproved: boolean; requiredApprovalSides: Side[] }
>;
export const approvalsVetoRef = anyApi.approvals.veto as unknown as Mutation<DecisionArgs & { reason?: string }, null>;
/** No `returns:` validator on the backend; the shape is copied from convex/maneuvers.ts. */
export const maneuverRef = anyApi.maneuvers.get as unknown as Query<ByEvent, Maneuver | null>;
export const rationaleListRef = anyApi.lib.rationale.list as unknown as Query<ByEvent, CardRationale[]>;
/** Operators of a party side only; a head of ops gets FORBIDDEN. */
export const advocatesListRef = anyApi.advocates.list as unknown as Query<ByEvent, AdvocatesView>;
export const advocatesRerunRef = anyApi.advocates.rerun as unknown as Mutation<ByEvent, null>;

/** Workflow, room and chat (wiring map §2, §3). */
export const startWorkflowRef = anyApi.rooms.startWorkflow as unknown as Mutation<
  ByEvent,
  { roomId: RoomId; created: boolean; joined: Id[] }
>;
/** The open room, or null before startWorkflow and after the room closes. */
export const roomByEventRef = anyApi.rooms.get as unknown as Query<ByEvent, RoomProjection | null>;
/** The incident's latest room, open or closed. */
export const roomForEventRef = anyApi.rooms.forEvent as unknown as Query<ByEvent, RoomRef | null>;
export const roomByIdRef = anyApi.rooms.byId as unknown as Query<ByRoom, RoomProjection>;
export const roomsMineRef = anyApi.rooms.listMine as unknown as Query<None, RoomProjection[]>;
export const roomJoinRef = anyApi.rooms.join as unknown as Mutation<ByRoom, null>;
export const roomLeaveRef = anyApi.rooms.leave as unknown as Mutation<ByRoom, null>;
export const roomSetInCallRef = anyApi.rooms.setInCall as unknown as Mutation<ByRoom & { inCall: boolean }, null>;
export const messagesListRef = anyApi.messages.list as unknown as Query<
  ByRoom & { eventId?: EventId; before?: ISODate; limit?: number },
  RoomMessage[]
>;
export const messagesSendRef = anyApi.messages.send as unknown as Mutation<
  ByRoom & { eventId?: EventId; text: string; refs?: { proposalId: ProposalId; revision: number } },
  { messageId: Id }
>;
export const summaryGetRef = anyApi.summary.get as unknown as Query<ByEvent, SummaryState>;
export const summaryRequestRef = anyApi.summary.request as unknown as Mutation<ByRoom, null>;
export const summaryEditRef = anyApi.summary.edit as unknown as Mutation<
  ByEvent & { proposalId: ProposalId; baseRevision: number; expectedGeneration?: number; changes: SummaryChanges },
  { accepted: true }
>;
export const revisionRequestRef = anyApi.revisions.request as unknown as Mutation<
  ByEvent & { hostRunId: Id },
  { accepted: boolean; alreadyApplied: boolean }
>;

/** Agents (wiring map §4). */
export const spansListRef = anyApi.spans.list as unknown as Query<{ eventId?: EventId; limit?: number }, PublicSpan[]>;
export const agentLogsListRef = anyApi.agentLogs.list as unknown as Query<{ eventId?: EventId; limit?: number }, AgentLog[]>;
export const agentsRerunRef = anyApi.agents.rerun as unknown as Mutation<
  ByEvent & { role?: "incident_analyst" | "coordination_host" },
  null
>;
export const hostTriggersRef = anyApi.hostTriggers.listForRoom as unknown as Query<ByRoom, HostTriggerRow[]>;

/** Inbox and the shared audit record (wiring map §6). */
export const inboxListRef = anyApi.inbox.list as unknown as Query<None, InboxEntry[]>;
export const inboxGetRef = anyApi.inbox.get as unknown as Query<ByEvent, InboxEntry>;
export const inboxMarkReadRef = anyApi.inbox.markRead as unknown as Mutation<ByEvent, null>;
export const logListRef = anyApi.log.list as unknown as Query<
  { eventId?: EventId; cursor?: string },
  { entries: LogEntry[]; nextCursor: string | null }
>;

/** Fleet, queue, scans (wiring map §7). */
export const myQueueRef = anyApi.myQueue.myQueue as unknown as Query<{ objectId?: ObjectId }, MyQueueRow[]>;
export const fleetMineRef = anyApi.fleetQuery.listMine as unknown as Query<None, FleetMine>;
export const scanStartRef = anyApi.scans.startMine as unknown as Mutation<{ requestId: string }, { scanId: ScanId; reused: boolean }>;
export const scanMineRef = anyApi.scans.getMine as unknown as Query<{ scanId?: ScanId }, ScanRun | null>;

/** Observer display (spec names demo.myRun / demo.publicView; wiring map §8). */
export const observerRunRef = anyApi.observer.myRun as unknown as Query<None, { demoRunId: DemoRunId; scenario: string } | null>;
export const observerViewRef = anyApi.observer.publicView as unknown as Query<{ demoRunId: DemoRunId }, ObserverView>;

/** Verification, reports, history (wiring map §9). */
export const verificationRef = anyApi.verifications.get as unknown as Query<ByEvent, Verification | null>;
export const verificationRequestRef = anyApi.verifications.request as unknown as Action<ByEvent, { verificationId: Id; reused: boolean }>;
export const verificationReplayRef = anyApi.verifications.replay as unknown as Query<None, Verification | null>;
type Period = { periodStart: ISODate; periodEnd: ISODate };
export const reportPreviewRef = anyApi.reports.preview as unknown as Query<Period, ReportPreview>;
export const reportCsvRef = anyApi.reports.exportCsv as unknown as Action<Period, { url: string; filename: string }>;
export const historySeriesRef = anyApi.history.series as unknown as Query<ByEvent, HistorySeries>;

/** Demo controls (wiring map §10). All throw FEATURE_DISABLED while demo launch is off. Operators only. */
export const launchDefaultsRef = anyApi.demoLaunch.launchDefaults as unknown as Query<None, LaunchDefaults>;
export const launchSatelliteRef = anyApi.demoLaunch.launchSatellite as unknown as Action<
  LaunchInput,
  { objectId: ObjectId; eventId: EventId; demoRunId: DemoRunId; assignmentVersion: number }
>;
export const demoOrbitRef = anyApi.demoLaunch.orbit as unknown as Query<
  { objectId: ObjectId },
  { demoRunId: DemoRunId; simulated: boolean; omm: unknown } | null
>;
export const demoResetRef = anyApi.demoReset.reset as unknown as Mutation<
  { demoRunId?: DemoRunId },
  { closedRunId: DemoRunId | null; assignmentVersion: number }
>;
