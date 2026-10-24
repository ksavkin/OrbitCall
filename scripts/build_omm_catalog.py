#!/usr/bin/env python3
"""Publish the pinned GP OMM snapshot to the web app, where real mode (Dev off) draws it.

A pure function of committed files, no system clock and no network:
  data/snapshots/gp-<time>/<group>.json + manifest.json        (scripts/fetch_gp.py)
  data/snapshots/satcat-<time>/satcat.csv.gz + manifest.json    (SATCAT, see data/README.md)
  web/data/snapshot/owners.json                                 (SATCAT owner code -> name)
Writes web/public/snapshots/gp-<time>/, which Vercel serves as static files:
  <group>.json   byte-identical copies of the pinned group files (git stores each blob once)
  catalog.json   the index the browser loads (web/src/lib/catalog/omm.ts): each group file with its
                 sha256 and record count, SATCAT metadata for the snapshot's objects, owner names
The index's path, /snapshots/gp-<time>/catalog.json, is catalog.snapshot.ommUrl; build_catalog_pairs.py
writes it into catalog-pairs.json and scripts/load_snapshot.mjs registers it in Convex.

Usage:  python3 scripts/build_omm_catalog.py [gpId] [--satcat satcatId]
        (an id may be omitted when data/snapshots holds exactly one folder of that kind)
Python 3.12, standard library only.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "data" / "snapshots"
OWNERS = ROOT / "web" / "data" / "snapshot" / "owners.json"
PUBLIC = ROOT / "web" / "public" / "snapshots"
FORMAT = "orbitcall-omm-catalog/1"  # OMM_INDEX_FORMAT in web/src/lib/catalog/omm.ts
SATCAT_COLUMNS = ["OWNER", "LAUNCH_DATE", "LAUNCH_SITE", "OBJECT_TYPE", "RCS"]


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def resolve(arg: str | None, kind: str) -> str:
    if arg:
        return arg
    found = sorted(p.name for p in SNAPSHOTS.glob(f"{kind}-*") if (p / "manifest.json").exists())
    if len(found) != 1:
        die(f"pass the {kind} snapshot id; found {found}")
    return found[0]


def manifest_of(snapshot_id: str) -> dict:
    manifest = json.loads((SNAPSHOTS / snapshot_id / "manifest.json").read_text())
    if manifest["snapshotId"] != snapshot_id:
        die(f"{snapshot_id}/manifest.json belongs to another snapshot")
    return manifest


def read_groups(gp_id: str, manifest: dict) -> list[tuple[dict, bytes, list[dict]]]:
    """Every group file, checked against its manifest entry."""
    groups = []
    for f in manifest["files"]:
        body = (SNAPSHOTS / gp_id / f["file"]).read_bytes()
        if len(body) != f["bytes"] or hashlib.sha256(body).hexdigest() != f["sha256"]:
            die(f"{gp_id}/{f['file']} does not match its manifest (bytes or sha256)")
        records = json.loads(body)
        if len(records) != f["records"]:
            die(f"{gp_id}/{f['file']}: manifest says {f['records']} records, the file has {len(records)}")
        groups.append((f, body, records))
    return groups


def read_satcat(satcat_id: str, manifest: dict) -> tuple[dict, dict[int, dict]]:
    entry = next(f for f in manifest["files"] if f["source"] == "celestrak_satcat")
    with gzip.open(SNAPSHOTS / satcat_id / entry["file"], "rt", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = set(SATCAT_COLUMNS + ["NORAD_CAT_ID"]) - set(reader.fieldnames or [])
        if missing:
            die(f"{satcat_id} header lacks {sorted(missing)}")
        rows = {int(r["NORAD_CAT_ID"]): r for r in reader if r["NORAD_CAT_ID"].strip().isdigit()}
    if len(rows) != entry["rows"]:
        die(f"{satcat_id} manifest says {entry['rows']} rows, the file has {len(rows)}")
    return entry, rows


def rcs(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("gp_id", nargs="?")
    ap.add_argument("--satcat", help="satcat-* snapshot id (default: the only one in data/snapshots)")
    args = ap.parse_args()
    gp_id = resolve(args.gp_id, "gp")
    satcat_id = resolve(args.satcat, "satcat")
    gp_manifest = manifest_of(gp_id)
    groups = read_groups(gp_id, gp_manifest)
    satcat_entry, satcat = read_satcat(satcat_id, manifest_of(satcat_id))
    owners = json.loads(OWNERS.read_text())

    ids = sorted({int(r["NORAD_CAT_ID"]) for _, _, records in groups for r in records})
    satcat_rows = {
        str(i): [satcat[i]["OWNER"], satcat[i]["LAUNCH_DATE"], satcat[i]["LAUNCH_SITE"], satcat[i]["OBJECT_TYPE"],
                 rcs(satcat[i]["RCS"])]
        for i in ids if i in satcat
    }
    index = {
        "format": FORMAT,
        "snapshotId": gp_id,
        "takenAt": gp_manifest["takenAt"],
        "copiedFrom": f"data/snapshots/{gp_id}/ (group files byte-identical, checked by sha256)",
        "groups": [
            {k: f[k] for k in ("group", "file", "url", "fetchedAt", "sha256", "bytes", "records")}
            for f, _, _ in groups
        ],
        "satcat": {
            "snapshotId": satcat_id,
            "fetchedAt": satcat_entry["fetchedAt"],
            "subset": "Rows for this snapshot's objects that the pinned SATCAT file has; objects it lacks have no owner or launch data.",
            "columns": SATCAT_COLUMNS,
            "rows": satcat_rows,
        },
        "owners": owners,
    }

    out = PUBLIC / gp_id
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for f, body, _ in groups:
        (out / f["file"]).write_bytes(body)
    (out / "catalog.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    print(f"wrote {out.relative_to(ROOT)}: {len(groups)} group files, {len(ids)} unique objects, "
          f"{len(satcat_rows)} with SATCAT rows ({len(ids) - len(satcat_rows)} without), "
          f"{sum(1 for i in ids if i > 99999)} catalog numbers above 99999")
    print(f"ommUrl: /snapshots/{gp_id}/catalog.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
