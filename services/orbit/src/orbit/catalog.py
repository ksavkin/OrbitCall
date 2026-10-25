"""The catalog: element sets loaded once from a pinned snapshot, plus simulated objects added at runtime.

Real mode (default, ORBIT_CATALOG_MODE=omm): a pinned CelesTrak GP snapshot in OMM JSON with a sha256 manifest,
loaded with sgp4.omm.initialize. Default source: the team's snapshot (`snapshots/gp-<time>/`, scripts/fetch_gp.py),
so the service and Convex use the same snapshot and the same snapshotId (decision O33); alternative: the lane's own
fetch (`omm/<fetch>/`), chosen with ORBIT_SNAPSHOT_DIR (or the older ORBIT_OMM_DIR) — OMM epochs are kept as given, never round-tripped through TLE
(team roadmap §8). Development mode (ORBIT_CATALOG_MODE=tle, explicit only, labeled in every snapshot id): the
team's committed 3-line TLE files (data/snapshot, decision D11). There is no silent fallback between the two.
Object ids are strings: catalog numbers as decimal ("48211", Alpha-5 decoded, 9-digit OMM ids) or "SIM-0001".
A record that fails to parse or to propagate at its own epoch is skipped and recorded, never fatal (DATA-6).
"""

import csv
import gzip
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sgp4 import omm
from sgp4.api import Satrec, WGS72

from .timeutil import iso, jd_to_unix

MU = 398600.8  # km^3/s^2, WGS-72 (the constant SGP4 uses)
ALPHA5 = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # Alpha-5 skips I and O; A = 10
STATUS_RE = re.compile(r"\[([-+?PBSXD])\]\s*$")


def decode_catnum(field5: str) -> str:
    """TLE columns 3-7 → decimal id string; "A0001" = 100001."""
    s = field5.strip()
    if s and s[0].isalpha():
        return str((ALPHA5.index(s[0].upper()) + 10) * 10000 + int(s[1:]))
    return str(int(s))


def mean_motion_rad_s(sat: Satrec) -> float:
    return sat.no_kozai / 60.0


def sma_km(sat: Satrec) -> float:
    return (MU / mean_motion_rad_s(sat) ** 2) ** (1 / 3)


def epoch_unix(sat: Satrec) -> float:
    return jd_to_unix(sat.jdsatepoch, sat.jdsatepochF)


@dataclass
class Obj:
    object_id: str
    name: str
    sat: Satrec
    simulated: bool = False
    group: str = ""  # source file stem ("active", "cosmos-2251-debris", ...); "sim" for simulated objects
    omm: dict | None = None  # the OMM record as received (real mode) or built for a simulated object

    @property
    def perigee_apogee_km(self) -> tuple[float, float]:
        a = sma_km(self.sat)
        return a * (1 - self.sat.ecco), a * (1 + self.sat.ecco)


@dataclass
class Catalog:
    snapshot_id: str
    taken_at: str
    sources: list[dict]
    objects: dict[str, Obj] = field(default_factory=dict)
    skipped: list[dict] = field(default_factory=list)
    status: dict[str, str] = field(default_factory=dict)  # SATCAT operational status per id from SOCRATES names
    format: str = "tle"  # "omm" (real mode) or "tle" (development mode)
    manifest: dict | None = None  # the OMM snapshot manifest (files, sha256, fetch time)

    def add(self, obj: Obj) -> None:
        # Copy-on-write: a request iterating the old dict is never disturbed by a concurrent /simulate.
        self.objects = {**self.objects, obj.object_id: obj}

    def get(self, object_id: str) -> Obj | None:
        return self.objects.get(object_id)



def _valid(sat: Satrec) -> bool:
    e, _, _ = sat.sgp4(sat.jdsatepoch, sat.jdsatepochF)
    return e == 0


