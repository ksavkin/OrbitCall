"""Closest approach between two trajectories, and one-against-many screening (re-screen, SCR-7 / EXE-2)."""

import time
from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize_scalar
from sgp4.api import SatrecArray

from .catalog import Obj
from .timeutil import jd_split
from .track import Track


class PropagationError(ValueError):
    """SGP4 could not propagate one of the objects over the needed interval (decay, bad elements)."""


@dataclass
class Approach:
    tca_ts: float
    miss_km: float
    rel_speed_km_s: float


def _dist(a: Track, b: Track, t: float) -> float:
    ea, ra, _ = a.rv(t)
    eb, rb, _ = b.rv(t)
    if ea[0] or eb[0]:
        return float("inf")
    return float(np.linalg.norm(ra[0] - rb[0]))


def refine(a: Track, b: Track, t_lo: float, t_hi: float) -> Approach:
    # Optimize over the offset from t_lo: Brent's tolerance has a relative term √eps·|x|, which at Unix time
    # (~1.8e9 s) is ~27 s and would stop the search at its first point.
    res = minimize_scalar(lambda x: _dist(a, b, t_lo + x), bounds=(0.0, t_hi - t_lo), method="bounded",
                          options={"xatol": 1e-4})
    t = t_lo + float(res.x)
    ea, ra, va = a.rv(t)
    eb, rb, vb = b.rv(t)
    if ea[0] or eb[0]:
        raise PropagationError(f"SGP4 error {max(ea[0], eb[0])} near {t:.0f}")
    return Approach(t, float(np.linalg.norm(ra[0] - rb[0])), float(np.linalg.norm(va[0] - vb[0])))


def closest(a: Track, b: Track, t0: float, window_s: float = 600.0, step_s: float = 2.0) -> Approach:
    """Minimum distance within t0 ± window: dense sampling, then bounded refinement around the best sample.
    A 2 s step at ≤ 16 km/s relative speed brackets the true minimum (one-sided error ≤ 16 km is refined away)."""
    if window_s <= 0:
        raise ValueError("search window must be positive")
    ts = np.arange(t0 - window_s, t0 + window_s + step_s, step_s)
    ea, ra, _ = a.rv(ts)
    eb, rb, _ = b.rv(ts)
    d = np.linalg.norm(ra - rb, axis=1)
    d[(ea != 0) | (eb != 0)] = np.inf
    if not np.isfinite(d).any():
        raise PropagationError("SGP4 cannot propagate the pair over the search window")
    i = int(np.argmin(d))
    return refine(a, b, ts[max(i - 1, 0)], ts[min(i + 1, len(ts) - 1)])


MATCH_WINDOW_S = 60.0  # roadmap §8: one encounter per pair per fixed 60 s window around its first refined TCA


@dataclass
class Hit:
    object_id: str
    approach: Approach
    anchor: float = 0.0  # TCA of the first refinement of this encounter; never moves (no chaining)


class DeadlineExceeded(Exception):
    """The caller's time budget ran out between two chunks of the coarse pass."""


PERSIST_S = 3600.0  # a slow pair counts as co-located only if it stays within the threshold this long


