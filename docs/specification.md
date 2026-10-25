# OrbitCall — Specification: frontend ↔ backend

The contract between the Next.js frontend and the Convex backend: data shapes, enums, functions, permissions, live updates, errors and the live-call join flow. Behavior comes from [functionality.md](functionality.md); IDs in brackets (for example `[ROOM-7]`) point there. Written Oct 24, 2026, from the locked docs (commit 49f930e).

Updated Oct 24, 2026 after direct user decisions: [assigned-fleet workflow](user-flow.md), My Fleet + My Incidents + globe, fleet-versus-catalog Run Scan, severity then earliest closest approach, separate missing/stale-data review, up to four computed candidates, shared selection followed by independent Approve, and a separate unilateral debris path. The Dev Switch separates TLE development simulation from the OMM-only real mode. No TLE fallback is allowed with Dev off. Appendix C specifies safe agent observability. These are requirements; the current simulator types are not yet identical to this contract.

The latest scope and stack are locked in [master-roadmap.md](master-roadmap.md), the team's source of truth. This specification supplies the detailed contract. The four-screen demo uses three dispatchers, group rooms for any number of linked operators with pair-specific approvals, three languages, DigitalOcean services, and separate Factory/Backboard/Tiger Data roles. In v1.1, Claude runs the Analyst/Advocates and translation, Gemini runs the Coordination Host, and Grok runs the independent check and selected audio tasks. These targets are not all implemented at the code baseline.

The accepted decisions in the master roadmap, user-flow.md, and functionality.md govern behavior. There is no simulator-specific exception overriding approval integrity. Counter is a conversation message, not an approval status. Country and language do not grant fleet access.

---

## Implementation boundary after branch reconciliation

The Phase 1 stretch implements `policies.getMine`, `policies.update`, and protected `advocates.list`/`advocates.rerun`, plus trusted company/assignment setup and immutable candidate inputs. The implemented [Operator Advocate v1 contract](operator-advocate-v1.md) documents provisional risk outcomes, issuer-bound account lookup, the bounded negotiation round and the scheduling boundary. It does not implement the full Phase 2 room/approval APIs described below.

The merged Phase 1 backend implements catalog ingestion, catalog snapshot/pairs, Risk Monitor coloring and the checked Incident Analyst. The `ec5ea34` OMM merge adds pinned web assets, a nullable/string `catalog.snapshot.ommUrl`, frontend loading and direct OMM worker propagation. SOCRATES rows are filtered by catalog membership, with their supplied encounter geometry retained. Full fleet APIs, numerical fleet-scoped scans, authenticated rooms, candidate approvals and unilateral debris remain targets. The public catalog queries are an explicit temporary scope exception to section 1 and do not authorize private data or scheduling. See [integration status](integration-status.md) for the handoff, [data layout](../data/README.md) for OMM delivery, and the [Phase 1 guide](phase1-andrew.md) for the original callable functions.

## 0. Conventions

- **One backend for the frontend.** The frontend calls only Convex functions (`useQuery`, `useMutation`, `useAction`) and LiveKit for the call. It never calls the Python orbital service, Space-Track, CelesTrak, xAI, Cartesia or Factory directly.
- **Names.** `module.function` here is `api.module.function` in code.
- **Kinds.** *query* = reactive read (`useQuery`, updates live on every screen [SYNC-2]); *mutation* = transactional write; *action* = a call that reaches an external service.
- **Time.** ISO-8601 UTC strings, for example `"2026-10-25T03:14:07Z"`. The frontend formats them; the countdown to TCA is computed on the client from `tcaUtc`.
- **Units live in field names.** `missKm`, `deltaVMs`, `fuelKg`, `relSpeedKmS`, `deltaAKm`. Values are plain numbers, never strings with units.
- **Unavailable is `null`, never `0`.** A missing Pc, fuel estimate or observation is `null` and the UI shows "unavailable" [M8, INBOX-3].
- **IDs.** Documents use Convex IDs (`Id<"events">`). Space objects use `ObjectId`: a catalog number as a decimal string (`"48211"`, 9-digit numbers allowed [DATA-6]) or a reserved simulated ID (`"SIM-0001"`) [DATA-7].
- **Proposal labels.** `P1`, `P2`… per event; revisions are integers from 1. The UI shows `P2 · R2`.
- **Sides.** In an event, side `"A"` owns `objectA` and side `"B"` owns `objectB`. Colors: A blue, B violet.
- **Languages.** `"en" | "ru" | "zh"`. Every text a viewer reads arrives already in the viewer's language, with the original attached [LANG-3, LANG-8].
- **Simulated.** Every record derived from the simulated satellite carries `simulated: true`. The UI shows a distinct color and a "simulated" label wherever the record appears [DATA-5].
- **The backend owns all state changes.** The frontend never sets an event status, a color, a feasibility outcome or an approval reset; it calls a mutation and watches queries.

```ts
type ISODate = string;              // "2026-10-25T03:14:07Z"
type Lang = "en" | "ru" | "zh";   // locked target: English, Russian, Mandarin
type ObjectId = string;             // "48211" | "799501621" | "SIM-0001"
type Side = "A" | "B";
```

---

## 1. Sign-in and permissions

- **Login** is Auth0 with sign-ups disabled; the team pre-creates three dispatcher users for the main demo, four assigned spacecraft each (US/RU/CN profiles), a read-only observer, and support for further operators in group-room tests; a room has no fixed operator count [ACC-1]. The frontend uses `ConvexProviderWithAuth0`. There is no registration screen.
- **Every function** resolves the caller with `ctx.auth.getUserIdentity()` and looks up `users` by `authSubject`. No identity → `UNAUTHENTICATED`. No user row → `FORBIDDEN`.
- **Identity failure:** show the sign-in failure. Auth0 is the locked provider. Replacing it requires a recorded stack revision and another authorization check.

| Role [ACC-4] | Can call |
|---|---|
| `operator` | Everything in section 3, limited to events involving at least one currently assigned object of their company, plus their own company's policy and settings |
| `head_of_ops` | `users.me`, `fleet.listMine`, `events.myQueue`, `log.list`, `reports.*` for their own company; company scope, read-only |
| `demo_observer` | `users.me`, `catalog.snapshot`, `demo.myRun`, `demo.publicView` for its assigned demo run; no approval, policy, private trace, or raw memory access |

A **party company** operates `objectA` or `objectB`. A **fleet assignment** grants an authenticated user responsibility for an object within that company. Event actions (select, approve, veto) require company membership and a current assignment to the corresponding active object; otherwise `FORBIDDEN`. Room chat/call/read requires explicit group-room membership derived from involvement in a linked event. Shared room access never grants approval rights on unrelated sides or access to private records. Side is resolved on the server, never accepted from the browser. Public catalog browsing grants no room access. Demo assignments are seeded, not editable by clients. Revocation invalidates affected approvals. Every additional group member (third, fourth or later) is an ordinary fleet operator involved in a linked event, distinct from deferred unsolicited affected-party notices.

An event has stable canonical A/B sides, independent of the current viewer. When two of the same company's objects are involved, return `myObjectIds` for both and `workflow: "internal_review"`, `mySide: null`, `canAct: false`; scheduling remains disabled pending an internal approval rule. A missing active counterpart retains a bilateral requirement and is never treated as debris.

**Privacy rules every function keeps** [POL-2, M2, LOG-1]:
1. No query returns another company's policy values. Only `policies.getMine` returns policy values, and only the caller's own.
2. Feasibility reaches the other side only as an outcome plus categories (`"fuel"`, `"mission_window"`…), never numbers from a policy.
3. Operator Advocates' private context lives in a table no client function reads.
4. Policy changes appear in the shared log only as a category ("policy changed: fuel").
5. These rules hold for live subscriptions and exports too, not only for the screens [ACC-2].