def load_tle_file(path: Path, cat: Catalog) -> None:
    lines = [ln.rstrip() for ln in path.read_text(encoding="ascii", errors="replace").splitlines() if ln.strip()]
    i = 0
    while i < len(lines):
        if lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            name, l1, l2, step = "", lines[i], lines[i + 1], 2
        elif i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            name, l1, l2, step = lines[i].strip(), lines[i + 1], lines[i + 2], 3
        else:
            cat.skipped.append({"file": path.name, "line": i + 1, "reason": "not a TLE record"})
            i += 1
            continue
        i += step
        try:
            oid = decode_catnum(l1[2:7])
            sat = Satrec.twoline2rv(l1, l2, WGS72)
        except Exception as exc:  # noqa: BLE001 — any bad record is skipped (DATA-6)
            cat.skipped.append({"file": path.name, "line": i - step + 1, "reason": f"parse: {exc}"})
            continue
        if sat.error or not _valid(sat):
            cat.skipped.append({"objectId": oid, "file": path.name, "reason": f"sgp4 error {sat.error}"})
            continue
        if oid not in cat.objects:  # groups overlap (stations ⊂ active); the first file wins
            cat.objects[oid] = Obj(oid, name or oid, sat, group=path.stem)  # load time: no readers yet


def load_omm_json(path: Path, cat: Catalog, group: str | None = None) -> None:
    for rec in json.loads(path.read_text()):
        oid = str(rec.get("NORAD_CAT_ID", "")).strip()
        if not oid:
            cat.skipped.append({"file": path.name, "reason": "OMM record without NORAD_CAT_ID"})
            continue
        try:
            sat = Satrec()
            omm.initialize(sat, {k: str(v) for k, v in rec.items()})
        except Exception as exc:  # noqa: BLE001
            cat.skipped.append({"objectId": oid, "file": path.name, "reason": f"parse: {exc}"})
            continue
        if sat.error or not _valid(sat):
            cat.skipped.append({"objectId": oid, "file": path.name, "reason": f"sgp4 error {sat.error}"})
            continue
        if oid not in cat.objects:  # groups overlap (stations ⊂ active); the first file wins
            cat.objects[oid] = Obj(oid, rec.get("OBJECT_NAME") or oid, sat, group=group or path.name.split(".")[0], omm=rec)


def load_socrates_status(path: Path) -> dict[str, str]:
    """Operational status per object from the SOCRATES run's names ("FLOCK 4Q-4 [+]"): the SATCAT status code
    (+ operational, - nonoperational, P partial, B backup, S spare, X extended, D decayed, ? unknown)."""
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    with gzip.open(path, "rt", newline="") as f:
        for row in csv.DictReader(f):
            for n in ("1", "2"):
                m = STATUS_RE.search(row[f"OBJECT_NAME_{n}"])
                if m:
                    out.setdefault(str(int(row[f"NORAD_CAT_ID_{n}"])), m.group(1))
    return out


class SnapshotMissing(Exception):
    pass


class SnapshotInvalid(SnapshotMissing):
    """The snapshot is there but does not match its manifest (sha256, a missing file, an id that is not its own)."""


def expected_snapshot_id(data_dir: Path) -> str | None:
    """The OMM snapshot id Convex uses: ORBIT_SNAPSHOT_ID, else `omm.snapshotId` of the team's catalog-pairs.json
    (scripts/build_catalog_pairs.py writes the id the queue and the web were built from)."""
    if os.environ.get("ORBIT_SNAPSHOT_ID"):
        return _component(os.environ["ORBIT_SNAPSHOT_ID"], "ORBIT_SNAPSHOT_ID")
    # newest queue build first (several socrates-<time>/ builds may be kept), then the lane copy
    for p in sorted(data_dir.glob("snapshots/socrates-*/catalog-pairs.json"), reverse=True) + [data_dir / "snapshot" / "catalog-pairs.json"]:
        try:
            doc = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        omm = doc.get("omm") if isinstance(doc, dict) else None
        sid = omm.get("snapshotId") if isinstance(omm, dict) else None
        if isinstance(sid, str) and sid:
            return _component(sid, str(p))
    return None


def _component(name: str, where: str) -> str:
    """A snapshot id or a manifest file name must be one plain path component (no '/', '..', absolute path)."""
    if not name or name in (".", "..") or "/" in name or "\\" in name or Path(name).is_absolute():
        raise SnapshotInvalid(f"{where}: {name!r} is not a plain name")
    return name


