import json
from pathlib import Path

import numpy as np
import pytest

from orbit.verify import load_replay, verify

DATA = Path(__file__).resolve().parents[2] / "data"
REPLAY = json.loads((DATA / "replay" / "iss-simulated-reboost.json").read_text())


def expected(**kw):
    return {"objectId": "25544", "expected": {"burnTimeUtc": REPLAY["burnTimeUtc"], "deltaVMs": 0.5, "direction": "prograde", **kw}}


def test_replay_is_consistent_and_labeled_simulated():
    v = verify(expected(), REPLAY)
    assert v["result"] == "consistent" and v["label"] == "evidence consistent with plan"
    assert v["kind"] == "replay" and v["simulated"] is True
    assert v["observed"]["z"] >= 5 and v["elementSetCount"] >= 8
    json.dumps(v)  # plain JSON types only


def test_wrong_direction_or_size_is_a_mismatch():
    assert verify(expected(direction="retrograde"), REPLAY)["result"] == "mismatch"
    assert verify(expected(deltaVMs=2.0), REPLAY)["result"] == "mismatch"


def test_too_few_sets_is_awaiting_not_mismatch():
    v = verify({**expected(), "series": REPLAY["series"][:6]}, None)
    assert v["result"] == "awaiting_data" and v["missing"]


def test_no_jump_is_awaiting_not_mismatch():
    flat = [{"epochUtc": s["epochUtc"], "smaKm": 6798.0 + 0.01 * (i % 2)} for i, s in enumerate(REPLAY["series"])]
    v = verify({**expected(), "series": flat}, None)
    assert v["result"] == "awaiting_data" and "above the noise" in v["missing"][0]


def test_zero_mad_uses_the_floor_and_mean_motion_input_works():
    n0 = 15.49  # rev/day
    series = [{"epochUtc": s["epochUtc"], "meanMotionRevPerDay": n0 - (0.0016 if s["epochUtc"] > REPLAY["burnTimeUtc"] else 0)}
              for s in REPLAY["series"]]
    v = verify({**expected(), "series": series}, None)
    assert v["observed"]["deltaAKm"] > 0 and np.isfinite(v["observed"]["z"])


def test_replay_names_are_file_stems_only():
    assert load_replay(DATA, "../../etc/passwd") is None
    assert load_replay(DATA, "iss-simulated-reboost")["simulated"] is True
