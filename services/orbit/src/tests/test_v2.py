"""Contract v2: /screen, /validation, object classification, the optional v2 fields of /candidates and /rescreen."""

import json


import pytest

from orbit import validation
from orbit.candidates import candidates
from orbit.objects import classify
from orbit.rescreen import rescreen
from orbit.screen import SnapshotMismatch, screen
from orbit.simulate import simulate
from orbit.timeutil import iso, parse_utc


def test_classification_never_claims_a_real_object_is_maneuverable(catalog, fresh_catalog):
    iss = classify(catalog, catalog.get("25544"))
    assert (iss["kind"], iss["maneuverability"]) == ("payload", "unknown")
    deb = classify(catalog, catalog.get("31021"))  # FENGYUN 1C DEB
    assert (deb["kind"], deb["maneuverability"]) == ("debris", "non_maneuverable")
    rb = next(o for o in catalog.objects.values() if " R/B" in o.name)
    assert classify(catalog, rb)["kind"] == "rocket_body"
    assert all(classify(catalog, o)["maneuverability"] != "maneuverable" for o in catalog.objects.values() if not o.simulated)
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, None)
    assert classify(fresh_catalog, fresh_catalog.get(s["objectId"]))["maneuverability"] == "maneuverable"


def test_candidates_move_only_allowed_and_maneuverable_objects(catalog, pair):
    only_a = candidates(catalog, {**pair, "allowedMovingObjectIds": [pair["objectA"]], "evidenceVersion": "ev-1",
                                  "snapshotId": catalog.snapshot_id})
    assert {c["movingObjectId"] for c in only_a["candidates"]} == {pair["objectA"]}
    assert only_a["evidenceVersion"] == "ev-1" and only_a["notMovable"][0]["objectId"] == pair["objectB"]
    debris = candidates(catalog, {"objectA": pair["objectA"], "objectB": "31021", "tcaUtc": pair["tcaUtc"]})
    assert debris["candidates"] and all(c["movingObjectId"] == pair["objectA"] for c in debris["candidates"])
    assert debris["objects"]["31021"]["kind"] == "debris"
    assert len(candidates(catalog, pair)["candidates"]) == 48  # v1 callers: no new fields, same grid
    nobody = candidates(catalog, {**pair, "allowedMovingObjectIds": []})
    assert nobody["candidates"] == [] and nobody["wait"]["kind"] == "wait" and len(nobody["notMovable"]) == 2
    assert any("not confirmed" in a for a in only_a["assumptions"])


