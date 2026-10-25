import shutil
from pathlib import Path

import pytest

from orbit.catalog import Catalog, decode_catnum, load_snapshot, load_tle_file


@pytest.fixture(autouse=True)
def _clean_snapshot_env(monkeypatch):
    """Snapshot selection reads the environment: each test starts from none of it."""
    for k in ("ORBIT_SNAPSHOT_ID", "ORBIT_SNAPSHOT_DIR", "ORBIT_OMM_DIR", "ORBIT_SOCRATES_DIR", "ORBIT_TLE_DIR"):
        monkeypatch.delenv(k, raising=False)


def test_alpha5_ids_decode_to_decimal_strings():
    assert decode_catnum("25544") == "25544"
    assert decode_catnum("A0001") == "100001"
    assert decode_catnum("Z9999") == "339999"


def test_real_mode_uses_the_team_snapshot_and_its_id(catalog, tle_catalog):
    # Default: the team's pinned GP snapshot (scripts/fetch_gp.py), the one Convex and the web use — same snapshotId.
    assert catalog.format == "omm" and catalog.snapshot_id == "gp-20261024T2134Z" and catalog.manifest["layout"] == "team"
    assert len(catalog.objects) == catalog.manifest["uniqueObjects"] and catalog.get("25544").name.startswith("ISS")
    assert tle_catalog.format == "tle" and tle_catalog.snapshot_id.startswith("celestrak-gp-2026-10-24T08:02:43Z-")


def test_the_lane_fetch_stays_selectable(lane_dir, monkeypatch):
    data = Path(__file__).resolve().parents[2] / "data"
    lane = lane_dir
    monkeypatch.setenv("ORBIT_SNAPSHOT_DIR", str(lane))
    own = load_snapshot(data, "omm")
    assert own.snapshot_id.startswith("celestrak-omm-") and own.manifest["layout"] == "lane"
    with pytest.raises(ValueError):
        load_snapshot(data, "auto")  # no other modes, no silent fallback


def test_the_team_repo_layout_loads_as_is(tmp_path):
    """ORBIT_DATA = the team repo's data/: snapshots/gp-*, snapshots/socrates-*, TLE in web/data/snapshot."""
    from orbit.catalog import socrates_paths, tle_dir
    data = Path(__file__).resolve().parents[2] / "data"
    repo = tmp_path / "OrbitCall"
    shutil.copytree(data / "snapshots" / "gp-20261024T2134Z", repo / "data" / "snapshots" / "gp-20261024T2134Z")
    soc = repo / "data" / "snapshots" / "socrates-20261024T0147Z"
    soc.mkdir(parents=True)
    shutil.copy(data / "snapshot" / "socrates.csv.gz", soc / "socrates.csv.gz")
    shutil.copy(data / "snapshot" / "socrates-manifest.json", soc / "manifest.json")
    (repo / "web" / "data" / "snapshot").mkdir(parents=True)
    for t in (data / "snapshot").glob("*.tle"):
        shutil.copy(t, repo / "web" / "data" / "snapshot" / t.name)
    cat = load_snapshot(repo / "data", "omm")
    assert cat.snapshot_id == "gp-20261024T2134Z" and cat.status  # SATCAT status read from the team's SOCRATES
    assert socrates_paths(repo / "data") == (soc / "socrates.csv.gz", soc / "manifest.json")
    assert tle_dir(repo / "data") == repo / "web" / "data" / "snapshot"
    assert len(load_snapshot(repo / "data", "tle").objects) > 18000


def test_omm_epochs_are_kept_as_given_not_round_tripped(catalog):
    from datetime import datetime, timezone

    from orbit.catalog import epoch_unix
    for oid in ("25544", "48274", "31021"):
        o = catalog.get(oid)
        given = datetime.fromisoformat(o.omm["EPOCH"]).replace(tzinfo=timezone.utc).timestamp()
        assert abs(epoch_unix(o.sat) - given) < 1e-3  # microseconds, not a TLE's rounded day fraction
        assert o.sat.no_kozai == pytest.approx(o.omm["MEAN_MOTION"] * 2 * 3.141592653589793 / 1440, rel=1e-12)


