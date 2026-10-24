# OrbitCall — Specification: frontend ↔ backend

The contract between the Next.js frontend and the Convex backend: data shapes, enums, functions, permissions, live updates, errors and the live-call join flow. Behavior comes from [functionality.md](functionality.md); IDs in brackets (for example `[ROOM-7]`) point there. Written Oct 24, 2026, from the locked docs (commit 49f930e).

Updated Oct 24, 2026 after direct user decisions: [assigned-fleet workflow](user-flow.md), My Fleet + My Incidents + globe, fleet-versus-catalog Run Scan, severity then earliest closest approach, separate missing/stale-data review, up to four computed candidates, shared selection followed by independent Approve, and a separate unilateral debris path. Dual orbit ingest and the Dev Switch remain transitional prototype support. Appendix C specifies safe agent observability. These are requirements; the current simulator types are not yet identical to this contract.

The accepted decisions in user-flow.md and functionality.md govern behavior. There is no simulator-specific exception overriding approval integrity. Counter is a conversation message, not an approval status. Country and language do not grant fleet access.

---

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
- **Languages.** `"en" | "ru"`. Every text a viewer reads arrives already in the viewer's language, with the original attached [LANG-3, LANG-8].
- **Simulated.** Every record derived from the simulated satellite carries `simulated: true`. The UI shows a distinct color and a "simulated" label wherever the record appears [DATA-5].
- **The backend owns all state changes.** The frontend never sets an event status, a color, a feasibility outcome or an approval reset; it calls a mutation and watches queries.

```ts
type ISODate = string;              // "2026-10-25T03:14:07Z"
type Lang = "en" | "ru";          // China-based demo dispatcher may use English; zh is not implemented
type ObjectId = string;             // "48211" | "799501621" | "SIM-0001"
type Side = "A" | "B";
```

---

## 1. Sign-in and permissions

- **Login** is Auth0 with sign-ups disabled; the team pre-creates two required dispatcher users and an optional third, each with four explicitly assigned spacecraft (demo profiles based in Russia, the US and China) [ACC-1]. The frontend uses `ConvexProviderWithAuth0`. There is no registration screen.
- **Every function** resolves the caller with `ctx.auth.getUserIdentity()` and looks up `users` by `authSubject`. No identity → `UNAUTHENTICATED`. No user row → `FORBIDDEN`.
- **Fallback** (plan section 11 cut rule): the same test users move to Convex Auth. Only `authSubject` changes; every function below stays the same.

| Role [ACC-4] | Can call |
|---|---|
| `operator` | Everything in section 3, limited to events involving at least one currently assigned object of their company, plus their own company's policy and settings |
| `head_of_ops` | `users.me`, `fleet.listMine`, `events.myQueue`, `log.list`, `reports.*` for their own company; company scope, read-only |

