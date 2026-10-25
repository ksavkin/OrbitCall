# Orbital service (Python)

The numerical service of the master roadmap (§5, §7, §12): the orbital math Convex cannot do. Only Convex calls it,
with a service token; the browser never does. It computes candidate maneuvers, screens the assigned fleet against the
catalog, re-screens a planned maneuver, checks maneuvers against element sets, classifies objects
(kind / maneuverability), measures validation against SOCRATES, and builds the demo satellite.

The deal module works without it for simulated events (demo provider) and refuses to invent numbers for real events
(`UPSTREAM_UNAVAILABLE`).

Code: [`orbit-service/`](orbit-service/). HTTP contract (v2.1 plus the [v2.2] and [v2.3] additions): [`orbit-service/docs/contract.md`](orbit-service/docs/contract.md).
Why each choice (O1–O34): [`orbit-service/docs/decisions.md`](orbit-service/docs/decisions.md).
Owner: the numerical-service owner (roadmap §15 work areas).

## Where it goes
`services/orbit/` in the OrbitCall repo (roadmap §12 repository layout): copy the content of `orbit-service/` there as
is. Deployment (roadmap §12 deployment map): a Python container on the DigitalOcean Droplet, behind Caddy (HTTPS,
explicit route), with a **persistent volume** for the data folder — the team's pinned snapshots, the job records and
the simulated satellites. Convex reaches it at its HTTPS URL.

## What it does
| Endpoint | For | How |
|---|---|---|
| `POST /candidates` | Incident Analyst (AGT-2) | The grid A/B × T−12/6/3 h × 0.02–0.2 m/s × pro/retrograde (up to 48) with the SGP4 miss distance after each burn, plus wait. No fuel: masses are private. Optional `snapshotId`, `evidenceVersion`, `allowedMovingObjectIds`; a non-maneuverable object never moves |
| `POST /rescreen` → job | Maneuver Scheduler (EXE-2/3) | The moved satellite against the whole catalog for 72 h from the burn: pass when the pair stays ≥ 1 km and nothing else comes within 1 km. Bodies sharing the moved object's element set (docked modules and vehicles) move with it and are listed in `attachedObjectIds`. About 15–20 s for the catalog |
| `POST /screen` → job | Fleet Run Scan (SCR-1, SCAN-1..3) | Each assigned primary against the whole catalog, 5 km, 72 h; canonical A/B; 60 s matching window; docked bodies (same element set) listed in `dockedBodies`, co-located pairs in `coLocated`; coverage, `missingPrimaryIds`, deadline 480 s. Four primaries ≈ 18 s |
| `GET /jobs/{jobId}` | Job status | Persisted before acceptance; status, phase, measured progress, counters, coverage, result |
| `POST /verify` | Maneuver Verifier (VER-1..4) | Step of the semi-major axis across element sets, drag trend removed, robust z ≥ 5, ≥ 50 m, right sign and ±50% size; fewer than 8 sets → awaiting data |
| `GET /validation` | Reference coverage (SCR-3, SCR-8) | Recall over the full eligible SOCRATES scope (rows whose element sets equal SOCRATES'), geometry/time error measured separately; cached, 503 `NOT_READY` while computing |
| `GET /objects/{id}`, `POST /objects` | kind / maneuverability (ROOM-14) | Evidence only (names, debris groups, SATCAT status); a real object is never reported "maneuverable" |
| `POST /simulate` | `demo.launchSatellite` (DATA-7, SCR-10) | A simulated satellite on a near-miss course with a chosen target (plane tilted 3°, semi-major axis +20 km by default, so there is one encounter); it joins the catalog |
| `GET /snapshot`, `GET /snapshot/omm`, `GET /health` | Provenance and the OMM asset | The team's pinned OMM snapshot (`gp-20261024T2134Z`, 19,468 objects), its manifest and the team's snapshotId, the same id Convex stores; `/snapshot/omm` serves the catalog for Convex to store and hand to browsers by versioned URL |

Every request except `/health` needs the `X-Service-Token` header. Units: km, km/s, m/s for Δv; ISO 8601 UTC times.
Results echo `snapshotId`, `evidenceVersion` and, when sent, `proposalId`, `revision`, `runId`.

**Jobs.** `POST /screen` and `POST /rescreen` validate the request (400 / 404 / 409 at once), persist the job, then
answer `202 { jobId, status, created, statusUrl }`; Convex polls `GET /jobs/{jobId}` with bounded requests (roadmap §7
user-command pattern). A caller-named `jobId` (default `screen-<scanId>` for scans) makes a resubmit idempotent; the
same id with another body is 409 `JOB_CONFLICT`. A restart marks unfinished jobs `failed` (`SERVICE_RESTARTED`).

## Which snapshot (decisions O33, O34)
Real mode reads **the team's pinned OMM snapshot**, the folder `snapshots/gp-<time>/` that the OrbitCall repo's
`scripts/fetch_gp.py` writes (CelesTrak GP JSON per group plus `manifest.json` with the sha256 of every file), as is:
every file's sha256 is checked at load and the manifest's `snapshotId` must equal the folder name. The service then
reports **the team's snapshotId** (e.g. `gp-20261024T2134Z`), the id Convex stores (`catalog-pairs.json`
`omm.snapshotId`) and the web serves (`/snapshots/gp-20261024T2134Z/catalog.json`). So the service and Convex speak of
one catalog, and a job that names a snapshotId is not refused with 409 `SNAPSHOT_MISMATCH`.