---

## 2. Data shapes

### 2.1 Enums

```ts
type EventStatus =                  // [§3 lifecycle]
  | "new" | "agents" | "proposal" | "communication" | "approved"
  | "scheduled" | "monitoring" | "awaiting_verification_data"
  | "verified" | "flagged" | "no_action_needed";

type Situation =                    // only while status is "communication"
  | "needs_operator_decision" | "waiting_for_operator" | null;

type Color = "red" | "yellow" | "none";          // [Q-2] red: Pc > 1e-4 and TCA < 72 h; yellow: 1e-5 ≤ Pc ≤ 1e-4, or Pc > 1e-4 and TCA ≥ 72 h

type AgentRole =
  | "risk_monitor" | "incident_analyst" | "operator_advocate"
  | "coordination_host" | "maneuver_scheduler" | "maneuver_verifier"
  | "second_model";                                // [AGT-6]

type FeasibilityOutcome = "feasible" | "infeasible" | "preferred" | "pending";
type FeasibilityCategory = "fuel" | "mission_window" | "risk" | "priority" | "other";

type MessageKind = "text" | "voice" | "negotiation" | "system" | "summary";

type ManeuverStatus =
  | "preview" | "rescreening" | "refused" | "committing" | "committed" | "failed";

type VerificationResult = "awaiting_data" | "consistent" | "mismatch";

type SourceName =
  | "celestrak_gp" | "celestrak_supgp" | "socrates" | "cdm_public"
  | "gp_history" | "keeptrack" | "simulated" | "celestrak_satcat";
```

### 2.2 Objects and events

```ts
interface SourceRef {
  name: SourceName;
  url: string | null;               // "Verify on CelesTrak" target where it exists [Q-9]
  epochUtc: ISODate | null;
  fetchedAt: ISODate | null;
}

interface SpaceObject {
  objectId: ObjectId;
  name: string;
  ownerName: string | null;         // fictional for the simulated satellite [DATA-7]
  ownerCompanyId: Id<"companies"> | null;   // set only for companies with users
  country: string | null;
  purpose: string | null;
  launchDate: string | null;
  simulated: boolean;
  kind: "payload" | "debris" | "rocket_body" | "unknown";
  maneuverability: "maneuverable" | "non_maneuverable" | "unknown";
  celestrakUrl: string | null;      // null for simulated objects
}

interface Pc {                      // supplied, never computed [SCR-2]
  value: number | null;             // null = unavailable, never zero
  metric: "pc" | "max_prob";        // SOCRATES reports a maximum probability
  source: "cdm" | "socrates" | "simulated";
  epochUtc: ISODate | null;
  sourceUrl: string | null;
  emergencyReportable: boolean | null;     // CDM flag [SCR-5]
}

interface SourceSpread {            // label: "source disagreement" [SCR-4, SCR-9]
  gpMissKm: number | null;
  supgpMissKm: number | null;
  minKm: number | null;
  maxKm: number | null;
  gpEpochUtc: ISODate | null;
  supgpEpochUtc: ISODate | null;
}

interface EventRow {
  eventId: Id<"events">;
  objectA: SpaceObject;
  objectB: SpaceObject;
  mySide: Side | null;              // assigned active side; null for context/internal review
  myObjectIds: ObjectId[];          // involved assigned objects; may include both sides
  workflow: "bilateral" | "unilateral_debris" | "internal_review";
  requiredApprovalSides: Side[];    // A+B bilateral; active side only for confirmed debris; [] internal review, scheduling disabled
  approvalRuleVersion: number;     // server-owned; classification changes invalidate approvals
  evidenceVersion: string;         // source/computation generation
  snapshotId: string;
  evidenceFreshness: "current" | "stale" | "unknown";
  lastKnownColor: Color | null;     // retained with stale label, never presented as current evidence
  freshnessReason: string | null;
  queueSection: "active" | "data_review" | "follow_up" | "history";
  rank: number;                    // server rank within queueSection
  priorityReason: string;          // viewer language, factual explanation
  tcaUtc: ISODate;
  missKm: number;
  relSpeedKmS: number;
  pc: Pc;
  color: Color;
  status: EventStatus;
  situation: Situation;
  agentsWorking: boolean;           // [Q-6]
  agentsStalled: boolean;           // agents working with no progress for 60 s; the UI offers Re-run [AGT-9]
  selectionGeneration: number;     // exists even with no selection; monotonically increases on invalidation
  selected: { proposalId: Id<"proposals">; label: string; revision: number; generation: number } | null;
  outcome: VerificationResult | null;          // [Q-8]
  reviewRequired: boolean;          // scheduled plan flagged by new data or a policy edit [POL-3]
  roomId: Id<"rooms"> | null;       // coordination room may link several pair events
  roomOpen: boolean;                // an open room exists (created when the workflow starts) [DSP-1]
  sources: SourceRef[];
  reference: ReferenceCheck | null; // SOCRATES check of our scan's event; null before matching_sources ran
  simulated: boolean;
  updatedAt: ISODate;
}

/** How a scan event compares with the SOCRATES reference list (decision of Oct 25, 2026; SCR-3 rules). */
interface ReferenceCheck {
  source: "socrates";
  referenceRunUtc: ISODate;          // the SOCRATES run the event was compared with
  // Checked in this order, as GET /validation does (contract.md: matchToleranceS 60, epochToleranceS 45):
  status: "data_differs"             // same canonical pair, but either object's element-set epoch differs from ours by
                                     // more than 45 s (SOCRATES epoch = its TCA − DSE); not a confirmation, not a miss
        | "matched"                  // same pair and same element sets (both epochs within 45 s), TCA within 60 s
        | "tca_mismatch"             // same pair and same element sets, but TCA more than 60 s apart: a real disagreement
        | "not_listed";              // the pair is not in that SOCRATES run
  referenceTcaUtc: ISODate | null;   // null when not_listed
  referenceMissKm: number | null;
  referenceMaxProb: number | null;   // SOCRATES max_prob, labeled as such, never a Pc
  tcaDiffS: number | null;           // ours − theirs
  missDiffKm: number | null;
}
```

A reference match is provenance, not a confidence score. "Not in SOCRATES" is not an error: their run may be older than our snapshot, or the pair may fall outside their thresholds. In real mode our OMM snapshot (gp-20261024T2134Z) is about 20 h newer than the SOCRATES run (socrates-20261024T0147Z), so most listed pairs come out `data_differs`; that is expected, and why `/validation` is measured on the TLE snapshot closest to the SOCRATES run.

### 2.3 Room, proposals, approvals