def snapshot_dir(data_dir: Path) -> Path:
    """The real-mode snapshot directory. ORBIT_SNAPSHOT_DIR (or ORBIT_OMM_DIR) pins one explicitly — the only way to
    use the lane's own fetch (`omm/*`). Otherwise only the team layout is used (`snapshots/gp-*`): the directory of
    the expected id (see expected_snapshot_id), or — when no id is known — the newest `snapshots/gp-*` (the team's
    fetch_gp.py naming; a differently named team snapshot must be named by ORBIT_SNAPSHOT_ID). A missing or different
    snapshot is an error, never a silent switch to another catalog (decision O33)."""
    pinned = os.environ.get("ORBIT_SNAPSHOT_DIR") or os.environ.get("ORBIT_OMM_DIR")
    if pinned:
        if not (Path(pinned) / "manifest.json").is_file():
            raise SnapshotMissing(f"ORBIT_SNAPSHOT_DIR {pinned} has no manifest.json file")
        return Path(pinned)
    want = expected_snapshot_id(data_dir)
    if want:  # exactly snapshots/<id>/, whatever the id looks like
        d = data_dir / "snapshots" / want
        if not (d / "manifest.json").is_file():
            raise SnapshotMissing(f"the snapshot Convex uses ({want}) is not under {data_dir / 'snapshots'}")
        return d
    dirs = sorted(p for p in data_dir.glob("snapshots/gp-*") if (p / "manifest.json").is_file())
    if not dirs:
        raise SnapshotMissing(f"no team OMM snapshot under {data_dir / 'snapshots'} (gp-*/manifest.json); set "
                              f"ORBIT_SNAPSHOT_DIR for another one, or ORBIT_CATALOG_MODE=tle for development")
    return dirs[-1]


def latest_omm_dir(data_dir: Path) -> Path:
    """Earlier name, kept for callers: the real-mode snapshot directory (snapshot_dir)."""
    return snapshot_dir(data_dir)


def socrates_paths(data_dir: Path) -> tuple[Path, Path]:
    """(socrates.csv.gz, its manifest): the lane layout (snapshot/socrates-manifest.json) or the team layout
    (snapshots/socrates-*/manifest.json)."""
    if os.environ.get("ORBIT_SOCRATES_DIR"):
        d = Path(os.environ["ORBIT_SOCRATES_DIR"])
        return d / "socrates.csv.gz", d / "manifest.json"
    dirs = sorted(p for p in data_dir.glob("snapshots/socrates-*") if (p / "socrates.csv.gz").exists())
    if dirs:  # team layout first, like the OMM snapshot
        return dirs[-1] / "socrates.csv.gz", dirs[-1] / "manifest.json"
    lane = data_dir / "snapshot"
    # Absent: no SATCAT status (classification falls back to names/groups) and GET /validation reports the error.
    return lane / "socrates.csv.gz", lane / "socrates-manifest.json"


def tle_dir(data_dir: Path) -> Path:
    """The TLE files (development mode, validation snapshot): ORBIT_TLE_DIR, data/snapshot (lane layout), or the
    team repo's web/data/snapshot next to its data/ directory."""
    if os.environ.get("ORBIT_TLE_DIR"):
        return Path(os.environ["ORBIT_TLE_DIR"])
    for d in (data_dir / "snapshot", data_dir.parent / "web" / "data" / "snapshot"):
        if list(d.glob("*.tle")):
            return d
    raise SnapshotMissing(f"no TLE files under {data_dir / 'snapshot'} (set ORBIT_TLE_DIR)")


def load_snapshot(data_dir: Path, mode: str | None = None) -> Catalog:
    """The pinned catalog of the given mode: "omm" (real, default) or "tle" (development, explicit)."""
    mode = mode or os.environ.get("ORBIT_CATALOG_MODE", "omm")
    if mode == "omm":
        return load_omm_snapshot(data_dir)
    if mode != "tle":
        raise ValueError(f"ORBIT_CATALOG_MODE must be omm or tle, not {mode!r}")
    return load_tle_snapshot(data_dir)


