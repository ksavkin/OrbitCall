"""GET /validation: measured reference coverage against the committed SOCRATES run (SCR-3, SCR-8, roadmap §8).

Roadmap §8: "Validate with the full eligible reference scope and separate geometry/time error from recall." So:
- Reference: SOCRATES sort-minRange.csv of the pinned run (team data, sha256 in its manifest; lane or team layout, catalog.socrates_paths).
- Validation snapshot: the pinned snapshot closest in time to that run (the team's TLE files, fetched 6 h after it);
  the result names it. Real-mode screening uses the OMM snapshot, fetched later, whose element sets SOCRATES never saw.
- In scope: TCA within 72 h after the run, both objects in the validation snapshot, relative speed >= 0.1 km/s
  (docked / formation pairs are not encounters, as in /screen). Every other row is counted in `excluded`.
- Data timestamp (SCR-3): SOCRATES gives each object's days since epoch at TCA (DSE, 3 decimals: ±43.2 s), so its
  element-set epoch is TCA − DSE. A row is eligible only if both epochs equal ours within 45 s; every other in-scope
  row is "data differs" — neither eligible nor a miss.
- Recall (detection): ALL eligible rows. A small set of primaries that covers them (greedy set cover — not
  guaranteed minimal; deterministic: most rows first, then catalog number) are each screened against the whole catalog exactly like /screen; a row is matched
  by our encounter with the same partner within 60 s, one to one (rows in TCA order take their nearest unused
  encounter). recall = matched / (matched + unmatched), which is matched / eligible when every eligible row was
  screened (scopeComplete). The refinement threshold is 5.5 km so a 5 km-edge reference is not lost
  to rounding.
- Geometry / time error, separate from recall: for every eligible row the pair's closest approach is refined around
  the reference TCA (no detection involved) and compared with SOCRATES' TCA and miss distance.
ORBIT_VALIDATION_MAX_PRIMARIES limits the screened primaries for tests only; the result then says scopeComplete false
and lists the eligible rows that were not screened. Simulated objects never count.
"""

import csv
import gzip
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .catalog import Catalog, SnapshotMissing, epoch_unix, socrates_paths
from .conjunction import MATCH_WINDOW_S, PropagationError, closest
from .screen import MIN_REL_SPEED_KM_S, id_key, screen_primary
from .timeutil import iso
from .track import Track

HORIZON_H = 72
MATCH_TOLERANCE_S = 60
EPOCH_TOLERANCE_S = 45.0  # DSE has 3 decimals of a day: ±43.2 s of rounding, nothing more
MAX_PRIMARIES = int(os.environ["ORBIT_VALIDATION_MAX_PRIMARIES"]) if os.environ.get("ORBIT_VALIDATION_MAX_PRIMARIES") else None
REFINE_KM = 5.5
REFERENCE_KM = 5.0
CONFIG_VERSION = 5  # bump when the scope or matching rules change: the cache key includes it


def _ts(text: str) -> float:
    """SOCRATES TCA "2026-10-29 21:46:38.477" (fractional seconds optional) → Unix seconds, UTC."""
    t = datetime.fromisoformat(text.strip().replace(" ", "T"))
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()


def _stats(values: list[float], digits: int) -> dict | None:
    if not values:
        return None
    return {"median": round(float(np.median(values)), digits), "p95": round(float(np.percentile(values, 95)), digits),
            "max": round(float(np.max(values)), digits), "n": len(values)}


def _ref_sha(data_dir: Path) -> str:
    """sha256 of the SOCRATES file from its manifest ("noref" if the manifest is missing or has no file)."""
    try:
        return json.loads(socrates_paths(data_dir)[1].read_text())["files"][0]["gzSha256"]
    except (OSError, ValueError, KeyError, IndexError):
        return "noref"


def cover(rows: list[tuple]) -> list[str]:
    """Objects such that every row has one of them (greedy set cover: small, not guaranteed minimal; ties by catalog
    number): the primaries to screen."""
    left = set(range(len(rows)))
    out: list[str] = []
    while left:
        count: dict[str, int] = {}
        for i in left:
            for o in rows[i][:2]:
                count[o] = count.get(o, 0) + 1
        best = min(count, key=lambda o: (-count[o], id_key(o)))
        out.append(best)
        left = {i for i in left if best not in rows[i][:2]}
    return out


