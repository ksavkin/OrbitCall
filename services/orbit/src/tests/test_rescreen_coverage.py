"""Re-screen verdict fixes from the PR #14 review: an unscreened object never yields a pass, and the 1 km threshold
applies to the exact distance, not to the rounded one."""
from types import SimpleNamespace

import pytest

import orbit.rescreen as rescreen_mod
from orbit.rescreen import rescreen

# A maneuver that clears the pinned SOCRATES pair (63855 × 69019) with nothing else within 1 km over 24 h.
BODY = {"objectId": "63855", "partnerObjectId": "69019", "tcaUtc": "2026-10-24T01:58:13Z", "horizonH": 24,
        "maneuver": {"burnTimeUtc": "2026-10-23T13:58:13Z", "deltaVMs": 0.02, "direction": "retrograde"}}


@pytest.fixture
def baseline(catalog):
    r = rescreen(catalog, BODY)
    assert r["passed"] and not r.get("unpropagatedObjectIds"), r["refusalReason"]
    return r


def test_an_object_that_cannot_be_propagated_over_the_horizon_is_not_a_pass(catalog, baseline, monkeypatch):
    real = rescreen_mod.screen_one
    lost = sorted(o.object_id for o in catalog.objects.values() if o.object_id not in ("63855", "69019"))[0]

    def screen_one(*args, unpropagated=None, **kwargs):
        hits, checked = real(*args, unpropagated=unpropagated, **kwargs)
        assert unpropagated is not None, "rescreen must collect objects SGP4 cannot propagate"
        unpropagated.add(lost)  # as screen_one does when an object's SGP4 error appears mid-horizon
        return hits, checked

    monkeypatch.setattr(rescreen_mod, "screen_one", screen_one)
    r = rescreen(catalog, BODY)
    assert not r["passed"] and r["unpropagatedObjectIds"] == [lost]
    assert r["objectsChecked"] == baseline["objectsChecked"] - 1
    assert "could not be propagated" in r["refusalReason"] and lost in r["refusalReason"]


@pytest.mark.parametrize("exact_km, passes", [(0.9996, False), (1.0004, True)])
def test_the_threshold_applies_to_the_exact_original_miss(catalog, baseline, monkeypatch, exact_km, passes):
    real = rescreen_mod.closest
    calls = []

    def closest(*args, **kwargs):
        ap = real(*args, **kwargs)
        calls.append(ap)
        # The first call is the original encounter; both distances round to the same reported 1.0 km.
        return SimpleNamespace(miss_km=exact_km, tca_ts=ap.tca_ts) if len(calls) == 1 else ap

    monkeypatch.setattr(rescreen_mod, "closest", closest)
    r = rescreen(catalog, BODY)
    assert r["originalMissAfterKm"] == 1.0
    assert r["passed"] is passes
    if not passes:
        assert "0.9996 km" in r["refusalReason"]