def load_omm_snapshot(data_dir: Path) -> Catalog:
    d = snapshot_dir(data_dir)
    try:
        manifest = json.loads((d / "manifest.json").read_text())
    except (OSError, ValueError) as exc:
        raise SnapshotInvalid(f"{d / 'manifest.json'} cannot be read: {exc}") from exc
    if not isinstance(manifest, dict):
        raise SnapshotInvalid(f"{d / 'manifest.json'} is not a JSON object")
    # Layout by place, not by content: a directory under snapshots/ is the team layout (scripts/fetch_gp.py), whose
    # manifest must name its own directory; anything else (the lane's omm/<fetch>/) gets a content-hash id.
    team = d.parent.name == "snapshots"
    if team and manifest.get("snapshotId") != d.name:
        raise SnapshotInvalid(f"manifest snapshotId {manifest.get('snapshotId')!r} is not its directory {d.name}")
    fetched = manifest.get("takenAt") or manifest.get("fetchedAt")
    if not fetched or not isinstance(manifest.get("files"), list):
        raise SnapshotInvalid(f"{d / 'manifest.json'} has no takenAt/fetchedAt or no files list")
    for f in manifest["files"]:
        if not (isinstance(f, dict) and isinstance(f.get("file"), str) and isinstance(f.get("sha256"), str)):
            raise SnapshotInvalid(f"manifest entry {f!r} needs string file and sha256")
        _component(f["file"], "manifest file")
        f.setdefault("group", f["file"].split(".")[0])
        f.setdefault("url", None)
    digest = hashlib.sha256()
    for f in manifest["files"]:
        if not (d / f["file"]).is_file():
            raise SnapshotInvalid(f"{f['file']} is listed in the manifest but missing")
        try:
            b = (d / f["file"]).read_bytes()
        except OSError as exc:
            raise SnapshotInvalid(f"{f['file']} cannot be read: {exc}") from exc
        if hashlib.sha256(b).hexdigest() != f["sha256"]:
            raise SnapshotInvalid(f"{f['file']} does not match its manifest sha256")
        digest.update(f["file"].encode() + b"\0" + b)
    sid = manifest["snapshotId"] if team else f"celestrak-omm-{fetched}-{digest.hexdigest()[:8]}"
    cat = Catalog(snapshot_id=sid, taken_at=fetched, sources=[], format="omm",
                  manifest={**manifest, "dir": d.name, "layout": "team" if team else "lane", "contentSha256": digest.hexdigest()})
    files = sorted(manifest["files"], key=lambda f: (f["group"] != "active", f["group"]))
    for f in files:
        load_omm_json(d / f["file"], cat, group=f["group"])
    cat.sources = [{"name": "celestrak_gp", "url": f["url"], "format": "omm", "epochUtc": None,
                    "fetchedAt": f.get("fetchedAt", fetched), "sha256": f["sha256"]} for f in files]
    _finish(cat, data_dir)
    return cat


def _finish(cat: Catalog, data_dir: Path) -> None:
    cat.status = load_socrates_status(socrates_paths(data_dir)[0])
    epochs = [epoch_unix(o.sat) for o in cat.objects.values()]
    for src in cat.sources if epochs else []:
        src["epochUtc"] = iso(float(np.median(epochs)))  # typical element-set epoch of the snapshot


def load_tle_snapshot(data_dir: Path) -> Catalog:
    """Development mode: the TLE files (CelesTrak GP groups, TLE format; see tle_dir), active.tle first."""
    snap = tle_dir(data_dir)
    fetched = (snap / "fetched_at.txt").read_text().strip() if (snap / "fetched_at.txt").exists() else None
    cat = Catalog(
        snapshot_id=f"celestrak-gp-{fetched or 'unknown'}",
        taken_at=fetched or "",
        sources=[],
    )
    files = sorted(snap.glob("*.tle"), key=lambda p: (p.name != "active.tle", p.name))
    cat.sources = [{"name": "celestrak_gp", "url": f"https://celestrak.org/NORAD/elements/gp.php?GROUP={p.stem}&FORMAT=tle",
                    "epochUtc": None, "fetchedAt": fetched} for p in files]
    omms = sorted(snap.glob("*.omm.json"))
    digest = hashlib.sha256()
    for p in [*files, *omms]:
        digest.update(p.name.encode() + b"\0" + p.read_bytes())
    cat.snapshot_id += f"-{digest.hexdigest()[:8]}"  # content hash: same files, same id (DATA-2)
    for p in files:
        load_tle_file(p, cat)
    for p in omms:
        load_omm_json(p, cat)
    _finish(cat, data_dir)
    return cat