```ts
interface Feasibility {             // shareable only [POL-2]
  outcome: FeasibilityOutcome;
  categories: FeasibilityCategory[];
}

interface Revision {
  proposalId: Id<"proposals">;
  label: string;                    // "P2"
  revision: number;                 // 1, 2, …
  createdAt: ISODate;
  kind: "maneuver" | "wait";
  movingSide: Side | null;          // null for "wait"
  movingObjectId: ObjectId | null;
  burnTimeUtc: ISODate | null;
  deltaVMs: number | null;
  direction: "prograde" | "retrograde" | null;
  estimatedFuelKg: number | null;   // shared estimate of the burn's cost [ROOM-5]
  missBeforeKm: number;
  missAfterKm: number | null;       // indicative geometry [AGT-2]
  indicative: true;
  assumptions: string[];            // viewer's language
  feasibility: Partial<Record<Side, Feasibility>>; // active operator sides only; no debris policy
  recommendedBy: Side[];            // Operator Advocates' recommendation [AGT-3]
  rationale: {
    text: string;                   // viewer's language
    numbersChecked: boolean;        // [AGT-5]; false never reaches the UI as a normal card
    secondModel: { agrees: boolean; note: string } | null;   // [AGT-6]
  };
  reviewCondition: string | null;   // for "wait" candidates
  changeSummary: string | null;     // what changed from the previous revision and why [AGT-12]
  sourceMessageIds: Id<"messages">[];
  schedulePreviewDiff: string | null;   // Droid's prepared diff for this revision [EXE-4, ROOM-9]
  simulated: boolean;
}

interface ProposalCard {
  proposalId: Id<"proposals">;
  label: string;
  latest: Revision;
  revisionCount: number;
  isSelected: boolean;
}

interface SideApproval {
  status: "pending" | "approved" | "vetoed";
  byUserId: Id<"users"> | null;
  byName: string | null;
  at: ISODate | null;
  proposalId: Id<"proposals"> | null;
  revision: number | null;
  selectionGeneration: number | null;
  approvalRuleVersion: number;
}

interface Understood {              // facts, constraints, preferences the agents took from the discussion [ROOM-12]
  kind: "fact" | "constraint" | "preference" | "correction" | "hypothetical";
  hard: boolean;
  text: string;                     // viewer's language
  side: Side | null;
  sourceMessageId: Id<"messages">;
  status: "active" | "corrected";
}

interface RoomState {
  roomId: Id<"rooms">;
  state: "open" | "closed";         // closes when every linked incident is resolved; a closed room stays readable
  closedAt: ISODate | null;
  event: EventRow;                 // focused event with viewer-specific canAct/assignment scope
  linkedEvents: { eventId: Id<"events">; summary: string; canAct: boolean; requiredApprovalSides: Side[] }[]; // intentionally shared projection
  operatorCompanyIds: Id<"companies">[]; // every active operator company with a linked event; no fixed cap
  trajectoryPlans: TrajectoryPlan[]; // plans whose moved spacecraft affects a linked event (§2.5)
  summaryLines: string[];           // Incident Analyst's five lines, viewer's language [AGT-2]
  participants: {
    userId: Id<"users">; companyId: Id<"companies">; name: string; language: Lang; // sides are event-specific
    inRoom: boolean; inCall: boolean;
  }[];
  selected: EventRow["selected"];
  approvals: Partial<Record<Side, SideApproval>>; // required sides only; no dummy debris approval
  requiredApprovalSides: Side[];
  allRequiredApproved: boolean;     // false for internal_review even though required sides is empty
  lastReset: { at: ISODate; reason: string } | null;   // "P2 · R2 created — both approvals reset" [ROOM-11]
  understood: Understood[];
  callActive: boolean;
  canAct: boolean;                  // current assignment to active side and supported workflow
  omm: Record<Side, object> | null; // real mode waits when unavailable; TLE is dev-only
}
```

### 2.4 Messages

```ts
interface ProtectedValue {          // shown in monospace, never altered by translation [LANG-2]
  placeholder: string;              // "⟦v1⟧"
  kind: "number" | "unit" | "datetime" | "timezone" | "object_id" | "sign";
  text: string;                     // "0.20 m/s", "2026-10-25 03:14 UTC"
}

interface Message {
  messageId: Id<"messages">;
  roomId: Id<"rooms">;
  eventId: Id<"events"> | null;     // topic of this phrase, not the whole room
  at: ISODate;
  author:
    | { kind: "human"; userId: Id<"users">; companyId: Id<"companies">; name: string; side: Side | null }
    | { kind: "agent"; role: AgentRole; side: Side | null }
    | { kind: "system" };
  kind: MessageKind;
  text: string;                     // viewer's language
  originalText: string;
  originalLang: Lang;
  translationStatus: "ok" | "pending" | "original_only";   // original_only = placeholder check failed [LANG-2]
  values: ProtectedValue[];
  refs: { eventId?: Id<"events">; proposalId?: Id<"proposals">; revision?: number };
  form: SummaryForm | null;         // only for kind "summary" [ROOM-13]
  simulated: boolean;
}

interface SummaryForm {             // end-of-call summary, editable [ROOM-13]
  proposalId: Id<"proposals">;
  revision: number;
  movingSide: Side | null;
  burnTimeUtc: ISODate | null;
  deltaVMs: number | null;
  direction: "prograde" | "retrograde" | null;
  note: string;
}
```

### 2.5 Maneuver, verification, log, inbox, reports, policy

```ts
interface Rescreen {                // [EXE-2, EXE-3, §20 Q11]
  passed: boolean;
  objectsChecked: number;
  horizonH: number;                 // 72
  originalMissAfterKm: number;      // pass needs ≥ 1 km
  newConjunctions: { objectId: ObjectId; name: string; tcaUtc: ISODate; missKm: number }[];   // pass needs none under 1 km
  refusalReason: string | null;
}

interface Maneuver {
  maneuverId: Id<"maneuvers">;
  proposalId: Id<"proposals">;
  revision: number;
  status: ManeuverStatus;
  filePath: string;                 // "operators/<operator>/schedule.json" [EXE-1]
  diff: string | null;              // unified diff
  commitSha: string | null;         // [§20 Q14]
  writtenBy: "droid" | "backend";
  rescreen: Rescreen | null;
  error: string | null;
  reviewRequired: boolean;
  updatedAt: ISODate;
}

interface TrajectoryPlan {          // one moved spacecraft across every pair event it affects (§4.1)
  objectId: ObjectId;               // the moved spacecraft
  planVersion: number;              // advances on any change to the moved trajectory
  affectedEventIds: Id<"events">[]; // pair events whose inputs use this trajectory
  proposalRefs: { eventId: Id<"events">; proposalId: Id<"proposals">; revision: number }[]; // one per affected event
  maneuverId: Id<"maneuvers"> | null;   // the single schedule entry, once an intent is reserved
  state: "proposed" | "authorized" | "scheduled" | "review_required" | "superseded";
}

interface Verification {            // [VER-1..VER-4, §20 Q11]
  kind: "live" | "replay";          // the demo shows "replay" [VER-3]
  result: VerificationResult;
  label: string;                    // "evidence consistent with plan" / "mismatch" / "awaiting verification data"
  expected: { deltaAKm: number; sign: 1 | -1 };
  observed: { deltaAKm: number; z: number; epochUtc: ISODate } | null;
  elementSetCount: number;
  series: { epochUtc: ISODate; smaKm: number }[];
  thresholds: { z: 5; minDeltaAKm: 0.05; sizeTolerance: 0.5; minSets: 8 };
  method: string;
  limitations: string[];
  missing: string[];                // what evidence is missing [VER-4]
  sources: SourceRef[];
}

type LogAction =
  | "event_created" | "status_changed" | "message" | "negotiation"
  | "proposal_revised" | "selected" | "approved" | "vetoed" | "countered"  // countered is a conversation audit action, not approval state
  | "approvals_reset" | "rescreened" | "refused" | "schedule_committed"
  | "schedule_failed" | "verified" | "policy_changed" | "no_action_needed"
  | "agents_rerun" | "summary_posted";

interface LogEntry {                // immutable [LOG-1..LOG-3, LOG-5, LOG-6]
  logId: Id<"log">;
  at: ISODate;
  eventId: Id<"events"> | null;
  actor:
    | { kind: "human"; userId: Id<"users">; name: string; side: Side | null }
    | { kind: "agent"; role: AgentRole; side: Side | null }
    | { kind: "system" };
  action: LogAction;
  summary: string;                  // viewer's language
  texts: Partial<Record<Lang, string>> | null;   // both language versions of a human line [LANG-5]
  before: Record<string, number | string | null> | null;
  after: Record<string, number | string | null> | null;
  proposalId: Id<"proposals"> | null;
  revision: number | null;
  simulated: boolean;
}

interface InboxItem {               // per person [INBOX-1, INBOX-2]
  eventId: Id<"events">;
  unread: boolean;
  title: string;                    // "KESTREL-7 × 48211"
  color: Color;
  status: EventStatus;
  situation: Situation;
  tcaUtc: ISODate;
  lastUpdateAt: ISODate;
  lastUpdateSummary: string;       // a notice when someone added the reader to a room [INBOX-1]
  room: { roomId: Id<"rooms">; joined: boolean; otherSideJoined: boolean; otherSidePresenceAt: ISODate | null } | null; // [DSP-5]
  simulated: boolean;
}

interface IncidentDetail extends EventRow {      // [INBOX-3, INBOX-4]
  spread: SourceSpread;
  summaryLines: string[];
  contacts: {
    side: Side; companyName: string;
    people: { name: string; role: string | null; email: string | null; phone: string | null; availability: string | null }[];
  }[];
  missing: string[];                // fields shown as unavailable
  currentDecision: string | null;
  verification: Verification | null;
}

interface ValidationSummary {       // [SCR-3, SCR-8]; simulated events never count
  snapshotId: string;
  snapshotUtc: ISODate;
  scope: string;
  horizonH: number;
  matchToleranceS: 60;
  eligible: number;
  matched: number;
  recall: number | null;
  dataDiffers: number;
  unmatched: number;
  excluded: { reason: string; count: number }[];
  tcaErrorS: { median: number; p95: number } | null;
  missErrorKm: { median: number; p95: number } | null;
}

interface ReportPreview {           // [LOG-7..LOG-9, §20 Q10]; simulated events excluded
  periodStart: ISODate;
  periodEnd: ISODate;
  satellites: ObjectId[];
  uniqueEvents: number;
  eventsWithCoordination: number;
  eventsWithScheduledManeuver: number;
  eventsWithObservedExecution: number;
  unresolvedEvents: number;
  coverage: { source: SourceName; fromUtc: ISODate | null; toUtc: ISODate | null }[];
  missingFields: { field: string; note: string }[];
  fccFields: "to_verify";
}

interface Window { startUtc: ISODate; endUtc: ISODate; reason: string }

interface SatellitePolicy {         // private to the company [POL-1]
  objectId: ObjectId;
  minFuelReserveKg: number;
  currentFuelKg: number;            // spec addition: needed to estimate fuel; simulated in the demo
  dryMassKg: number;                // spec addition
  ispS: number;                     // spec addition
  protectedWindows: Window[];       // hard constraints [POL-6]
  preferredWindows: Window[];       // preferences
  acceptablePc: number;
  missionPriority: "low" | "normal" | "high";
}
```

