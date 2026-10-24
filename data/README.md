# Data

Where the repository keeps external data, and the rules for adding more. Real mode (Dev off) uses only what is pinned
here; Dev mode keeps its own TLE copy in `web/` ([integration status](../docs/integration-status.md), "Data modes").

## Layout

| Folder | What | Read by |
|---|---|---|
| `data/snapshots/socrates-<run time>/` | SOCRATES list (`socrates.csv.gz`), the 1000 queued pairs (`catalog-pairs.json`) | `scripts/build_catalog_pairs.py`, `scripts/load_snapshot.mjs` → Convex |
| `data/snapshots/satcat-<fetch time>/` | SATCAT (`satcat.csv.gz`): object names, owner country, launch and decay dates | `scripts/build_catalog_pairs.py` |
| `data/snapshots/gp-<fetch time>/` | GP as OMM JSON, one file per CelesTrak group (`scripts/fetch_gp.py`) | real mode, once its delivery is decided (below) |
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

## Open

- **How the browser gets OMM in real mode:** a copy under `web/public/` (Vercel's CDN) or Convex file storage (no
  copy, but the free plan's egress is about 1 GB a month). The answer sets `catalog.snapshot.ommUrl`; decide with
  Adil.
- `build_catalog_pairs.py` still reads the Dev TLE ids in `web/data/snapshot/` to keep only drawable pairs. It moves
  to the `gp-*` OMM snapshot once that snapshot is complete.
- `satcat-20261024T0802Z` is the subset Adil committed (the objects in his TLE groups). Objects new in OMM fall back
  to SOCRATES names until a full SATCAT is pinned.
