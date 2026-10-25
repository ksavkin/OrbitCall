import pytest

from orbit.candidates import candidates
from orbit.simulate import reload_sims, simulate
from orbit.catalog import Catalog


def test_sim_meets_the_target_with_the_requested_geometry(fresh_catalog, tmp_path):
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, tmp_path)
    assert s["objectId"] == "SIM-0001" and s["simulated"] and s["event"]["simulated"]
    assert s["event"]["missKm"] == pytest.approx(0.2, abs=0.05)
    assert s["event"]["relSpeedKmS"] == pytest.approx(7.66 * 0.0524, rel=0.1)  # |v|·tilt(3°)
    assert fresh_catalog.get("SIM-0001").simulated
    again = Catalog("t", "", [])
    reload_sims(again, tmp_path)
    assert again.get("SIM-0001").sat.no_kozai == fresh_catalog.get("SIM-0001").sat.no_kozai


def test_sim_conjunction_has_at_least_two_passing_candidates(fresh_catalog):
    """SCR-10: the geometry must leave at least two feasible options."""
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, None)
    out = candidates(fresh_catalog, {"objectA": "25544", "objectB": s["objectId"], "tcaUtc": s["event"]["tcaUtc"]})
    assert out["simulated"] and sum(c["passesPairThreshold"] for c in out["candidates"]) >= 2


def test_default_sim_meets_the_target_once_and_cheap_candidates_pass_the_rescreen(fresh_catalog):
    """The default scenario (Δa +20 km) has one close encounter, not one per node crossing, so a cheap candidate of
    either side passes the 72 h whole-catalog re-screen; docked ISS modules move with the ISS / count as the ISS."""
    from orbit.conjunction import screen_one
    from orbit.rescreen import rescreen
    from orbit.timeutil import parse_utc
    from orbit.track import Track
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T09:45:41Z"}, None)
    t = parse_utc(s["event"]["tcaUtc"])
    sim, iss = fresh_catalog.get(s["objectId"]), fresh_catalog.get("25544")
    assert s["event"]["missKm"] == pytest.approx(0.2, abs=0.05) and s["event"]["relSpeedKmS"] == pytest.approx(0.40, abs=0.03)
    hits, _ = screen_one(Track(sim.sat), [iss], t - 12 * 3600, t + 12 * 3600, 5.0)
    assert len(hits) == 1 and abs(hits[0].approach.tca_ts - t) < 60
    out = candidates(fresh_catalog, {"objectA": "25544", "objectB": s["objectId"], "tcaUtc": s["event"]["tcaUtc"],
                                     "notBeforeUtc": "2026-10-25T00:00:00Z"})
    for side, partner in (("A", s["objectId"]), ("B", "25544")):
        best = next(c for c in out["candidates"] if c["movingSide"] == side and c["passesPairThreshold"])
        r = rescreen(fresh_catalog, {"objectId": best["movingObjectId"], "partnerObjectId": partner, "tcaUtc": out["tcaUtc"],
                                     "maneuver": {k: best[k] for k in ("burnTimeUtc", "deltaVMs", "direction")}})
        assert r["passed"], r["refusalReason"]
        modules = r["attachedObjectIds"] if side == "A" else r["partnerAttachedObjectIds"]
        assert "25575" in modules and "26400" in modules  # UNITY, ZVEZDA
        assert not any(n["objectId"] in modules for n in r["newConjunctions"])


def test_a_later_pass_of_the_partner_station_is_listed_once(fresh_catalog):
    """The co-orbital geometry (Δa 0) re-meets the ISS cluster: one entry with the docked bodies attached."""
    from orbit.rescreen import rescreen
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T09:45:41Z", "deltaAKm": 0}, None)
    r = rescreen(fresh_catalog, {"objectId": s["objectId"], "partnerObjectId": "25544", "tcaUtc": s["event"]["tcaUtc"],
                                 "maneuver": {"burnTimeUtc": "2026-10-25T03:45:41Z", "deltaVMs": 0.05, "direction": "prograde"},
                                 "horizonH": 24})
    station = [n for n in r["newConjunctions"] if n["objectId"] == "25544"]
    assert station and all("25575" in n["attachedObjectIds"] for n in station)
    assert not any(n["objectId"] in r["partnerAttachedObjectIds"] for n in r["newConjunctions"])


def test_attachment_is_a_shared_element_set_not_proximity(fresh_catalog):
    """A co-orbital free-flyer metres away is screened as usual; only bodies published with the same element set
    (docked modules and vehicles) are attached."""
    from orbit.conjunction import attached_to
    iss = fresh_catalog.get("25544")
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T09:45:41Z", "deltaAKm": 0,
                                 "tiltDeg": 0.001, "missKm": 0.05}, None)
    near = fresh_catalog.get(s["objectId"])
    docked = attached_to(iss, list(fresh_catalog.objects.values()))
    assert {"25575", "26400", "26700"} <= set(docked) and near.object_id not in docked
    assert attached_to(iss, [near]) == []