def run_validation(cat: Catalog, data_dir: Path, max_primaries: int | None = MAX_PRIMARIES, progress=None) -> dict:
    started = time.time()
    progress = progress or (lambda *a, **k: None)
    socrates_csv, socrates_manifest = socrates_paths(data_dir)
    if not socrates_csv.exists() or not socrates_manifest.exists():
        raise SnapshotMissing(f"no SOCRATES reference ({socrates_csv}, {socrates_manifest}): validation is unavailable")
    manifest = json.loads(socrates_manifest.read_text())
    run_utc = manifest["socratesRunUtc"]
    run = datetime.fromisoformat(run_utc.replace("Z", "+00:00")).timestamp()
    end = run + HORIZON_H * 3600
    excluded: dict[str, int] = {}
    scope_rows = []
    ref_epoch: dict[str, float] = {}  # each object's element-set epoch as SOCRATES used it (TCA − DSE), any row
    total = 0
    with gzip.open(socrates_csv, "rt", newline="") as f:
        for row in csv.DictReader(f):
            total += 1
            a, b, t = str(int(row["NORAD_CAT_ID_1"])), str(int(row["NORAD_CAT_ID_2"])), _ts(row["TCA"])
            ref_epoch.setdefault(a, t - float(row["DSE_1"]) * 86400.0)
            ref_epoch.setdefault(b, t - float(row["DSE_2"]) * 86400.0)
            if not run <= t <= end:
                reason = f"TCA outside {HORIZON_H} h after the SOCRATES run"
            elif a not in cat.objects or b not in cat.objects or cat.objects[a].simulated or cat.objects[b].simulated:
                reason = "an object is not in the validation snapshot"
            elif float(row["TCA_RELATIVE_SPEED"]) < MIN_REL_SPEED_KM_S:
                reason = f"co-located or formation pair (relative speed < {MIN_REL_SPEED_KM_S} km/s)"
            else:
                scope_rows.append((a, b, t, float(row["TCA_RANGE"]), float(row["DSE_1"]), float(row["DSE_2"])))
                continue
            excluded[reason] = excluded.get(reason, 0) + 1

    def same_data(oid: str, tca: float, dse: float) -> bool:
        return abs(epoch_unix(cat.objects[oid].sat) - (tca - dse * 86400.0)) <= EPOCH_TOLERANCE_S

    eligible_rows = sorted((r for r in scope_rows if same_data(r[0], r[2], r[4]) and same_data(r[1], r[2], r[5])),
                           key=lambda r: (r[2], r[0], r[1]))
    data_differs = len(scope_rows) - len(eligible_rows)

    # Geometry / time error on every eligible row, independent of detection.
    geo_tca, geo_miss, geo_failed = [], [], 0
    for a, b, tca, rng, _, _ in eligible_rows:
        try:
            ap = closest(Track(cat.objects[a].sat), Track(cat.objects[b].sat), tca, 120.0, 1.0)
        except PropagationError:
            geo_failed += 1
            continue
        geo_tca.append(abs(ap.tca_ts - tca))
        geo_miss.append(abs(ap.miss_km - rng))
    progress("screening", 0.0, eligible=len(eligible_rows))

    # Detection (recall) on every eligible row.
    primaries = cover(eligible_rows)
    planned = len(primaries)
    if max_primaries is not None:
        primaries = primaries[:max_primaries]
    enc: dict[tuple[str, str], list] = {}
    failed: list[str] = []
    for i, oid in enumerate(primaries):
        try:
            hits, _, _, _, _ = screen_primary(cat, oid, run, end, REFINE_KM, exclude_simulated=True)
        except PropagationError:
            failed.append(oid)
            continue
        for h in hits:
            key = (min(oid, h.object_id), max(oid, h.object_id))
            lst = enc.setdefault(key, [])
            if not any(abs(x.tca_ts - h.approach.tca_ts) <= MATCH_WINDOW_S for x in lst):
                lst.append(h.approach)  # a pair of two screened primaries is one physical pass
        progress(None, (i + 1) / len(primaries), primariesScreened=i + 1)
    screened = set(primaries) - set(failed)
    measured = [r for r in eligible_rows if r[0] in screened or r[1] in screened]
    not_screened = [r for r in eligible_rows if not (r[0] in screened or r[1] in screened)]
    used: set[int] = set()

    def match(a: str, b: str, tca: float):
        best = None
        for ap in enc.get((min(a, b), max(a, b)), []):
            if id(ap) not in used and abs(ap.tca_ts - tca) <= MATCH_TOLERANCE_S:
                if best is None or abs(ap.tca_ts - tca) < abs(best.tca_ts - tca):
                    best = ap
        if best is not None:
            used.add(id(best))
        return best

    matched = 0
    det_tca, det_miss, unmatched_list = [], [], []
    for a, b, tca, rng, _, _ in measured:
        ap = match(a, b, tca)
        if ap is None:
            unmatched_list.append({"objectA": a, "objectB": b, "tcaUtc": iso(tca), "socratesMissKm": rng})
            continue
        matched += 1
        det_tca.append(abs(ap.tca_ts - tca))
        det_miss.append(abs(ap.miss_km - rng))

    # Our encounters under 5 km between screened primaries and the catalog that SOCRATES does not list in scope.
    listed = {(min(r[0], r[1]), max(r[0], r[1])) for r in scope_rows}

    def same_ref(oid: str) -> bool:
        return oid in ref_epoch and abs(epoch_unix(cat.objects[oid].sat) - ref_epoch[oid]) <= EPOCH_TOLERANCE_S

    extra = [(k, ap) for k, aps in enc.items() for ap in aps if ap.miss_km < REFERENCE_KM
             and ap.rel_speed_km_s >= MIN_REL_SPEED_KM_S and run <= ap.tca_ts <= end and k not in listed]
    extra_same = [{"objectA": k[0], "objectB": k[1], "tcaUtc": iso(ap.tca_ts), "missKm": round(ap.miss_km, 3)}
                  for k, ap in extra if same_ref(k[0]) and same_ref(k[1])]
    excluded["data differs (element-set epoch not SOCRATES')"] = data_differs
    complete = not not_screened and not failed
    return {
        "snapshotId": cat.snapshot_id, "snapshotUtc": cat.taken_at, "snapshotFormat": cat.format,
        "referenceRunUtc": run_utc, "referenceSha256": _ref_sha(data_dir),
        "scope": f"SOCRATES run {run_utc} vs validation snapshot {cat.snapshot_id} ({cat.format}); TCA within "
                 f"{HORIZON_H} h of the run; both objects in the snapshot; relative speed >= {MIN_REL_SPEED_KM_S} km/s; "
                 f"eligible = all {len(eligible_rows)} in-scope rows whose two element sets equal SOCRATES' (epoch within "
                 f"{EPOCH_TOLERANCE_S:.0f} s); detection by screening {len(primaries)} of {planned} covering primaries "
                 f"against the whole catalog.",
        "scopeComplete": complete,
        "horizonH": HORIZON_H, "matchToleranceS": MATCH_TOLERANCE_S, "epochToleranceS": EPOCH_TOLERANCE_S,
        "referenceRows": total, "inScopeRows": len(scope_rows),
        "eligible": len(eligible_rows), "matched": matched, "unmatched": len(measured) - matched,
        "notScreened": len(not_screened),
        "recall": round(matched / len(measured), 4) if measured else None,
        "dataDiffers": data_differs,
        "excluded": [{"reason": r, "count": n} for r, n in sorted(excluded.items())],
        "tcaErrorS": _stats(geo_tca, 3), "missErrorKm": _stats(geo_miss, 4), "geometryFailed": geo_failed,
        "detectionErrors": {"tcaErrorS": _stats(det_tca, 3), "missErrorKm": _stats(det_miss, 4)},
        "oursNotInReference": {"total": len(extra), "sameData": len(extra_same), "sameDataSample": extra_same[:20]},
        "primaries": {"planned": planned, "screened": len(screened), "failed": failed},
        "unmatchedSample": unmatched_list[:20],
        "limitations": [
            "Eligible rows are those whose element sets equal SOCRATES' (epoch within 45 s); our snapshot is 6 h younger "
            "than the run, so most in-scope rows are 'data differs'. Space-Track gp_history would make more rows "
            "comparable; it needs an account and is not used.",
            "tcaErrorS / missErrorKm are geometry and time errors of every eligible pair refined around the reference "
            "TCA, separate from recall; detectionErrors are the same errors for the encounters our screening found.",
            "Our encounters not in SOCRATES are reported, not judged: either side can be wrong on mean elements, and "
            "SOCRATES' own inputs for operator pairs are not visible here.",
        ],
        "configVersion": CONFIG_VERSION, "runtimeS": round(time.time() - started, 1), "simulated": False,
    }


