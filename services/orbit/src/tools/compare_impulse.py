"""Settles decision O3 by measurement: three ways to apply an along-track impulse to an SGP4 element set.

A: edit mean motion so a' = a + 2Δv/n, shift mean anomaly at epoch so M is continuous at the burn.
B: osculating Keplerian elements of the post-burn state → sgp4init at the burn epoch.
C (used): differential re-epoch (orbit/impulse.py + orbit/track.py).
Metrics at the burn: position jump (should be 0) and velocity jump (should be Δv). Run where the service runs (e.g. inside its container):
  python tools/compare_impulse.py
"""

import math
import sys
from pathlib import Path

import numpy as np
from sgp4.api import Satrec, WGS72

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orbit.catalog import MU, load_snapshot  # noqa: E402
from orbit.impulse import EPOCH_1949  # noqa: E402
from orbit.simulate import _coe  # noqa: E402
from orbit.timeutil import jd_split, jd_to_unix  # noqa: E402
from orbit.track import Track  # noqa: E402

DV = 0.1  # m/s


def rv(sat, t):
    jd, fr = jd_split(t)
    _, r, v = sat.sgp4(float(jd), float(fr))
    return np.array(r), np.array(v)


def method_a(sat, tb):
    n0 = sat.no_kozai / 60
    a0 = (MU / n0**2) ** (1 / 3)
    n1 = math.sqrt(MU / (a0 + 2 * DV / 1000 / n0) ** 3)
    dt = tb - jd_to_unix(sat.jdsatepoch, sat.jdsatepochF)
    out = Satrec()
    out.sgp4init(WGS72, "i", sat.satnum, sat.jdsatepoch + sat.jdsatepochF - EPOCH_1949, sat.bstar, sat.ndot, sat.nddot,
                 sat.ecco, sat.argpo, sat.inclo, (sat.mo - (n1 - n0) * dt) % (2 * math.pi), n1 * 60, sat.nodeo)
    return lambda t: rv(out, t)


def method_b(sat, tb):
    r, v = rv(sat, tb)
    v = v + DV / 1000 * v / np.linalg.norm(v)
    a, e, i, raan, w, m = _coe(r, v)
    jd, fr = jd_split(tb)
    out = Satrec()
    out.sgp4init(WGS72, "i", sat.satnum, float(jd) + float(fr) - EPOCH_1949, sat.bstar, 0, 0, e, w, i, m,
                 math.sqrt(MU / a**3) * 60, raan)
    return lambda t: rv(out, t)


def method_c(sat, tb):
    tr = Track.with_burn(sat, tb, DV, "prograde")
    return lambda t: tuple(x[0] for x in tr.rv(t)[1:])


if __name__ == "__main__":
    cat = load_snapshot(Path(__file__).resolve().parents[2] / "data")
    picks = ["25544", "44713", "56123", "48274", "43013"]  # ISS, Starlink, Starlink, CSS, a Starlink-era object
    print(f"{'object':<26}{'method':<8}{'pos jump m':>12}{'dv jump m/s':>13}")
    for oid in picks:
        o = cat.get(oid)
        if o is None:
            continue
        tb = jd_to_unix(o.sat.jdsatepoch, o.sat.jdsatepochF) + 1.5 * 86400
        r0, v0 = rv(o.sat, tb)
        for name, f in (("A", method_a), ("B", method_b), ("C", method_c)):
            r1, v1 = f(o.sat, tb)(tb)
            print(f"{o.name[:24]:<26}{name:<8}{np.linalg.norm(r1 - r0) * 1000:>12.1f}{np.linalg.norm(v1 - v0) * 1000:>13.4f}")
