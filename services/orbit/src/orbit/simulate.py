"""POST /simulate: the simulated satellite of DATA-7 / SCR-10.

Take the real target's TEME state at the chosen time, rotate its velocity by a few degrees about the position
vector (a plane tilted about the meeting point), offset the position by a small radial miss, and fit an SGP4
element set with epoch at that time whose SGP4 state reproduces the wanted state (fixed-point on the input state,
a few iterations). The object gets a reserved id outside catalog ranges, `simulated: true`, and is added to the
in-memory catalog so /candidates and /rescreen see it; it is also written to data/sim/ and reloaded on restart.
"""

import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sgp4 import exporter
from sgp4.api import Satrec, WGS72

from .catalog import MU, Catalog, Obj, sma_km
from .conjunction import closest
from .impulse import EPOCH_1949
from .timeutil import iso, jd_split, jd_to_unix, parse_utc
from .track import Track

TILT_DEG = 3.0
MISS_KM = 0.2  # small enough that both operators must act, large enough to be a near miss, not a hit
# A co-orbital SIM (same semi-major axis, 3° tilt) meets its target at every node crossing, every ~46 min, with a miss
# that changes by only ~0.6 km per crossing (measured on the ISS: Δa 0.34 km). Then any small burn only moves the
# near-zero crossing a few hours later and the 72 h re-screen refuses every cheap candidate. Raising the SIM's
# semi-major axis by 20 km makes the pair drift ~190 km along-track per orbit, so the demo encounter is single and
# the cheap candidates can pass the re-screen. The orbit still crosses the target's shell at the meeting point.
DELTA_A_KM = 20.0
R_EARTH_KM = 6378.135  # WGS-72 equatorial radius (the SGP4 constants)
MIN_PERIGEE_KM = 200.0


def _coe(r: np.ndarray, v: np.ndarray) -> tuple[float, float, float, float, float, float]:
    """Osculating (a, e, i, Ω, ω, M) of a two-body state."""
    rn, v2 = np.linalg.norm(r), v @ v
    a = 1 / (2 / rn - v2 / MU)
    h = np.cross(r, v)
    i = math.acos(h[2] / np.linalg.norm(h))
    node = np.cross([0, 0, 1.0], h)
    raan = math.atan2(node[1], node[0]) % (2 * math.pi)
    e_vec = ((v2 - MU / rn) * r - (r @ v) * v) / MU
    e = float(np.linalg.norm(e_vec))
    p = node / np.linalg.norm(node)
    q = np.cross(h / np.linalg.norm(h), p)
    w = math.atan2(float(e_vec @ q), float(e_vec @ p)) % (2 * math.pi)
    u = math.atan2(float(r @ q), float(r @ p))
    nu = u - w
    E = 2 * math.atan2(math.sqrt(1 - e) * math.sin(nu / 2), math.sqrt(1 + e) * math.cos(nu / 2))
    return a, e, i, raan, w, (E - e * math.sin(E)) % (2 * math.pi)


def _sat_from_state(r: np.ndarray, v: np.ndarray, epoch_jd: float, bstar: float) -> Satrec:
    a, e, i, raan, w, m = _coe(r, v)
    sat = Satrec()
    sat.sgp4init(WGS72, "i", 0, epoch_jd - EPOCH_1949, bstar, 0.0, 0.0,
                 max(e, 1e-7), w, i, m, math.sqrt(MU / a**3) * 60.0, raan)
    return sat


def fit_state(r_want: np.ndarray, v_want: np.ndarray, ts: float, bstar: float = 0.0) -> Satrec:
    """Element set whose SGP4 state at ts equals (r_want, v_want) to ~1 m: iterate the input state."""
    jd, fr = jd_split(ts)
    epoch = float(jd) + float(fr)
    r_in, v_in = r_want.copy(), v_want.copy()
    for _ in range(12):
        sat = _sat_from_state(r_in, v_in, epoch, bstar)
        _, r_out, v_out = sat.sgp4(float(jd), float(fr))
        dr, dv = np.array(r_out) - r_want, np.array(v_out) - v_want
        if sat.error:
            raise ValueError(f"SGP4 cannot represent the simulated orbit (error {sat.error})")
        if np.linalg.norm(dr) < 1e-3 and np.linalg.norm(dv) < 1e-6:
            return sat
        r_in, v_in = r_in - dr, v_in - dv
    raise ValueError("the simulated orbit did not converge to the wanted state")


def _rotate(vec: np.ndarray, axis: np.ndarray, deg: float) -> np.ndarray:
    k = axis / np.linalg.norm(axis)
    t = math.radians(deg)
    return vec * math.cos(t) + np.cross(k, vec) * math.sin(t) + k * (k @ vec) * (1 - math.cos(t))