- Selection: `ORBIT_SNAPSHOT_ID` if set; else the id recorded in the newest `snapshots/socrates-*/catalog-pairs.json`
  (`omm.snapshotId`); only when no id is recorded anywhere, the newest `snapshots/gp-*`.
- If that snapshot is missing, or a file is missing, unreadable or fails its sha256, the service **refuses to start**
  (e.g. `SnapshotMissing: the snapshot Convex uses (gp-…) is not under /service/data/snapshots`). There is no silent
  switch to another catalog.
- The service's own CelesTrak fetch (`omm/2026-10-24T225229Z/`, 19,473 objects, id `celestrak-omm-…`) is used only
  when `ORBIT_SNAPSHOT_DIR` names it explicitly.
- When the team takes a new snapshot and rebuilds `catalog-pairs.json`, rerun `setup-data.sh` and restart the service:
  it follows the id recorded there.
- The tests pin their SOCRATES pair (63855 × 69019, 2026-10-24 01:58:13.157, 0.600 km) instead of taking the first
  entry of `catalog-pairs.json`, which the team rebuilds; they pass on both the earlier and the current team data (O34).

## Layout
| Path | What |
|---|---|
| `orbit-service/src/orbit/` | FastAPI app (`app.py`), jobs (`jobs.py`), the physics (`candidates.py`, `rescreen.py`, `screen.py`, `verify.py`, `validation.py`, `objects.py`, `simulate.py`, `impulse.py`, `track.py`, `conjunction.py`, `catalog.py`) |
| `orbit-service/src/tests/` | pytest suite (92 tests), reads the data folder at `../data` (`/service/data` in the image) |
| `orbit-service/src/tools/` | the measurements behind decisions O3 and O5, the replay builder, `run_validation.py` |
| `orbit-service/data/omm/<fetch>/` | the service's own CelesTrak GP **OMM** fetch (six groups, 19,473 objects, fetched 2026-10-24T22:52:29Z, manifest with sha256 checked at load): an alternative used only with an explicit `ORBIT_SNAPSHOT_DIR`, and read by the tests. Real mode uses the team's snapshot |
| `orbit-service/data/replay/` | NASA's public ISS ephemeris (OEM, sha256 in the meta file) and the **simulated** reboost replay built from it, labeled simulated |
| `orbit-service/data/validation/` | the cached `/validation` result (rebuilt by `tools/run_validation.py`, ~12 min) |
| `orbit-service/setup-data.sh` | builds the data folder: the OrbitCall repo's snapshot files plus the files above |
| `orbit-service/Dockerfile` | python 3.12-slim, pinned requirements, code only; the data folder is the volume |