def test_real_mode_refuses_a_tampered_or_missing_omm_snapshot(tmp_path):
    from orbit.catalog import SnapshotMissing
    with pytest.raises(SnapshotMissing):
        load_snapshot(tmp_path, "omm")
    data = Path(__file__).resolve().parents[2] / "data"
    dst = tmp_path / "snapshots" / "gp-20261024T2134Z"
    shutil.copytree(data / "snapshots" / "gp-20261024T2134Z", dst)
    (dst / "stations.json").write_text("[]")
    with pytest.raises(SnapshotMissing, match="sha256"):
        load_snapshot(tmp_path, "omm")


def test_a_bad_record_is_skipped_and_recorded(tmp_path):
    good = ("ISS (ZARYA)\n1 25544U 98067A   26296.69304404  .00008515  00000+0  16237-3 0  9995\n"
            "2 25544  51.6336  24.1765 0006871 300.7285  59.3026 15.49021515591674\n")
    (tmp_path / "x.tle").write_text("JUNK\n1 garbage line\n2 more garbage\n" + good)
    cat = Catalog("t", "", [])
    load_tle_file(tmp_path / "x.tle", cat)
    assert list(cat.objects) == ["25544"]
    assert cat.skipped and "parse" in cat.skipped[0]["reason"]


def test_omm_record_without_an_id_is_skipped(tmp_path, catalog):
    import json

    from orbit.catalog import load_omm_json
    rec = dict(catalog.get("25544").omm)
    rec.pop("NORAD_CAT_ID")
    (tmp_path / "x.omm.json").write_text(json.dumps([rec]))
    cat = Catalog("t", "", [])
    load_omm_json(tmp_path / "x.omm.json", cat)
    assert not cat.objects and "NORAD_CAT_ID" in cat.skipped[0]["reason"]


def _team_data(tmp_path, *ids, pinned=None):
    """A team-layout data/ with GP snapshots under the given ids (same files) and, optionally, catalog-pairs.json
    naming the id Convex uses."""
    import json
    data = Path(__file__).resolve().parents[2] / "data"
    root = tmp_path / "data"
    for sid in ids:
        d = root / "snapshots" / sid
        shutil.copytree(data / "snapshots" / "gp-20261024T2134Z", d)
        m = json.loads((d / "manifest.json").read_text())
        (d / "manifest.json").write_text(json.dumps({**m, "snapshotId": sid}))
    if pinned:
        soc = root / "snapshots" / "socrates-20261024T0147Z"
        soc.mkdir(parents=True)
        (soc / "catalog-pairs.json").write_text(json.dumps({"omm": {"snapshotId": pinned}, "pairs": []}))
    return root


def test_the_snapshot_is_the_one_convex_uses_not_the_newest(tmp_path, monkeypatch):
    from orbit.catalog import SnapshotMissing
    monkeypatch.delenv("ORBIT_SNAPSHOT_DIR", raising=False)
    root = _team_data(tmp_path, "gp-20261024T2134Z", "gp-20261025T0000Z", pinned="gp-20261024T2134Z")
    assert load_snapshot(root, "omm").snapshot_id == "gp-20261024T2134Z"  # pinned by catalog-pairs, not newest
    monkeypatch.setenv("ORBIT_SNAPSHOT_ID", "gp-20261025T0000Z")
    assert load_snapshot(root, "omm").snapshot_id == "gp-20261025T0000Z"
    monkeypatch.setenv("ORBIT_SNAPSHOT_ID", "gp-20991231T0000Z")
    with pytest.raises(SnapshotMissing, match="Convex uses"):
        load_snapshot(root, "omm")


def test_no_silent_switch_to_the_lane_fetch(tmp_path, monkeypatch, lane_dir):
    from orbit.catalog import SnapshotMissing
    monkeypatch.delenv("ORBIT_SNAPSHOT_DIR", raising=False)
    lane = lane_dir
    shutil.copytree(lane, tmp_path / "data" / "omm" / lane.name)
    with pytest.raises(SnapshotMissing, match="no team OMM snapshot"):
        load_snapshot(tmp_path / "data", "omm")
    monkeypatch.setenv("ORBIT_SNAPSHOT_DIR", str(tmp_path / "data" / "omm" / lane.name))
    own = load_snapshot(tmp_path / "data", "omm")
    assert own.snapshot_id.startswith("celestrak-omm-") and own.snapshot_id != "gp-20261024T2134Z"