def screen_one(moved: Track, others: list[Obj], t_start: float, t_end: float, threshold_km: float,
               step_s: float = 60.0, chunk: int = 240, uncovered: list | None = None,
               min_rel_speed_km_s: float | None = None, colocated: dict | None = None,
               deadline: float | None = None, unpropagated: set | None = None) -> tuple[list[Hit], int]:
    """Every object in `others` that comes within threshold_km of `moved` in [t_start, t_end].

    Coarse pass: positions every step_s; for each pair the linear closest approach inside ±step/2 is estimated
    from relative position and velocity; pairs whose linear estimate is under threshold + margin are refined
    with SGP4 (bounded minimization over ±step). Near an encounter both objects feel nearly the same gravity:
    their relative acceleration is the gravity gradient, ~n²·d ≈ 1.3e-5 km/s² at d = 10 km in LEO, so the
    linear estimate is off by ~½·1.3e-5·30² ≈ 6 m over half a step. The 10 km margin is very generous.
    A flagged pair that cannot be refined (SGP4 error) refuses the whole screen only when its linear estimate
    is within threshold + 2 km; on the far fringe it is recorded in `uncovered` instead (no false refusal).
    With `min_rel_speed_km_s` (fleet screening, SCR-1; the re-screen does not set it), flagged samples slower than
    that are held back: if the object stays within the threshold for at least PERSIST_S (docked or formation
    flying, re-detected every step otherwise) it goes to `colocated` with its closest distance and is not a hit;
    a brief slow pass is refined like any other encounter, so a real slow crossing is never hidden.
    `deadline` (time.monotonic) is checked before every chunk and raises DeadlineExceeded. Objects that SGP4 cannot
    propagate at some samples of the window (decay, bad elements) are unscreened there: their ids go to
    `unpropagated` so the caller can disclose them.
    Returns the hits and the number of objects checked.
    """
    if not others:
        return [], 0
    margin = 10.0
    arr = SatrecArray([o.sat for o in others])
    hits: list[Hit] = []
    slow: dict[int, list[tuple[float, float, float]]] = {}  # object index → (sample time, linear TCA, linear miss)

    def consider(n: int, tc: float, est: float) -> None:
        oid = others[n].object_id
        try:
            ap = refine(moved, Track(others[n].sat), tc - step_s, tc + step_s)
        except PropagationError as exc:
            if est < threshold_km + 2.0:  # a possible encounter we cannot check is not a pass
                raise PropagationError(f"cannot refine a possible encounter with {oid}: {exc}") from exc
            if uncovered is not None:
                e = round(est, 1)
                prev = next((u for u in uncovered if u["objectId"] == oid), None)  # one line per object
                if prev is None:
                    uncovered.append({"objectId": oid, "linearEstimateKm": e, "reason": str(exc)})
                elif e < prev["linearEstimateKm"]:
                    prev["linearEstimateKm"] = e
            return
        if ap.miss_km >= threshold_km:
            return
        # One entry per encounter: refinements within 60 s of the encounter's fixed anchor collapse into it (the
        # closest one is kept); anything farther is another encounter. The anchor never moves, so no chaining.
        same = next((h for h in hits if h.object_id == oid and abs(h.anchor - ap.tca_ts) <= MATCH_WINDOW_S), None)
        if same is None:
            hits.append(Hit(oid, ap, ap.tca_ts))
        elif ap.miss_km < same.approach.miss_km:
            same.approach = ap

    ts_all = np.arange(t_start, t_end + step_s, step_s)
    for k in range(0, len(ts_all), chunk):
        if deadline is not None and time.monotonic() > deadline:
            raise DeadlineExceeded()
        ts = ts_all[k:k + chunk]
        jd, fr = jd_split(ts)
        err, r, v = arr.sgp4(jd, fr)  # [N, T, 3]
        err_m, rm, vm = moved.rv(ts)  # [T, 3]
        if err_m.any():
            raise PropagationError(f"the moved satellite fails to propagate (SGP4 error {int(err_m.max())}) within the horizon")
        dr = r - rm[None]
        dv = v - vm[None]
        dv2 = np.maximum(np.einsum("ntk,ntk->nt", dv, dv), 1e-12)
        tau = np.clip(-np.einsum("ntk,ntk->nt", dr, dv) / dv2, -step_s / 2, step_s / 2)
        dmin = np.linalg.norm(dr + dv * tau[..., None], axis=2)
        bad = err != 0
        if unpropagated is not None and bad.any():
            unpropagated.update(others[n].object_id for n in np.nonzero(bad.any(axis=1))[0])
        dmin[bad] = np.inf
        for n, t in zip(*np.nonzero(dmin < threshold_km + margin)):
            tc, est = float(ts[t] + tau[n, t]), float(dmin[n, t])
            if min_rel_speed_km_s is not None and dv2[n, t] < min_rel_speed_km_s ** 2:
                slow.setdefault(int(n), []).append((float(ts[t]), tc, est))
                continue
            consider(int(n), tc, est)
    for n, samples in slow.items():
        # Co-located only when the slow samples within the threshold form one unbroken interval of >= PERSIST_S;
        # scattered slow passes (even if they add up to an hour) are refined like any other encounter.
        close = [(t, est) for t, _, est in samples if est < threshold_km]
        longest = run = 0
        for i in range(len(close)):
            run = run + 1 if i and close[i][0] - close[i - 1][0] <= step_s * 1.01 else 1
            longest = max(longest, run)
        if (longest - 1) * step_s >= PERSIST_S:  # n samples span n − 1 steps
            if colocated is not None:
                oid = others[n].object_id
                colocated[oid] = min(colocated.get(oid, np.inf), round(min(e for _, e in close), 3))
            continue
        if deadline is not None and time.monotonic() > deadline:
            raise DeadlineExceeded()
        for _, tc, est in samples:
            consider(n, tc, est)
    return sorted(hits, key=lambda h: h.approach.miss_km), len(others)


