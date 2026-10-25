"""One test per finding of the adversarial code review (see docs/decisions.md, "Review findings")."""

import os

import numpy as np
import pytest

os.environ.setdefault("ORBIT_SERVICE_TOKEN", "test-token")
from fastapi.testclient import TestClient  # noqa: E402

from orbit import app as appmod  # noqa: E402
from orbit import rescreen as resc  # noqa: E402
from orbit.candidates import candidates  # noqa: E402
from orbit.catalog import epoch_unix  # noqa: E402
from orbit.conjunction import PropagationError, screen_one  # noqa: E402
from orbit.simulate import reload_sims, simulate  # noqa: E402
from orbit.track import Track  # noqa: E402
from orbit.verify import verify  # noqa: E402

client = TestClient(appmod.app)
H = {"X-Service-Token": appmod.TOKEN}


@pytest.mark.parametrize("oid", ["25544", "../../../tmp/x", "SIM-1", 7])
def test_simulate_rejects_catalog_ids_paths_and_bad_ids(fresh_catalog, tmp_path, oid):
    with pytest.raises(ValueError):
        simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z", "objectId": oid}, tmp_path)
    assert fresh_catalog.get("25544").simulated is False
    assert not any(tmp_path.rglob("*.json"))


def test_simulate_never_reuses_an_id_and_reload_skips_bad_files(fresh_catalog, tmp_path):
    a = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, tmp_path)
    b = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T07:00:00Z"}, tmp_path)
    assert (a["objectId"], b["objectId"]) == ("SIM-0001", "SIM-0002")
    (tmp_path / "sim" / "SIM-0003.json").write_text("{not json")
    from orbit.catalog import Catalog
    cat = Catalog("t", "", [])
    reload_sims(cat, tmp_path)
    assert set(cat.objects) == {"SIM-0001", "SIM-0002"} and cat.skipped


def test_moved_satellite_propagation_errors_refuse_instead_of_passing(catalog):
    sat = catalog.get("25544").sat

    class Failing(Track):
        def rv(self, ts):
            err, r, v = super().rv(ts)
            err = err.copy()
            err[np.atleast_1d(ts) > epoch_unix(sat) + 7200] = 6  # "decayed" two hours in
            return err, r, v

    t0 = epoch_unix(sat)
    with pytest.raises(PropagationError):
        screen_one(Failing(sat), [catalog.get("44713") or catalog.get("56123")], t0, t0 + 6 * 3600, 1.0)


