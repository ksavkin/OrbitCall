# Decisions (O1–O32) and why

Each design question was answered independently by two reviewers. A choice was accepted where both chose the same
and justified it. Where they disagreed, or where both disagreed with the physics, the question was settled by
running code or by the primary source, not by vote.

| # | Question | Options considered | Decision | Why |
|---|---|---|---|---|
| O1 | /candidates schema, ranking | service orders by miss gain per Δv · Convex ranks (Pareto) | Full grid (48) + wait, Δv inputs only, `estimatedFuelKg: null`; a **policy-free** order (`rank`) that Convex may use; Convex chooses the 2–3 shown | Grid, no fuel and "Convex decides" were common ground. Order key from the doc text "largest miss for the least fuel": pair-threshold pass, least Δv, largest miss, latest burn |
| O2 | missAfterKm | re-propagate both with SGP4 after the impulse | **Accepted**: SGP4 on the moved trajectory, refined minimum near TCA, `indicative: true` | Agreement |
| O3 | Impulse on a TLE | state vector + least-squares refit · edit n and M at epoch · osculating elements → SGP4 init | **Differential re-epoch** (impulse.py, track.py) | Measured (`tools/compare_impulse.py`, 4 real orbits, Δv 0.1 m/s): the n/M edit jumps 180–207 m at the burn (≈ Δa); osculating → SGP4 init jumps 7.5–9.9 km; the differential re-epoch 0.1–0.6 m with Δv exact. A refit was not needed |
| O4 | /rescreen input + algorithm | add partner + TCA; band prefilter; vectorized coarse sweep; refine | **Accepted**: `partnerObjectId`, `tcaUtc` added; radius-band prefilter ±30 km; 60 s coarse steps with a linear closest-approach estimate (margin 10 km); bounded refinement. Horizon starts at the burn | EXE-2 screens "the moved satellite", which differs from the catalog orbit only after the burn; deterministic. Soundness tested against a 2 s brute force (tests/test_rescreen.py) |
| O5 | /verify input + method | burn time added; plain median(post) − median(pre) | Burn time added; **drag-trend-corrected** step (Theil–Sen on pre-burn sets); robust z; ≥ 8 sets, ≥ 4 each side; σ floor 10 m | Measured (`tools/compare_verify.py`, ISS drag 55 m/day from NASA's OEM): the plain median step is biased −200 m, −57% of a 0.2 m/s burn (a false "mismatch"); the trend-corrected step is unbiased (+0.6%). Floor 10 m (conservative z) |
| O6 | Replay evidence without gp_history | labeled simulated series anchored to a real reboost · NASA ISS OEM first | **Labeled simulated replay** with a real drag trend from NASA's OEM | Primary source checked: NASA's current ISS OEM (2026-10-21..11-05) is public but contains no reboost (only decay ~55 m/day). No real maneuver is available account-free, so the series is labeled simulated (VER-3: "any demonstration agreement is explicitly simulated") |
| O7 | /simulate, SIM in catalog | rotate v about r̂ + phasing, refit | **Accepted**: rotate v about r̂ (3°), small radial offset (0.2 km), fit SGP4 elements by iterating the input state (≤ 1 m), overlay catalog + `data/sim/` persistence | Agreement on geometry. Re-injecting SIM objects from Convex (`extraObjects`) is an open item |
| O8 | TLE vs OMM, ids | TLE snapshot, OMM parsed too, Alpha-5, skip + record | **Accepted** | Agreement |
| O9 | /screen | build now (needed by /validation) · not in the base build | **Not built in v1** (501) | Priority went to what the deal needs (candidates, rescreen, verify); the queue uses SOCRATES. Open item |
| O10 | Fuel inputs | Δv only, no kg | **Accepted** | Agreement: masses are private (POL-2) |
| O11 | Freshness, provenance | pinned, content-hash id, no runtime fetch | **Accepted**: `snapshotId` = fetch time + sha256 of the files | Agreement |
| O12 | Determinism, tests | inputs only, no wall clock; loose SOCRATES regression | **Accepted**; SOCRATES comparison is TCA-only (epochs differ: SCR-3 "data differs") | Agreement |
| O13 | Runtime | 1 worker, in memory, token; timeouts 15/120/30/10 s | **Accepted**: 1 uvicorn worker, catalog in memory, threadpool + lock | Agreement |
| O14 | Misleading claims | label indicative, no post-burn Pc, no exact Δv/time | **Accepted**: `indicative`, `limitations`, `simulated` on every relevant result | Agreement |

## Found while building
- **Refinement bug**: scipy's bounded Brent has a relative tolerance √eps·|x|; at Unix time (1.8·10⁹ s) it is
  ~27 s, so the search stopped at its first point and returned the nearest sample instead of the minimum (up to km
  off). Fixed by optimizing over the offset from the interval start. Caught by the test that /rescreen and
  /candidates agree on the same maneuver (now to 0.01 km).
- **New conjunctions in dense shells**: the smallest-Δv candidate of the first SOCRATES pair (a Starlink) drifts
  ~10 km along-track in two days and meets other Starlinks under 1 km; without the burn the same encounters are
  7–11 km. /rescreen reports `withoutManeuverKm` for each hit so the room sees the burn caused it. This is the
  EXE-3 refusal working, and why Convex walks the grid order (`selectShown`).

## Review findings, all fixed
Four adversarial review rounds; each finding was checked against the code. One test per finding in
`tests/test_review_fixes.py`.

| Finding | Fix |
|---|---|
| `/simulate objectId` overwrote real objects and wrote outside `data/sim` | `SIM-\d{4}` only, must be new; atomic file write; bad sim files skipped on reload |
| SGP4 errors ignored (moved trajectory, refinement) → fabricated misses or NaN | errors masked to ∞; the moved satellite failing → `PropagationError` → /rescreen refuses with a reason |
| One unmodelable burn killed the whole /candidates grid | per-candidate `failed[]`, the rest returned |
| Partner re-encounters after ±10 min were never screened | the partner stays in the screen; only the original encounter is filtered out; one hit per encounter |
| Without `tcaUtc` the pair was searched over ±36 h around the burn | whole horizon from the burn |
| `simulated` ignored a SIM partner | moved or partner |
| `/verify` on an unknown object returned a result | 404 (unless a replay for that object is named) |
| `/snapshot` named only the `active` URL | one source per group file |
| Edge inputs: non-ASCII token → 500, self-pair, `smaKm: 0`, `deltaAKm: 0`, series + replay, non-string replay, negative horizon, far-future times, non-converging SIM fit | 401 / 400 for each |
| `meanMotionRevPerDay: 0` → ZeroDivisionError 500 | 400 |
| `withoutManeuverKm` refinement could raise → 500 | `null` (informational; verdict unaffected) |
| /rescreen accepted negative/huge Δv and any direction string | 400: Δv ∈ (0, 1], direction literal |
| /simulate added the object before fallible steps | added last |
| SIM id exhaustion → StopIteration 500 | 400 |
| ±120 s post-burn window too narrow for slow co-orbital pairs | ±600 s |
| Empty grid after `notBeforeUtc` unexplained | note in `assumptions` |
| /verify accepted any direction / kind | 400 |
| /health blocked behind a 2-minute /rescreen (shared lock) | copy-on-write catalog; lock only around /simulate; test: /health < 1 s during a /rescreen |
| /simulate ignored the target's SGP4 error | 400 |
| Corrupt replay file → 500 | treated as not available (404) |
| A flagged encounter whose refinement fails was silently dropped (possible false pass) | the re-screen refuses with the reason |
| Unbounded `tiltDeg` / `missKm` | (0, 10] / [0.05, 5] |
| "every endpoint is deterministic" overbroad | contract scoped: all but /simulate |
| Lazy `SatrecArray` cache could go stale under copy-on-write | removed (nothing used it) |
| Unrefinable flagged encounters could refuse on the 8–11 km fringe | near an encounter the relative acceleration is the gravity gradient (radial coefficient 3n²), so the linear estimate over 30 s is good to ~18 m at 11 km; refuse only within threshold + 2 km, list the rest in `limitations` |
| `kind` contradicting the evidence | 400; one implausible element set is ignored and listed, not a 400 |
| Duplicate `uncovered` lines | one per object |
| `simulated` in /verify was client-settable | taken from the catalog or the replay file only |

Not changed (low): a missing `fetched_at.txt` gives `takenAt: ""` (the pinned snapshot always has it); a crash
between the SIM file write and the in-memory add leaves the SIM on disk — a retry gets "already exists", a restart
reloads it.

## v2: fleet Run Scan, validation, object kind (team spec of 2026-10-24)
Two independent designs, consolidated, implemented, then reviewed adversarially. Every number below was measured on
the pinned snapshot.

| # | Question | Options considered | Decision | Why |
|---|---|---|---|---|
| O15 | /screen engine and threshold | one-vs-many engine per primary, 5 km, 72 h · exactly 72 h | **Accepted**: the re-screen engine (band prefilter, 60 s linear CA, SGP4 refine), threshold 5 km (SCR-1 = SOCRATES), window default 72 h, allowed (0, 168] h | Convex sends 72 h; tests use shorter windows; nothing depends on 72. Measured: ISS, STARLINK-33969, NUSAT-39, CSS → 20 s |
| O16 | Docked / formation pairs | not events, listed apart · one `persistent` event per interval | **`coLocated` list, not events** (relative speed < 0.1 km/s for one unbroken interval ≥ 1 h) | Measured: without the filter ISS gets 2,599 hits (docked vehicles re-detected every step). An incident starts a two-operator negotiation; a docked vehicle is not one. Disclosed with min distance and a coverage reason. The same rule scopes validation (SOCRATES lists 582 such rows in 72 h) |
| O17 | Event A/B order, dedupe | primary first · canonical by id | **Canonical (catalog number order)** + `primaries` per event | Convex events keep stable A/B across viewers (user-flow §1), so two users' scans must agree. Pairs of two primaries are computed once |
| O18 | Missing primary, timeouts, repeats | partial coverage · 404, deadline, cache | **Partial coverage** with `missingPrimaryIds`; **deadline** (480 s, env `ORBIT_SCREEN_DEADLINE_S`) → `timedOut`, never `complete`; **cache** of 8 identical requests | SCAN-3 asks for partial states, not a failed scan. The deadline keeps Convex's 10 min action limit safe |
| O19 | `spread` | null · object with one source | **SourceSpread with GP only**: `gpMissKm`, `gpEpochUtc`; SupGP fields and min/max null | Spec type SourceSpread (SCR-4) is an object; no SupGP in the snapshot, so no spread is claimed |
| O20 | /validation method | full screen of sampled primaries · pair-centric check around each reference TCA | **Screen-based (detection)** | A pair-centric check cannot miss a pair, so it does not measure detection (prefilter and coarse pass) |
| O21 | Data timestamp (SCR-3) | epoch = TCA − DSE (±43 s), tolerance 60 s | **Accepted**; `eligible` = same-data rows only, `dataDiffers` separate, `recall = matched / eligible`, one-to-one matching | A data difference is neither eligible nor a miss. Only 200 of 38,390 in-scope rows have both element sets equal to SOCRATES' (the snapshot is 6 h younger) |
| O22 | Validation cost and serving | lazy background run + disk cache · prebuilt artifact | **Both**: `tools/run_validation.py` prebuilds; a missing cache starts one background run and GET answers 503 `NOT_READY` + Retry-After; cache key = snapshot id + SOCRATES sha256 + config version | Never blocks a request |
| O23 | kind / maneuverability | name tokens, debris groups, SATCAT status; "operational ≠ maneuverable" | **Rule in objects.py**: simulated → payload/maneuverable (demo); DEB/DEBRIS or a debris group → debris/non_maneuverable; R/B → rocket_body/non_maneuverable (wins over the group); payload groups → payload, SATCAT status "-"/"D" → non_maneuverable, else **unknown**; a real object is never "maneuverable" | Evidence only. A dead payload cannot burn (SATCAT is explicit evidence); the two active-group R/B records are payloads attached to upper stages that cannot maneuver independently |
| O24 | v2 fields of /candidates and /rescreen | all optional, echo; empty allow-list = wait only | **Accepted**: `snapshotId` (409 `SNAPSHOT_MISMATCH` if stale), `evidenceVersion` echo, `allowedMovingObjectIds` (absent = v1, empty = nobody moves), non-maneuverable objects never move (candidates skip, rescreen 400), rescreen `fromUtc` + `toUtc` window from the burn | v1 callers get the same results (tested: 48 candidates) |

## v2.1: jobs and OMM (master roadmap §5, §8, §12)
| # | Question | Decision | Why |
|---|---|---|---|
| O25 | Long work | **Jobs** (jobs.py): /screen and /rescreen validate the request, persist the job to `ORBIT_DATA/jobs/<jobId>.json` **before** replying `{ jobId }` (202), run in a 2-thread pool outside the request thread; `GET /jobs/{jobId}` → status, phase, measured progress/counters, coverage, result + `resultRef`. Caller-named ids (`jobId`, or `screen-<scanId>`) are idempotent; the same id with another body → 409 `JOB_CONFLICT`. A restart marks queued/running jobs `failed` (`SERVICE_RESTARTED`) | Roadmap §5: long jobs run outside the request thread, survive a client timeout, and their status is persisted before acceptance. Two workers, so a Scheduler re-screen never waits behind a fleet scan |
| O26 | Current Convex caller | **Compatibility**: a v1-shaped /rescreen (no `snapshotId`, no `jobId` — what the deal module sends today) and any request with `?wait=1` return the result synchronously | Keeps the current caller working until Convex polls `/jobs`. Deprecated |
| O27 | Real mode | **OMM is the catalog** (`ORBIT_CATALOG_MODE=omm`, default): a pinned CelesTrak GP OMM JSON snapshot of the same six groups (`data/omm/<fetch>/`, manifest with URL, fetch time, sha256, record count; sha256 verified at load), loaded with `sgp4.omm.initialize` — epochs kept as given, never round-tripped through TLE. TLE is the explicit development mode (`ORBIT_CATALOG_MODE=tle`), labeled in the snapshot id; **no silent fallback** (a missing or tampered OMM snapshot stops the service). `GET /snapshot/omm` serves the asset for Convex to store and hand out by URL | Roadmap §8; spec §4.5. The team data has no OMM file, so one snapshot was fetched once |
| O28 | Encounter dedup | **Fixed 60 s window around a fixed anchor** (the first refined TCA of the encounter), no chaining | Roadmap §8: fixed 60 s matching window; never merge separate encounters by chaining nearby matches |
| O29 | Validation scope | **Full eligible scope**: every in-scope row whose element sets equal SOCRATES' is eligible; a covering set of primaries (greedy, deterministic, not guaranteed minimal) is screened against the whole catalog for recall; geometry/time error is measured separately on every eligible pair. The validation snapshot is the TLE snapshot closest to the run; real-mode screening uses OMM | Roadmap §8: full eligible reference scope, geometry/time error separate from recall. The OMM snapshot is 21 h younger than the run, so it would make almost no row comparable |
| O30 | Versions in results | Results echo `snapshotId`, `evidenceVersion` and, when sent, `proposalId`, `revision`, `runId` | Roadmap §5 |

Measured validation (744 s): eligible 200, matched 200, recall 1.0; geometry error on all 200 pairs: TCA median
0.000 s, p95 0.001 s, max 0.003 s; miss median 0.7 m, p95 7 m, max 11 m; 38,190 in-scope rows "data differs";
12 same-data encounters found here that SOCRATES does not list (unexplained, listed in the result).

v2.1 review fixes: `/validation` schema and recall denominator in the contract; a job keeps the catalog view it was
accepted on; co-located only for one unbroken interval ≥ 1 h; `excludedObjects` counts distinct objects; OMM records
without `NORAD_CAT_ID` skipped; an off-by-one in the slow-sample span (n samples span n − 1 steps).

Not done: real verification replay (needs Space-Track history, which needs an account); SupGP spread (SCR-4);
`extraObjects` (SIM objects persist in `data/sim` and reload on restart, so Convex never needs to re-inject them).

## v2.2: docked bodies and the demo geometry (found in a live deal run)
| # | Question | Decision | Why |
|---|---|---|---|
| O31 | ISS modules and visiting vehicles are separate catalog objects (UNITY, ZVEZDA, DESTINY, POISK, NAUKA, …) | **Attached = shares the moved object's element set.** In /rescreen those bodies move with it: excluded from the screen, disclosed in `attachedObjectIds` and `limitations`. The partner is never attached (a partner sharing the moved object's element set is refused as one body); the original miss is the minimum over the partner and its docked bodies. Hits of bodies of one element set at one pass (≤ 60 s, fixed first-hit anchor) collapse into one entry with `attachedObjectIds`, in /rescreen and in /screen events. In /screen a primary's docked bodies are never screened against it; they are listed in `dockedBodies` | An ISS burn re-screen was refused on "new conjunction with ISS (UNITY) at 0.0 km". CelesTrak publishes docked modules and vehicles with the station's elements: all ten ISS bodies have the same epoch and elements, 0.000 km apart over 24 h. A free-flyer always has its own element set, so no proximity heuristic is used (a proximity rule was rejected in review: it would also hide co-orbital free-flyers, a real post-burn threat). If CelesTrak republishes a docked body with its own elements it is screened as a separate object (conservative) |
| O32 | /simulate default geometry refused every cheap candidate on OMM | **Default semi-major axis offset +20 km** (`deltaAKm`, range [-50, 50], 0 = the old co-orbital geometry); a perigee below 200 km (fitted mean elements) is refused | Measured: with Δa 0.34 km and the 3° tilt the SIM met the ISS at every node crossing (every 46 min) with a miss changing ~0.6 km per crossing, so a 0.05 m/s burn just moved the near-zero crossing 4 h later. Real physics of a co-orbital pair, not a model error. With +20 km the pair drifts ~190 km per orbit: one encounter in ±12 h; on a clean catalog the six cheapest passing candidates of both sides passed the 72 h re-screen |
| O33 | Which OMM snapshot in real mode | **The team's snapshot** (`data/snapshots/gp-<time>/` from the team's `scripts/fetch_gp.py`: CelesTrak GP JSON per group + a manifest with per-file sha256), read as is with every file's sha256 verified; the service's **snapshotId is the team's id** (e.g. `gp-20261024T2134Z`), the id Convex stores (`catalog-pairs.json` `omm.snapshotId`). Selection: `ORBIT_SNAPSHOT_ID` if set; else the id recorded in the team's `catalog-pairs.json` (newest build if several); if that snapshot is missing the service refuses to start. The service's own CelesTrak snapshot (`data/omm/…`, `celestrak-omm-…` id) is used only with an explicit `ORBIT_SNAPSHOT_DIR`; there is no silent fallback. `ORBIT_DATA` may point at the team repo's `data/` (SOCRATES from `snapshots/socrates-*/`, TLE from `web/data/snapshot/`; without SOCRATES validation answers 503). Refused: a manifest id that differs from the folder name or is missing, a listed file missing or unreadable, a sha256 mismatch, a broken manifest, an id or file name escaping the snapshot folder | The service and Convex must use the same snapshot and snapshotId; a mismatch (409 SNAPSHOT_MISMATCH) would block every job |
| O34 | Tests that took "the first pair" | The `pair` fixture is a pinned SOCRATES row (63855 × 69019, 2026-10-24 01:58:13.157, 0.600 km), not the first entry of catalog-pairs.json | The team rebuilt catalog-pairs.json (its first pair changed); the suite now passes on both versions of the file |

v2.2 review fixes: /rescreen refuses a `tcaUtc` before the burn; the demo test asserts miss 0.2 km and relative speed
0.40 km/s.