## Data folder (`ORBIT_DATA`, the persistent volume)
| Path | Source |
|---|---|
| `snapshots/gp-*/` | OrbitCall `data/snapshots/gp-*/`, verbatim: the team's pinned OMM snapshots (`gp-20261024T2134Z`: six groups, 19,468 objects, taken 2026-10-24T21:34:21Z). Real mode reads the one named by `catalog-pairs.json` |
| `snapshots/socrates-*/` | OrbitCall `data/snapshots/socrates-*/`, verbatim (`catalog-pairs.json`, `manifest.json`, `socrates.csv.gz`): the pinned SOCRATES run for `/validation`, SATCAT status and the snapshot id |
| `snapshot/*.tle`, `snapshot/fetched_at.txt` | OrbitCall `web/data/snapshot/` (TLE groups, 18,589 objects, fetched 2026-10-24T08:02:43Z): the explicit development mode and the validation snapshot |
| `snapshot/socrates.csv.gz`, `snapshot/socrates-manifest.json` | a copy of the newest SOCRATES run, read only by the test suite |
| `omm/`, `replay/`, `validation/` | this package (`validation/` holds the cached result for exactly these TLE files and this SOCRATES run, so `/validation` answers at once) |
| `jobs/`, `sim/` | written at runtime: job records and simulated satellites |

```bash
cd orbit-service
./setup-data.sh /path/to/OrbitCall /srv/orbit-data      # or no second argument: fills ./data in place
# /srv/orbit-data: OMM snapshot gp-20261024T2134Z (as recorded in socrates-20261024T0147Z/catalog-pairs.json) | ...
```
Exit 0 done · 64 bad arguments (or a target inside the checkout) · 65 a required repo file is missing, including the
snapshot that `catalog-pairs.json` names. The folder must be writable: the service writes `jobs/`, `sim/` and
`validation/` into it. Pointing `ORBIT_DATA` at the OrbitCall repo's `data/` directly also loads (SOCRATES from
`snapshots/socrates-*/`, TLE from the repo's `web/data/snapshot/` or `ORBIT_TLE_DIR`; without SOCRATES `/validation`
answers 503), but the service then writes its job records into the checkout, the simulated replay is absent and the
validation is recomputed (~12 min); use it for a quick local look, not for deployment. A read-only mount of the team
data is not supported.

## Run
```bash
cd orbit-service
./setup-data.sh /path/to/OrbitCall /srv/orbit-data
docker build -t orbitcall-orbit .
docker run -d --name orbitcall-orbit -p 127.0.0.1:3610:3610 \
  -e ORBIT_SERVICE_TOKEN=<choose a token> -v /srv/orbit-data:/service/data orbitcall-orbit
curl http://127.0.0.1:3610/health      # {"ok":true,"snapshotId":"gp-20261024T2134Z","objects":19468}
docker exec orbitcall-orbit python -m pytest -q -p no:cacheprovider tests      # 92 passed (about 2 min)
```
A smoke check of the two calls the deal module makes (token as chosen above):
```bash
T='X-Service-Token: <token>'; J='Content-Type: application/json'; U=http://127.0.0.1:3610
curl -s -H "$T" -H "$J" -X POST $U/candidates \
  -d '{"objectA":"63855","objectB":"69019","tcaUtc":"2026-10-24T01:58:13.157Z"}'          # 48 candidates + wait
curl -s -H "$T" -H "$J" -X POST $U/rescreen -d '{"jobId":"smoke-1","objectId":"63855","partnerObjectId":"69019",
  "tcaUtc":"2026-10-24T01:58:13Z","maneuver":{"burnTimeUtc":"2026-10-23T13:58:13Z","deltaVMs":0.02,"direction":"retrograde"}}'
                                                       # 202 {"jobId":"smoke-1","status":"running",...}
curl -s -H "$T" $U/jobs/smoke-1                        # poll until "status":"completed" (about 20 s)
```
On the Droplet, Caddy terminates HTTPS and proxies one explicit route to port 3610; do not publish 3610 publicly.
Without Docker: Python 3.12, `pip install -r src/requirements.txt`, then from `src/`:
`ORBIT_DATA=/srv/orbit-data ORBIT_SERVICE_TOKEN=… python -m uvicorn orbit.app:app --port 3610 --workers 1`.
The tests always read `orbit-service/data` (fill it with `./setup-data.sh /path/to/OrbitCall`), then
`python -m pytest -q tests` from `src/`.

Keep one process: the catalog lives in memory, jobs run in its thread pool and `/simulate` changes the catalog.