def test_rescreen_turns_a_propagation_error_into_a_refusal(catalog, monkeypatch):
    def boom(*a, **k):
        raise PropagationError("the moved satellite fails to propagate (SGP4 error 6) within the horizon")
    monkeypatch.setattr(resc, "screen_one", boom)
    r = resc.rescreen(catalog, {"objectId": "25544", "partnerObjectId": "56123", "horizonH": 1,
                                "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}})
    assert r["passed"] is False and "fails to propagate" in r["refusalReason"]


def test_rescreen_input_validation(catalog):
    base = {"objectId": "25544", "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}}
    for bad in ({"horizonH": -1}, {"horizonH": 1000}, {"partnerObjectId": "25544"}):
        with pytest.raises(ValueError):
            resc.rescreen(catalog, {**base, **bad})


def test_rescreen_without_tca_searches_the_whole_horizon_and_labels_sim_partners(fresh_catalog):
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, None)
    # burn 20 h before the encounter, no tcaUtc: the encounter is 20 h into a 24 h horizon
    r = resc.rescreen(fresh_catalog, {"objectId": "25544", "partnerObjectId": s["objectId"], "horizonH": 24,
                                      "maneuver": {"burnTimeUtc": "2026-10-24T10:00:00Z", "deltaVMs": 0.001, "direction": "prograde"}})
    assert r["originalMissAfterKm"] < 1 and r["passed"] is False
    assert r["simulated"] is True


def test_candidates_rejects_a_self_pair(catalog):
    with pytest.raises(ValueError):
        candidates(catalog, {"objectA": "25544", "objectB": "25544", "tcaUtc": "2026-10-25T06:00:00Z"})


def test_verify_input_checks():
    r = {"objectId": "25544", "series": [{"epochUtc": "2026-10-22T00:00:00Z", "smaKm": 6798}] * 8}
    with pytest.raises(ValueError):
        verify({**r, "expected": {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaAKm": 0}}, None)
    with pytest.raises(ValueError):
        verify({**r, "expected": {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}}, {"series": []})
    v = verify({"objectId": "25544", "series": [{"epochUtc": "2026-10-22T00:00:00Z", "smaKm": 0}],
                "expected": {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}}, None)
    assert v["result"] == "awaiting_data" and any("ignored" in x for x in v["limitations"])


def test_http_edges():
    exp = {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}
    assert client.post("/verify", headers=H, json={"objectId": "999999999", "expected": exp}).status_code == 404
    assert client.post("/verify", headers=H, json={"objectId": "56123", "replay": "iss-simulated-reboost", "expected": exp}).status_code == 400
    assert client.post("/verify", headers=H, json={"objectId": "25544", "replay": ["x"], "expected": exp}).status_code == 404
    assert client.get("/snapshot", headers={"X-Service-Token": "tökén".encode("latin-1")}).status_code == 401
    assert client.post("/candidates", headers=H, json={"objectA": "25544", "objectB": "56123", "tcaUtc": "9999-01-01T00:00:00Z"}).status_code == 400
    srcs = client.get("/snapshot", headers=H).json()["sources"]
    assert len(srcs) >= 6 and all("celestrak.org/NORAD/elements/gp.php?" in s["url"] and s["sha256"] for s in srcs)


# ---- review round 2

def test_verify_rejects_bad_direction_kind_and_zero_mean_motion():
    base = {"objectId": "25544", "expected": {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}}
    with pytest.raises(ValueError):
        verify({**base, "expected": {**base["expected"], "direction": "upward"}}, None)
    with pytest.raises(ValueError):
        verify({**base, "kind": "garbage", "series": []}, None)
    with pytest.raises(ValueError):
        verify({**base, "kind": "live"}, {"series": []})  # a replay is not live evidence
    v = verify({**base, "series": [{"epochUtc": "2026-10-22T00:00:00Z", "meanMotionRevPerDay": 0}]}, None)
    assert v["elementSetCount"] == 0 and any("ignored" in x for x in v["limitations"])


def test_rescreen_validates_the_maneuver(catalog):
    base = {"objectId": "25544", "horizonH": 1, "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}}
    for bad in ({"deltaVMs": -0.05}, {"deltaVMs": 5}, {"direction": "Prograde"}):
        with pytest.raises(ValueError):
            resc.rescreen(catalog, {**base, "maneuver": {**base["maneuver"], **bad}})


def test_an_unrefinable_flagged_encounter_refuses_instead_of_passing(catalog, monkeypatch):
    import orbit.conjunction as conj
    sat = catalog.get("56123").sat
    t0 = epoch_unix(sat)
    moved = Track(sat)
    lo, hi = catalog.get("56123").perigee_apogee_km
    others = [o for o in catalog.objects.values() if o.object_id != "56123" and conj.band_overlaps(o, lo, hi, 30)][:1500]
    def broken(*a, **k):
        raise PropagationError("SGP4 error 6")
    monkeypatch.setattr(conj, "refine", broken)
    with pytest.raises(PropagationError, match="possible encounter"):
        screen_one(moved, others, t0, t0 + 6 * 3600, 25.0)
    # with a threshold that only the fringe reaches, an unrefinable pair is recorded, not a refusal
    uncovered = []
    hits, _ = screen_one(moved, others, t0, t0 + 6 * 3600, 0.001, uncovered=uncovered)
    assert hits == [] and all(u["linearEstimateKm"] >= 2.0 for u in uncovered)


def test_simulate_bounds_and_no_half_added_object(fresh_catalog, tmp_path):
    for bad in ({"tiltDeg": 45}, {"missKm": 50}, {"missKm": 0}):
        with pytest.raises(ValueError):
            simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z", **bad}, tmp_path)
    assert not any(o.simulated for o in fresh_catalog.objects.values())


def test_corrupt_replay_file_is_not_available(tmp_path):
    from orbit.verify import load_replay
    (tmp_path / "replay").mkdir()
    (tmp_path / "replay" / "broken.json").write_text("{nope")
    assert load_replay(tmp_path, "broken") is None


def test_health_answers_while_a_long_request_runs():
    import threading, time
    body = {"objectId": "56123", "partnerObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z",
            "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}}
    th = threading.Thread(target=lambda: client.post("/rescreen", headers=H, json=body))
    th.start()
    time.sleep(1.0)
    t = time.time()
    assert client.get("/health").json()["ok"]
    assert time.time() - t < 1.0
    th.join()



# ---- review round 4

def test_simulated_label_is_not_client_settable():
    exp = {"burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": 0.5}
    series = [{"epochUtc": f"2026-10-2{d}T0{h}:00:00Z", "smaKm": 6798.0} for d in (1, 2, 3) for h in (0, 8)]
    v = client.post("/verify", headers=H, json={"objectId": "25544", "series": series, "simulated": True, "expected": exp}).json()
    assert v["simulated"] is False and v["kind"] == "live"
