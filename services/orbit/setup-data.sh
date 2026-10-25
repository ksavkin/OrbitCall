#!/usr/bin/env bash
# Builds the service's data folder (ORBIT_DATA) from this package and a checkout of the OrbitCall repo:
#   snapshots/gp-*/          from the repo's data/snapshots/: the team's pinned CelesTrak GP snapshots in OMM
#                            (scripts/fetch_gp.py: one JSON per group + manifest.json with per-file sha256). Real mode
#                            reads the one whose id the newest catalog-pairs.json records (omm.snapshotId), so the
#                            service reports the same snapshotId as Convex; the sha256 of every file is checked at load
#   snapshots/socrates-*/    from the repo's data/snapshots/: the pinned SOCRATES runs (catalog-pairs.json,
#                            manifest.json, socrates.csv.gz) for /validation, SATCAT status and the snapshot id above
#   snapshot/                the repo's committed CelesTrak GP TLE groups (web/data/snapshot: *.tle, fetched_at.txt):
#                            the explicit development mode and the validation snapshot. Also a copy of the newest
#                            SOCRATES run as socrates.csv.gz + socrates-manifest.json, read only by the test suite
#   omm/, replay/,           shipped here: the service's own CelesTrak OMM fetch (used only with an explicit
#   validation/              ORBIT_SNAPSHOT_DIR, and by the tests), the labeled replay, the cached /validation result
#   jobs/, sim/              created empty: written at runtime (keep them on the persistent volume)
# The folder must be writable by the service (jobs/, sim/, validation/). Files of the repo are copied, never changed.
# Usage: ./setup-data.sh /path/to/OrbitCall [target-dir (default: ./data)]
# Exit codes: 0 done · 64 bad arguments · 65 a required file of the repo is missing.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: ./setup-data.sh /path/to/OrbitCall [target-dir]" >&2; exit 64; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$1" 2>/dev/null && pwd)" || { echo "no directory $1" >&2; exit 64; }
out="${2:-$here/data}"
snaps="$repo/data/snapshots"
tle="$repo/web/data/snapshot"

# The target is built here and partly replaced on every run: never inside the repo checkout itself.
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# The package's own data/ (services/orbit/data, git-ignored) is the one place inside the checkout that is allowed.
if [ "$out" != "$here/data" ]; then
  case "$out/" in "$repo/"*) rmdir "$out" 2>/dev/null || true
    echo "target $out is inside the repo checkout; choose another folder" >&2; exit 64;; esac
fi

# Inputs: TLE groups, at least one SOCRATES run, and the GP snapshot its newest catalog-pairs.json names.
ls "$tle"/*.tle >/dev/null 2>&1 || { echo "no TLE groups in $tle" >&2; exit 65; }
[ -f "$tle/fetched_at.txt" ] || { echo "no $tle/fetched_at.txt" >&2; exit 65; }
socs=()
for d in "$snaps"/socrates-*; do [ -d "$d" ] && socs+=("$d"); done   # glob order = name order = time order
[ ${#socs[@]} -gt 0 ] || { echo "no SOCRATES run under $snaps (socrates-*)" >&2; exit 65; }
for d in "${socs[@]}"; do
  for f in catalog-pairs.json manifest.json socrates.csv.gz; do [ -f "$d/$f" ] || { echo "no $d/$f" >&2; exit 65; }; done
done
newest="${socs[${#socs[@]}-1]}"
# omm.snapshotId of the newest catalog-pairs.json: the id Convex stores and the service must load (decision O33).
sid=$(tr -d '\n' < "$newest/catalog-pairs.json" | grep -oE '"omm": *\{[^}]*\}' | grep -oE '"snapshotId": *"[^"]*"' \
  | head -n 1 | cut -d'"' -f4 || true)
[ -n "$sid" ] || { echo "$newest/catalog-pairs.json records no omm.snapshotId" >&2; exit 65; }
[ -f "$snaps/$sid/manifest.json" ] || { echo "the snapshot Convex uses ($sid) is not in $snaps" >&2; exit 65; }

# Team layout, verbatim: every gp-* and socrates-* folder of the repo replaces the copy from an earlier run.
mkdir -p "$out/snapshots" "$out/snapshot" "$out/jobs" "$out/sim"
for d in "$snaps"/gp-* "${socs[@]}"; do
  [ -d "$d" ] || continue
  rm -rf "$out/snapshots/$(basename "$d")"
  cp -R "$d" "$out/snapshots/"
done

# TLE groups (the development mode and the validation snapshot) and the test suite's SOCRATES copy. No other files:
# any *.omm.json here would change the TLE snapshot's content-hash id and so miss the cached validation result.
rm -f "$out/snapshot"/*.tle "$out/snapshot"/*.omm.json "$out/snapshot/catalog-pairs.json"
cp "$tle"/*.tle "$tle/fetched_at.txt" "$out/snapshot/"
cp "$newest/socrates.csv.gz" "$out/snapshot/"
cp "$newest/manifest.json" "$out/snapshot/socrates-manifest.json"

# What this package ships (skipped when filling ./data in place).
if [ "$out" != "$here/data" ]; then
  # omm/ (the service's own fetch) is not in git, so a fresh clone has none: copy it only when present.
  for d in omm replay validation; do
    [ -d "$here/data/$d" ] || continue
    mkdir -p "$out/$d"; cp -R "$here/data/$d/." "$out/$d/"
  done
fi

echo "$out: OMM snapshot $sid (as recorded in $(basename "$newest")/catalog-pairs.json) | snapshots: $(ls "$out/snapshots" | tr '\n' ' ')| snapshot: $(ls "$out"/snapshot/*.tle | wc -l | tr -d ' ') TLE groups | omm: $(ls "$out/omm" 2>/dev/null | tr '\n' ' ')"