def test_a_stale_snapshot_is_refused_everywhere(catalog, pair):
    for fn, body in ((candidates, pair), (rescreen, {"objectId": "25544", "maneuver": {}}),
                     (screen, {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z"})):
        with pytest.raises(SnapshotMismatch):
            fn(catalog, {**body, "snapshotId": "celestrak-gp-old"})


def test_rescreen_window_from_to(catalog):
    body = {"objectId": "25544", "evidenceVersion": "ev-2",
            "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}}
    r = rescreen(catalog, {**body, "fromUtc": "2026-10-24T11:00:00Z", "toUtc": "2026-10-24T13:00:00Z"})
    assert r["horizonH"] == 1 and r["toUtc"] == "2026-10-24T13:00:00Z" and r["evidenceVersion"] == "ev-2"
    assert r["fromUtc"] == "2026-10-24T11:00:00Z" and r["screenedFromUtc"] == "2026-10-24T12:00:00Z"
    with pytest.raises(ValueError):
        rescreen(catalog, {**body, "fromUtc": "2026-10-24T12:30:00Z", "toUtc": "2026-10-24T13:00:00Z"})
    with pytest.raises(ValueError):  # both or neither
        rescreen(catalog, {**body, "toUtc": "2026-10-24T13:00:00Z"})
    with pytest.raises(ValueError, match="cannot be the moving object"):
        rescreen(catalog, {**body, "objectId": "31021"})


def test_screen_dedupes_a_pair_of_two_primaries_and_discloses_coverage(tle_catalog, pair):
    catalog = tle_catalog  # the SOCRATES pair meets at its listed TCA on the element sets of that day
    t = parse_utc(pair["tcaUtc"])
    win = {"fromUtc": iso(t - 1800), "toUtc": iso(t + 1800), "scanId": "s-1", "snapshotId": catalog.snapshot_id}
    ab = screen(catalog, {**win, "primaryObjectIds": [pair["objectA"], pair["objectB"], pair["objectA"]]})
    mine = [e for e in ab["events"] if {e["objectA"], e["objectB"]} == {pair["objectA"], pair["objectB"]}]
    first = min((pair["objectA"], pair["objectB"]), key=int)  # canonical A/B: catalog number order
    assert len(mine) == 1 and mine[0]["objectA"] == first and mine[0]["missKm"] < 5
    assert sorted(mine[0]["primaries"]) == sorted([pair["objectA"], pair["objectB"]])
    assert mine[0]["spread"]["gpMissKm"] == mine[0]["missKm"] and mine[0]["spread"]["supgpMissKm"] is None
    assert abs(parse_utc(mine[0]["tcaUtc"]) - t) < 60  # the SOCRATES pair is found at its TCA
    assert ab["counts"]["primaryObjects"] == 2 and ab["coverage"]["complete"] and ab["scanId"] == "s-1"
    assert all(e["objectA"] != e["objectB"] and e["missKm"] < 5 and e["relSpeedKmS"] >= 0.1 for e in ab["events"])
    assert all(e["objectA"] in ab["objects"] and e["objectB"] in ab["objects"] for e in ab["events"])
    ba = screen(catalog, {**win, "scanId": "s-2", "primaryObjectIds": [pair["objectB"], pair["objectA"]]})
    assert ba["cached"] and ba["scanId"] == "s-2" and ba["events"] == ab["events"]  # order of primaries is irrelevant
    gone = screen(catalog, {**win, "primaryObjectIds": [pair["objectA"], "999999999"]})
    assert not gone["coverage"]["complete"] and gone["missingPrimaryIds"] == ["999999999"]
    assert {"reason": "primary not in the snapshot", "count": 1} in gone["coverage"]["reasons"]


def test_screen_deadline_returns_an_honest_partial_result(catalog, monkeypatch):
    from orbit import screen as scr
    monkeypatch.setattr(scr, "DEADLINE_S", -1.0)
    r = screen(catalog, {"primaryObjectIds": ["25544", "63855"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T09:00:00Z"})
    assert r["coverage"]["timedOut"] and not r["coverage"]["complete"] and r["counts"]["primariesCompleted"] == 0
    assert {"reason": "primaries not screened before the deadline", "count": 2} in r["coverage"]["reasons"]


def test_screen_lists_a_formation_flyer_as_colocated_not_as_events(fresh_catalog):
    # A free-flyer metres from the ISS on nearly the same orbit (its own element set): slow and close for hours.
    f = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-24T09:00:00Z", "deltaAKm": 0,
                                 "tiltDeg": 0.001, "missKm": 0.05}, None)["objectId"]
    r = screen(fresh_catalog, {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T10:00:00Z"})
    assert any(f in (c["objectA"], c["objectB"]) and c["minDistanceKm"] < 5 for c in r["coLocated"])
    assert not any(f in (e["objectA"], e["objectB"]) for e in r["events"])
    assert "25575" in r["dockedBodies"]["25544"]  # docked modules: the primary itself, neither events nor co-located


@pytest.mark.parametrize("body", [{"primaryObjectIds": [], "fromUtc": "2026-10-24T08:00:00Z"},
                                  {"primaryObjectIds": ["25544"]},
                                  {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T07:00:00Z"},
                                  {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-11-24T08:00:00Z"}])
def test_screen_rejects_bad_requests(catalog, body):
    with pytest.raises(ValueError):
        screen(catalog, body)


def test_validation_accounts_for_every_reference_row(tle_catalog):
    from conftest import DATA
    v = validation.run_validation(tle_catalog, DATA, max_primaries=1)
    assert v["referenceRows"] == v["eligible"] + sum(x["count"] for x in v["excluded"])  # every row accounted for
    assert v["inScopeRows"] == v["eligible"] + v["dataDiffers"] and v["eligible"] >= 1
    assert v["eligible"] == v["matched"] + v["unmatched"] + v["notScreened"]
    assert v["recall"] == pytest.approx(v["matched"] / (v["matched"] + v["unmatched"]), abs=1e-4)
    assert not v["scopeComplete"] and v["notScreened"] > 0 and v["primaries"]["screened"] == 1  # test-only limit
    # geometry/time error covers every eligible row, independent of the detection limit
    assert v["tcaErrorS"]["n"] == v["eligible"] - v["geometryFailed"] and v["tcaErrorS"]["p95"] <= 60
    assert v["matchToleranceS"] == 60 and v["horizonH"] == 72 and v["snapshotFormat"] == "tle" and not v["simulated"]


def test_cover_picks_the_fewest_primaries_deterministically():
    rows = [("1", "2"), ("1", "3"), ("4", "5"), ("2", "3")]
    assert validation.cover(rows) == ["1", "2", "4"]


def test_validation_cache_serves_once_ready_and_retries_a_failure(catalog, tmp_path, monkeypatch):
    calls = []

    def fake(cat, data_dir, sample=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return {"snapshotId": cat.snapshot_id, "eligible": 0}

    monkeypatch.setattr(validation, "run_validation", fake)
    from conftest import DATA
    (tmp_path / "snapshot").mkdir()
    (tmp_path / "snapshot" / "socrates-manifest.json").write_text((DATA / "snapshot" / "socrates-manifest.json").read_text())
    cache = validation.ValidationCache(catalog, tmp_path)
    assert cache.get() == (None, "running") and "9fe9b11f" in cache.path.name
    cache.thread.join(5)
    res, state = cache.get()  # the failure is reported once and the run restarts
    assert res is None and state.startswith("failed: boom")
    cache.thread.join(5)
    assert cache.get()[1] == "ready" and json.loads(cache.path.read_text())["eligible"] == 0
    assert validation.ValidationCache(catalog, tmp_path).get()[1] == "ready"  # a restart reads the file



def test_slow_filter_never_hides_a_brief_pass_and_the_engine_honors_a_deadline(tle_catalog, pair):
    catalog = tle_catalog
    import time as _t

    from orbit.conjunction import DeadlineExceeded, screen_one
    from orbit.track import Track
    t = parse_utc(pair["tcaUtc"])
    a, b = catalog.get(pair["objectA"]), catalog.get(pair["objectB"])
    near: dict = {}
    # Every sample counts as "slow" here, yet a pass of a minute or two is not persistent, so it is refined as a hit.
    hits, _ = screen_one(Track(a.sat), [b], t - 1800, t + 1800, 5.0, min_rel_speed_km_s=100.0, colocated=near)
    assert hits and abs(hits[0].approach.tca_ts - t) < 60 and not near
    with pytest.raises(DeadlineExceeded):
        screen_one(Track(a.sat), [b], t - 1800, t + 1800, 5.0, deadline=_t.monotonic() - 1)


def test_screen_cache_is_per_catalog_view(fresh_catalog):
    body = {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T09:00:00Z"}
    assert not screen(fresh_catalog, body)["cached"] and screen(fresh_catalog, body)["cached"]
    simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-24T08:30:00Z"}, None)
    after = screen(fresh_catalog, body)
    assert not after["cached"] and any(e["simulated"] for e in after["events"])  # the new SIM object is screened


def test_socrates_time_parser_accepts_whole_seconds():
    assert validation._ts("2026-10-29 21:46:38") == validation._ts("2026-10-29 21:46:38.000")


def test_classification_order_and_status_everywhere(catalog):
    from orbit.catalog import Obj
    sat = catalog.get("25544").sat
    assert classify(catalog, Obj("1", "SL-16 R/B", sat, group="cosmos-2251-debris"))["kind"] == "rocket_body"
    assert classify(catalog, Obj("2", "COSMOS 2251 DEB", sat, group="active"))["kind"] == "debris"
    catalog.status["3"] = "-"
    try:
        dead = classify(catalog, Obj("3", "OLDSAT", sat, group="other"))
        assert (dead["kind"], dead["maneuverability"]) == ("unknown", "non_maneuverable")
    finally:
        del catalog.status["3"]


def test_corrupt_validation_cache_is_recomputed(catalog, tmp_path, monkeypatch):
    monkeypatch.setattr(validation, "run_validation", lambda cat, d, sample=None: {"eligible": 1})
    cache = validation.ValidationCache(catalog, tmp_path)
    cache.path.parent.mkdir(parents=True)
    cache.path.write_text("{not json")
    assert cache.get() == (None, "running")
    cache.thread.join(5)
    assert cache.get() == ({"eligible": 1}, "ready")


def test_screen_discloses_objects_it_could_not_propagate(catalog):
    r = screen(catalog, {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T09:00:00Z"})
    assert isinstance(r["unpropagatedObjectIds"], list)
    assert r["coverage"]["complete"] == (not r["unpropagatedObjectIds"] and not r["uncovered"] and not r["missingPrimaryIds"])
    failed = {u["objectId"] for u in r["uncovered"] if "primaryObjectId" not in u}
    distinct = set(r["missingPrimaryIds"]) | set(r["unpropagatedObjectIds"]) | failed
    assert r["coverage"]["excludedObjects"] == len(distinct) + len(catalog.skipped)


def test_colocated_needs_one_unbroken_hour(fresh_catalog):
    from orbit.conjunction import screen_one
    from orbit.track import Track
    f = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-24T09:00:00Z", "deltaAKm": 0,
                                 "tiltDeg": 0.001, "missKm": 0.05}, None)["objectId"]
    t0 = parse_utc("2026-10-24T08:45:00Z")
    near: dict = {}
    # 30 minutes side by side is not an unbroken hour: refined and reported like any encounter, never hidden.
    hits, _ = screen_one(Track(fresh_catalog.get("25544").sat), [fresh_catalog.get(f)], t0, t0 + 1800, 5.0,
                         min_rel_speed_km_s=0.1, colocated=near)
    assert hits and not near


def test_a_primary_is_never_in_conjunction_with_its_own_docked_bodies(catalog):
    # Under an hour the docked modules are not "co-located" by the slow-pass rule; they share the element set.
    r = screen(catalog, {"primaryObjectIds": ["25544"], "fromUtc": "2026-10-24T08:00:00Z", "toUtc": "2026-10-24T08:30:00Z"})
    docked = set(r["dockedBodies"]["25544"])
    assert {"25575", "26400"} <= docked
    assert not any({e["objectA"], e["objectB"]} & docked for e in r["events"]) and not r["coLocated"]


def test_rescreen_refuses_a_tca_before_the_burn(catalog):
    with pytest.raises(ValueError, match="after the burn"):
        rescreen(catalog, {"objectId": "25544", "partnerObjectId": "48274", "tcaUtc": "2026-10-24T11:00:00Z",
                           "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}})