def test_an_inconsistent_team_snapshot_is_refused(tmp_path, monkeypatch):
    import json

    from orbit.catalog import SnapshotInvalid
    monkeypatch.delenv("ORBIT_SNAPSHOT_DIR", raising=False)
    root = _team_data(tmp_path, "gp-20261024T2134Z")
    d = root / "snapshots" / "gp-20261024T2134Z"
    (d / "gnss.json").unlink()
    with pytest.raises(SnapshotInvalid, match="missing"):
        load_snapshot(root, "omm")
    root2 = _team_data(tmp_path / "b", "gp-20261024T2134Z")
    m = root2 / "snapshots" / "gp-20261024T2134Z" / "manifest.json"
    m.write_text(json.dumps({**json.loads(m.read_text()), "snapshotId": "gp-other"}))
    with pytest.raises(SnapshotInvalid, match="not its directory"):
        load_snapshot(root2, "omm")


def test_validation_without_a_socrates_reference_is_reported(tmp_path, tle_catalog):
    from orbit import validation
    from orbit.catalog import SnapshotMissing
    with pytest.raises(SnapshotMissing, match="validation is unavailable"):
        validation.run_validation(tle_catalog, tmp_path)


def test_any_expected_id_and_strict_team_manifests(tmp_path, monkeypatch):
    import json

    from orbit.catalog import SnapshotInvalid, SnapshotMissing
    root = _team_data(tmp_path, "custom-snapshot-1")  # not gp-*: still found by its id
    monkeypatch.setenv("ORBIT_SNAPSHOT_ID", "custom-snapshot-1")
    assert load_snapshot(root, "omm").snapshot_id == "custom-snapshot-1"
    m = root / "snapshots" / "custom-snapshot-1" / "manifest.json"
    data = json.loads(m.read_text())
    m.write_text(json.dumps({k: v for k, v in data.items() if k != "snapshotId"}))
    with pytest.raises(SnapshotInvalid, match="not its directory"):  # an id-less team manifest is not "lane"
        load_snapshot(root, "omm")
    m.write_text(json.dumps({k: v for k, v in data.items() if k != "takenAt"}))
    with pytest.raises(SnapshotInvalid, match="takenAt"):
        load_snapshot(root, "omm")
    monkeypatch.delenv("ORBIT_SNAPSHOT_ID")
    odd = tmp_path / "odd"
    (odd / "manifest.json").mkdir(parents=True)  # a directory where the file should be
    monkeypatch.setenv("ORBIT_SNAPSHOT_DIR", str(odd))
    with pytest.raises(SnapshotMissing):
        load_snapshot(root, "omm")


def test_malformed_inputs_are_snapshot_errors_never_raw_exceptions(tmp_path, monkeypatch):
    import json

    from orbit.catalog import SnapshotInvalid, expected_snapshot_id
    monkeypatch.setenv("ORBIT_SNAPSHOT_ID", "/tmp/evil")
    with pytest.raises(SnapshotInvalid, match="plain name"):
        load_snapshot(tmp_path, "omm")
    monkeypatch.setenv("ORBIT_SNAPSHOT_ID", "..")
    with pytest.raises(SnapshotInvalid):
        load_snapshot(tmp_path, "omm")
    monkeypatch.delenv("ORBIT_SNAPSHOT_ID")
    root = _team_data(tmp_path, "gp-20261024T2134Z")
    m = root / "snapshots" / "gp-20261024T2134Z" / "manifest.json"
    good = json.loads(m.read_text())
    for bad in ([], {**good, "files": [{}]}, {**good, "files": ["x"]},
                {**good, "files": [{**good["files"][0], "file": "../stations.json"}]}):
        m.write_text(json.dumps(bad))
        with pytest.raises(SnapshotInvalid):
            load_snapshot(root, "omm")
    soc = root / "snapshots" / "socrates-20261024T0147Z"
    soc.mkdir()
    for junk in ("[]", '{"omm": "x"}', "not json"):  # unusable catalog-pairs files are skipped
        (soc / "catalog-pairs.json").write_text(junk)
        assert expected_snapshot_id(root) is None
