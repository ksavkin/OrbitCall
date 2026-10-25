# Data

Product scope and stack follow the [master roadmap](../docs/master-roadmap.md), the team's source of truth. This file documents the pinned inputs and their current delivery path. OMM loading does not implement the planned fleet-screening service or recompute supplied SOCRATES geometry.

Where the repository keeps external data, and the rules for adding more. Real mode (Dev off) uses only what is pinned
here; Dev mode keeps its own TLE copy in `web/` ([integration status](../docs/integration-status.md), "Data modes").

## Layout

| Folder | What | Read by |
|---|---|---|
| `data/snapshots/socrates-<run time>/` | SOCRATES list (`socrates.csv.gz`), the 1000 queued pairs (`catalog-pairs.json`) | `scripts/build_catalog_pairs.py`, `scripts/load_snapshot.mjs` → Convex |
| `data/snapshots/satcat-<fetch time>/` | SATCAT (`satcat.csv.gz`): object names, owner country, launch and decay dates | `scripts/build_catalog_pairs.py` |
| `data/snapshots/gp-<fetch time>/` | GP as OMM JSON, one file per CelesTrak group (`scripts/fetch_gp.py`) | `scripts/build_omm_catalog.py`, `scripts/build_catalog_pairs.py` |
| `web/public/snapshots/gp-<fetch time>/` | the same group files, byte-identical, plus `catalog.json` (index with sha256, SATCAT rows, owner names) | the browser in real mode: `catalog.snapshot.ommUrl` points at `catalog.json` |
| `web/data/snapshot/` | GP as TLE plus a SATCAT subset: Adil's Dev globe fallback | the Next server (`/api/catalog`), Dev only |
| `web/data/weather/` | weather layer fallbacks | the Next server |
| `fixtures/` | simulated events and candidates | tests |
| `web/.cache/` (ignored) | live CelesTrak and weather cache | the Next server |

## Rules

- **One folder per download**, named `<source>-<UTC time as YYYYMMDDTHHMMZ>`, always with a `manifest.json`: URL,
  fetch time, HTTP status, bytes, sha256, row or record count. A copy or subset says so in the manifest
  (`copiedFrom`, `subset`). Never edit a pinned file; a newer download is a new folder.
- **Backend and frontend do not share files.** Scripts and Convex read `data/`; the web app reads `web/`. Vercel
  builds only `web/`, so anything the web server reads at runtime must live inside `web/`.
- **TLE is for Dev only.** Real mode uses OMM (DATA-6: TLE cannot hold catalog numbers above five digits).
- **Download once, from your own machine,** with the `scripts/fetch_*.py` scripts: no retries, no loops, never from
  a Convex action. CelesTrak refuses the same GP group more than once per 2-hour cycle, and the web app's
  `/api/catalog` counts too (set `ORBITCALL_OFFLINE=1` while a fetch is pending).
- **`data/snapshots/_incoming/`** holds raw responses between runs of a fetch script. It is ignored; never commit it.
- Store large CSVs gzipped (`mtime=0`, so the same input gives the same bytes). OMM JSON is stored as served.

## Real-mode OMM delivery

- **The browser gets OMM from a copy under `web/public/`** (Vercel's CDN; Convex file storage would cost egress on
  the free plan). `scripts/build_omm_catalog.py` writes it; git stores the byte-identical group files once. The web
  app checks each file against its pinned sha256 in a secure context. This code is merged. Shared-deployment validation remains a separate check.
- `build_catalog_pairs.py` keeps only pairs whose objects are both in the `gp-*` OMM snapshot, and writes its
  `catalog.json` path into `catalog-pairs.json` (`omm.url`), which `load_snapshot.mjs` registers as `ommUrl`.
- `build_catalog_pairs.py` drops pairs whose two objects belong to one operator (a Starlink with a Starlink):
  one operator needs no coordination call, and such rows are 4 of 5 that would otherwise qualify. The operator is
  read from the object-name prefix (`FLEETS` in the script: STARLINK, ONEWEB, KUIPER), because SATCAT `OWNER` is a
  country code; replace it with operator metadata when a source exists. `--keep-same-fleet` switches it off, and
  `counts.droppedSameFleet` / `filter.sameFleet` in `catalog-pairs.json` record what the build did.
- The globe and the queue are not one screening: SOCRATES ran on CelesTrak's own elements at its run time, while
  the globe propagates the later GP download. The pair list is SOCRATES's; positions are ours.

## Open

- `satcat-20261024T0802Z` is the subset Adil committed (the objects in his TLE groups). Objects new in OMM fall back
  to SOCRATES names until a full SATCAT is pinned.
