# Phase 1 — Kostya's plan

> Current product decisions: [assigned-fleet workflow](../../user-flow.md) and [integration handoff](../../integration-status.md). Dev on is TLE/simulation; Dev off requires OMM and has no TLE fallback. The old Phase 1 fallback/global-queue descriptions below are implementation history, not the latest real-mode contract. Fleet scope, new sorting, selection/approval and unilateral debris are accepted follow-up requirements.


Task source: [issue #1](https://github.com/ksavkin/OrbitCall/issues/1), "Phase 1 — tasks", Kostya's block. Frontend contract: [specification.md](../../specification.md). Behavior: [functionality.md](../../functionality.md). Library and source pitfalls: `docs/research/code-reuse.md` (referenced research note is not included in this repository).

Status: plan only, no code yet. Written Oct 24, 2026, ~04:40 PDT; cross-checked against an independent plan by an Opus outside voice (section 10).

## Updates, Oct 24 ~05:20 PDT — these override the sections below

- **Schema (section 5) is replaced** by the normalized schema in PR #3: `convex/schema/data.ts` (`snapshots`, `spaceObjects`, `events`) and `convex/schema/agents.ts` (`agentRuns`). Store each fact once and only what Phase 1 uses; derive the rest in queries. No new tables or fields without a reason a Phase 1 query needs. No `config` table, no `analystRequestedAt`, no `raw`, `origin`, `pairKey`, `demoRunId`.
- **Layout (D1):** the Convex backend is a separate package at the repo root (`package.json` `orbitcall-backend`, `convex/`, `tests/`, vitest, CI on Node 22). The Next.js app is its own package in `web/`.
- **Andrew's analyst is merged** (PR #2 inside PR #3). `events.ingest` stores one encounter and schedules the analyst; `agentSummaries.get` serves the checked summary without sign-in (D3); `agents.rerun` is internal. `convex/lib/events.ts` builds `EventFacts` from the tables.
- **Step 2 is smaller:** Adil already committed GP (TLE), SATCAT and owner names in `web/data/snapshot/` (fetched 2026-10-24T08:02:43Z). Only SOCRATES is downloaded, once. Metadata comes from Adil's `satcat.csv`.
- **D11:** the globe keeps Adil's TLE pipeline; `catalog.snapshot` returns `ommUrl: null` and the GP source URL as `gpUrl` (spec §3.2 dual ingest).
- **D12:** the shared deployment is the project's prod deployment (`npx convex deploy`, loads with `--prod`). The analyst model is `claude-sonnet-5-5`; Kostya sets `ANTHROPIC_API_KEY` there himself.
- **Step 6 safeguards without a table:** the recolor cron starts the analyst for at most the top 3 red catalog events (`ANALYST_TOP_K` in code), only when the latest run for the current evidence is missing; env `ANALYST_AUTOSTART=false` turns autostart off. Failed runs are not retried automatically.
- **D14:** no `events.get`; the summary is read through `agentSummaries.get`.

---

## 1. Goal

"Done when" from the issue: Adil's globe and queue run on real data, a red event gets a checked summary, and everything is merged into `main`.

My part of that:

| What | Why | Unblocks |
|---|---|---|
| Convex project and `convex/schema.ts` (with Andrew) | One database that the screens and the agents subscribe to | Everyone |
| CelesTrak snapshot (GP, SupGP, SOCRATES, SATCAT) in `data/snapshots/` | The demo runs on pinned real data; CelesTrak bans IPs for repeated downloads | Adil (the file), Phase 3 (validation, GP/SupGP spread) |
| Metadata: owner, country, launch date | Event card, the future Coordination Host | Adil (queue), Andrew (summary) |
| `catalog.snapshot` | Returns the link to the OMM file the globe is drawn from | Adil (globe) |
| SOCRATES pairs in `events` + `events.catalogPairs` | A queue of real pairs | Adil (queue) |
| An event turning red calls `agents.analyst.start` | The bridge to Andrew's agent | Andrew (summary), "Done when" |
| `events.get` (spec addition, D14) | Without it the analyst summary has nowhere to be shown: `EventRow` has no summary | Adil, "Done when" |
| Stretch: `orbit-service/` with `/screen` (SGP4) | Our own screening instead of someone else's list | Phase 2 (simulated satellite), Phase 3 (validation) |

---

## 2. What Kostya needs to provide or decide

| # | What | Why |
|---|---|---|
| H1 | Log into Convex (`npx convex login` opens a browser), create the team and project, invite Andrew and Adil | Login is interactive only; without a project nobody has a deployment |
| H2 | Agree with Adil: who creates the root `package.json` and the Next.js app, one package manager and lockfile, whether `convex/_generated` is committed (I propose yes) | Two scaffolds at the root collide; without `_generated` in the repo, typecheck fails unless `convex dev` is running |
| H3 | Agree the contract in section 6 with Andrew | My trigger calls his function; he reads my event fields |
| H4 | Pick the shared deployment (D12) | Convex gives every team member their own empty dev deployment: data I load, Adil won't see in his |
| H5 | Pick the metadata source (D5) | KeepTrack needs a key and gives purpose; SATCAT needs no key but has no purpose and no owner company |
| H6 | Approve committing ~40 MB of CelesTrak snapshots to the public repo (D6) | Reproducibility; CelesTrak allows it, Space-Track does not (we don't touch Space-Track in this phase) |
| H7 | Say whose session "OrbitCall dev branch setup" is and what it is doing | If it is already scaffolding the repo or a branch, step 1 changes |
| H8 | Download only from your machine, once | CelesTrak limits: 100 MB/day and 50 errors per 2 h per IP; the venue IP is shared |
| H9 | Request a Space-Track account now (for Phase 3, not this one) | Epoch-matched SOCRATES validation needs `gp_history`; the approval delay is unknown |
| H10 | Put the Anthropic key into the shared deployment's env (`npx convex env set ANTHROPIC_API_KEY …`) or give Andrew access | Andrew's analyst runs inside the same deployment |

---

## 3. Default decisions (where the docs conflict)

Where the docs disagree or are silent, and what I do unless you say otherwise.

| # | Question | Default | Why |
|---|---|---|---|
| D1 | Repo layout | One Next.js project at the repo root, `convex/` at the root next to `package.json`. Merge order: scaffold (Adil or me) → schema → Andrew's stub | Standard Convex + Next layout; parallel `_generated` changes conflict |
| D2 | Who does what | Follow issue #1 (Kostya: Convex and data; Andrew: agents). The role table in plan-v1 §13 is outdated | The issue is newer |
| D3 | Authentication in Phase 1 | `catalog.snapshot`, `events.catalogPairs` and `events.get` are open without sign-in. Phase 2 adds `requireUser` | Spec §1 requires an identity everywhere, but sign-in arrives only in Phase 2. A deliberate temporary gap; catalog data is public |
| D4 | Does SOCRATES `MAX_PROB` count as the probability for color | Yes, labeled `metric: "max_prob"`, `source: "socrates"` | Spec §2.2 `Pc` allows it, SCR-2 allows a "labeled SOCRATES value". It is an upper bound, not a CDM Pc — a product decision to confirm with the team. CDMs (Space-Track) come in Phase 3 |
| D5 | Metadata | CelesTrak SATCAT, no key: `OWNER` → `country` (a country or organization code, not a company), `LAUNCH_DATE`, `OBJECT_TYPE`, `DECAY_DATE`. `purpose` = null. `ownerName` = null, except a small labeled name-prefix table (STARLINK → SpaceX) with its source marked. KeepTrack `/v4/sats/brief` only if we get a key | No key, no limits. Looping KeepTrack per object = ban. Name prefixes are not used for same-fleet exclusion |
| D6 | What to commit | GP active JSON raw (for the globe, D11); SOCRATES/SupGP/SATCAT as `.gz` plus `manifest.json` | A raw 22 MB SOCRATES file bloats git history forever |
| D7 | Red trigger on real pairs | Yes: the analyst runs for a red catalog pair, without a room. The pair stays in status `new`; `agentsWorking` shows that the agent is running | Q-3 and the issue want the agent on red; spec §3.2 forbids rooms for catalog pairs; status `agents` implies a room and proposals that don't exist. Rooms belong to Phase 2 incidents |
| D8 | Color depends on "now", but the snapshot is frozen | Color is stored on the event, set by the import and by a Risk Monitor cron every 5 minutes. Queries never compute color | §20 Q2: 5-minute cadence. A query using `Date.now()` is cached and does not rerun as time passes; the spec says only the backend sets color |
| D9 | Which SOCRATES pairs to load | An offline filter relative to the snapshot's `FILE_MTIME` (not the current time): `MAX_PROB ≥ 1e-5` plus the top 200 by `TCA_RANGE`, decayed objects removed, deduped by pair and \|ΔTCA\| ≤ 60 s, at most 1000. The full file stays in the repo | ~22 MB, on the order of 100k+ rows — above Convex limits (16k writes, 32k scans per transaction; 5 MiB arguments for Node actions). Filtering on `FILE_MTIME` makes reruns produce the same output |
| D10 | Branches | `kostya/convex-schema` (with Andrew), `kostya/data-snapshot`, `kostya/catalog-events`, each a PR into `main` | The issue's rule (plan-v1's "one branch, main" is outdated) |
| D11 | Where the globe's OMM file lives | Served statically by Next: the file in `public/snapshots/<id>/gp-active.json`, `ommUrl` returns that path. Until the app exists, Adil reads the file from the repo directly | Spec Appendix A puts it in Convex file storage, but the free plan's egress is 1 GB/month — about 120 loads of 8 MB. Vercel's CDN compresses. **Spec deviation — raise with the team** |
| D12 | Shared deployment | The project's prod deployment is shared: code goes there with `npx convex deploy` from `main`, data with the same load script plus `--prod` (flag to verify). Everyone keeps their own dev deployment for experiments and can load the snapshot into it with the same script | Otherwise the data lands in my dev deployment while the frontend and Vercel point elsewhere, or the Anthropic key is missing there |
| D13 | Empty and zero `MAX_PROB` | Empty → `null` ("unavailable"); `0` from the source → `0`, labeled with its source | Spec: missing is `null`, never `0`. A real zero from the source is a value |
| D14 | Where the frontend reads the analyst summary | A new query `events.get({ eventId })` → `EventRow` + `summaryLines` + `numbersChecked`. **Spec addition** | `EventRow` has no summary; `RoomState` is `null` for catalog pairs; `IncidentDetail` is behind sign-in |
| D15 | Past TCA | The cron sets `active: false`; the event leaves `catalogPairs`, its history stays | The spec has no status for this, and by Sunday there will be many such events |

---

## 4. Steps in dependency order

Critical path to "Done when": 0 → 1 → 2 → 3 → 4 → 5 → 6. Steps 1 and 2 run in parallel.

### Step 0. Agreements (H1–H4, H7)

Step 1 cannot start without H1, H2 and H4. The H3 contract is needed before step 6.

### Step 1. Convex project and schema — branch `kostya/convex-schema`

1. Root `package.json` with `convex` (unless Adil's scaffold does it), `npx convex dev` → dev deployment, `.env.local` in `.gitignore`.
2. First check that the Convex CLI works on Node 26; if not, use Node 22.
3. `convex/schema.ts` assembles tables from `convex/tables/data.ts` (mine) and `convex/tables/agents.ts` (Andrew's), so we don't edit one file. Draft in section 5.
4. A stub `convex/agents/analyst.ts` with `start` per the contract in section 6 — Andrew replaces the body later.
5. PR → merged first, then `npx convex deploy` to the shared deployment (D12).

### Step 2. Data snapshot — branch `kostya/data-snapshot`

Script `scripts/fetch_snapshot.py` (Python 3.12, stdlib only, `uv run`). One pass, no retries. Never download from Convex actions: they run from shared cloud IPs.

| File | URL | Size |
|---|---|---|
| GP active | `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json` | ~7–8 MB |
| SupGP | `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json` (+ `oneweb`, `planet`) — downloaded in the same session so the epochs line up, not processed | ~5 MB starlink |
| SOCRATES | the file name from `https://celestrak.org/SOCRATES/jsonDir.php` (currently `sort-minRange.csv`; confirm the path when downloading) | 22.1 MB, `FILE_MTIME 2026-10-24 01:47:21 UTC` |
| SATCAT | `https://celestrak.org/pub/satcat.csv` (confirm when downloading) | unknown |

Rules:
- Any status other than 200 stops the run. Check the body's shape: JSON starts with `[` and parses into an array; CSV has the expected header. CelesTrak serves HTML error pages with HTTP 200. No retries.
- `data/snapshots/<snapshotId>/manifest.json`: per file — source (`SourceName`), URL, `fetchedAt`, HTTP status, bytes, sha256, record count; `FILE_MTIME` for SOCRATES; the latest `EPOCH` for GP. The snapshot's `takenAt` = GP download time; the SOCRATES run time is kept separately (they differ by about 10 hours).
- OMM only, no TLE (DATA-6). Object IDs are always strings, without leading zeros (9-digit IDs).

PR → merge. Right after that Adil gets the GP JSON path and can draw the globe without waiting for Convex.

### Step 3. Measure before building the trigger

The same `build_catalog_pairs.py` (step 4) first prints:
- total SOCRATES rows;
- rows with `MAX_PROB > 1e-4` and TCA < 72 h from `FILE_MTIME` — **whether there will be any real red events at all** (risk R1);
- how many SOCRATES IDs are missing from GP active (it holds only active objects, while SOCRATES includes debris) — how many pairs the globe can't draw.

Steps 5–6 depend on these numbers.

### Step 4. Offline event build

`scripts/build_catalog_pairs.py` (stdlib). A pure function of the committed files and a config, no system clock:
- Reads the SOCRATES CSV: `NORAD_CAT_ID_1, OBJECT_NAME_1, DSE_1, NORAD_CAT_ID_2, OBJECT_NAME_2, DSE_2, TCA, TCA_RANGE, TCA_RELATIVE_SPEED, MAX_PROB, DILUTION`. Converts TCA to ISO with `Z` (check the source format).
- Filter and dedupe per D9; the pair key is the unordered ID pair (§20 Q8).
- Joins SATCAT for objects in the selection; decayed ones (`DECAY_DATE` set) are dropped. An `ommAvailable` flag per object.
- Writes `data/snapshots/<id>/catalog-pairs.json`: `{ snapshotId, sourceSha256, filter, counts, pairs[], objects[] }`. The file is committed, so a rerun shows up as a diff.

### Step 5. Load and queries — branch `kostya/catalog-events`

- `scripts/load_snapshot.sh`: reads `catalog-pairs.json` and sends batches of 200 rows to the internal mutation `ingest.upsertBatch` via `npx convex run` (`--prod` for the shared deployment, D12). No public mutations for loading. Check on the first run that `npx convex run` can call internal functions.
- `upsertBatch`: upsert by `pairKey` + \|ΔTCA\| ≤ 60 s. A repeated load keeps the `_id`s and never starts the analyst again. We don't use `npx convex import --replace`: new `_id`s would orphan Andrew's `agentRuns`, and the color logic would not run.
- At the end of the load: `register` the snapshot and call `recolor` (step 6).
- `catalog.snapshot` (query): the current snapshot → `{ snapshotId, takenAt, ommUrl, sources }` per spec §3.2; `ommUrl` per D11.
- `events.catalogPairs({ limit? })` (query): events with `origin: "catalog"` and `active: true`, ordered like `myQueue` in spec §3.2 (red, yellow, the rest with Pc by Pc descending then TCA, "Pc unavailable" last). Builds `EventRow`: join of two `spaceObjects`, `mySide: null`, `roomOpen: false`, `agentsWorking` from `agentRuns`. Up to 1000 events — in-memory sort, far from the scan limit.
- `events.get({ eventId })` (query): `EventRow` + `summaryLines` + `numbersChecked` from Andrew's table (D14).
- `null` means "no data", never `0` (spec §0).

### Step 6. Red trigger (D7, D8)

- `convex/lib/color.ts`: a pure function `color(pc, tcaMs, nowMs)` per Q-2. `pc.value === null` → never red (§20 Q12).
- `convex/riskMonitor.ts` → `recolor` (internal mutation) + `convex/crons.ts` every 5 minutes (my file; Andrew adds his watchdog there). Recomputes color, sets `active: false` after TCA.
- The transition to red, in the same transaction:

  ```ts
  if (c === "red" && !e.analystRequestedAt && redRank < cfg.analystTopK
      && cfg.analystAutostart && cfg.analystUsed < cfg.analystMax) {
    await ctx.db.patch(e._id, { color: c, redSince: now, analystRequestedAt: now });
    await ctx.db.patch(cfg._id, { analystUsed: cfg.analystUsed + 1 });
    await ctx.scheduler.runAfter(0, internal.agents.analyst.start, { eventId: e._id });
  }
  ```

  A mutation can't call an action directly, hence the scheduler. The flag and the schedule commit together, so my side starts the analyst exactly once.
- Safeguards in a `config` document: `analystAutostart` (turn off overnight), `analystTopK = 3` (Q-4, "top of the queue"), `analystMax` (a total cap against a rerun ↔ recolor loop). Other red events show without a summary.
- If step 3 finds zero red events: Andrew's fixture (`simulated: true`) goes through the same path.

### Step 7 (stretch). `orbit-service/` with `/screen`

Only once steps 1–6 are merged. Python 3.12, `sgp4` 2.27 + numpy + scipy `cKDTree`, FastAPI. Pitfalls from code-reuse §5: 9-digit IDs break `omm.initialize` (try/except per record), decayed objects return garbage with error code 0 (radius and speed guards), check `sgp4.api.accelerated`. 72 h horizon, cache the result. In Phase 1 a skeleton with `/health` is enough. **Phase 2 requires this service** (`/simulate` for the simulated satellite), and the issue gives it no owner — risk R6.

---

## 5. Convex schema (draft for Andrew)

Adding a table or an optional field needs no migration. Changing a type, making a field required or renaming one does. So what we agree now is **types and conventions**, not every Phase 2 table.

Conventions:
- `objectId` is always a string (9-digit IDs, `SIM-0001`).
- Times are ISO strings per the spec, plus a numeric `tcaMs` for indexes.
- Events reference objects by `objectId` instead of embedding them: in Phase 2, DATA-7 reassigns `ownerCompanyId` on a real satellite — one patch instead of N.
- Declare the full `EventStatus`, `Color` and `AgentRole` unions from spec §2.1 now. Add `"celestrak_satcat"` to `SourceName` (missing from the spec).
- `simulated` and `demoRunId` exist from the start.

`convex/tables/data.ts` (Kostya):

```ts
snapshots:   { snapshotId, takenAt, socratesRunUtc, ommUrl, sources: SourceRef[],
               counts: { socratesRows, loaded, skipped, missingOmm }, isCurrent }
  .index("by_isCurrent", ["isCurrent"])

spaceObjects: { objectId, name, ownerName|null, ownerCompanyId?: Id<"companies">,
                country|null, purpose|null, launchDate|null, objectType|null,
                simulated, celestrakUrl|null, ommAvailable, snapshotId }
  .index("by_objectId", ["objectId"])

events: { origin: "catalog"|"incident", snapshotId, pairKey, objectAId, objectBId,
          companyA?: Id<"companies">, companyB?: Id<"companies">,
          tcaUtc, tcaMs, missKm, relSpeedKmS, pc: Pc, color, status, situation,
          redSince|null, analystRequestedAt|null, active, selected|null, outcome|null,
          reviewRequired, roomOpen, sources: SourceRef[], simulated, demoRunId|null,
          updatedAt, raw: { dse1, dse2, dilutionKm } | null }
  .index("by_pair_tca", ["pairKey", "tcaMs"])
  .index("by_origin_active", ["origin", "active"])

config: { analystAutostart, analystTopK, analystMax, analystUsed }   // one document
```

`convex/tables/agents.ts` (Andrew, his call):

```ts
agentRuns:        { eventId, role, status, attempt, startedAt, lastProgressAt, inputHash, error|null }
  .index("by_event", ["eventId"])
analystSummaries: { eventId, lang, lines: string[], numbersChecked, inputHash, model, createdAt }
  .index("by_event", ["eventId"])
```

No owner yet: `users` and `companies` (sign-in is Phase 2). `companies` is declared empty so `ownerCompanyId` passes the validator.

---

## 6. Contract with Andrew

- `internal.agents.analyst.start({ eventId: v.id("events") }) → null` — an internal mutation, idempotent (if the event already has a `running` run with the same `inputHash`, it does nothing); it schedules its own action.
- I call it only via `ctx.scheduler.runAfter(0, …)` from `recolor`.
- It **never writes** the event's `color` or `status` — those are mine (spec: the backend sets status and color; inside the backend, the Risk Monitor does).
- What the analyst reads from the event: `tcaUtc`, `missKm`, `relSpeedKmS`, `pc`, `raw`, both `spaceObjects`. For the number check I pass both raw numbers and display strings: SOCRATES gives km to three decimals, and "213 m" vs "0.213 km" won't match otherwise.
- He writes `agentRuns` and `analystSummaries` (with `numbersChecked`); `agentsStalled` (60 s without progress) is written by his watchdog, not computed in a query.
- `agentRuns.by_event` — my queries need this index.
- The `start` stub ships in the schema PR (step 1).
- His fixture in `fixtures/` is loaded by the same `upsertBatch` and goes through the same `recolor`.

## 7. What Adil gets

- Step 2: the path to `data/snapshots/<id>/gp-active.json` (OMM JSON). Later the same file in `public/snapshots/` (D11).
- Step 5: `catalog.snapshot` → `ommUrl`, `takenAt` for the "snapshot from…" banner; `events.catalogPairs` → `EventRow[]` per spec §2.2; `events.get` for the summary. All without sign-in in Phase 1.
- For some pairs the second object is missing from GP active (debris) — `ommAvailable: false`, it won't be on the globe.
- From code-reuse: use `satellite.js` 6.0.2 (7.x has bundler problems; confirm that 6.0.2 parses OMM JSON via `json2satrec`); the catalog has 9-digit IDs; decayed objects return garbage positions without an error — filter by radius.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Zero red events — or hundreds | Step 3 counts answer it immediately. Zero → Andrew's fixture; hundreds → `analystTopK` and `analystMax`. We don't tune the threshold |
| R2 | Data loaded into the wrong deployment, or no Anthropic key there | D12: one shared deployment, loaded by script, env set there (H10) |
| R3 | Merge deadlock: scaffold, schema and Andrew's stub depend on each other | Merge in order (D1), regenerate `_generated` after each |
| R4 | CelesTrak firewalls the venue IP or returns HTML with 200 | One machine, one pass, body-shape check, no retries; fallback — a phone hotspot |
| R5 | The Convex CLI doesn't work on Node 26 | Check in the first minutes of step 1; fallback — Node 22 |
| R6 | `orbit-service` is a stretch in Phase 1 but required in Phase 2 (`/simulate`) | Raise the ownership question before Phase 1 ends |
| R7 | Andrew's number check fails on units and rounding | Raw numbers + display strings in the section 6 contract |
| R8 | OMM file: Convex egress, or object B missing on the globe | D11 (static), `ommAvailable` |

## 9. How we check it's done

- `npx convex dev` and `npx convex deploy` pass with no type errors.
- `npx convex run catalog:snapshot` returns `ommUrl`; the file is served there and its size matches `manifest.json`.
- `npx convex run events:catalogPairs '{"limit":5}'` → 5 `EventRow`s with object metadata; no `0` where `null` belongs.
- Load counts match `counts` in `catalog-pairs.json`; a repeated load changes neither the number of events nor their `_id`s.
- The fixture turns red → `agents.analyst.start` is called exactly once; a second `recolor` run does not call it again; `analystUsed` went up by 1.
- `npx convex run events:get '{"eventId":"…"}'` after the analyst runs returns `summaryLines` and `numbersChecked: true`.
- Adil confirms the globe and queue run on real data in the shared deployment.
- All PRs are merged into `main`.

---

## 10. Cross-check with the outside voice

Opus got the same brief (the issue, the full spec, excerpts from functionality, code-reuse and plan-v1, and the 04:22 measurements) and wrote its own plan independently, without seeing this one. The OpenCode voices (GLM, HY3, MiMo) were not run: the gateway key has expired.

**Agreed without changes:** root layout, offline SOCRATES parsing, loading through internal functions, an idempotent trigger with its flag in the same transaction, top 3 for the analyst, the fixture as a fallback path, SATCAT instead of KeepTrack without a key, open queries in Phase 1, `orbit-service` as a stretch.

**Taken from Opus:**

| What | Where |
|---|---|
| Every member gets their own Convex dev deployment — a shared one is needed | H4, D12, R2 |
| The analyst summary has nowhere to be read: `EventRow` has no summary | D14, `events.get` |
| Color can't be computed in a query via `Date.now()` — the cache doesn't rerun | D8 |
| Filter on `FILE_MTIME`, not the current time; selection rule `≥ 1e-5` + top 200 by distance, up to 1000 | D9, step 4 |
| GP active has no debris — some pairs lack their second object | step 3, `ommAvailable`, R8 |
| Convex egress is 1 GB/month for an 8 MB file — serve it statically | D11 |
| SATCAT `OWNER` is a country or organization, not a company | D5 |
| A catalog pair stays in status `new` while the analyst runs | D7 |
| A total `analystMax` cap against a rerun ↔ recolor loop | step 6 |
| `active: false` for past TCAs | D15 |
| Raw numbers + display strings for the number check | section 6, R7 |
| Tables in separate files so we don't both edit `schema.ts` | step 1 |
| Don't use `convex import --replace` | step 5 |
| Commit `_generated`; merge order | H2, D1, R3 |
| Node 26 with the Convex CLI is unverified | R5 |
| Request a Space-Track account now — for Phase 3 | H9 |
| `SourceName` has no SATCAT value | section 5 |

**Not taken:**

| What | Why |
|---|---|
| A TypeScript build script | Python stdlib is simpler for CSV and matches `orbit-service` |
| A precomputed `rankKey` and an index for `.take(limit)` | Up to 1000 events, an in-memory sort fits the limits; revisit if the selection grows |
| A separate `by_pcBand_tca` index for the cron | Same: a full pass over 1000 documents is cheap |
| Ranking pairs with both objects higher in the queue | Queue order is set by spec §3.2; a missing object is shown by a flag, not by order |

**Raise with the team (deviations from the spec and the issue):**
1. A room for a red real pair: Q-3 vs `catalogPairs` and DATA-5 vs the issue (D7).
2. Open queries without sign-in in Phase 1 (D3).
3. `ommUrl` served statically instead of from file storage (D11).
4. New `events.get` (D14), `SourceName: "celestrak_satcat"` (section 5), `active` for past TCAs (D15).
5. `MAX_PROB` as the Pc for red (D4).
6. Spec Appendix A takes the snapshot and events from `orbit-service`; the issue takes them from committed files and SOCRATES.
7. Who owns `orbit-service` for Phase 2 (R6). Spec §5 also gives Kostya the translation worker, per the outdated role table.
8. Without `gp_history`, Phase 3 validation will mostly say "data differs": GP was downloaded about 10 hours after the SOCRATES run (H9).
