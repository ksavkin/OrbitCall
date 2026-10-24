#!/usr/bin/env python3
"""Build data/snapshots/<snapshotId>/catalog-pairs.json from the committed SOCRATES snapshot.

A pure function of committed files, no system clock and no network:
  data/snapshots/<snapshotId>/socrates.csv.gz + manifest.json   (scripts/fetch_socrates.py)
  data/snapshots/satcat-<time>/satcat.csv.gz + manifest.json    (SATCAT, see data/README.md)
  data/snapshots/gp-<time>/manifest.json + <group>.json         (GP as OMM, scripts/fetch_gp.py: the objects
                                                                  the real-mode globe can draw)
The output rows are exactly the arguments of `events.ingest` (convex/events.ts) minus the
snapshot id and the simulated flag; `omm.url` is the catalog.snapshot.ommUrl the web app serves
(scripts/build_omm_catalog.py). The Convex loader reads this file.

Usage:  python3 scripts/build_catalog_pairs.py [snapshotId] [--satcat satcatId] [--gp gpId]
        (an id may be omitted when data/snapshots holds exactly one folder of that kind)

Selection, relative to the SOCRATES run time (never to "now"):
  1. eligible rows: TCA at or after the run time (an earlier TCA is already past when we load)
     and relative speed >= 0.1 km/s (slower pairs are docked or co-orbiting objects, such as the
     ISS with its own modules and visiting vehicles, not conjunctions; this alone removes ~80% of
     the highest-probability rows. `--min-rel-speed-km-s 0` switches the rule off);
  2. candidates: MAX_PROB >= 1e-5, plus the 200 smallest TCA_RANGE;
  3. drop pairs where either object has a SATCAT DECAY_DATE;
  4. dedupe by unordered pair, |dTCA| <= 60 s (keep the higher MAX_PROB, then the smaller range);
  5. at most 1000 pairs: the 200 closest are always kept, the rest by MAX_PROB descending
     (then TCA_RANGE, TCA, catalog numbers ascending).
Python 3.12, standard library only.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import math
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "data" / "snapshots"

# GP is pinned per group; `active` is the one URL we can name in a single SourceRef.
GP_SOURCE_GROUP = "active"

MIN_MAX_PROB = 1e-5
CLOSEST_COUNT = 200
MAX_PAIRS = 1000
DEDUPE_TOLERANCE_S = 60
MIN_REL_SPEED_KM_S = 0.1  # orbit-watch's co-orbiting threshold (docs/research/code-reuse.md)
RED_MIN_PROB = 1e-4       # exclusive; same rule as isRed in convex/lib/analyst.ts
RED_WITHIN_HOURS = 72     # exclusive
NAME_MAX = 200


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def iso(dt: datetime) -> str:
    """ISO UTC with Z, milliseconds only when non-zero (same shape as isoUtc in convex/lib/events.ts)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3].replace(".000", "") + "Z"


