#!/usr/bin/env python3
"""Download the SOCRATES conjunction list from CelesTrak once and pin it in the repo.

How to refresh the snapshot
---------------------------
CelesTrak bans an IP after 50 errors in 2 hours and the venue IP is shared, so this
script makes at most two requests per run (the index, then the CSV), with no retries,
no redirects and no loops. Run it from your own machine, never from a Convex action:

    python3 scripts/fetch_socrates.py                       # prints and writes data/snapshots/<id>/
    python3 scripts/build_catalog_pairs.py <id>             # writes catalog-pairs.json (offline)
    git add data/snapshots/<id> && git commit

* The snapshot id is `socrates-<SOCRATES run time as YYYYMMDDTHHMMZ>`, taken from the
  index entry's FILE_MTIME (or the CSV's Last-Modified header when the index has none).
  If that snapshot already exists the script stops after the index request and does
  not download the CSV again.
* Any status other than 200, or a body that is not the expected CSV header (CelesTrak
  serves HTML error pages with status 200), stops the run. Each raw response is saved in
  data/snapshots/_incoming/ the moment it arrives, and a rerun reuses a saved file instead
  of requesting it again, so fixing this script after a failure costs no extra request.
  `--discard-incoming` deletes the saved responses to start over. A successful run removes
  the folder; never commit it.
* The CSV is stored gzipped (about 22 MB raw) with manifest.json (URL, fetchedAt, HTTP
  status, bytes, sha256, row count, FILE_MTIME). Commit the new snapshot folder; keep
  old ones only if the Convex data still refers to them.

Python 3.12, standard library only.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

INDEX_URL = "https://celestrak.org/SOCRATES/jsonDir.php"
BASE_URL = "https://celestrak.org/SOCRATES/"
FILE_NAME = "sort-minRange.csv"
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$")
USER_AGENT = "OrbitCall/0.1 (Cal Hacks 13.0; one download per snapshot)"
TIMEOUT_S = 180
REQUIRED_COLUMNS = (
    "NORAD_CAT_ID_1", "OBJECT_NAME_1", "NORAD_CAT_ID_2", "OBJECT_NAME_2",
    "TCA", "TCA_RANGE", "TCA_RELATIVE_SPEED", "MAX_PROB",
)
MIN_CSV_BYTES = 1_000_000  # the real file is ~22 MB; an error page is a few hundred bytes

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


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def parse_mtime(value) -> datetime:
    """FILE_MTIME as an aware UTC datetime. Accepts epoch seconds/ms, ISO and 'YYYY-MM-DD HH:MM:SS UTC'."""
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"\d{9,13}(\.\d+)?", value.strip())):
        n = float(value)
        return datetime.fromtimestamp(n / 1000 if n > 1e11 else n, tz=timezone.utc)
    if not isinstance(value, str):
        raise Stop(f"FILE_MTIME has an unexpected type: {value!r}")
    text = re.sub(r"\s*(UTC|GMT|Z)$", "", value.strip()).replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc)
    except (TypeError, ValueError) as err:
        raise Stop(f"Cannot read FILE_MTIME {value!r}") from err


def find_entry(index_body: bytes) -> dict:
    try:
        index = json.loads(index_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise Stop(f"The SOCRATES index is not JSON (first bytes: {index_body[:200]!r}). "
                   "Raw body kept in data/snapshots/_incoming/.") from err
    entries = index if isinstance(index, list) else index.get("files", []) if isinstance(index, dict) else []
    for entry in entries:
        if isinstance(entry, dict) and entry.get("FILE_NAME") == FILE_NAME:
            return entry
    names = [e.get("FILE_NAME") for e in entries if isinstance(e, dict)]
    raise Stop(f"{FILE_NAME} is not in the SOCRATES index (files: {names}). Check the file name by hand.")


def validate_csv(body: bytes) -> tuple[list[str], int]:
    """Return (header, data row count) or raise Stop when the body is not the SOCRATES CSV."""
    if len(body) < MIN_CSV_BYTES:
        raise Stop(f"The CSV body is only {len(body)} bytes (expected ~22 MB). First bytes: {body[:200]!r}")
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError as err:
        raise Stop(f"The CSV body is not UTF-8 text (first bytes: {body[:200]!r}).") from err
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, [])
    missing = [c for c in REQUIRED_COLUMNS if c not in header]
    if missing:
        raise Stop(f"Unexpected CSV header, missing {missing}. Header: {header}")
    rows = sum(1 for row in reader if row and any(cell.strip() for cell in row))
    if rows == 0:
        raise Stop("The CSV has a header but no rows.")
    return header, rows


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def snapshot_id(run: datetime) -> str:
    return "socrates-" + run.astimezone(timezone.utc).strftime("%Y%m%dT%H%MZ")


def save_incoming(name: str, response: dict) -> None:
    INCOMING.mkdir(parents=True, exist_ok=True)
    (INCOMING / name).write_bytes(response["body"])
    meta = {k: response[k] for k in ("url", "status", "headers", "fetchedAt")}
    (INCOMING / f"{name}.meta.json").write_text(json.dumps(meta, indent=2) + "\n")


def fetch_or_load(name: str, url: str) -> dict:
    """The saved response for `name` if there is one, otherwise one GET that is saved right away."""
    meta_path, body_path = INCOMING / f"{name}.meta.json", INCOMING / name
    if meta_path.exists() and body_path.exists():
        print(f"using the saved response {body_path} (no request)")
        return {**json.loads(meta_path.read_text()), "body": body_path.read_bytes()}
    response = get(url)
    save_incoming(name, response)
    return response


def run() -> Path:
    # Request 1: the index (also tells the SOCRATES run time via FILE_MTIME).
    index_res = fetch_or_load("jsonDir.json", INDEX_URL)
    entry = find_entry(index_res["body"])
    if not FILE_NAME_RE.match(entry["FILE_NAME"]):
        raise Stop(f"Unsafe file name in the index: {entry['FILE_NAME']!r}")
    csv_url = BASE_URL + entry["FILE_NAME"]
    mtime_raw = entry.get("FILE_MTIME")
    run_time = parse_mtime(mtime_raw) if mtime_raw not in (None, "") else None
    print(f"index ok: {entry}")

    if run_time is not None and (SNAPSHOTS / snapshot_id(run_time) / "socrates.csv.gz").exists():
        raise Stop(f"{snapshot_id(run_time)} already exists; nothing to download. "
                   "Delete the folder first if you really want to replace it.")

    # Request 2: the CSV itself.
    csv_res = fetch_or_load(entry["FILE_NAME"], csv_url)
    header, rows = validate_csv(csv_res["body"])
    if run_time is None:
        last_modified = next((v for k, v in csv_res["headers"].items() if k.lower() == "last-modified"), None)
        if not last_modified:
            raise Stop("The index has no FILE_MTIME and the CSV has no Last-Modified header, so the SOCRATES "
                       "run time is unknown. Raw files are in data/snapshots/_incoming/.")
        run_time = parse_mtime(last_modified)
        mtime_raw = f"Last-Modified: {last_modified}"
    sid = snapshot_id(run_time)
    out = SNAPSHOTS / sid
    if (out / "socrates.csv.gz").exists():
        raise Stop(f"{sid} already exists; nothing written.")

    raw = csv_res["body"]
    out.mkdir(parents=True, exist_ok=True)
    gz_path = out / "socrates.csv.gz"
    with gz_path.open("wb") as fh:  # mtime=0 and no embedded name: same input, same bytes
        with gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0, compresslevel=9) as gz:
            gz.write(raw)
    gz_bytes = gz_path.read_bytes()
    if gzip.decompress(gz_bytes) != raw:
        raise Stop("gzip round trip failed; the snapshot was not trusted.")

    size_in_index = entry.get("FILE_SIZE")
    manifest = {
        "snapshotId": sid,
        "socratesRunUtc": iso(run_time),
        "index": {
            "url": index_res["url"], "fetchedAt": index_res["fetchedAt"], "httpStatus": index_res["status"],
            "bytes": len(index_res["body"]), "sha256": sha256(index_res["body"]), "entry": entry,
        },
        "files": [{
            "file": "socrates.csv.gz", "source": "socrates", "url": csv_res["url"],
            "fetchedAt": csv_res["fetchedAt"], "httpStatus": csv_res["status"],
            "bytes": len(raw), "sha256": sha256(raw), "rows": rows, "columns": header,
            "fileMtime": mtime_raw, "fileMtimeUtc": iso(run_time),
            "lastModifiedHeader": next((v for k, v in csv_res["headers"].items() if k.lower() == "last-modified"), None),
            "fileSizeInIndex": size_in_index,
            "compression": "gzip", "gzBytes": len(gz_bytes), "gzSha256": sha256(gz_bytes),
        }],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.rmtree(INCOMING, ignore_errors=True)
    print(f"wrote {out}: {rows} rows, {len(raw)} bytes raw, {len(gz_bytes)} bytes gzipped, run time {iso(run_time)}")
    if isinstance(size_in_index, (int, float)) and int(size_in_index) != len(raw):
        print(f"note: the index says FILE_SIZE={size_in_index}, the download is {len(raw)} bytes")
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
