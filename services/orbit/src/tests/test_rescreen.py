import numpy as np
import pytest

from orbit.candidates import candidates
from orbit.catalog import epoch_unix
from orbit.conjunction import band_overlaps, screen_one
from orbit.rescreen import rescreen
from orbit.simulate import simulate
from orbit.timeutil import iso
from orbit.track import Track


def test_rescreen_agrees_with_candidates_and_its_verdict_follows_the_rule(catalog, pair):
    c = candidates(catalog, pair)
    best = c["candidates"][0]
    partner = pair["objectB"] if best["movingSide"] == "A" else pair["objectA"]
    r = rescreen(catalog, {"objectId": best["movingObjectId"], "partnerObjectId": partner, "tcaUtc": c["tcaUtc"],
                           "maneuver": {k: best[k] for k in ("burnTimeUtc", "deltaVMs", "direction")}})
    assert r["originalMissAfterKm"] == pytest.approx(best["missAfterKm"], abs=0.01)  # same SGP4 geometry
    assert r["passed"] == (r["originalMissAfterKm"] >= 1 and not r["newConjunctions"])
    assert r["objectsChecked"] > 1000 and r["horizonH"] == 72
    for n in r["newConjunctions"]:
        assert n["missKm"] < 1 and "withoutManeuverKm" in n
    # every reported hit is real: an independent dense check (5 ms steps) finds it under 1 km
    if r["newConjunctions"]:
        from orbit.timeutil import parse_utc
        n = r["newConjunctions"][0]
        moved = Track.with_burn(catalog.get(best["movingObjectId"]).sat, parse_utc(best["burnTimeUtc"]), best["deltaVMs"], best["direction"])
        ts = parse_utc(n["tcaUtc"]) + np.arange(-2, 2, 0.005)  # tcaUtc is rounded to the second; ~10 km/s
        _, a, _ = moved.rv(ts)
        _, b, _ = Track(catalog.get(n["objectId"]).sat).rv(ts)
        assert np.linalg.norm(a - b, axis=1).min() < 1.05


def test_refuses_when_the_original_pair_stays_close(fresh_catalog):
    s = simulate(fresh_catalog, {"targetObjectId": "25544", "tcaUtc": "2026-10-25T06:00:00Z"}, None)
    r = rescreen(fresh_catalog, {"objectId": s["objectId"], "partnerObjectId": "25544", "tcaUtc": s["event"]["tcaUtc"],
                                 "maneuver": {"burnTimeUtc": "2026-10-25T05:00:00Z", "deltaVMs": 0.001, "direction": "prograde"},
                                 "horizonH": 6})
    assert not r["passed"] and r["originalMissAfterKm"] < 1 and "original pair" in r["refusalReason"]


def test_without_a_partner_it_never_passes(catalog):
    r = rescreen(catalog, {"objectId": "25544", "horizonH": 1,
                           "maneuver": {"burnTimeUtc": "2026-10-24T12:00:00Z", "deltaVMs": 0.05, "direction": "prograde"}})
    assert not r["passed"] and "partner not given" in r["refusalReason"]


def test_coarse_pass_misses_nothing_a_dense_brute_force_finds(catalog):
    """Soundness of the 60 s linear estimate: brute force at 2 s over 6 h, threshold 25 km, LEO shell."""
    moved_obj = catalog.get("56123")
    t0 = epoch_unix(moved_obj.sat) + 3600
    moved = Track.with_burn(moved_obj.sat, t0, 0.1, "prograde")
    lo, hi = moved_obj.perigee_apogee_km
    others = [o for o in catalog.objects.values() if o.object_id != "56123" and band_overlaps(o, lo, hi, 30)][:1500]
    hits, _ = screen_one(moved, others, t0, t0 + 6 * 3600, 25.0)
    found = {h.object_id for h in hits}
    ts = np.arange(t0, t0 + 6 * 3600, 2.0)
    _, rm, _ = moved.rv(ts)
    brute = set()
    for o in others:
        _, r, _ = Track(o.sat).rv(ts)
        if np.linalg.norm(r - rm, axis=1).min() < 24.0:  # 1 km under the threshold: sampling at 2 s can only overestimate
            brute.add(o.object_id)
    assert brute, "the test needs at least one close approach to be meaningful"
    assert brute <= found