def parse_tca(text: str) -> datetime:
    """SOCRATES TCA is UTC, written '2026-10-29 21:46:38.477' with no zone."""
    return datetime.strptime(text.strip(), "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)


def clean_name(raw: str) -> str:
    """Single-line name without the SOCRATES ops-status suffix (' [+]', ' [P]', ...)."""
    name = re.sub(r"\s*\[[^\]]*\]\s*$", "", raw)
    name = re.sub(r"[\x00-\x1f\x7f]", " ", name)
    return re.sub(r"\s+", " ", name).strip()[:NAME_MAX]


def parse_float(text: str) -> float | None:
    text = text.strip()
    if text == "":
        return None
    value = float(text)
    return value if math.isfinite(value) else None


def read_socrates(path: Path) -> list[dict]:
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        need = {"NORAD_CAT_ID_1", "OBJECT_NAME_1", "NORAD_CAT_ID_2", "OBJECT_NAME_2",
                "TCA", "TCA_RANGE", "TCA_RELATIVE_SPEED", "MAX_PROB"}
        if not need <= set(reader.fieldnames or []):
            die(f"{path} header lacks {sorted(need - set(reader.fieldnames or []))}")
        rows = []
        for line, r in enumerate(reader, start=2):
            id1, id2 = r["NORAD_CAT_ID_1"].strip(), r["NORAD_CAT_ID_2"].strip()
            if not (id1.isdigit() and id2.isdigit()):
                die(f"{path} line {line}: catalog numbers must be decimal, got {id1!r} {id2!r}")
            rng, speed = parse_float(r["TCA_RANGE"]), parse_float(r["TCA_RELATIVE_SPEED"])
            prob = parse_float(r["MAX_PROB"])  # empty stays None; a real 0 stays 0 (plan D13)
            if rng is None or speed is None or rng < 0 or speed < 0 or (prob is not None and not 0 <= prob <= 1):
                die(f"{path} line {line}: range, speed or probability out of bounds: {r}")
            rows.append({
                "id1": int(id1), "id2": int(id2), "name1": r["OBJECT_NAME_1"], "name2": r["OBJECT_NAME_2"],
                "tca": parse_tca(r["TCA"]), "range": rng, "speed": speed, "prob": prob,
            })
    return rows


def read_satcat(path: Path) -> dict[int, dict]:
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        need = {"OBJECT_NAME", "NORAD_CAT_ID", "OWNER", "LAUNCH_DATE", "DECAY_DATE"}
        if not need <= set(reader.fieldnames or []):
            die(f"{path} header lacks {sorted(need - set(reader.fieldnames or []))}")
        return {int(r["NORAD_CAT_ID"]): r for r in reader if r["NORAD_CAT_ID"].strip().isdigit()}


def read_omm_ids(gp_id: str) -> tuple[set[int], dict]:
    """Catalog numbers in every group of the pinned OMM snapshot, and that snapshot's GP source entry."""
    folder = SNAPSHOTS / gp_id
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest["snapshotId"] != gp_id:
        die(f"{gp_id}/manifest.json belongs to another snapshot")
    ids: set[int] = set()
    for f in manifest["files"]:
        records = json.loads((folder / f["file"]).read_bytes())
        if len(records) != f["records"]:
            die(f"{gp_id}/{f['file']}: manifest says {f['records']} records, the file has {len(records)}")
        ids.update(int(r["NORAD_CAT_ID"]) for r in records)
    source = next((f for f in manifest["files"] if f["group"] == GP_SOURCE_GROUP), None)
    if source is None:
        die(f"{gp_id} has no {GP_SOURCE_GROUP} group")
    return ids, source


def better(x: dict, y: dict) -> bool:
    """Is row x a better representative of one encounter than y?"""
    kx = (-1.0 if x["prob"] is None else x["prob"], -x["range"], -x["tca"].timestamp())
    ky = (-1.0 if y["prob"] is None else y["prob"], -y["range"], -y["tca"].timestamp())
    return kx > ky


def dedupe(rows: list[dict]) -> tuple[list[dict], int]:
    """One row per unordered pair within |dTCA| <= tolerance; returns (kept, number dropped)."""
    kept: list[dict] = []
    last: dict[tuple[int, int], int] = {}  # pair -> index in `kept` of its latest encounter
    dropped = 0
    for row in sorted(rows, key=lambda r: (r["tca"], min(r["id1"], r["id2"]), max(r["id1"], r["id2"]))):
        pair = (min(row["id1"], row["id2"]), max(row["id1"], row["id2"]))
        at = last.get(pair)
        if at is not None and abs((row["tca"] - kept[at]["tca"]).total_seconds()) <= DEDUPE_TOLERANCE_S:
            dropped += 1
            if better(row, kept[at]):
                kept[at] = row
            continue
        last[pair] = len(kept)
        kept.append(row)
    return kept, dropped


def row_key(r: dict) -> tuple:
    return (r["tca"], min(r["id1"], r["id2"]), max(r["id1"], r["id2"]))


def select(rows: list[dict], run: datetime, satcat: dict[int, dict], min_speed: float,
           drawable: set[int] | None) -> tuple[list[dict], dict]:
    upcoming = [r for r in rows if r["tca"] >= run]
    fast = [r for r in upcoming if r["speed"] >= min_speed]
    # Only pairs the globe can draw: both objects in the pinned OMM snapshot.
    eligible = [r for r in fast if drawable is None or (r["id1"] in drawable and r["id2"] in drawable)]
    closest = sorted(eligible, key=lambda r: (r["range"],) + row_key(r))[:CLOSEST_COUNT]
    closest_ids = {id(r) for r in closest}
    candidates = [r for r in eligible if (r["prob"] is not None and r["prob"] >= MIN_MAX_PROB) or id(r) in closest_ids]

    def decayed(r: dict) -> bool:
        return any(satcat.get(i, {}).get("DECAY_DATE", "").strip() != "" for i in (r["id1"], r["id2"]))

    live = [r for r in candidates if not decayed(r)]
    dropped_decayed = len(candidates) - len(live)
    unique, dropped_duplicates = dedupe(live)
    over_cap = 0
    if len(unique) > MAX_PAIRS:
        reserved = [r for r in unique if id(r) in closest_ids]
        reserved_ids = {id(r) for r in reserved}
        rest = sorted((r for r in unique if id(r) not in reserved_ids),
                      key=lambda r: (-(r["prob"] if r["prob"] is not None else -1.0), r["range"]) + row_key(r))
        chosen = reserved + rest[: max(0, MAX_PAIRS - len(reserved))]
        over_cap = len(unique) - len(chosen)
    else:
        chosen = unique
    stats = {
        "eligible": len(eligible), "droppedBeforeRun": len(rows) - len(upcoming),
        "droppedCoorbiting": len(upcoming) - len(fast), "droppedNotDrawable": len(fast) - len(eligible),
        "candidates": len(candidates), "droppedDecayed": dropped_decayed,
        "droppedDuplicates": dropped_duplicates, "droppedOverCap": over_cap,
    }
    return chosen, stats


def meta(object_id: int, socrates_name: str, satcat: dict[int, dict]) -> dict:
    row = satcat.get(object_id)
    name = clean_name(row["OBJECT_NAME"]) if row else ""
    name = name or clean_name(socrates_name) or f"NORAD {object_id}"
    country = (row["OWNER"].strip() if row else "") or None
    launch = (row["LAUNCH_DATE"].strip() if row else "")
    launch = launch if re.fullmatch(r"\d{4}-\d{2}-\d{2}", launch) else None
    return {"objectId": str(object_id), "name": name, "country": country, "launchDate": launch}


def to_pair(r: dict, satcat: dict[int, dict]) -> dict:
    (a, name_a), (b, name_b) = sorted(((r["id1"], r["name1"]), (r["id2"], r["name2"])), key=lambda t: t[0])
    return {
        "objectA": meta(a, name_a, satcat), "objectB": meta(b, name_b, satcat),
        "tcaUtc": iso(r["tca"]), "missKm": r["range"], "relSpeedKmS": r["speed"], "pcValue": r["prob"],
    }


def dump(doc: dict) -> str:
    """Stable text: header fields indented, one pair per line, so reruns diff cleanly."""
    pairs = doc["pairs"]
    head = json.dumps({k: v for k, v in doc.items() if k != "pairs"}, indent=2, ensure_ascii=False)
    body = ",\n".join("    " + json.dumps(p, ensure_ascii=False, separators=(", ", ": ")) for p in pairs)
    return head[:-2] + ',\n  "pairs": [\n' + body + ("\n  ]\n}\n" if pairs else "  ]\n}\n")


def resolve_snapshot(arg: str | None, kind: str = "socrates", marker: str | None = None) -> str:
    if arg:
        return arg
    found = sorted(p.name for p in SNAPSHOTS.glob(f"{kind}-*") if (p / (marker or f"{kind}.csv.gz")).exists())
    if len(found) != 1:
        die(f"pass the {kind} snapshot id; found {found}")
    return found[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("snapshot_id", nargs="?")
    ap.add_argument("--satcat", help="satcat-* snapshot id (default: the only one in data/snapshots)")
    ap.add_argument("--gp", help="gp-* OMM snapshot id (default: the only one in data/snapshots)")
    ap.add_argument("--min-rel-speed-km-s", type=float, default=MIN_REL_SPEED_KM_S,
                    help="drop docked or co-orbiting pairs slower than this (default %(default)s; 0 keeps them)")
    ap.add_argument("--all-pairs", action="store_true",
                    help="keep pairs whose objects are missing from the OMM snapshot (not drawable on the globe)")
    args = ap.parse_args()
    sid = resolve_snapshot(args.snapshot_id)
    folder = SNAPSHOTS / sid
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest["snapshotId"] != sid:
        die("manifest.json belongs to another snapshot")
    entry = next(f for f in manifest["files"] if f["source"] == "socrates")
    run = datetime.strptime(manifest["socratesRunUtc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    gp_id = resolve_snapshot(args.gp, "gp", "manifest.json")
    omm_ids, gp_source = read_omm_ids(gp_id)
    catalog_fetched = gp_source["fetchedAt"]
    datetime.strptime(catalog_fetched, "%Y-%m-%dT%H:%M:%SZ")  # must be ISO UTC with Z
    satcat_id = resolve_snapshot(args.satcat, "satcat")
    satcat_manifest = json.loads((SNAPSHOTS / satcat_id / "manifest.json").read_text())
    if satcat_manifest["snapshotId"] != satcat_id:
        die(f"{satcat_id}/manifest.json belongs to another snapshot")
    satcat_entry = next(f for f in satcat_manifest["files"] if f["source"] == "celestrak_satcat")

    rows = read_socrates(folder / "socrates.csv.gz")
    satcat = read_satcat(SNAPSHOTS / satcat_id / satcat_entry["file"])
    if len(rows) != entry["rows"]:
        die(f"manifest says {entry['rows']} rows, the file has {len(rows)}")
    if len(satcat) != satcat_entry["rows"]:
        die(f"{satcat_id} manifest says {satcat_entry['rows']} rows, the file has {len(satcat)}")

    red = lambda r: (r["prob"] is not None and r["prob"] > RED_MIN_PROB
                     and timedelta(0) < r["tca"] - run < timedelta(hours=RED_WITHIN_HOURS))
    red_at_run = sum(1 for r in rows if red(r))

    chosen, stats = select(rows, run, satcat, args.min_rel_speed_km_s, None if args.all_pairs else omm_ids)
    pairs = [(r, to_pair(r, satcat)) for r in chosen]
    pairs.sort(key=lambda t: (t[0]["tca"], int(t[1]["objectA"]["objectId"]), int(t[1]["objectB"]["objectId"])))
    selected_ids = {int(p[k]["objectId"]) for _, p in pairs for k in ("objectA", "objectB")}
    missing_omm = len(selected_ids - omm_ids)

    counts = {
        "socratesRows": len(rows), "redAtRunTime": red_at_run, "selected": len(pairs),
        "droppedDecayed": stats["droppedDecayed"], "droppedDuplicates": stats["droppedDuplicates"],
        "missingFromOmm": missing_omm,
    }
    doc = {
        "snapshotId": sid,
        "sources": [
            {"name": "socrates", "url": entry["url"], "epochUtc": manifest["socratesRunUtc"], "fetchedAt": entry["fetchedAt"]},
            {"name": "celestrak_gp", "url": gp_source["url"], "epochUtc": None, "fetchedAt": catalog_fetched},
            {"name": "celestrak_satcat", "url": satcat_entry["url"], "epochUtc": None, "fetchedAt": satcat_entry["fetchedAt"]},
        ],
        "omm": {"snapshotId": gp_id, "url": f"/snapshots/{gp_id}/catalog.json"},
        "filter": {
            "runTimeUtc": manifest["socratesRunUtc"],
            "tcaNotBeforeRunTime": True,
            "minRelSpeedKmS": args.min_rel_speed_km_s,
            "minMaxProb": MIN_MAX_PROB,
            "closestRangeCount": CLOSEST_COUNT,
            "dropDecayed": True,
            "dedupeToleranceS": DEDUPE_TOLERANCE_S,
            "maxPairs": MAX_PAIRS, "bothObjectsInOmm": not args.all_pairs,
            "capRule": "closest kept first, then MAX_PROB descending, TCA_RANGE, TCA, catalog numbers ascending",
            "redRule": {"maxProbAbove": RED_MIN_PROB, "tcaWithinHoursOfRunTime": RED_WITHIN_HOURS},
        },
        "counts": counts,
        "pairs": [p for _, p in pairs],
    }
    (folder / "catalog-pairs.json").write_text(dump(doc), encoding="utf-8")

    # Measurements for the plan (step 3); not stored beyond `counts`.
    sel = [r for r, _ in pairs]
    ids_over = sum(1 for _, p in pairs if int(p["objectA"]["objectId"]) >= 100000 or int(p["objectB"]["objectId"]) >= 100000)
    no_satcat = len(selected_ids - satcat.keys())
    both_omm = sum(1 for _, p in pairs if int(p["objectA"]["objectId"]) in omm_ids and int(p["objectB"]["objectId"]) in omm_ids)
    same_fleet = sum(1 for r in sel if clean_name(r["name1"]).split("-")[0] == clean_name(r["name2"]).split("-")[0]
                     and clean_name(r["name1"]).startswith(("STARLINK", "ONEWEB", "KUIPER")))
    print(f"snapshot            {sid} (SOCRATES run {manifest['socratesRunUtc']}, OMM {gp_id}, {GP_SOURCE_GROUP} fetched {catalog_fetched})")
    print(f"SOCRATES rows       {counts['socratesRows']}")
    print(f"red at run time     {red_at_run}  (MAX_PROB > 1e-4 and TCA within 72 h after the run)")
    drawable = lambda r: r["id1"] in omm_ids and r["id2"] in omm_ids
    print(f"  with both objects in the OMM snapshot: {sum(1 for r in rows if red(r) and drawable(r))}"
          f"  (all rows with MAX_PROB >= 1e-5 and TCA >= run: {sum(1 for r in rows if drawable(r) and r['tca'] >= run and (r['prob'] or 0) >= MIN_MAX_PROB)})")
    slow = lambda r: r["speed"] < args.min_rel_speed_km_s
    print(f"  red and >= {args.min_rel_speed_km_s} km/s: {sum(1 for r in rows if red(r) and not slow(r))}"
          f"  (with both objects in OMM: {sum(1 for r in rows if red(r) and not slow(r) and drawable(r))})")
    print(f"before run time     {stats['droppedBeforeRun']} rows dropped (TCA earlier than the run)")
    print(f"co-orbiting         {stats['droppedCoorbiting']} upcoming rows dropped (relative speed < {args.min_rel_speed_km_s} km/s)")
    print(f"candidates          {stats['candidates']} (MAX_PROB >= 1e-5 or among the 200 closest)")
    print(f"dropped decayed     {counts['droppedDecayed']}")
    print(f"dropped duplicates  {counts['droppedDuplicates']}")
    print(f"dropped over cap    {stats['droppedOverCap']}")
    print(f"selected            {counts['selected']} pairs, {len(selected_ids)} objects")
    print(f"  red among them    {sum(1 for r in sel if red(r))}")
    print(f"  objects not in OMM groups  {missing_omm}  (pairs with both objects in OMM: {both_omm})")
    print(f"  objects not in SATCAT file {no_satcat}  (names fall back to SOCRATES, country/launch null)")
    print(f"  pairs with an id >= 100000 {ids_over}  (OMM only; TLE cannot hold these)")
    print(f"  same-constellation pairs   {same_fleet}  (STARLINK/ONEWEB/KUIPER vs itself, by name)")
    top = Counter(int(((r['tca'] - run).total_seconds()) // 86400) for r in sel)
    print(f"  TCA day offset from run    {sorted(top.items())}")
    print(f"wrote {folder / 'catalog-pairs.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