def sim_omm(sat: Satrec, sim_id: str, name: str) -> dict:
    """OMM of a simulated object, from its exact SGP4 initialization (labeled simulated by its id and name)."""
    return {
        "OBJECT_NAME": name, "OBJECT_ID": sim_id, "NORAD_CAT_ID": sim_id,
        "EPOCH": datetime.fromtimestamp(jd_to_unix(sat.jdsatepoch, sat.jdsatepochF), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "MEAN_MOTION": sat.no_kozai * 1440 / (2 * math.pi), "ECCENTRICITY": sat.ecco,
        "INCLINATION": math.degrees(sat.inclo), "RA_OF_ASC_NODE": math.degrees(sat.nodeo),
        "ARG_OF_PERICENTER": math.degrees(sat.argpo), "MEAN_ANOMALY": math.degrees(sat.mo),
        "BSTAR": sat.bstar, "MEAN_MOTION_DOT": 0.0, "MEAN_MOTION_DDOT": 0.0,
        "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 0, "SIMULATED": True,
    }


def simulate(cat: Catalog, body: dict, data_dir: Path | None) -> dict:
    target = cat.get(str(body["targetObjectId"]))
    if target is None:
        from .candidates import NotFound
        raise NotFound(str(body["targetObjectId"]))
    ts = parse_utc(body["tcaUtc"])
    err, r, v = Track(target.sat).rv(ts)
    if err[0]:
        raise ValueError(f"target {target.object_id} cannot be propagated at {iso(ts)} (SGP4 error {err[0]})")
    r, v = r[0], v[0]
    tilt = float(body.get("tiltDeg", TILT_DEG))
    miss = float(body.get("missKm", MISS_KM))
    delta_a = float(body.get("deltaAKm", DELTA_A_KM))
    if not (0 < tilt <= 10 and 0.05 <= miss <= 5):
        raise ValueError("tiltDeg must be in (0, 10] and missKm in [0.05, 5] for a credible near miss")
    if not -50 <= delta_a <= 50:
        raise ValueError("deltaAKm must be in [-50, 50] km")
    r_sim = r + miss * r / np.linalg.norm(r)
    v_sim = _rotate(v, r, tilt)
    if delta_a:  # vis-viva: same direction, the speed that gives semi-major axis a + Δa at this radius
        rn = float(np.linalg.norm(r_sim))
        a_new = 1 / (2 / rn - float(v_sim @ v_sim) / MU) + delta_a
        v_sim = v_sim * math.sqrt(MU * (2 / rn - 1 / a_new) / float(v_sim @ v_sim))
    sat = fit_state(r_sim, v_sim, ts, target.sat.bstar)
    if sma_km(sat) * (1 - sat.ecco) - R_EARTH_KM < MIN_PERIGEE_KM:  # the fitted mean elements' perigee
        raise ValueError(f"the simulated orbit's perigee would be below {MIN_PERIGEE_KM:.0f} km; use a larger deltaAKm")
    sim_id = body.get("objectId") or next((f"SIM-{k:04d}" for k in range(1, 10000) if f"SIM-{k:04d}" not in cat.objects), None)
    if sim_id is None:
        raise ValueError("no free SIM id left")
    if not isinstance(sim_id, str) or not re.fullmatch(r"SIM-\d{4}", sim_id):
        raise ValueError("objectId must look like SIM-0001")  # never a catalog id, never a path
    if sim_id in cat.objects:
        raise ValueError(f"{sim_id} already exists")
    name = body.get("name") or sim_id
    ap = closest(Track(target.sat), Track(sat), ts, 600.0, 1.0)
    line1, line2 = exporter.export_tle(sat)
    omm = sim_omm(sat, sim_id, name)
    if data_dir is not None:
        d = data_dir / "sim"
        d.mkdir(parents=True, exist_ok=True)
        init = [sat.jdsatepoch + sat.jdsatepochF - EPOCH_1949, sat.bstar, sat.ecco, sat.argpo, sat.inclo, sat.mo,
                sat.no_kozai, sat.nodeo]  # exact sgp4init inputs: a TLE would round them
        tmp = d / f".{sim_id}.json.tmp"
        tmp.write_text(json.dumps({"objectId": sim_id, "name": name, "init": init,
                                   "targetObjectId": target.object_id, "tcaUtc": iso(ts)}, indent=1))
        os.replace(tmp, d / f"{sim_id}.json")  # atomic: a crash never leaves a half-written file
    cat.add(Obj(sim_id, name, sat, simulated=True, group="sim", omm=omm))  # only after every fallible step succeeded
    return {
        "objectId": sim_id, "omm": omm, "tle": [line1, line2], "simulated": True,
        "event": {"objectA": target.object_id, "objectB": sim_id, "tcaUtc": iso(ap.tca_ts),
                  "missKm": round(ap.miss_km, 3), "relSpeedKmS": round(ap.rel_speed_km_s, 3), "simulated": True},
        "assumptions": [f"Plane tilted {tilt}° about the meeting point, {miss} km radial offset, semi-major axis "
                        f"{delta_a:+g} km from the target's (a single encounter, no repeated node crossings) (SCR-10).",
                        "TLE line uses catalog number 00000 as a placeholder; the object id is the SIM id."],
    }


def reload_sims(cat: Catalog, data_dir: Path) -> None:
    for p in sorted((data_dir / "sim").glob("SIM-*.json")):
        try:
            rec = json.loads(p.read_text())
            if not re.fullmatch(r"SIM-\d{4}", rec["objectId"]) or rec["objectId"] in cat.objects:
                raise ValueError("bad or duplicate id")
            epoch, bstar, ecco, argpo, inclo, mo, no_kozai, nodeo = rec["init"]
            sat = Satrec()
            sat.sgp4init(WGS72, "i", 0, epoch, bstar, 0.0, 0.0, ecco, argpo, inclo, mo, no_kozai, nodeo)
        except (OSError, ValueError, KeyError, TypeError) as exc:  # one bad file never stops the service
            cat.skipped.append({"file": p.name, "reason": f"sim reload: {exc}"})
            continue
        cat.add(Obj(rec["objectId"], rec["name"], sat, simulated=True, group="sim", omm=sim_omm(sat, rec["objectId"], rec["name"])))
