import pytest

from orbit.candidates import NotFound, candidates
from orbit.timeutil import parse_utc


def test_full_grid_plus_wait_in_a_policy_free_order(catalog, pair):
    out = candidates(catalog, pair)
    grid = out["candidates"]
    assert len(grid) == 2 * 3 * 4 * 2
    assert [c["rank"] for c in grid] == list(range(1, 49))
    assert {c["movingSide"] for c in grid} == {"A", "B"}
    assert all(c["estimatedFuelKg"] is None and c["indicative"] for c in grid)
    assert out["wait"]["kind"] == "wait" and out["wait"]["missAfterKm"] is None
    passing = [c["passesPairThreshold"] for c in grid]
    assert passing == sorted(passing, reverse=True)  # threshold-passing candidates first
    for c in grid:
        assert c["passesPairThreshold"] == (c["missAfterKm"] >= 1.0)


def test_same_input_same_output(catalog, pair):
    assert candidates(catalog, pair) == candidates(catalog, pair)


def test_burns_before_not_before_are_not_offered(catalog, pair):
    tca = parse_utc(candidates(catalog, pair)["tcaUtc"])
    from orbit.timeutil import iso
    out = candidates(catalog, {**pair, "notBeforeUtc": iso(tca - 7 * 3600)})
    assert {c["leadH"] for c in out["candidates"]} == {6, 3}


def test_our_tca_is_near_the_queue_tca(catalog, pair):
    # Different element-set epochs (SOCRATES run vs our snapshot) move objects by km (SCR-3: "data differs"),
    # so only the TCA is compared, loosely; the miss distance is reported, not asserted against SOCRATES.
    out = candidates(catalog, pair)
    assert abs(parse_utc(out["tcaUtc"]) - parse_utc(pair["tcaUtc"])) < 60
    assert 0 <= out["missBeforeKm"] < 25


def test_unknown_object(catalog, pair):
    with pytest.raises(NotFound):
        candidates(catalog, {**pair, "objectA": "999999999"})
