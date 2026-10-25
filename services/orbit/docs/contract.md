# Orbital service HTTP contract (v2.1)

Team spec Appendix A plus the additions it needs. Only Convex calls the service. Base URL `ORBIT_SERVICE_URL`;
every request except `GET /health` carries `X-Service-Token`. JSON bodies; units km, km/s, m/s for Δv; times ISO 8601
UTC (`"2026-10-25T03:14:07Z"`, whole seconds). Object ids are strings: catalog numbers (`"25544"`, Alpha-5 decoded,
9-digit OMM ids) or `"SIM-0001"`. Results that involve a simulated object carry `simulated: true`.

Additions to Appendix A are marked **[added]**; v2 changes (team spec of main 0bf8215) are marked **[v2]**. The reason
for each is in `decisions.md` (O1–O30); **[v2.1]** marks the changes for team main 776eaad (master roadmap §5, §8).
Every v2 request field is optional: a v1 caller gets v1 behavior.

**[v2.1] Real mode is OMM.** The catalog is a pinned CelesTrak GP OMM snapshot with a sha256 manifest, loaded with
`sgp4.omm.initialize`, epochs as given. **[v2.3]** By default it is the team's snapshot (`data/snapshots/gp-<time>/`)
and `snapshotId` is the team's id (`gp-20261024T2134Z`) — the same id Convex stores and the web serves. The id is
pinned: `ORBIT_SNAPSHOT_ID`, else `omm.snapshotId` of the team's catalog-pairs.json; the service loads exactly that
snapshot or refuses to start. The service's own CelesTrak fetch (`data/omm/<fetch>/`, id `celestrak-omm-…`) is used only when
`ORBIT_SNAPSHOT_DIR` pins it. `ORBIT_CATALOG_MODE=tle` is the explicit, labeled
development mode (the team's TLE files); there is no silent fallback.

**[v2.1] Jobs.** `POST /screen` and `POST /rescreen` answer `202 { jobId, status, created, statusUrl }` after the job
is persisted; `GET /jobs/{jobId}` reports it (below). Requests are validated first (400/404/409 come back at once,
no job). A caller-named `jobId` (for /screen: `screen-<scanId>` by default) makes a resubmit idempotent; the same id
with another body is 409 `JOB_CONFLICT`. Compatibility (deprecated): `?wait=1`, or a /rescreen without
`snapshotId` and `jobId` (the current Convex provider), returns the result synchronously.

**[v2.1] Versions.** Results echo `snapshotId`, `evidenceVersion` and, when sent, `proposalId`, `revision`, `runId`.

## Errors
HTTP status + body `{"error": {"code", "message"}}` with the spec §6 codes:

| Status | code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | missing or wrong `X-Service-Token` |
| 400 | `VALIDATION` | missing field, bad time, unknown direction |
| 404 | `NOT_FOUND` | object not in the snapshot (or replay not available) |
| 409 | `SNAPSHOT_MISMATCH` | **[v2]** the request pins a `snapshotId` this process does not hold |
| 503 | `NOT_READY` | **[v2]** `/validation` is being computed (header `Retry-After: 60`) |
| 409 | `JOB_CONFLICT` | **[v2.1]** a job with this id exists for another request |

Suggested Convex action timeouts: `/candidates` 15 s, `/rescreen` 120 s, `/verify` 30 s, `/simulate` 10 s,
`/snapshot` 5 s, **[v2]** `/screen` 540 s (the service stops at 480 s with a partial result), `/validation` 5 s,
`/objects` 5 s. Retry only on connection errors; every endpoint except `/simulate` (it adds an object) is deterministic for the
same snapshot and body.

## `GET /health` (no token)
`{ ok: true, snapshotId, objects }`

## `GET /snapshot` [v2.1]
```ts
{ snapshotId: string;            // real: the team's "gp-20261024T2134Z" (or "celestrak-omm-…" for the service's own fetch); dev: "celestrak-gp-…"
  takenAt: ISODate; format: "omm" | "tle"; mode: "real" | "development (TLE, …)";
  sources: SourceRef[];          // one per group: url, format, fetchedAt, sha256, epochUtc = median element-set epoch
  manifest: object | null;       // the OMM snapshot manifest (files, sha256, records, epoch range) + dir, layout
                                 // ("team" | "lane"; "lane" = the service's own fetch) and contentSha256 [v2.3]
  objectCount: number; skipped: number; skippedSample: { file?, objectId?, line?, reason }[];
  simulated: ObjectId[];         // SIM objects currently in the catalog
  ommFile: { path: "/snapshot/omm"; sha256; bytes; records; snapshotId } | null }   // null in development mode
```
`GET /snapshot/omm` → the OMM JSON array of the catalog (records as received; SIM objects built from their exact
elements, `SIMULATED: true`), `ETag` = sha256. Convex stores it and hands browsers a versioned file URL.

## `GET /jobs/{jobId}` [v2.1]
```ts
{ jobId; kind: "screen" | "rescreen"; status: "queued" | "running" | "completed" | "failed";
  phase: "queued" | "screening" | "publishing" | "done" | "failed";
  progress: number | null;       // measured fraction (screen: primaries done / primaries)
  counters: { primaryObjects?, catalogObjects?, primariesCompleted?, pairsChecked?, eventsFound? };
  coverage?: object;             // the screen's coverage once completed
  requestHash; createdAt; startedAt; finishedAt;
  result: object | null;         // the /screen or /rescreen result (shapes below) once completed
  resultRef: string | null;      // "jobs/<jobId>.json#result" in ORBIT_DATA
  error: { code; message } | null }   // VALIDATION | ERROR | SERVICE_RESTARTED
```

## `POST /candidates` — Incident Analyst [AGT-2, §20 Q11]
Request:
```ts
{ objectA: ObjectId | { objectId }; objectB: ObjectId | { objectId };   // two different objects
  tcaUtc: ISODate;               // from the queue (SOCRATES) or /simulate; refined here with SGP4 within ±10 min
  notBeforeUtc?: ISODate;        // [added] burns earlier than this are not offered (pass "now" from Convex)
  snapshotId?: string;           // [v2] 409 if it is not the loaded snapshot
  evidenceVersion?: string;      // [v2] echoed, no effect on the math
  allowedMovingObjectIds?: ObjectId[] }  // [v2] only these may move; absent = both (v1); [] = nobody (wait only)
// [v2] debris, rocket bodies and nonoperational payloads never move (see /objects), whatever the allow-list says
```
Response:
```ts
{ snapshotId; evidenceVersion: string | null;   // [v2] echo
  objectA; objectB;
  objects: Record<ObjectId, ObjectInfo>;          // [v2] classification of both objects (see /objects)
  notMovable: { side; objectId; reason }[];       // [v2] sides that do not move and why
  tcaUtc: ISODate;               // our SGP4 TCA
  tcaInputUtc: ISODate;
  missBeforeKm: number; relSpeedKmS: number; simulated: boolean;
  candidates: Candidate[];       // the full grid, policy-free order (rank 1 = first)
  wait: Candidate;               // kind "wait"
  failed: { candidateId; reason }[];   // grid points SGP4 cannot model (e.g. the orbit decays); the rest is returned
  assumptions: string[]; method: string }

interface Candidate {
  candidateId: string;           // "A:T-6h:+0.05" (side, lead, signed Δv); "wait"
  kind: "maneuver" | "wait";
  movingSide: "A" | "B" | null; movingObjectId: ObjectId | null;
  burnTimeUtc: ISODate | null; leadH: 12 | 6 | 3 | null;
  deltaVMs: number | null;       // magnitude, m/s
  direction: "prograde" | "retrograde" | null;
  deltaAKm: number | null;       // signed 2·Δv/n, for reference
  missBeforeKm: number; missAfterKm: number | null;   // indicative, partner only
  tcaAfterUtc: ISODate | null; relSpeedKmS: number | null;
  passesPairThreshold: boolean;  // missAfterKm ≥ 1 km (wait: missBeforeKm ≥ 1 km); NOT the whole-catalog re-screen
  estimatedFuelKg: null;         // always null: mass/Isp are private (POL-2); each Advocate computes it
  indicative: true; simulated: boolean; rank: number | null }
```
Grid: A|B × T−12/−6/−3 h × 0.02/0.05/0.1/0.2 m/s × prograde/retrograde = up to 48, plus wait. Order: passing the
pair threshold first, then least Δv, then largest miss, then latest burn. Convex filters by each side's
feasibility (`convex/lib/yield/assess.ts`), re-screens in this order (`convex/deal/proposals.ts` `prepareCandidates`)
and shows the cheapest passing option per side plus wait.
Maps to spec `Revision`: `movingSide, movingObjectId, burnTimeUtc, deltaVMs, direction, missBeforeKm,
missAfterKm, indicative, assumptions`; `estimatedFuelKg` comes from the moving company's Advocate.

## `POST /rescreen` — Maneuver Scheduler [SCR-7, EXE-2, EXE-3]
Request:
```ts
{ objectId: ObjectId;                                   // the moved satellite
  maneuver: { burnTimeUtc: ISODate; deltaVMs: number /* (0, 1] */; direction: "prograde" | "retrograde" };
  partnerObjectId?: ObjectId;    // [added] the original partner; without it the pair is not checked and passed = false
  tcaUtc?: ISODate;              // [added] the original TCA; the post-maneuver pair miss is searched within ±10 min
  horizonH?: number;             // default 72, counted from the burn; (0, 168]
  snapshotId?: string; evidenceVersion?: string;   // [v2] as in /candidates
  fromUtc?: ISODate; toUtc?: ISODate }             // [v2] both or neither; the screen runs from the burn to toUtc
                                                   // (before the burn the orbit is unchanged); fromUtc ≤ burn
// Without tcaUtc the original encounter is the pair's closest approach over the whole horizon.
// [v2] 400 if objectId is non-maneuverable (debris, rocket body, nonoperational payload).
// [v2.2] 400 if tcaUtc is not after the burn, or if the partner shares the moved object's element set (one body).
```
**[v2.1]** With `snapshotId` or `jobId` in the body: `202 { jobId }`, the result below is the job's `result`.
Without both (the v1 shape the current Convex provider sends) or with `?wait=1`: the result directly (deprecated).
Also accepts `jobId`, `proposalId`, `revision`, `runId` (echoed).
Result — spec `Rescreen` plus diagnostics:
```ts
{ passed: boolean;               // original pair ≥ 1 km (exact distance, before rounding), no other object
                                 // < 1 km, and every object screened over the whole horizon [PR #14]
  objectsChecked: number;        // objects that survived the radius-band prefilter and were propagated
  unpropagatedObjectIds: ObjectId[];   // [PR #14] objects SGP4 cannot propagate over part of the horizon: not
                                       // screened there, not in objectsChecked; any entry makes passed false
  objectsInCatalog: number;
  horizonH: number;
  originalMissAfterKm: number | null;
  newConjunctions: { objectId; name; tcaUtc; missKm;
                     withoutManeuverKm;
                     attachedObjectIds: ObjectId[] }[];   // [v2.2] bodies sharing this object's element set at this pass   // < 1 km, closest first; the partner's later re-encounters
                                              // count too; withoutManeuverKm: same encounter on the unmoved orbit
  refusalReason: string | null;  // also set (passed false) when the maneuver cannot be propagated or a flagged
                                 // encounter cannot be refined: an unchecked possible encounter is never a pass
  snapshotId; evidenceVersion: string | null; fromUtc; toUtc;   // [v2] echo of the requested window
  screenedFromUtc; screenedToUtc;                              // [v2.1] what was screened (from the burn)
  attachedObjectIds: ObjectId[];         // [v2.2] bodies sharing the moved object's element set (docked modules and
                                         // vehicles): moved with it, not screened
  partnerAttachedObjectIds: ObjectId[];  // [v2.2] bodies sharing the partner's element set: count as the partner
                                         // (originalMissAfterKm is the minimum over the group)
  simulated: boolean;            // true if the moved object or the partner is simulated
  method: string; limitations: string[] }
```

## `POST /verify` — Maneuver Verifier [VER-1..VER-4]
Request:
```ts
{ objectId: ObjectId;
  expected: { burnTimeUtc: ISODate;                     // [added] needed to split before/after
              deltaVMs?: number; direction?: "prograde" | "retrograde";   // [added] expected Δa = 2·Δv/n
              deltaAKm?: number };                       // or give the expected signed Δa directly
  series?: { epochUtc: ISODate; meanMotionRevPerDay?: number; smaKm?: number }[];  // [added] element sets Convex holds
  replay?: string;               // [added] name of a labeled replay in data/replay (e.g. "iss-simulated-reboost")
  kind?: "live" | "replay"; sources?: SourceRef[]; simulated?: boolean }
```
Response — spec `Verification` plus `simulated`:
```ts
{ kind: "live" | "replay"; result: "awaiting_data" | "consistent" | "mismatch";
  label: "awaiting verification data" | "evidence consistent with plan" | "mismatch";
  expected: { deltaAKm; sign: 1 | -1 };
  observed: { deltaAKm; z; epochUtc } | null;
  elementSetCount: number; series: { epochUtc; smaKm }[];
  thresholds: { z: 5; minDeltaAKm: 0.05; sizeTolerance: 0.5; minSets: 8 };
  method: string; limitations: string[]; missing: string[]; sources: SourceRef[]; simulated: boolean }
```
404 when `objectId` is unknown and no replay is named; 400 when the replay is for another object, when both
`series` and `replay` are given, or when the expected change is zero. `awaiting_data` when: fewer than 8 sets, fewer than 4 before or after the burn (±1 h excluded), or no change above
noise yet (absence of a jump is not a mismatch, VER-4).

## `POST /simulate` — `demo.launchSatellite` [DATA-7, SCR-10]
Request: `{ targetObjectId: ObjectId; tcaUtc: ISODate; name?: string; objectId?: "SIM-dddd"; tiltDeg?: number (3); missKm?: number (0.2);
deltaAKm?: number (20, range [-50, 50]) }` — **[v2.2]** the SIM's semi-major axis differs from the target's by `deltaAKm`, so
the pair drifts apart and meets once (0 = co-orbital: a meeting at every node crossing, decision O32)
(`objectId` must match `SIM-\d{4}` and be new; by default the next free one is used. `tiltDeg` ∈ (0, 10],
`missKm` ∈ [0.05, 5]; the target must propagate at `tcaUtc`.)
Response:
```ts
{ objectId: "SIM-0001"; omm: object; tle: [string, string];   // TLE uses placeholder catalog number 00000
  simulated: true;
  event: { objectA: ObjectId; objectB: "SIM-0001"; tcaUtc; missKm; relSpeedKmS; simulated: true };
  assumptions: string[] }
```
The SIM object joins the service's catalog (so /candidates and /rescreen see it) and is persisted in `data/sim/`.

## `POST /screen` — fleet Run Scan [v2] [SCR-1, SCAN-1..3, user-flow §3]
Request: `{ scanId?: string; jobId?: string; snapshotId?: string; primaryObjectIds: ObjectId[] (1–50); fromUtc: ISODate;
toUtc?: ISODate (default fromUtc + 72 h, window ≤ 168 h); evidenceVersion?: string; runId?: string }`. Convex resolves the
primaries from the user's assignments (the service trusts the list it is given).
**[v2.1]** Response: `202 { jobId }`; the result below is the job's `result` (or the direct answer with `?wait=1`).
Encounter dedup **[v2.1]**: refinements within 60 s of an encounter's fixed anchor are one event; no chaining.
Result:
```ts
{ scanId; snapshotId; evidenceVersion; fromUtc; toUtc; thresholdKm: 5; cached: boolean; runtimeS: number;
  coverage: { complete: boolean;           // every primary screened, every flagged pair refined, no timeout
              timedOut: boolean;           // stopped at the 480 s deadline (env ORBIT_SCREEN_DEADLINE_S)
              catalogScope: string;        // snapshot, object count, groups — "not every object in space"
              excludedObjects: number; reasons: { reason; count }[] };
  counts: { primaryObjects; catalogObjects; primariesCompleted; pairsChecked; eventsFound };
  missingPrimaryIds: ObjectId[];           // primaries not in the snapshot (partial coverage, not an error)
  unpropagatedObjectIds: ObjectId[];       // catalog objects SGP4 could not propagate over part of the window
  dockedBodies: Record<ObjectId, ObjectId[]>;   // [v2.2] per primary: bodies sharing its element set (docked
                                                // modules/vehicles) — the primary itself, never screened against it
  events: { objectA; objectB;              // canonical: catalog number order, stable for every user
            tcaUtc; missKm; relSpeedKmS;   // one event per 60 s anchor window (no chaining); miss < 5 km
            spread: SourceSpread;          // GP only: gpMissKm, gpEpochUtc (older element set); SupGP/min/max null
            primaries: ObjectId[];         // which of the two were primaries
            attachedObjectIds: ObjectId[]; // [v2.2] bodies sharing objectB's element set (docked), one event
            simulated: boolean }[];        // sorted by TCA
  coLocated: { objectA; objectB; minDistanceKm }[];   // docked / formation pairs (< 0.1 km/s): not events
  objects: Record<ObjectId, ObjectInfo>;   // classification of every object named above
  uncovered: object[];                     // primaries or pairs that could not be propagated / refined
  method; limitations }
```
Measured on the OMM snapshot: 4 primaries (ISS, STARLINK-33969, NUSAT-39, CSS) × 72 h → 18 s, 76 events,
14 co-located pairs, coverage complete.

## `GET /validation` [v2, v2.1] [SCR-3, SCR-8, roadmap §8]
Query: `snapshotId?` (409 if it is not the loaded real-mode snapshot). Served from a cache
(`data/validation/<validation snapshot>-<socrates sha8>-v<config>.json`, prebuilt by `tools/run_validation.py`,
~12 min); if absent, one background run starts and the answer is 503 `NOT_READY` + Retry-After.
**[v2.1] Full eligible scope**, geometry/time error separate from recall. The validation snapshot is the pinned
snapshot closest to the SOCRATES run (the team's TLE files, 6 h after it), named with its format.
Response — spec `ValidationSummary` plus disclosure:
```ts
{ snapshotId; snapshotUtc; snapshotFormat: "tle" | "omm"; referenceRunUtc; referenceSha256; scope: string;
  scopeComplete: boolean;      // false only with the test-only ORBIT_VALIDATION_MAX_PRIMARIES limit or a failed primary
  horizonH: 72; matchToleranceS: 60; epochToleranceS: 45;
  referenceRows; inScopeRows;  // inScopeRows = eligible + dataDiffers
  eligible;                    // ALL in-scope rows whose two element-set epochs equal SOCRATES' (TCA − DSE, ±45 s)
  matched; unmatched; notScreened;   // eligible = matched + unmatched + notScreened (notScreened = 0 in full scope)
  recall: number | null;       // matched / (matched + unmatched); = matched / eligible when scopeComplete
  dataDiffers;                 // in-scope rows with other element sets: neither eligible nor misses
  excluded: { reason; count }[];     // horizon, object not in the snapshot, co-located, data differs;
                                     // referenceRows = eligible + Σ excluded
  tcaErrorS: { median; p95; max; n } | null;    // GEOMETRY/TIME error: every eligible pair refined around the
  missErrorKm: { median; p95; max; n } | null;  // reference TCA, independent of detection
  geometryFailed: number;
  detectionErrors: { tcaErrorS; missErrorKm };  // the same errors for the encounters our screening matched
  oursNotInReference: { total; sameData; sameDataSample[] };   // informational, not judged
  primaries: { planned; screened; failed[] };   // greedy set cover of the eligible rows (deterministic, not minimal)
  unmatchedSample[]; limitations[]; configVersion; runtimeS; simulated: false }
```
Measured (full scope, 744 s): 195,064 reference rows; 38,390 in scope; **eligible 200, matched 200, recall 1.0**
(73 primaries screened); geometry error on all 200 pairs: TCA median 0.000 s / p95 0.001 s / max 0.003 s, miss
median 0.7 m / p95 7 m / max 11 m; 38,190 rows data differs; 12 same-data encounters of ours that SOCRATES does not
list (unexplained, listed in `sameDataSample`).

## `GET /objects/{objectId}`, `POST /objects` [v2] [spec SpaceObject.kind / maneuverability, ROOM-14]
`POST` body `{ objectIds: ObjectId[] (≤ 1000) }` → `{ snapshotId, rule, objects: Record<ObjectId, ObjectInfo>, missing }`.
```ts
interface ObjectInfo { objectId; name; kind: "payload" | "debris" | "rocket_body" | "unknown";
  maneuverability: "maneuverable" | "non_maneuverable" | "unknown";
  classificationBasis: string; operationalStatus: string | null;   // SATCAT code from the SOCRATES names
  group: string; simulated: boolean }
```
Rule (objects.py, O23): simulated → payload/maneuverable (demo only); name token DEB/DEBRIS or a debris group →
debris/non_maneuverable; R/B → rocket_body/non_maneuverable; active/stations/gnss → payload, SATCAT "-"/"D" →
non_maneuverable, else unknown. A real object is never "maneuverable": public data has no propulsion field.
