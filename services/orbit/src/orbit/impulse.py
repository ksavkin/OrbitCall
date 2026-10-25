"""Applying an along-track impulse to an element set, so the moved satellite is propagated with the same SGP4.

Method (indicative, see docs/decisions.md O3):
1. Propagate the original element set to the burn time: TEME state (r, v) and SGP4's mean elements at that time
   (nm, em, im, Om, om, mm — the secular-updated Brouwer elements SGP4 exposes after a call).
2. Add Δv along v̂ (prograde +, retrograde −) and take the two-body change of the osculating orbit in
   non-singular form: Δa, Δ(e·cosω), Δ(e·sinω), Δ(ω+M). Inclination and node do not change for an in-plane burn.
3. Re-epoch: a new element set with epoch = burn time, mean elements = SGP4's mean elements at the burn plus those
   deltas. sgp4init takes a Kozai mean motion and converts it to Brouwer internally; we solve for the Kozai value
   that reproduces the target Brouwer value (fixed point, converges in a few steps).
4. Re-epoching alone is off by 0.5–3 km (SGP4's internal mean elements are not exactly re-initializable), so the
   moved trajectory is differential (track.Track): original(t) + [re-epoched with Δv](t) − [re-epoched with 0](t).
   The common re-epoch error cancels. Measured: position jump at the burn < 1 m, velocity jump = Δv to 0.3%,
   orbit-mean radius change within ~30% of 2·Δv/n (tests/test_impulse.py).
"""

import math

import numpy as np
from sgp4.api import Satrec, WGS72

from .catalog import MU
from .timeutil import jd_split

EPOCH_1949 = 2433281.5  # sgp4init epoch is days since 1949-12-31 00:00 UT


def _nonsingular(r: np.ndarray, v: np.ndarray) -> tuple[float, float, float, float]:
    """Two-body (a, e·cosω, e·sinω, ω+M) of a state; stable for near-circular orbits."""
    rn, v2 = np.linalg.norm(r), v @ v
    a = 1.0 / (2.0 / rn - v2 / MU)
    h = np.cross(r, v)
    e_vec = ((v2 - MU / rn) * r - (r @ v) * v) / MU
    node = np.cross([0.0, 0.0, 1.0], h)
    p = node / np.linalg.norm(node) if np.linalg.norm(node) > 1e-9 else np.array([1.0, 0.0, 0.0])
    q = np.cross(h / np.linalg.norm(h), p)
    ex, ey = float(e_vec @ p), float(e_vec @ q)
    e = math.hypot(ex, ey)
    u = math.atan2(float(r @ q), float(r @ p))  # true argument of latitude
    w = math.atan2(ey, ex)
    nu = u - w
    E = 2.0 * math.atan2(math.sqrt(1 - e) * math.sin(nu / 2), math.sqrt(1 + e) * math.cos(nu / 2))
    lam = w + E - e * math.sin(E)  # ω + M; tends to u as e → 0 whatever ω is
    return a, ex, ey, lam


def _wrap(x: float) -> float:
    return (x + math.pi) % (2 * math.pi) - math.pi


def _init(sat: Satrec, epoch_jd: float, ecco, argpo, inclo, mo, no_kozai, nodeo) -> Satrec:
    out = Satrec()
    out.sgp4init(WGS72, "i", sat.satnum, epoch_jd - EPOCH_1949, sat.bstar, sat.ndot, sat.nddot,
                 ecco, argpo, inclo, mo, no_kozai, nodeo)
    return out


def apply_along_track(sat: Satrec, burn_ts: float, dv_ms: float, direction: str) -> Satrec:
    """New element set valid from the burn time on. direction: "prograde" | "retrograde"."""
    sign = {"prograde": 1.0, "retrograde": -1.0}[direction]
    jd, fr = jd_split(burn_ts)
    err, r, v = sat.sgp4(float(jd), float(fr))
    if err:
        raise ValueError(f"sgp4 error {err} at the burn time")
    r, v = np.array(r), np.array(v)
    nm, em, im, Om, om, mm = sat.nm, sat.em, sat.im, sat.Om, sat.om, sat.mm  # mean elements at the burn
    v2 = v + sign * (dv_ms / 1000.0) * v / np.linalg.norm(v)
    a1, ex1, ey1, l1 = _nonsingular(r, v)
    a2, ex2, ey2, l2 = _nonsingular(r, v2)

    ex, ey = em * math.cos(om) + (ex2 - ex1), em * math.sin(om) + (ey2 - ey1)
    ecco = min(max(math.hypot(ex, ey), 1e-9), 0.999)
    argpo = math.atan2(ey, ex) % (2 * math.pi)
    lam = om + mm + _wrap(l2 - l1)
    mo = (lam - argpo) % (2 * math.pi)
    target = nm * (a1 / a2) ** 1.5  # Brouwer mean motion after the burn, rad/min

    epoch = float(jd) + float(fr)
    kozai = target
    for _ in range(6):  # sgp4init: Kozai in, Brouwer (`no`) out; match the Brouwer value
        out = _init(sat, epoch, ecco, argpo, im % (2 * math.pi), mo, kozai, Om % (2 * math.pi))
        kozai *= target / out.no
    out = _init(sat, epoch, ecco, argpo, im % (2 * math.pi), mo, kozai, Om % (2 * math.pi))
    if out.error:
        raise ValueError(f"sgp4init error {out.error} after the impulse")
    return out


def delta_a_km(sat: Satrec, dv_ms: float, direction: str) -> float:
    """Indicative Δa ≈ 2·Δv/n (functionality §20 Q11), signed, km."""
    return {"prograde": 1.0, "retrograde": -1.0}[direction] * 2.0 * (dv_ms / 1000.0) / (sat.no_kozai / 60.0)