---

### 2.6 Assigned fleet, scan runs and orbit rendering

```ts
interface FleetSatellite {
  object: SpaceObject;
  assignedAt: ISODate;
  position: { latDeg: number; lonDeg: number; altitudeKm: number; atUtc: ISODate } | null;
  orbitEpochUtc: ISODate | null;
  freshness: "current" | "stale" | "unknown";
  unresolvedIncidentCount: number;
  lastScanId: Id<"scanRuns"> | null;
  scanCoverage: "not_scanned" | "complete" | "partial" | "failed";
}

interface ScanRun {
  scanId: Id<"scanRuns">;
  requestedBy: Id<"users">;
  assignmentVersion: number;
  primaryObjectIds: ObjectId[];
  snapshotId: string;
  fromUtc: ISODate;
  toUtc: ISODate;                    // fromUtc + 72 hours
  status: "queued" | "running" | "completed" | "failed";
  phase: "queued" | "loading" | "screening" | "matching_sources" | "publishing" | "done" | "failed";
  progress: number | null;           // measured fraction, null if indeterminate
  counts: { primaryObjects: number; catalogObjects: number; primariesCompleted: number; pairsChecked: number; eventsFound: number };
  coverage: {
    complete: boolean; catalogScope: string; excludedObjects: number;
    reasons: { reason: string; count: number }[];
  };
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
  error: { code: string; message: string } | null;
}
```

`fleet.listMine` positions are a coarse display sample, not a high-rate Convex stream. The browser propagates the same pinned orbit elements between samples and labels position time separately from element epoch. Unknown position stays null.

`catalog.snapshot` additionally returns `snapshotId` and source epochs. A production adapter joins each ObjectId to that snapshot, not to an unstable `catalogIndex`. `events.orbits({ eventId })` is an assignment-authorized query returning `{ snapshotId, evidenceVersion, objects: { objectId, epochUtc, simulated, format: "omm", omm: object }[] }` for both objects, even before a room exists. OMM schemas and validity are checked at ingest. Real mode accepts only OMM. TLE remains exclusively in the development simulator; there is no real-mode fallback. Rendering must propagate each supplied orbit, including simulated OMM, rather than inventing a synthetic counterpart with `engine.encounters`. Lat/lon are degrees, altitude is km and the position conversion is WGS84. Any provided Cartesian state must explicitly identify TEME, km, km/s and epoch; never pass an unlabelled vector.

Runs pin assignments and snapshot. If either changes, old results remain historical and cannot be labeled current for the new scope. Negative results are meaningful only with complete disclosed coverage. Routine monitoring may share numerical work, but user-facing queries remain assignment-authorized and canonical events remain deduplicated. Source freshness limits are per-source versioned backend configuration; unknown freshness goes to data review. Past-TCA events cannot generate a new future maneuver approval.

---

## 3. Functions by screen

Each entry: kind · arguments → result · who · errors beyond `UNAUTHENTICATED` / `FORBIDDEN` · IDs.

### 3.1 Session and configuration

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `users.me` | query | `{}` → `{ userId, name, role, language, dispatcherCountry, company: { companyId, name, country, simulated }, assignedObjectIds, assignmentVersion }` | Any user |
| `demo.myRun` | query | `{}` → `{ demoRunId, scenario } \| null` | Observer only: the newest open run whose manifest grants this observer, or null while none does. Reactive, so a reset and a new grant move the large display to the new run |
| `demo.publicView` | query | `{ demoRunId }` → observer projection | Dedicated run-authorized observer. Shared globe/scan/proposal/job/results only; no private policy/memory or controls |
| `config.flags` | query | `{}` → `{ demoLaunch, voice, droid, secondModel }` (booleans) | Hide what is off: no launch form, no call button [LANG-7] |

### 3.2 Assigned-fleet dashboard (screen 1)