def band_overlaps(obj: Obj, lo_km: float, hi_km: float, margin_km: float) -> bool:
    """Perigee–apogee prefilter: two orbits whose radius bands do not overlap cannot meet."""
    p, a = obj.perigee_apogee_km
    return p - margin_km <= hi_km and lo_km <= a + margin_km


def element_key(sat) -> tuple:
    """The element set itself (epoch and mean elements). CelesTrak publishes docked vehicles and station modules
    with the station's element set, so they share this key exactly; a free-flying object never does."""
    return tuple(round(float(x), 12) for x in (sat.jdsatepoch, sat.jdsatepochF, sat.no_kozai, sat.ecco, sat.inclo,
                                                sat.nodeo, sat.argpo, sat.mo, sat.bstar))


def attached_to(obj: Obj, others: list[Obj]) -> list[str]:
    """Bodies docked to `obj`: the objects that share its element set (they are one body; a burn moves them all).
    Evidence-only: a co-orbital free-flyer, however close, has its own element set and is screened as usual."""
    key = element_key(obj.sat)
    return [o.object_id for o in others if o.object_id != obj.object_id and element_key(o.sat) == key]


def _id_key(oid: str) -> tuple:
    return (0, int(oid), "") if oid.isdigit() else (1, 0, oid)


def collapse_same_body(hits: list[Hit], objects: dict, prefer: set | None = None) -> list[tuple[Hit, list[str]]]:
    """Hits on objects that share one element set (a station and its docked bodies) at the same pass (within 60 s of
    the group's first hit — the fixed-anchor rule, no chaining; identical elements give identical TCAs) are one
    encounter: one entry, represented by a preferred id (the partner) or the lowest catalog number, the others listed.
    Distinct bodies are never merged, whatever their TCA and miss."""
    groups: list[list[Hit]] = []
    for h in sorted(hits, key=lambda h: (h.approach.tca_ts, _id_key(h.object_id))):
        k = element_key(objects[h.object_id].sat)
        g = next((g for g in groups if element_key(objects[g[0].object_id].sat) == k
                  and abs(g[0].approach.tca_ts - h.approach.tca_ts) <= MATCH_WINDOW_S), None)
        if g is None:
            groups.append([h])
        else:
            g.append(h)
    out = []
    for g in groups:
        rep = next((h for h in g if prefer and h.object_id in prefer), None) or min(g, key=lambda h: _id_key(h.object_id))
        out.append((rep, sorted((h.object_id for h in g if h is not rep), key=_id_key)))
    return sorted(out, key=lambda x: x[0].approach.miss_km)
