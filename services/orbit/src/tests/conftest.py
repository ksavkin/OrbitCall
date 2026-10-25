from pathlib import Path

import pytest

from orbit.catalog import load_snapshot

DATA = Path(__file__).resolve().parents[2] / "data"


@pytest.fixture(scope="session")
def catalog():
    """Real mode: the pinned OMM snapshot."""
    return load_snapshot(DATA, "omm")


@pytest.fixture(scope="session")
def tle_catalog():
    """Development mode / validation snapshot: the team's TLE files (closest to the SOCRATES run)."""
    return load_snapshot(DATA, "tle")


@pytest.fixture(scope="session")
def pair():
    """A fixed real SOCRATES row (run 2026-10-24T01:47Z, sort-minRange.csv, unchanged in the team data): STARLINK-33969
    × PELICAN-9 at 2026-10-24 01:58:13.157, 0.600 km. Pinned by ids, not by the order of catalog-pairs.json (the team
    rebuilds that file)."""
    return {"objectA": "63855", "objectB": "69019", "tcaUtc": "2026-10-24T01:58:13.157Z", "socratesMissKm": 0.6}


@pytest.fixture
def lane_dir():
    """The service's own CelesTrak OMM fetch (data/omm/<fetch>/). It is not in git: the tests that read it skip
    without it. Unpack it from the delivery archive into data/omm/ to run them."""
    dirs = sorted(p for p in (DATA / "omm").glob("*") if p.is_dir())
    if not dirs:
        pytest.skip("the service's own OMM fetch is not in data/omm (not committed)")
    return dirs[-1]


@pytest.fixture
def fresh_catalog():
    return load_snapshot(DATA, "omm")
