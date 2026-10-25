"""A trajectory: an element set, optionally with one along-track burn (differential, see impulse.py)."""

from dataclasses import dataclass

import numpy as np
from sgp4.api import Satrec

from .impulse import apply_along_track
from .timeutil import jd_split


def sgp4_rv(sat: Satrec, ts) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """TEME position (km) and velocity (km/s) at Unix times ts (array). Returns (err, r[T,3], v[T,3])."""
    jd, fr = jd_split(np.atleast_1d(ts))
    err, r, v = sat.sgp4_array(jd, fr)
    return err, r, v


@dataclass
class Track:
    sat: Satrec
    burn_ts: float | None = None
    moved: Satrec | None = None
    zero: Satrec | None = None

    @classmethod
    def with_burn(cls, sat: Satrec, burn_ts: float, dv_ms: float, direction: str) -> "Track":
        return cls(sat, burn_ts, apply_along_track(sat, burn_ts, dv_ms, direction),
                   apply_along_track(sat, burn_ts, 0.0, direction))

    def rv(self, ts) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        ts = np.atleast_1d(np.asarray(ts, dtype=float))
        err, r, v = sgp4_rv(self.sat, ts)
        if self.burn_ts is None:
            return err, r, v
        after = ts >= self.burn_ts
        if after.any():
            e1, r1, v1 = sgp4_rv(self.moved, ts[after])
            e0, r0, v0 = sgp4_rv(self.zero, ts[after])
            r[after] += r1 - r0
            v[after] += v1 - v0
            err = err.copy()
            err[after] = np.maximum(err[after], np.maximum(e1, e0))
        return err, r, v