The default dashboard is My Fleet + My Incidents + globe. Label the separate missing/stale-evidence section "Data needs review" (Russian: "Нужно проверить данные"). Selecting a fleet row filters incidents; it does not change the scope of Run Scan. Show current propagated position and time separately from orbital epoch. Define TCA in UI copy as "Time until closest approach" / "До ближайшего сближения".

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `fleet.listMine` | query | `{}` → `{ assignmentVersion, satellites: FleetSatellite[] }` | All assigned objects, including zero-incident objects. Head of ops gets company read scope. No public assignment mutation [FLEET-1..FLEET-4] |
| `scans.startMine` | mutation | `{ requestId: string }` → `{ scanId, reused: boolean }` | Resolves all assignments server-side, queues work; duplicate requests/active runs reuse a job. No client-supplied primary IDs. `EMPTY_FLEET`, `RATE_LIMITED` [SCAN-1..SCAN-3] |
| `scans.getMine` | query | `{ scanId? }` → `ScanRun \| null` | Own run/latest run, live progress, coverage, partial/failure and zero-result states. Shared computation cannot expose another user's results. The `matching_sources` phase fills `EventRow.reference` for every published event |
| `events.myQueue` | query | `{ objectId?: ObjectId }` → `EventRow[]` | Assigned-fleet events only, deduplicated. Optional filter must be assigned. Head of ops gets company read scope. Separate active, data-review, follow-up and history sections. Active order: red, yellow, other usable Pc; within severity earliest TCA, emergency flag, descending Pc, event ID. Data review: TCA, miss, event ID. No Pc/time score [Q-1, Q-5, §20 Q12] |
| `events.orbits` | query | `{ eventId }` → orbit payload from section 2.6 | Authorized assigned incident only; available before room creation, stable object IDs and snapshot/evidence versions |
| `events.catalogPairs` | query | `{ limit?: number }` (default: every active real pair, at most 1200 rows) → `EventRow[]` | Real pairs from the snapshot for a separate Explore catalog view, never the default queue; read-only, `mySide: null`, `myObjectIds: []`, no room access [DATA-5] |
| `agentSummaries.get` | query | `{ eventId }` → `{ eventId, summaryLines, numbersChecked, originalLang, createdAt, simulated, agentsWorking, agentsStalled, run }` | Phase 1 Analyst read endpoint, independent of a room. Only current checked evidence is returned; English output in this phase. Identity/party rules and the full return shape are in [the Phase 1 integration guide](phase1-andrew.md#adils-summary-integration) |
| `catalog.snapshot` | query | `{}` → `{ snapshotId, takenAt, ommUrl: string \| null, gpUrl: string \| null, sources: SourceRef[] }` | Real mode requires `ommUrl`; null means OMM not ready and no real orbit/screening result is shown. `gpUrl` is provenance or legacy information, never an automatic real-mode TLE fallback. `takenAt` drives the "snapshot from …" banner |
| `validation.latest` | query | `{}` → `ValidationSummary \| null` | Measured numbers only; nothing hard-coded [SCR-8] |
| `data.refresh` | action | `{}` → `{ started: boolean, nextAllowedAt: ISODate }` | `RATE_LIMITED` inside source limits [DATA-3, DATA-4] |
| `demo.launchDefaults` | query | `{}` → `{ name, ownerName, ownerCountry, targetObjectId, tcaUtc, scenarioPc }` | Prefilled, rehearsed values [DATA-7] |
| `demo.launchSatellite` | action | `{ name, ownerName, ownerCountry, targetObjectId, tcaUtc, scenarioPc }` → `{ objectId, eventId, demoRunId, assignmentVersion }` | `operator` only; `FEATURE_DISABLED` unless `demoLaunch`; `UPSTREAM_UNAVAILABLE` if the orbital service fails. Owner company = caller's [DATA-7, SCR-10] |
| `demo.reset` | mutation | `{}` → `{ closedRunId, assignmentVersion }` | Closes the current demo run so the next judge starts clean. Simulated records of closed runs leave the queue, inbox and rooms; log entries stay, tagged with their run. `FEATURE_DISABLED` unless `demoLaunch` |

### 3.3 Personal inbox (screen 5)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `inbox.list` | query | `{}` → `InboxItem[]` | Newest update first [INBOX-6] |
| `inbox.get` | query | `{ eventId }` → `IncidentDetail` | `NOT_FOUND` [INBOX-3, INBOX-4, INBOX-7] |
| `inbox.markRead` | mutation | `{ eventId }` → `null` | Never approves anything [INBOX-8] |

### 3.4 Coordination room (screen 2)

A room groups all linked pair events and every operator company they involve, with no fixed operator count. It is an optional, automatically connected channel: an operator starts the workflow on an incident, every operator currently assigned to an involved object is joined, and deciding never requires opening the room. It closes when every linked incident is resolved (status approved or later, or no longer active); a closed room stays readable and refuses new lines and presence changes. A head of operations reads the rooms of company incidents and cannot start, join or post. Decision turns: while an incident has a selected card and required approvals outstanding, the required sides decide in order, A then B; only the side in turn approves, vetoes and posts, and the room projection marks each linked incident with `deciding`, `turn` and `myTurn`. Everyone may discuss before a decision opens. Voice may select a card; approval stays an explicit click. Main demo: US/RU and US/CN, three dispatchers. Call/chat/presence are room-scoped. Selection, approval, scheduling, and verification remain event-scoped. A situation with more satellites is several linked pair events in one room; a spacecraft whose maneuver affects more than one of them has one `TrajectoryPlan` (§2.5, §4.1). A room member can read the intentionally shared card projection for linked incidents without permission to approve them or read private policy/memory. An observer uses `demo.publicView`, not the operator room query.

Counter uses `messages.send`, optionally referencing the selected proposal/revision. There is no `approvals.counter` mutation, structured counter form or `countered` approval state.

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `rooms.startWorkflow` | mutation | `{ eventId }` → `{ roomId, created: boolean, joined: Id<"users">[] }` | Operator of a party object, active incident. Creates or returns the encounter's open room (every pair row within ±60 s, both object orders), joins every assigned operator of the involved companies to the room and its call, and leaves an inbox notice for those joined by someone else. Nobody is redirected. Idempotent. The UI calls it from Run agents on this case. Each newly linked incident starts the Incident Analyst and candidate publication (`advocates.publishFromOrbit`); both deduplicate [DSP-1, DSP-5] |
| `rooms.get` | query | `{ eventId }` → `RoomState \| null` | `null` until someone starts the workflow, or after the room closed |
| `rooms.byId` | query | `{ roomId }` → shared group-room projection | Membership required; no private policy/memory/context |
| `rooms.listMine` | query | `{}` → shared room projections | Open rooms of the caller's incidents |
| `rooms.join` / `rooms.leave` | mutation | `{ roomId }` → `null` | Presence for "is B in the room" [DSP-5]. Starting the workflow already joins; operators only. `INVALID_STATE` on a closed room |
| `rooms.setInCall` | mutation | `{ roomId, inCall: boolean }` → `null` | Room-level presence (`roomMembers.inCall`). The call screen writes the call's own presence through `call.presence.setInCall` (Section 5) |
| `proposals.list` | query | `{ eventId }` → `ProposalCard[]` | Up to four computed candidate cards total, including wait when justified. Fewer/zero options are explicit; do not require exactly one shared recommendation [ROOM-5] |
| `proposals.revisions` | query | `{ proposalId }` → `Revision[]` | History, oldest first |
| `rooms.select` | mutation | `{ eventId, proposalId, revision, expectedGeneration }` → `null` | Selects an existing card for shared review, not a counter; checks expectedGeneration and increments generation on change; resets required approvals [ROOM-11]. While a decision is open only the side in turn may change it. Served as `api.proposals.select` (issue #6). `INVALID_STATE`, `STALE_REVISION` |
| `approvals.approve` | mutation | `{ eventId, proposalId, revision, selectionGeneration, approvalRuleVersion }` → `{ allRequiredApproved: boolean, requiredApprovalSides: Side[] }` | Approve the selected revision [ROOM-7]. Rules in section 4.1 |
| `approvals.veto` | mutation | `{ eventId, proposalId, revision, selectionGeneration, approvalRuleVersion, reason?: string }` → `null` | Resets required approvals, agents revise [§20 Q16]. Only the side in turn |
| `approvals.status` | query | `{ eventId }` → `{ workflow, requiredApprovalSides, approvalRuleVersion, selectionGeneration, selected, approvals: Partial<Record<Side, SideApproval>>, allRequiredApproved, reviewRequired, deciding, turn, lastReset, mySide, canAct, myTurn, simulated }` | The event's decision state for the Decision Center ("P2 · R2 · A approved · waiting for B"). Changed inputs retire signatures; an agreed plan retains its status and reports `reviewRequired` with the reset reason. Party operators and heads of operations read; observers use only the separate run-authorized `observer.publicView` projection [ROOM-8] |
| `messages.list` | query | `{ roomId, eventId?: Id<"events">, before?: ISODate, limit?: number }` (default 100) → `Message[]` | Oldest first within the page; text in the viewer's language |
| `messages.send` | mutation | `{ roomId, eventId?: Id<"events">, text, refs?: { proposalId, revision } }` → `{ messageId }` | Up to 2,000 characters. While a decision is open on a linked incident, only the side in turn may post (`INVALID_STATE` otherwise). Returns at once; translation and agent reactions arrive through `messages.list` [LANG-4, AGT-11] |
| `summary.request` | mutation | `{ roomId }` → `null` | Asks the Coordination Host for the summary form now [ROOM-13] |
| `summary.edit` | mutation | `{ eventId, proposalId, baseRevision, changes: Partial<Pick<SummaryForm, "movingSide" \| "burnTimeUtc" \| "deltaVMs" \| "direction" \| "note">> }` → `{ accepted: true }` | The backend recomputes the numbers and publishes a new revision; required approvals reset to `pending`. `STALE_REVISION` if `baseRevision` is old |
| `agents.rerun` | mutation | `{ eventId }` → `null` | Retries a stuck agent step; cannot duplicate a schedule entry or revive approvals [AGT-9] |
| `call.join` | action | `{ roomId }` → `{ serverUrl, token, roomName, identity, language }` | `operator` with authorized room membership from an assigned linked event; `FEATURE_DISABLED` unless `voice`. Section 5 |
| `call.hostSpeech.speak` | internal action | `{ roomId, hostRunId, text, expectedInputVersion }` → `{ status: "sent" \| "failed" \| "no_listeners" \| "disabled" \| "rejected", httpStatus?, id?, reason? }` | Server only. `text` must be a summary or clarification of a succeeded host run of this open room. Capture `expectedInputVersion` after publication; changed discussion, evidence, selection or responsibility rejects queued delivery. The text is sent to the worker as a LiveKit server data packet (topic `orbit.host-speech`) only while someone is in the call. Writes no table and never approves. Section 5 |
| `maneuvers.get` | query | `{ eventId }` → `Maneuver \| null` | Diff before approval, re-screen and commit after [ROOM-8, ROOM-9] |
| `history.series` | query | `{ eventId }` → `{ atUtc, pc: number \| null, missKm, source: SourceName }[]` | Authorized cached Tiger Data observations only, no forecast. A scheduled server action performs the SQL query/export and publishes the versioned cache [ROOM-10] |
| `verifications.get` | query | `{ eventId }` → `Verification \| null` | [Q-8, VER-2] |
| `verifications.replay` | query | `{}` → `Verification` | The labeled historical replay [VER-3] |

### 3.5 Policy (screen 3)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `policies.getMine` | query | `{}` → `{ satellites: SatellitePolicy[], updatedAt }` | Own company only [POL-1, POL-2] |
| `policies.update` | mutation | `{ satellites: SatellitePolicy[] }` → `null` | `VALIDATION` on bad windows or negative values. Re-runs negotiation on open events; flags scheduled ones `reviewRequired` [POL-3, POL-5] |
| `companies.getMySettings` | query | `{}` → `{ language, contact }` | Shareable settings, kept apart from the policy [POL-1] |
| `companies.updateMySettings` | mutation | `{ language?, contact? }` → `null` | |

### 3.6 Audit log and reports (screen 4)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `log.list` | query | `{ eventId?, cursor? }` → `{ entries: LogEntry[], nextCursor: string \| null }` | 50 per page, newest first; shared entries only [LOG-4] |
| `reports.preview` | query | `{ periodStart, periodEnd }` → `ReportPreview` | Caller's company only [LOG-7, LOG-9] |
| `reports.exportCsv` | action | `{ periodStart, periodEnd }` → `{ url, filename }` | CSV of supporting event records; no policy values [LOG-9] |

---

## 4. Backend rules the frontend can rely on

### 4.1 Approvals [M1, ROOM-2, ROOM-7, ROOM-11, EXE-1]

UI contract: shared card selection, **Approve** and explicit **Veto**, in turns. The decision belongs to the event and is made in the Decision Center; the room is only its channel. Required sides decide in order, side A then side B (user-flow "App navigation and the decision flow", point 6): while a card is selected and approvals are outstanding, only the side in turn may approve, veto or change the selection, and an off-turn call returns `INVALID_STATE`. Re-approving the same selection is idempotent. Counters use normal text/voice messages. Selecting an alternative is not a counter. Speech and casual acknowledgements never approve.

Bilateral workflow requires A and B. Confirmed debris requires only the assigned active-object side; debris has no approval record or advocate. The proposed mover must be that active object. Missing active operators never trigger unilateral authorization. `internal_review` disables scheduling until a separate approval rule is defined.

`approvals.approve` runs in one Convex transaction and checks, in order:

1. The caller is an `operator` with a current assignment to the required active-object side in that company → else `FORBIDDEN`. The workflow must allow scheduling.
2. The event status is `proposal` or `communication` → else `INVALID_STATE` (`ALREADY_DECIDED` once it is `approved` or `scheduled`). Publishing candidates moves `new`/`agents` to `proposal`; starting the workflow sets `communication`.
3. `(proposalId, revision, selectionGeneration, approvalRuleVersion)` identifies the current selection and workflow → else `NOT_SELECTED` or `STALE_REVISION`. Material evidence/policy/assignment changes have already invalidated affected approvals and advanced the authorization generation. If the revision belongs to a trajectory plan, the server stores the plan's current `planVersion` with the approval.
4. `revision` is the latest revision of that proposal → else `STALE_REVISION`.
5. It stores the caller's real required side as `approved`, with user identity, time and selection generation. Only if every required side has valid current authorization does the event move to `approved`, returning `{ allRequiredApproved: true, requiredApprovalSides }`. Empty required-side lists never authorize scheduling. Confirmed debris never fabricates an approval for its missing side.

`approvals.veto` also requires steps 1–4. It logs the veto, invalidates current approvals and returns the event to `agents` with the reason. The veto remains historical; approvals are pending on the revised selection. Messages trigger reconsideration only when they materially change facts, constraints or preferences. A conversational counter is not itself an approval or an unconditional reset.

After all workflow-required approvals the Maneuver Scheduler runs in the background:
- Preparation starts earlier: after each selection, it asks Factory to `/prepare` the selected maneuver under the intent key and records the checked diff and its hash on the revision (`schedulePreviewDiff`) [EXE-4]. An approval counts only if given after the revision's first recorded preview. A reset that only advances the selection generation keeps the revision's preview: the new generation's approvals count, and scheduling re-prepares the byte-identical diff before re-screening.
- It checks again that required approvals, selected generation, revision, evidence, policy and fleet assignments are current. Pin these inputs to the re-screen result. A Convex transaction rechecks them and reserves an immutable schedule-write intent keyed by event, proposal, revision and selection generation. The external file/git write uses that idempotency key and is not described as part of a Convex transaction. Changes after authorization flag the reserved/scheduled plan for review, never silently replace it. Failed writes retry the same intent.
- A **wait** candidate moves the event to `monitoring`, with no maneuver.
- A **maneuver** is re-screened by the orbital service. On refusal: maneuver `refused`, required approvals reset to `pending` with the reason, event back to `agents` [EXE-3]. On pass: Droid commits the prepared diff; maneuver `committed`, event `scheduled`. The commit reads the completed `/prepare` job back from the worker and checks its content hash, diff and file path against the approved preview. A failed write leaves the maneuver `failed` with `error`, and a retry never creates a second entry.
- Failures stay visible: a `schedule_failed` log entry while no maneuver exists, a `failed` maneuver after. A missing or unreachable worker shows `WORKER_UNAVAILABLE`; there is no substitute writer.
- A shared mover is scheduled through its trajectory plan: one intent per plan version, every affected incident's approvals on that version re-checked, one re-screen per partner encounter and one schedule write. Without a covering plan it fails `SHARED_TRAJECTORY_REQUIRED`.

**Shared maneuvers.** When one maneuver affects several pair events, the moved spacecraft has one `TrajectoryPlan`. Each affected event keeps its own selection and required approvals. Scheduling requires every affected event's required approvals on the same `planVersion`; one event's approvals never authorize another. The moved trajectory is re-screened once against the full catalog, and the schedule-write intent is keyed by object and `planVersion`, so the plan produces one schedule entry. A refusal resets approvals in all affected events. A revision of the plan advances `planVersion` and invalidates approvals in all affected events, each with its own reset message. Linked events that do not use the moved trajectory keep their approvals.

**Resets.** These invalidate required approvals, advance selection generation and post a workflow-appropriate system message: "Both approvals reset" for bilateral or "Approval reset" for unilateral debris:
- a new selection;
- a new revision of the selected proposal (an agent revision or `summary.edit`);
- a veto or material change inferred from a conversational counter;
- a new `planVersion` of a trajectory plan this event depends on, including a revision made for another affected event;
- a material change in policy inputs, orbital evidence, workflow classification or approval authorization (including assignment revocation).

Unrelated messages never reset approvals. Old approvals stay in the log and never come back, even when the selection switches back.

### 4.2 Translation and agents

- `messages.send` stores the original at once. Translation fills `text` for each language: `translationStatus` goes from `pending` to `ok`, or to `original_only` when the placeholder check fails [LANG-2].
- Agent work (interpretation, revisions, the second-model check) runs in background actions after messages and data changes. The frontend sees results only through queries. `agentsWorking` is true while any agent step for the event is running.
- The Coordination Host uses Gemini in a Convex Node action with shared room context and a schema-checked result. It can ask a clarification, request a checked revision, or publish a per-event summary. Mutations validate source IDs, numbers and input versions before publication. It receives no raw policy or private memory and cannot approve or write a schedule. Claude handles translation of its checked text through the existing speech path.
- A revision whose numbers failed the deterministic check is never published [AGT-5].

### 4.3 Events and statuses

- Status and color change only on the backend. The lifecycle is functionality section 3, including `no_action_needed`.
- A room is created when an operator starts the workflow on an active incident. Every operator currently assigned to an involved object is joined; the others receive an inbox notice and stay on their screen. While no room exists, `rooms.get` returns `null` and the UI shows the event without a room.
- The room closes when every linked incident is resolved. Starting the workflow again on a still-active incident opens a new room.
- `situation` is set only while the status is `communication`.

### 4.4 Simulated data [DATA-5, DATA-7]

- The linked demo may use two flagged simulated US objects, one per pair incident, within the four-object assigned fleet. This supersedes the old one-simulated-object restriction. `demo.reset` closes the run.
- Simulated records are excluded from `validation.latest` and from `reports.*`.
- The simulated event's `pc.source` is `"simulated"`. Only the synthetic object has no `celestrakUrl`; its real counterpart retains its real source link. Launch explicitly assigns the synthetic object to the caller, updates assignmentVersion and invalidates old scan coverage. Its OMM is included in a versioned demo-run overlay of the pinned catalog. Reset deactivates that overlay and assignment and advances assignmentVersion.
- **Frontend Dev Switch** (see Appendix C): the UI may run local synthetic scenarios for polish without Convex. The target adapter maps simulator view models to this contract. Dev on uses TLE and synthetic scenarios. Dev off subscribes to the Convex snapshot, loads the pinned OMM index and group files, and propagates those records directly. Missing or invalid OMM stays visibly pending/error. `demo.launchSatellite` is the separate backend demo target and does not authorize a silent local-simulator fallback.

### 4.5 Limits

- The full orbital catalog is not stored as per-object live Convex updates. Real mode requires OMM from `catalog.snapshot.ommUrl`. Unavailable/invalid OMM stays explicitly pending/error with no TLE or simulator fallback. `/api/catalog` and the TLE element path are dev-only. The shared worker now accepts either format and uses OMM directly in real mode. The numerical fleet-screening service remains to build [DATA-6].
- Queries read indexed tables only (Convex scans at most 32,000 documents per transaction). Lists are paged where noted.
- Rooms have no fixed operator or event count. The Coordination Host context accepts up to 24 linked events and 100 messages per run; a room with more linked events fails the host run with a visible reason and never drops an event silently.
- Risk charts use historical observations only — no forecast model [SCR-6 retired, ROOM-10].

---

## 5. Live call [ROOM-6, LANG-1..LANG-3, LANG-6]

The room's chat is always there; the call is optional, like a Discord channel.

1. The client calls `call.join({ roomId })` and gets `{ serverUrl, token, roomName, identity, language }`.
   - The room name is `coordination-<roomId>` and the identity is `user-<userId>`.
   - The token lasts 2 hours and carries participant attributes `{ lang, companyId }`. Approval sides are resolved separately per event. The observer monitor does not receive publish/approval rights.
2. The client connects with the LiveKit JS client, publishes its microphone, and calls `call.presence.setInCall({ roomId, inCall: true })`, repeating it every 30 s as a heartbeat. Disconnect clears that user's call presence; a member without a heartbeat for 75 s counts as having left.
3. The translation worker (Python on DigitalOcean) uses Grok STT, protects values, translates with Claude, restores/checks them, then uses Cartesia for EN/ZH and Grok TTS for RU. It listens only to original human tracks and publishes:
   - `tr:<lang>:<identity>` — the translated voice of each speaker, one track per listener language;
   - `host:<lang>` — the Coordination Host's voice, from a second worker connection with identity `host`, whose tracks the worker never transcribes. It speaks a checked English text of a succeeded host run (`call.hostSpeech.speak`): English listeners hear it as is, the others a Claude translation with protected values; a language whose translation fails its check is not voiced. Host speech plays regardless of decision turns and writes no phrase rows.
4. The client plays:
   - the `tr:<myLang>:*` tracks of the other speakers;
   - the `host:<myLang>` track, only from the identity `host` or `host-*`;
   - the raw microphone of a speaker only when they speak the viewer's language.
5. Captions are not read from LiveKit. The worker writes each phrase to Convex as a `voice` message with the original and translations, and the client shows it through `messages.list` [LANG-5].
6. When the last operator leaves the call (disconnect, leaving the room, or no heartbeat for 75 s) and no operator returns within 15 s, the backend requests a `call_ended` Coordination Host run; an observer still listening does not keep the call open. From that run the Coordination Host posts a room summary (`kind: "summary"`) and room members get a notification [ROOM-13]. Each linked incident retains its own selected revision and required approval form. Only `approvals.approve` records approval. Veto and conversational counters do not approve, and neither does speech or the summary.

Track names belong to the worker's implementation (Kostya). If they change, this section changes with them.

---

## 6. Errors

All errors are `ConvexError` with `data: { code, message }`. The frontend switches on `code`.

| Code | When | UI |
|---|---|---|
| `UNAUTHENTICATED` | No login | Send to login |
| `FORBIDDEN` | Wrong role or not a party company | "You are not part of this incident" |
| `NOT_FOUND` | Unknown ID | Back to the queue |
| `INVALID_STATE` | Action not allowed in the current status | Refresh the room; the queries already show the new state |
| `NOT_SELECTED` | Approving / vetoing / countering a candidate that is not selected | Ask to select it first |
| `STALE_REVISION` | Approving or editing an older revision | Show the newer revision |
| `ALREADY_DECIDED` | Changing an approval after both sides approved and scheduling started | Disable the control |
| `FEATURE_DISABLED` | Flag off | Hide the control |
| `EMPTY_FLEET` | No assigned objects for Run Scan | Show assignment empty state |
| `RATE_LIMITED` | Data refresh too early | Show `nextAllowedAt` |
| `VALIDATION` | Bad arguments | Show the field message |
| `UPSTREAM_UNAVAILABLE` | Orbital service, LiveKit, xAI, Cartesia or Factory down | Text-only fallback where possible [LANG-7] |

---

## Appendix A. Convex ↔ orbital service (backend-internal)

Only Convex calls these; the frontend never does. Base URL `ORBIT_SERVICE_URL`; every request carries the header `X-Service-Token`. Bodies are JSON, with the same units and time format as section 0.

| Endpoint | Input → output | Used by |
|---|---|---|
| `POST /screen` | `{ scanId, snapshotId, primaryObjectIds, fromUtc, toUtc }` → `{ jobId }`, then `GET /jobs/{jobId}` yields `{ scanId, snapshotId, coverage, events: { objectA, objectB, tcaUtc, missKm, relSpeedKmS, spread }[] }` | Fleet Run Scan and Risk Monitor cron; primary IDs resolved by Convex [SCR-1, SCR-4, SCAN-1] |
| `POST /candidates` | `{ snapshotId, evidenceVersion, objectA, objectB, tcaUtc, allowedMovingObjectIds }` → grid results with geometry and fuel inputs, no policy; debris cannot be a mover | Incident Analyst [AGT-2, §20 Q11] |
| `POST /rescreen` | `{ snapshotId, evidenceVersion, objectId, maneuver: { burnTimeUtc, deltaVMs, direction }, fromUtc, toUtc }` → `{ jobId }`; job result is `Rescreen` plus echoed snapshot/evidence versions | Maneuver Scheduler [SCR-7, EXE-2] |
| `POST /simulate` | `{ targetObjectId, tcaUtc, name }` → `{ objectId, omm, event }` | `demo.launchSatellite` [SCR-10] |
| `POST /verify` | `{ objectId, expected }` → `Verification` | Maneuver Verifier [VER-1] |
| `GET /validation` | → `ValidationSummary` | Validation run [SCR-3] |
| `GET /jobs/{jobId}` | → status, measured progress/counters, coverage, result or result reference | Convex polls bounded requests; long numerical work does not live inside a mutation |
| `GET /snapshot` | → `{ snapshotId, takenAt, sources, ommFile }` | Versioned OMM asset served through backend-issued file URL; selected persistence/delivery path documented in master roadmap |

## Appendix B. Not in this spec

- Deferred features: calling or inviting operators [DSP-2] and notices to unrelated affected operators [DSP-3, DSP-6].
- Internal designs: agent prompts and the messages agents send each other, the translation worker's pipeline, and the Droid configuration.
- The accepted four-screen demo story and schedule-artifact workflow are in the master roadmap. Exact presentation timing is established in rehearsal.
- Fallback [SYNC-3] uses tested local Dev-mode features and a labeled recording. A self-hosted shared backend is outside the locked deployment and cannot be claimed without implementation and validation.

## Appendix C. Agent observability + frontend Dev Switch (UI reconcile)

Powers the Agents panel (graph, step traces, latency, tokens, cost). Backend should stream these as Convex documents; the Dev Switch simulator emits the same shapes locally.

### C.1 Dev Switch

| Mode | Data |
|---|---|
| `dev: false` | Real mode: backend OMM only; explicit unavailable/integration-pending state until the OMM pipeline is ready. No TLE fallback |
| `dev: true` | TLE catalog plus local synthetic scenarios (`web/src/lib/ops/*`); explicitly development/demo data |

Same UI components in both modes. Dev mode is for polishing the ops board, conjunction overlays, and agent animations before Convex is complete. It does not replace Auth0 in production mode.

### C.2 Span stream

```ts
type AgentId =
  | "monitor" | "analyst" | `advocate:${string}`
  | "host" | "checker" | "scheduler" | "verifier";

type HumanId = `human:${string}`;   // stable user ID, not a room-wide A/B side

type ToolId =
  | "sgp4" | "celestrak" | "socrates" | "spacetrack"
  | "keeptrack" | "policy" | "convex" | "room" | "schedule";

type NodeId = AgentId | ToolId | HumanId;

type SpanKind = "llm" | "tool" | "http" | "handoff" | "human" | "check";
type SpanStatus = "running" | "ok" | "error" | "waiting";

interface Span {
  id: string;
  parent: string | null;
  eventId: Id<"events"> | string | null;
  agent: AgentId;
  target: NodeId;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  t0: number;                       // wall-clock start, ms epoch
  ms?: number;                      // duration once finished
  t1?: number;                      // wall-clock end (animations at any speed)
  progress: number | null;          // measured 0..1, or null for indeterminate work
  model?: string;
  provider?: "anthropic" | "xai" | "google"; // actual provider for the recorded call
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  costUsd?: number | null;          // null → UI shows "—"
  reasoning?: string;              // sanitized public explanation of the step, never private context or internal chain of thought
  input?: unknown;                 // allowlisted public tool parameters only
  output?: unknown;                // allowlisted public results only; no raw policy values
  http?: { method: string; url: string; status?: number; bytes?: number };
  error?: string;
}

interface AgentLogLine {
  id: string;
  t: number;
  level: "debug" | "info" | "warn" | "error";
  source: AgentId | "system" | HumanId;
  msg: string;
  spanId?: string;
  eventId?: Id<"events"> | string;
}
```

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `spans.list` | query | `{ eventId?: Id<"events">, limit?: number }` → `Span[]` | Active + recent; assigned-event scope, safe public fields only; no eventId means union of caller's authorized fleet events. Never global private spans |
| `agentLogs.list` | query | `{ eventId?: Id<"events">, limit?: number }` → `AgentLogLine[]` | Agents panel log tab; same assignment/privacy filters as spans, no raw policy/tool context; complements `log.list` audit entries |
| `scan.last` | query | `{}` → `{ at: ISODate, objects: number, pairs: number, flagged: number, ms: number } \| null` | Last fleet-relevant Risk Monitor sweep, not a global stats leak. Live Run Scan phases/counters come from scans.getMine |

Map `AgentRole` (section 2.1) to `AgentId` in the adapter: `risk_monitor→monitor`, `incident_analyst→analyst`, `operator_advocate`→`advocate:<companyId>`, `coordination_host→host`, `second_model→checker`, `maneuver_scheduler→scheduler`, `maneuver_verifier→verifier`. Existing simulator `advocateA`/`advocateB` and `humanA`/`humanB` labels are legacy local aliases. Resolve them through the event's actual company/user mapping. Group-room identity must support more than two parties.


## Appendix D. Locked external integrations

The [master roadmap](master-roadmap.md) defines the current deployment, model IDs, service endpoints, environment names, and phase goals. Target runtime: Vercel frontend, Convex application state, DigitalOcean orbital/voice/Factory containers, Auth0 identities, LiveKit transport, Grok STT/RU TTS and rationale check, Claude analysis/advocacy/translation, Gemini Coordination Host, Cartesia EN/ZH TTS, Backboard isolated company memory, and Tiger Data historical analytics. The host uses `@google/genai`, `GEMINI_API_KEY` and `GEMINI_HOST_MODEL=gemini-3.8-flash` server-side. No Google key goes to the browser or media worker.

Backboard is context only. Tiger Data is an analytics copy. Factory writes a checked, authorized artifact. None owns approval state. Convex actions call these services and mutations publish version-checked results. Current Phase 1 public catalog queries do not authorize these private operations.
