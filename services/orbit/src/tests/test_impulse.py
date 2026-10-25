import numpy as np
import pytest

from orbit.catalog import epoch_unix
from orbit.impulse import delta_a_km
from orbit.track import Track


@pytest.mark.parametrize("oid", ["25544", "56123", "43013"])
@pytest.mark.parametrize("direction", ["prograde", "retrograde"])
def test_burn_is_continuous_and_changes_velocity_by_dv(catalog, oid, direction):
    sat = catalog.get(oid).sat
    tb = epoch_unix(sat) + 1.5 * 86400
    plain, moved = Track(sat), Track.with_burn(sat, tb, 0.1, direction)
    _, r0, v0 = plain.rv(tb)
    _, r1, v1 = moved.rv(tb)
    assert np.linalg.norm(r1 - r0) * 1000 < 5          # metres
    assert abs(np.linalg.norm(v1 - v0) * 1000 - 0.1) < 0.002  # m/s
    # along-track drift after 12 h ≈ 3·Δv·t (first-order), within 15%
    _, ra, _ = plain.rv(tb + 43200)
    _, rb, _ = moved.rv(tb + 43200)
    assert np.linalg.norm(rb - ra) == pytest.approx(3 * 0.1e-3 * 43200, rel=0.15)


def test_zero_dv_reproduces_the_original_trajectory(catalog):
    sat = catalog.get("25544").sat
    tb = epoch_unix(sat) + 86400
    ts = tb + np.array([0, 3600, 86400, 3 * 86400])
    _, r0, _ = Track(sat).rv(ts)
    _, r1, _ = Track.with_burn(sat, tb, 0.0, "prograde").rv(ts)
    assert np.abs(r1 - r0).max() < 1e-9


def test_before_the_burn_nothing_changes(catalog):
    sat = catalog.get("25544").sat
    tb = epoch_unix(sat) + 86400
    _, r0, _ = Track(sat).rv(tb - 60)
    _, r1, _ = Track.with_burn(sat, tb, 0.2, "prograde").rv(tb - 60)
    assert np.array_equal(r0, r1)


def test_delta_a_is_two_dv_over_n(catalog):
    sat = catalog.get("25544").sat
    assert delta_a_km(sat, 0.1, "prograde") == pytest.approx(2 * 0.1e-3 / (sat.no_kozai / 60))
    assert delta_a_km(sat, 0.1, "retrograde") < 0