| Service env | Meaning | Default |
|---|---|---|
| `ORBIT_SERVICE_TOKEN` | the token Convex sends | required |
| `ORBIT_DATA` | the data folder | `/service/data` in the image |
| `ORBIT_CATALOG_MODE` | `omm` (real mode) or `tle` (explicit development mode, labeled in the snapshot id; no silent fallback) | `omm` |
| `ORBIT_SNAPSHOT_ID` | the team snapshot to load (`snapshots/<id>/`) | `omm.snapshotId` of the newest `snapshots/socrates-*/catalog-pairs.json` |
| `ORBIT_SNAPSHOT_DIR` | an explicit OMM snapshot folder, absolute path, e.g. the service's own fetch `/service/data/omm/2026-10-24T225229Z` (`ORBIT_OMM_DIR` is the older name) | unset |
| `ORBIT_SOCRATES_DIR` | the SOCRATES run folder | the newest `snapshots/socrates-*` |
| `ORBIT_TLE_DIR` | the TLE groups | `snapshot/`, else the repo's `web/data/snapshot/` next to `data/` |
| `ORBIT_SCREEN_DEADLINE_S` | a fleet scan stops with a partial, labeled result | 480 |
| `ORBIT_JOB_WORKERS` | job threads (a re-screen never waits behind a scan) | 2 |

## Connect Convex
Set in the Convex deployment (values typed by a human, never committed):
```bash
npx convex env set ORBIT_SERVICE_URL       # the Caddy HTTPS URL of the service
npx convex env set ORBIT_SERVICE_TOKEN     # the token the service was started with
```
Suggested Convex action timeouts: `/candidates` 15 s, `/rescreen` 120 s (or poll the job), `/verify` 30 s,
`/simulate` 10 s, `/screen` submit 5 s then poll, `/validation` 5 s, `/objects` 5 s.

What the deal module sends today:
- `/candidates` synchronously, with `notBeforeUtc` = now, so no burn in the past is offered, and
  `allowedMovingObjectIds` when only one object may move (a debris room: only the active satellite);
- `/rescreen` as a **job**: `jobId` = `rescreen-<claim key>-a<attempt>` from the Scheduler (the reserved intent, so a
  retry of the same attempt reuses the job), or a random id for the re-screens done before cards are shown; it sends
  `objectId`, `partnerObjectId`, `tcaUtc`, the maneuver, `proposalId` and `revision` (echoed), then polls `GET /jobs/{jobId}` every 1 s for up to
  240 s (a failed or unfinished job becomes `UPSTREAM_UNAVAILABLE` and the Scheduler retries);
- `/verify` synchronously.

It maps the answers to the spec's `Revision`, `Rescreen` and `Verification` shapes and drops the extra diagnostics. It
does not send `snapshotId`, `evidenceVersion` or `fromUtc` / `toUtc` yet, and sends `allowedMovingObjectIds` only on
`/candidates` for debris. Until Convex sends `snapshotId`, the service makes no 409 `SNAPSHOT_MISMATCH` check; it
echoes the id it used in every result, which Convex can compare with its own. Run Scan
(`scans.startMine` → `POST /screen` + `GET /jobs`), `validation.latest` (→ `GET /validation`) and object
classification (→ `/objects`, the input of `deal/rooms:open` for debris) are the team's backend functions to write.

## Limits (say them in the pitch)
- Public mean elements: SGP4 positions are good to about 1 km, so a 1 km threshold is at the method's resolution.
  Everything is labeled indicative; this is not flight-safety screening.
- No probability of collision is computed, and no post-maneuver Pc.
- The verification replay is simulated: no account-free source has element sets around a real recent maneuver
  (Space-Track history needs an account).
- Validation is measured on the 200 in-scope SOCRATES rows whose element sets equal ours (recall 200/200, TCA error
  p95 0.001 s, miss error p95 7 m); the other 38,190 rows are reported as "data differs", not as misses.
- One orbit source (CelesTrak GP): no SupGP spread (SCR-4).
- `/validation` is measured on the TLE validation snapshot (08:02:43Z, 6 h after the SOCRATES run), not on the OMM
  snapshot of real mode (21:34Z, 20 h after it), whose element sets would make almost no SOCRATES row comparable.
- The deal module sends `/rescreen` as a job but does not send `snapshotId`, `evidenceVersion` or `fromUtc` / `toUtc`
  yet; `allowedMovingObjectIds` goes only with `/candidates` for debris rooms (see "Connect Convex").
- Not done here: the move into `services/orbit/` of the OrbitCall repo and the DigitalOcean deployment (roadmap §12).
