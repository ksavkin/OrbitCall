#!/usr/bin/env python3
"""Download the CelesTrak GP catalog as OMM JSON once and pin it in the repo.

How to refresh the snapshot
---------------------------
Real mode (Dev off) draws and screens from OMM only (DATA-6: TLE cannot hold catalog numbers
above five digits). This script fetches the same groups the Dev globe loads as TLE
(web/src/lib/catalog/build.ts GROUPS), one request per group, with no retries, no redirects
and no loops. CelesTrak updates GP every 2 hours and refuses the same query more often, so run
it from your own machine, never from a Convex action, at most once per cycle:

    python3 scripts/fetch_gp.py          # prints and writes data/snapshots/gp-<time>/
    git add data/snapshots/gp-<time> && git commit

* The snapshot id is `gp-<first download time as YYYYMMDDTHHMMZ>`: GP has no single run time,
  and the plan takes the snapshot's takenAt from the GP download.
* Any status other than 200, or a body that is not a JSON array of OMM records (CelesTrak
  serves HTML and plain-text messages with status 200), stops the run. Each raw response is
  saved in data/snapshots/_incoming/ the moment it arrives, and a rerun reuses a saved file
  instead of requesting that group again. A "has not updated since your last download" answer
  is not kept: wait for the next 2-hour cycle and rerun. `--discard-incoming` deletes the saved
  responses to start over. A successful run removes the folder; never commit it.
* Each group is stored as served (`<group>.json`, raw bytes, so sha256 matches the download)
  with manifest.json (URL, fetchedAt, HTTP status, bytes, sha256, record count, epoch range,
  catalog numbers above 99999). Groups overlap; the manifest also counts unique objects.

Python 3.12, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# The Dev globe's groups (web/src/lib/catalog/build.ts), smallest first: a refusal costs one small request.
GROUPS = ("gnss", "stations", "iridium-33-debris", "cosmos-2251-debris", "fengyun-1c-debris", "active")
URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
USER_AGENT = "OrbitCall/0.1 (Cal Hacks 13.0; one download per snapshot)"
TIMEOUT_S = 180
REQUIRED_KEYS = (
    "OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "NORAD_CAT_ID", "BSTAR",
    "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
)
NOT_UPDATED = b"has not updated"  # CelesTrak's answer to a repeated query within one 2-hour cycle

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "data" / "snapshots"
INCOMING = SNAPSHOTS / "_incoming"


class Stop(Exception):
    """A run-stopping condition with a message for the user."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D102
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get(url: str) -> dict:
    """One GET. Returns the status, headers and body; raises Stop on anything but 200."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    opener = urllib.request.build_opener(_NoRedirect)
    fetched_at = now_iso()
    try:
        with opener.open(req, timeout=TIMEOUT_S) as res:
            status, headers, body = res.status, dict(res.headers.items()), res.read()
    except urllib.error.HTTPError as err:
        who = {k: v for k, v in err.headers.items() if k.lower() in ("server", "via", "x-proxy", "location")}
        raise Stop(f"{url} answered HTTP {err.code}, headers {who}. Not retrying. If this is a sandbox or "
                   "proxy block (the headers do not look like CelesTrak's), rerun once with the sandbox "
                   "disabled; the request never reached CelesTrak.") from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise Stop(f"{url} was not reachable ({type(err).__name__}: {err}). If this is a sandbox network "
                   "block, rerun once with the sandbox disabled; the request never reached CelesTrak.") from err
    if status != 200:
        raise Stop(f"{url} answered HTTP {status}, expected 200. Not retrying.")
    return {"url": url, "status": status, "headers": headers, "body": body, "fetchedAt": fetched_at}


def fetch_or_load(group: str) -> dict:
    """The saved response for `group` if there is one, otherwise one GET that is saved right away."""
    body_path, meta_path = INCOMING / f"{group}.json", INCOMING / f"{group}.json.meta.json"
    if meta_path.exists() and body_path.exists():
        print(f"using the saved response {body_path} (no request)")
        return {**json.loads(meta_path.read_text()), "body": body_path.read_bytes()}
    response = get(URL.format(group=group))
    INCOMING.mkdir(parents=True, exist_ok=True)
    body_path.write_bytes(response["body"])
    meta = {k: response[k] for k in ("url", "status", "headers", "fetchedAt")}
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    if NOT_UPDATED in response["body"][:500]:
        body_path.unlink()
        meta_path.unlink()
        raise Stop(f"CelesTrak refused GROUP={group} for this 2-hour cycle: {response['body'][:300]!r}. "
                   "Rerun after the next cycle; groups already saved are not requested again.")
    return response


def validate(group: str, body: bytes) -> list[dict]:
    """The OMM records, or Stop when the body is not a JSON array of them."""
    try:
        records = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise Stop(f"GROUP={group} is not JSON (first bytes: {body[:200]!r}). "
                   "Raw body kept in data/snapshots/_incoming/.") from err
    if not isinstance(records, list) or not records:
        raise Stop(f"GROUP={group} is not a non-empty JSON array (first bytes: {body[:200]!r}).")
    for i, r in enumerate(records):
        missing = [k for k in REQUIRED_KEYS if not isinstance(r, dict) or k not in r]
        if missing:
            raise Stop(f"GROUP={group} record {i} lacks {missing}: {str(r)[:200]}")
    return records


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run() -> Path:
    responses = {}
    for group in GROUPS:
        res = fetch_or_load(group)
        records = validate(group, res["body"])
        responses[group] = (res, records)
        print(f"{group}: {len(records)} records, {len(res['body'])} bytes")

    first = min(res["fetchedAt"] for res, _ in responses.values())
    sid = "gp-" + datetime.strptime(first, "%Y-%m-%dT%H:%M:%SZ").strftime("%Y%m%dT%H%MZ")
    out = SNAPSHOTS / sid
    if out.exists():
        raise Stop(f"{sid} already exists; nothing written.")
    out.mkdir(parents=True)

    files, ids = [], set()
    for group, (res, records) in responses.items():
        (out / f"{group}.json").write_bytes(res["body"])
        epochs = sorted(r["EPOCH"] for r in records)
        cat = [int(r["NORAD_CAT_ID"]) for r in records]
        ids.update(cat)
        files.append({
            "file": f"{group}.json", "group": group, "source": "celestrak_gp", "format": "omm-json",
            "url": res["url"], "fetchedAt": res["fetchedAt"], "httpStatus": res["status"],
            "lastModifiedHeader": next((v for k, v in res["headers"].items() if k.lower() == "last-modified"), None),
            "bytes": len(res["body"]), "sha256": sha256(res["body"]), "records": len(records),
            "epochMin": epochs[0], "epochMax": epochs[-1],
            "maxNoradCatId": max(cat), "noradCatIdsAbove99999": sum(1 for n in cat if n > 99999),
        })

    manifest = {
        "snapshotId": sid,
        "takenAt": first,
        "format": "OMM (CCSDS 502.0-B) as CelesTrak JSON, stored as served",
        "uniqueObjects": len(ids),
        "noradCatIdsAbove99999": sum(1 for n in ids if n > 99999),
        "files": files,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.rmtree(INCOMING, ignore_errors=True)
    print(f"wrote {out}: {len(ids)} unique objects in {len(files)} groups, taken {first}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--discard-incoming", action="store_true",
                    help="delete the saved raw responses in data/snapshots/_incoming/ before starting")
    args = ap.parse_args()
    if args.discard_incoming:
        shutil.rmtree(INCOMING, ignore_errors=True)
    try:
        run()
    except Stop as err:
        print(f"STOP: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
