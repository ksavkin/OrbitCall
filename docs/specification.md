# OrbitCall — Specification: frontend ↔ backend

The contract between the Next.js frontend and the Convex backend: data shapes, enums, functions, permissions, live updates, errors and the live-call join flow. Behavior comes from [functionality.md](functionality.md); IDs in brackets (for example `[ROOM-7]`) point there. Written Oct 24, 2026, from the locked docs (commit 49f930e).

Updated Oct 24, 2026 (UI reconcile on `adil`): approvals use approve / veto / counter (not tick-only); dual orbit ingest (OMM preferred, GP/TLE until cutover); frontend Dev Switch + synthetic scenarios coexist with `demo.launchSatellite`; agent span / trace streaming is specified in Appendix C for the Agents panel.

This document does not repeat behavior. If this spec and functionality.md disagree, functionality.md wins and this spec gets fixed — except where this reconcile note explicitly overrides the approval UX for the current UI.

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
type Lang = "en" | "ru";
type ObjectId = string;             // "48211" | "799501621" | "SIM-0001"
type Side = "A" | "B";
```

---

## 1. Sign-in and permissions

- **Login** is Auth0 with sign-ups disabled; the team pre-creates one test user per operator (A and B) [ACC-1]. The frontend uses `ConvexProviderWithAuth0`. There is no registration screen.
- **Every function** resolves the caller with `ctx.auth.getUserIdentity()` and looks up `users` by `authSubject`. No identity → `UNAUTHENTICATED`. No user row → `FORBIDDEN`.
- **Fallback** (plan section 11 cut rule): the same test users move to Convex Auth. Only `authSubject` changes; every function below stays the same.

| Role [ACC-4] | Can call |
|---|---|
| `operator` | Everything in section 3, limited to events where their company is a party, plus their own company's policy and settings |
| `head_of_ops` | `users.me`, `events.myQueue`, `log.list`, `reports.*` for their own company; read-only |

A **party company** of an event owns `objectA` or `objectB`. Room actions (select, approve, veto, counter, message, call) require the caller to be an `operator` of a party company; otherwise `FORBIDDEN`.

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
  mySide: Side | null;              // null when the viewer's company is not a party
  tcaUtc: ISODate;
  missKm: number;
  relSpeedKmS: number;
  pc: Pc;
  color: Color;
  status: EventStatus;
  situation: Situation;
  agentsWorking: boolean;           // [Q-6]
  agentsStalled: boolean;           // agents working with no progress for 60 s; the UI offers Re-run [AGT-9]
  selected: { proposalId: Id<"proposals">; label: string; revision: number } | null;
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
  feasibility: Record<Side, Feasibility>;
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

interface CounterPayload {
  message: string;                  // required free-text constraint / preference
  preferredAction?: "raise" | "lower" | "wait";
  preferredMover?: Side | "none";
}

interface SideApproval {
  status: "pending" | "approved" | "vetoed" | "countered";
  byName: string | null;
  at: ISODate | null;
  proposalId: Id<"proposals"> | null;
  revision: number | null;
  counter?: CounterPayload | null;  // set when status is "countered"
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
  approvals: Record<Side, SideApproval>;      // current, valid approvals only
  lastReset: { at: ISODate; reason: string } | null;   // "P2 · R2 created — both approvals reset" [ROOM-11]
  understood: Understood[];
  callActive: boolean;
  canAct: boolean;                  // caller is an operator of a party company
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
  | "proposal_revised" | "selected" | "approved" | "vetoed" | "countered"
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

## 3. Functions by screen

Each entry: kind · arguments → result · who · errors beyond `UNAUTHENTICATED` / `FORBIDDEN` · IDs.

### 3.1 Session and configuration

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `users.me` | query | `{}` → `{ userId, name, role, language, company: { companyId, name, country, simulated }, ownedObjectIds }` | Any user |
| `config.flags` | query | `{}` → `{ demoLaunch, voice, droid, secondModel }` (booleans) | Hide what is off: no launch form, no call button [LANG-7] |

### 3.2 Ops board (screen 1)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `events.myQueue` | query | `{}` → `EventRow[]` | Events where the caller's company is a party [Q-5]. Order: red, then yellow, then the rest with Pc (Pc descending, then TCA ascending), then "Pc unavailable — review" (TCA, then miss). Within a color, events flagged `emergencyReportable` or listed in both SOCRATES and a CDM come first [Q-1, SCR-5, §20 Q12] |
| `events.catalogPairs` | query | `{ limit?: number }` (default 50) → `EventRow[]` | Real pairs from the snapshot for context; read-only, `mySide: null`, no room [DATA-5] |
| `agentSummaries.get` | query | `{ eventId }` → `{ eventId, summaryLines, numbersChecked, originalLang, createdAt, simulated, agentsWorking, agentsStalled, run }` | Phase 1 Analyst read endpoint, independent of a room. Only current checked evidence is returned; English output in this phase. Identity/party rules and the full return shape are in [the Phase 1 integration guide](phase1-andrew.md#adils-summary-integration) |
| `catalog.snapshot` | query | `{}` → `{ snapshotId, takenAt, ommUrl: string \| null, gpUrl: string \| null, sources: SourceRef[] }` | Dual ingest: prefer `ommUrl` when present; otherwise use `gpUrl` (CelesTrak GP/TLE) for the globe via `satellite.js` until OMM cutover. `takenAt` drives the "snapshot from …" banner |
| `validation.latest` | query | `{}` → `ValidationSummary \| null` | Measured numbers only; nothing hard-coded [SCR-8] |
| `data.refresh` | action | `{}` → `{ started: boolean, nextAllowedAt: ISODate }` | `RATE_LIMITED` inside source limits [DATA-3, DATA-4] |
| `demo.launchDefaults` | query | `{}` → `{ name, ownerName, ownerCountry, targetObjectId, tcaUtc, scenarioPc }` | Prefilled, rehearsed values [DATA-7] |
| `demo.launchSatellite` | action | `{ name, ownerName, ownerCountry, targetObjectId, tcaUtc, scenarioPc }` → `{ objectId, eventId, demoRunId }` | `operator` only; `FEATURE_DISABLED` unless `demoLaunch`; `UPSTREAM_UNAVAILABLE` if the orbital service fails. Owner company = caller's [DATA-7, SCR-10] |
| `demo.reset` | mutation | `{}` → `{ closedRunId }` | Closes the current demo run so the next judge starts clean. Simulated records of closed runs leave the queue, inbox and rooms; log entries stay, tagged with their run. `FEATURE_DISABLED` unless `demoLaunch` |

### 3.3 Personal inbox (screen 5)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `inbox.list` | query | `{}` → `InboxItem[]` | Newest update first [INBOX-6] |
| `inbox.get` | query | `{ eventId }` → `IncidentDetail` | `NOT_FOUND` [INBOX-3, INBOX-4, INBOX-7] |
| `inbox.markRead` | mutation | `{ eventId }` → `null` | Never approves anything [INBOX-8] |

### 3.4 Conjunction room (screen 2)

| Function | Kind | Arguments → result | Notes |
|---|---|---|---|
| `rooms.get` | query | `{ eventId }` → `RoomState \| null` | `null` while no room exists (yellow, new) |
| `rooms.join` / `rooms.leave` | mutation | `{ eventId }` → `null` | Presence for "has B joined" [DSP-5] |
| `rooms.setInCall` | mutation | `{ eventId, inCall: boolean }` → `null` | Called on LiveKit connect/disconnect |
| `proposals.list` | query | `{ eventId }` → `ProposalCard[]` | Latest revision of each candidate [ROOM-5] |
| `proposals.revisions` | query | `{ proposalId }` → `Revision[]` | History, oldest first |
| `rooms.select` | mutation | `{ eventId, proposalId, revision }` → `null` | Selects for joint review; resets both approvals [ROOM-11]. `INVALID_STATE`, `STALE_REVISION` |
| `approvals.approve` | mutation | `{ eventId, proposalId, revision }` → `{ bothApproved: boolean }` | Approve the selected revision [ROOM-7]. Rules in section 4.1 |
| `approvals.veto` | mutation | `{ eventId, proposalId, revision, reason?: string }` → `null` | Resets both, agents revise [§20 Q16] |
| `approvals.counter` | mutation | `{ eventId, proposalId, revision, counter: CounterPayload }` → `null` | Records a counter; resets both sides; agents revise with the counter as a constraint |
| `messages.list` | query | `{ eventId, before?: ISODate, limit?: number }` (default 100) → `Message[]` | Oldest first within the page; text in the viewer's language |
| `messages.send` | mutation | `{ eventId, text }` → `{ messageId }` | Up to 2,000 characters. Returns at once; translation and agent reactions arrive through `messages.list` [LANG-4, AGT-11] |
| `summary.request` | mutation | `{ eventId }` → `null` | Asks the Coordination Host for the summary form now [ROOM-13] |
| `summary.edit` | mutation | `{ eventId, proposalId, baseRevision, changes: Partial<Pick<SummaryForm, "movingSide" \| "burnTimeUtc" \| "deltaVMs" \| "direction" \| "note">> }` → `{ accepted: true }` | The backend recomputes the numbers and publishes a new revision; both approvals reset to `pending`. `STALE_REVISION` if `baseRevision` is old |
| `agents.rerun` | mutation | `{ eventId }` → `null` | Retries a stuck agent step; cannot duplicate a schedule entry or revive approvals [AGT-9] |
| `call.join` | action | `{ eventId }` → `{ serverUrl, token, roomName, identity, language }` | `operator` of a party company; `FEATURE_DISABLED` unless `voice`. Section 5 |
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

UI contract (reconcile): each side uses **Approve / Veto / Counter**. Speech and casual acknowledgements never approve.

`approvals.approve` runs in one Convex transaction and checks, in order:

1. The caller is an `operator` of a party company → else `FORBIDDEN`.
2. The event status is `proposal` or `communication` → else `INVALID_STATE`.
3. `(proposalId, revision)` is the room's current selection → else `NOT_SELECTED`.
4. `revision` is the latest revision of that proposal → else `STALE_REVISION`.
5. It stores the caller's side as `approved`. If the other side has a valid `approved` on the same `(proposalId, revision)`, the event moves to `approved` and the result is `{ bothApproved: true }`.

`approvals.veto` and `approvals.counter` also require steps 1–4. Veto sets the caller's status to `vetoed`. Counter sets `countered` and stores `CounterPayload`. Both reset the other side to `pending`, return the event to `agents`, and attach the reason / counter as negotiation context.

After both approvals the Maneuver Scheduler runs in the background:
- It checks again that both approvals are still valid and the revision is still the latest.
- A **wait** candidate moves the event to `monitoring`, with no maneuver.
- A **maneuver** is re-screened by the orbital service. On refusal: maneuver `refused`, both approvals reset to `pending` with the reason, event back to `agents` [EXE-3]. On pass: Droid commits the prepared diff; maneuver `committed`, event `scheduled`. A failed write leaves the maneuver `failed` with `error`, and a retry never creates a second entry.

**Resets.** These invalidate both sides to `pending` and post a system message such as "P2 · R2 created — both approvals reset":
- a new selection;
- a new revision of the selected proposal (an agent revision or `summary.edit`);
- a veto or counter;
- a material change in policy inputs or orbital evidence.

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
- The simulated event's `pc.source` is `"simulated"`, and its objects have no `celestrakUrl`.
- **Frontend Dev Switch** (see Appendix C): the UI may also run local synthetic scenarios against the live catalog for polish and demos without Convex. Shapes match this contract; flipping Dev off switches to Convex queries. `demo.launchSatellite` remains the production Convex demo path and can coexist.

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
| `RATE_LIMITED` | Data refresh too early | Show `nextAllowedAt` |
| `VALIDATION` | Bad arguments | Show the field message |
| `UPSTREAM_UNAVAILABLE` | Orbital service, LiveKit, xAI, Cartesia or Factory down | Text-only fallback where possible [LANG-7] |

---

## Appendix A. Convex ↔ orbital service (backend-internal)

Only Convex calls these; the frontend never does. Base URL `ORBIT_SERVICE_URL`; every request carries the header `X-Service-Token`. Bodies are JSON, with the same units and time format as section 0.

| Endpoint | Input → output | Used by |
|---|---|---|
| `POST /screen` | `{ snapshotId }` → `{ snapshotId, events: { objectA, objectB, tcaUtc, missKm, relSpeedKmS, spread }[] }` | Risk Monitor cron [SCR-1, SCR-4] |
| `POST /candidates` | `{ objectA, objectB, tcaUtc }` → grid results with geometry and fuel inputs, no policy | Incident Analyst [AGT-2, §20 Q11] |
| `POST /rescreen` | `{ objectId, maneuver: { burnTimeUtc, deltaVMs, direction } }` → `Rescreen` | Maneuver Scheduler [SCR-7, EXE-2] |
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
  reasoning?: string;
  input?: unknown;
  output?: unknown;
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
| `spans.list` | query | `{ eventId?: Id<"events">, limit?: number }` → `Span[]` | Active + recent; updates live while agents run |
| `agentLogs.list` | query | `{ eventId?: Id<"events">, limit?: number }` → `AgentLogLine[]` | Agents panel log tab; complements `log.list` audit entries |
| `scan.last` | query | `{}` → `{ at: ISODate, objects: number, pairs: number, flagged: number, ms: number } \| null` | Last Risk Monitor sweep (globe radar / Agents header) |

Map `AgentRole` (section 2.1) to `AgentId` in the adapter: `risk_monitor→monitor`, `incident_analyst→analyst`, `operator_advocate`→`advocateA`/`advocateB` by side, `coordination_host→host`, `second_model→checker`, `maneuver_scheduler→scheduler`, `maneuver_verifier→verifier`.