A **party company** operates `objectA` or `objectB`. A **fleet assignment** grants an authenticated user responsibility for an object within that company. Room actions (select, approve, veto, message, call) require both company membership and a current assignment to the corresponding active object; otherwise `FORBIDDEN`. Side is resolved on the server, never accepted from the browser. Public catalog browsing grants no room access. Demo assignments are seeded, not editable by clients. Revocation invalidates affected approvals. A third demo user is an ordinary fleet operator, distinct from deferred affected-party notices.

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
  | "gp_history" | "keeptrack" | "simulated";
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
  roomOpen: boolean;                // a room exists (created at red) [Q-3]
  sources: SourceRef[];
  simulated: boolean;
  updatedAt: ISODate;
}
```

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
  event: EventRow;
  summaryLines: string[];           // Incident Analyst's five lines, viewer's language [AGT-2]
  participants: {
    userId: Id<"users">; name: string; side: Side;
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
  omm: Record<Side, object> | null; // OMM records when available; null during GP/TLE dual-ingest fallback
  elements?: Record<Side, object> | null; // GP/TLE-compatible elements for the globe until OMM cutover
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
  at: ISODate;
  author:
    | { kind: "human"; userId: Id<"users">; name: string; side: Side }
    | { kind: "agent"; role: AgentRole; side: Side | null }
    | { kind: "system" };
  kind: MessageKind;
  text: string;                     // viewer's language
  originalText: string;
  originalLang: Lang;
  translationStatus: "ok" | "pending" | "original_only";   // original_only = placeholder check failed [LANG-2]
  values: ProtectedValue[];
  refs: { proposalId?: Id<"proposals">; revision?: number };
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
  lastUpdateSummary: string;
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

`catalog.snapshot` additionally returns `snapshotId` and source epochs. A production adapter joins each ObjectId to that snapshot, not to an unstable `catalogIndex`. `events.orbits({ eventId })` is an assignment-authorized query returning `{ snapshotId, evidenceVersion, objects: { objectId, epochUtc, simulated, format: "omm" | "tle", omm: object | null, line1: string | null, line2: string | null }[] }` for both objects, even before a room exists. OMM schemas and validity are checked at ingest. The TLE fields are temporary fallback. Rendering must propagate each supplied orbit, including simulated OMM, rather than inventing a synthetic counterpart with `engine.encounters`. Lat/lon are degrees, altitude is km and the position conversion is WGS84. Any provided Cartesian state must explicitly identify TEME, km, km/s and epoch; never pass an unlabelled vector.

Runs pin assignments and snapshot. If either changes, old results remain historical and cannot be labeled current for the new scope. Negative results are meaningful only with complete disclosed coverage. Routine monitoring may share numerical work, but user-facing queries remain assignment-authorized and canonical events remain deduplicated. Source freshness limits are per-source versioned backend configuration; unknown freshness goes to data review. Past-TCA events cannot generate a new future maneuver approval.

---

## 3. Functions by screen

Each entry: kind · arguments → result · who · errors beyond `UNAUTHENTICATED` / `FORBIDDEN` · IDs.

### 3.1 Session and configuration

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `users.me` | query | `{}` → `{ userId, name, role, language, dispatcherCountry, company: { companyId, name, country, simulated }, assignedObjectIds, assignmentVersion }` | Any user |
| `config.flags` | query | `{}` → `{ demoLaunch, voice, droid, secondModel }` (booleans) | Hide what is off: no launch form, no call button [LANG-7] |

### 3.2 Assigned-fleet dashboard (screen 1)

The default dashboard is My Fleet + My Incidents + globe. Label the separate missing/stale-evidence section "Data needs review" (Russian: "Нужно проверить данные"). Selecting a fleet row filters incidents; it does not change the scope of Run Scan. Show current propagated position and time separately from orbital epoch. Define TCA in UI copy as "Time until closest approach" / "До ближайшего сближения".

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `fleet.listMine` | query | `{}` → `{ assignmentVersion, satellites: FleetSatellite[] }` | All assigned objects, including zero-incident objects. Head of ops gets company read scope. No public assignment mutation [FLEET-1..FLEET-4] |
| `scans.startMine` | mutation | `{ requestId: string }` → `{ scanId, reused: boolean }` | Resolves all assignments server-side, queues work; duplicate requests/active runs reuse a job. No client-supplied primary IDs. `EMPTY_FLEET`, `RATE_LIMITED` [SCAN-1..SCAN-3] |
| `scans.getMine` | query | `{ scanId? }` → `ScanRun \| null` | Own run/latest run, live progress, coverage, partial/failure and zero-result states. Shared computation cannot expose another user's results |
| `events.myQueue` | query | `{ objectId?: ObjectId }` → `EventRow[]` | Assigned-fleet events only, deduplicated. Optional filter must be assigned. Head of ops gets company read scope. Separate active, data-review, follow-up and history sections. Active order: red, yellow, other usable Pc; within severity earliest TCA, emergency flag, descending Pc, event ID. Data review: TCA, miss, event ID. No Pc/time score [Q-1, Q-5, §20 Q12] |
| `events.orbits` | query | `{ eventId }` → orbit payload from section 2.6 | Authorized assigned incident only; available before room creation, stable object IDs and snapshot/evidence versions |
| `events.catalogPairs` | query | `{ limit?: number }` (default 50) → `EventRow[]` | Real pairs from the snapshot for a separate Explore catalog view, never the default queue; read-only, `mySide: null`, `myObjectIds: []`, no room access [DATA-5] |
| `catalog.snapshot` | query | `{}` → `{ snapshotId, takenAt, ommUrl: string \| null, gpUrl: string \| null, sources: SourceRef[] }` | Dual ingest: prefer `ommUrl` when present; otherwise use `gpUrl` (CelesTrak GP/TLE) for the globe via `satellite.js` until OMM cutover. `takenAt` drives the "snapshot from …" banner |
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

### 3.4 Conjunction room (screen 2)

Counter uses `messages.send`, optionally referencing the selected proposal/revision. There is no `approvals.counter` mutation, structured counter form or `countered` approval state.

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `rooms.get` | query | `{ eventId }` → `RoomState \| null` | `null` while no room exists (yellow, new) |
| `rooms.join` / `rooms.leave` | mutation | `{ eventId }` → `null` | Presence for "has B joined" [DSP-5] |
| `rooms.setInCall` | mutation | `{ eventId, inCall: boolean }` → `null` | Called on LiveKit connect/disconnect |
| `proposals.list` | query | `{ eventId }` → `ProposalCard[]` | Up to four computed candidate cards total, including wait when justified. Fewer/zero options are explicit; do not require exactly one shared recommendation [ROOM-5] |
| `proposals.revisions` | query | `{ proposalId }` → `Revision[]` | History, oldest first |
| `rooms.select` | mutation | `{ eventId, proposalId, revision, expectedGeneration }` → `null` | Selects an existing card for shared review, not a counter; checks expectedGeneration and increments generation on change; resets required approvals [ROOM-11]. `INVALID_STATE`, `STALE_REVISION` |
| `approvals.approve` | mutation | `{ eventId, proposalId, revision, selectionGeneration, approvalRuleVersion }` → `{ allRequiredApproved: boolean, requiredApprovalSides: Side[] }` | Approve the selected revision [ROOM-7]. Rules in section 4.1 |
| `approvals.veto` | mutation | `{ eventId, proposalId, revision, selectionGeneration, approvalRuleVersion, reason?: string }` → `null` | Resets required approvals, agents revise [§20 Q16] |
| `messages.list` | query | `{ eventId, before?: ISODate, limit?: number }` (default 100) → `Message[]` | Oldest first within the page; text in the viewer's language |
| `messages.send` | mutation | `{ eventId, text, refs?: { proposalId, revision } }` → `{ messageId }` | Up to 2,000 characters. Returns at once; translation and agent reactions arrive through `messages.list` [LANG-4, AGT-11] |
| `summary.request` | mutation | `{ eventId }` → `null` | Asks the Coordination Host for the summary form now [ROOM-13] |
| `summary.edit` | mutation | `{ eventId, proposalId, baseRevision, changes: Partial<Pick<SummaryForm, "movingSide" \| "burnTimeUtc" \| "deltaVMs" \| "direction" \| "note">> }` → `{ accepted: true }` | The backend recomputes the numbers and publishes a new revision; required approvals reset to `pending`. `STALE_REVISION` if `baseRevision` is old |
| `agents.rerun` | mutation | `{ eventId }` → `null` | Retries a stuck agent step; cannot duplicate a schedule entry or revive approvals [AGT-9] |
| `call.join` | action | `{ eventId }` → `{ serverUrl, token, roomName, identity, language }` | `operator` with current active-object assignment in a party company; `FEATURE_DISABLED` unless `voice`. Section 5 |
| `maneuvers.get` | query | `{ eventId }` → `Maneuver \| null` | Diff before approval, re-screen and commit after [ROOM-8, ROOM-9] |
| `history.series` | query | `{ eventId }` → `{ atUtc, pc: number \| null, missKm, source: SourceName }[]` | Observations only, no forecast [ROOM-10] |
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

UI contract: shared card selection, independent **Approve** and explicit **Veto**. Counters use normal text/voice messages. Selecting an alternative is not a counter. Speech and casual acknowledgements never approve.

Bilateral workflow requires A and B. Confirmed debris requires only the assigned active-object side; debris has no approval record or advocate. The proposed mover must be that active object. Missing active operators never trigger unilateral authorization. `internal_review` disables scheduling until a separate approval rule is defined.

`approvals.approve` runs in one Convex transaction and checks, in order:

1. The caller is an `operator` with a current assignment to the required active-object side in that company → else `FORBIDDEN`. The workflow must allow scheduling.
2. The event status is `proposal` or `communication` → else `INVALID_STATE`.
3. `(proposalId, revision, selectionGeneration, approvalRuleVersion)` identifies the current selection and workflow → else `NOT_SELECTED` or `STALE_REVISION`. Material evidence/policy/assignment changes have already invalidated affected approvals and advanced the authorization generation.
4. `revision` is the latest revision of that proposal → else `STALE_REVISION`.
5. It stores the caller's real required side as `approved`, with user identity, time and selection generation. Only if every required side has valid current authorization does the event move to `approved`, returning `{ allRequiredApproved: true, requiredApprovalSides }`. Empty required-side lists never authorize scheduling. Confirmed debris never fabricates an approval for its missing side.

`approvals.veto` also requires steps 1–4. It logs the veto, invalidates current approvals and returns the event to `agents` with the reason. The veto remains historical; approvals are pending on the revised selection. Messages trigger reconsideration only when they materially change facts, constraints or preferences. A conversational counter is not itself an approval or an unconditional reset.

After all workflow-required approvals the Maneuver Scheduler runs in the background:
- It checks again that required approvals, selected generation, revision, evidence, policy and fleet assignments are current. Pin these inputs to the re-screen result. A Convex transaction rechecks them and reserves an immutable schedule-write intent keyed by event, proposal, revision and selection generation. The external file/git write uses that idempotency key and is not described as part of a Convex transaction. Changes after authorization flag the reserved/scheduled plan for review, never silently replace it. Failed writes retry the same intent.
- A **wait** candidate moves the event to `monitoring`, with no maneuver.
- A **maneuver** is re-screened by the orbital service. On refusal: maneuver `refused`, required approvals reset to `pending` with the reason, event back to `agents` [EXE-3]. On pass: Droid commits the prepared diff; maneuver `committed`, event `scheduled`. A failed write leaves the maneuver `failed` with `error`, and a retry never creates a second entry.

**Resets.** These invalidate required approvals, advance selection generation and post a workflow-appropriate system message: "Both approvals reset" for bilateral or "Approval reset" for unilateral debris:
- a new selection;
- a new revision of the selected proposal (an agent revision or `summary.edit`);
- a veto or material change inferred from a conversational counter;
- a material change in policy inputs, orbital evidence, workflow classification or approval authorization (including assignment revocation).

Unrelated messages never reset approvals. Old approvals stay in the log and never come back, even when the selection switches back.

### 4.2 Translation and agents

- `messages.send` stores the original at once. Translation fills `text` for each language: `translationStatus` goes from `pending` to `ok`, or to `original_only` when the placeholder check fails [LANG-2].
- Agent work (interpretation, revisions, the second-model check) runs in background actions after messages and data changes. The frontend sees results only through queries. `agentsWorking` is true while any agent step for the event is running.
- A revision whose numbers failed the deterministic check is never published [AGT-5].

### 4.3 Events and statuses

- Status and color change only on the backend. The lifecycle is functionality section 3, including `no_action_needed`.
- A room is created when an event turns red. While no room exists, `rooms.get` returns `null` and the UI shows the event without a room.
- `situation` is set only while the status is `communication`.

### 4.4 Simulated data [DATA-5, DATA-7]

- One simulated satellite per demo run; `demo.reset` closes the run.
- Simulated records are excluded from `validation.latest` and from `reports.*`.
- The simulated event's `pc.source` is `"simulated"`. Only the synthetic object has no `celestrakUrl`; its real counterpart retains its real source link. Launch explicitly assigns the synthetic object to the caller, updates assignmentVersion and invalidates old scan coverage. Its OMM is included in a versioned demo-run overlay of the pinned catalog. Reset deactivates that overlay and assignment and advances assignmentVersion.
- **Frontend Dev Switch** (see Appendix C): the UI may also run local synthetic scenarios against the live catalog for polish and demos without Convex. The target adapter maps simulator view models to this contract; flipping Dev off is intended to switch to Convex queries after integration. The current prototype is not connected merely by toggling Dev off. `demo.launchSatellite` remains the production Convex demo path and can coexist.

### 4.5 Limits

- The catalog is not stored as Convex documents. Dual ingest: the globe prefers OMM from `catalog.snapshot.ommUrl` when present; otherwise it uses GP/TLE from `gpUrl` (or the existing CelesTrak client path) until the OMM snapshot is ready. Screening still runs in the orbital service. Target end state is OMM-only [DATA-6].
- Queries read indexed tables only (Convex scans at most 32,000 documents per transaction). Lists are paged where noted.
- Risk charts use historical observations only — no forecast model [SCR-6 retired, ROOM-10].

---

## 5. Live call [ROOM-6, LANG-1..LANG-3, LANG-6]

The room's chat is always there; the call is optional, like a Discord channel.

1. The client calls `call.join({ eventId })` and gets `{ serverUrl, token, roomName, identity, language }`.
   - The room name is `event-<eventId>` and the identity is `user-<userId>`.
   - The token lasts 2 hours and carries the participant attributes `{ lang, side }`.
2. The client connects with the LiveKit JS client, publishes its microphone, and calls `rooms.setInCall({ inCall: true })`.
3. The translation worker (Python, server side) listens to each speaker and publishes:
   - `tr:<lang>:<identity>` — the translated voice of each speaker, one track per listener language;
   - `host:<lang>` — the Coordination Host's voice.
4. The client plays:
   - the `tr:<myLang>:*` tracks of the other speakers;
   - the `host:<myLang>` track;
   - the raw microphone of a speaker only when they speak the viewer's language.
5. Captions are not read from LiveKit. The worker writes each phrase to Convex as a `voice` message with the original and translations, and the client shows it through `messages.list` [LANG-5].
6. When the last participant leaves the call, the Coordination Host posts the summary form (`kind: "summary"`) and both operators get a notification [ROOM-13]. Approval is still only `approvals.approve` (or veto / counter); speech never approves.

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
| `POST /screen` | `{ scanId, snapshotId, primaryObjectIds, fromUtc, toUtc }` → `{ scanId, snapshotId, coverage, events: { objectA, objectB, tcaUtc, missKm, relSpeedKmS, spread }[] }` | Fleet Run Scan and Risk Monitor cron; primary IDs resolved by Convex [SCR-1, SCR-4, SCAN-1] |
| `POST /candidates` | `{ snapshotId, evidenceVersion, objectA, objectB, tcaUtc, allowedMovingObjectIds }` → grid results with geometry and fuel inputs, no policy; debris cannot be a mover | Incident Analyst [AGT-2, §20 Q11] |
| `POST /rescreen` | `{ snapshotId, evidenceVersion, objectId, maneuver: { burnTimeUtc, deltaVMs, direction }, fromUtc, toUtc }` → `Rescreen` plus echoed snapshot/evidence versions | Maneuver Scheduler [SCR-7, EXE-2] |
| `POST /simulate` | `{ targetObjectId, tcaUtc, name }` → `{ objectId, omm, event }` | `demo.launchSatellite` [SCR-10] |
| `POST /verify` | `{ objectId, expected }` → `Verification` | Maneuver Verifier [VER-1] |
| `GET /validation` | → `ValidationSummary` | Validation run [SCR-3] |
| `GET /snapshot` | → `{ snapshotId, takenAt, sources, ommFile }` | Stored into Convex file storage for `catalog.snapshot` |

## Appendix B. Not in this spec

- Deferred features: calling or inviting operators [DSP-2], third-operator notices [DSP-3, DSP-6], the details of the git-style schedule history [§20 Q14].
- Internal designs: agent prompts and the messages agents send each other, the translation worker's pipeline, and the Droid configuration.
- The demo script, which is still to be discussed (plan section 7).
- The local-backend fallback [SYNC-3] has no separate contract: a self-hosted Convex backend serves the same functions to the same frontend.

## Appendix C. Agent observability + frontend Dev Switch (UI reconcile)

Powers the Agents panel (graph, step traces, latency, tokens, cost). Backend should stream these as Convex documents; the Dev Switch simulator emits the same shapes locally.

### C.1 Dev Switch

| Mode | Data |
|---|---|
| `dev: false` | Convex queries / mutations in this document |
| `dev: true` | Local synthetic scenarios over the live catalog (`web/src/lib/ops/*`) |

Same UI components in both modes. Dev mode is for polishing the ops board, conjunction overlays, and agent animations before Convex is complete. It does not replace Auth0 in production mode.

### C.2 Span stream

```ts
type AgentId =
  | "monitor" | "analyst" | "advocateA" | "advocateB"
  | "host" | "checker" | "scheduler" | "verifier";

type ToolId =
  | "sgp4" | "celestrak" | "socrates" | "spacetrack"
  | "keeptrack" | "policy" | "convex" | "room" | "schedule";

type NodeId = AgentId | ToolId | "humanA" | "humanB";

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
  progress: number;                 // 0..1 while running
  model?: string;
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
  source: AgentId | "system" | "humanA" | "humanB";
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

Map `AgentRole` (section 2.1) to `AgentId` in the adapter: `risk_monitor→monitor`, `incident_analyst→analyst`, `operator_advocate`→`advocateA`/`advocateB` by side, `coordination_host→host`, `second_model→checker`, `maneuver_scheduler→scheduler`, `maneuver_verifier→verifier`.