class ValidationCache:
    """One background run per validation snapshot and config; the result is kept in memory and on disk."""

    def __init__(self, cat, data_dir: Path):
        """`cat`: the catalog, or a zero-argument loader called once in the background (the validation snapshot)."""
        self._cat, self.data_dir = cat, data_dir
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.error: str | None = None
        self.result: dict | None = None
        self.started_at: float | None = None

    @property
    def cat(self) -> Catalog:
        if callable(self._cat):
            self._cat = self._cat()
        return self._cat

    @property
    def path(self) -> Path:
        ref = _ref_sha(self.data_dir)
        limited = f"-max{MAX_PRIMARIES}" if MAX_PRIMARIES else ""
        return self.data_dir / "validation" / f"{self.cat.snapshot_id}-{ref[:8]}-v{CONFIG_VERSION}{limited}.json"

    def get(self) -> tuple[dict | None, str]:
        """(result, state): state is "ready", "running" or "failed: …" (a failed run restarts on the next call)."""
        with self.lock:
            if self.result is None and self.path.exists():
                try:
                    self.result = json.loads(self.path.read_text())
                except ValueError:  # a corrupt cache file is recomputed, never a 500
                    self.path.unlink(missing_ok=True)
            if self.result is not None:
                return self.result, "ready"
            if self.thread is None or not self.thread.is_alive():
                state = f"failed: {self.error}" if self.error else "running"
                self.error = None
                self.started_at = time.time()
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
                return None, state
            return None, "running"

    def _run(self) -> None:
        try:
            res = run_validation(self.cat, self.data_dir)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(res, indent=1))
            tmp.replace(self.path)
            with self.lock:
                self.result = res
        except Exception as exc:  # noqa: BLE001 — reported on the next GET, then retried
            with self.lock:
                self.error = str(exc)[:300]
