"""POST /verify: promised maneuver vs element-set evidence (VER-1..VER-4, §20 Q11).

Semi-major axis from each element set's mean motion. Baseline: sets before the burn; a robust linear trend
(Theil–Sen) removes drag decay (ISS: ~55 m/day in NASA's OEM). Without it the plain median step is biased by
−200 m on a 4+3-day window, −57% of a 0.2 m/s burn (tools/compare_verify.py, decision O5). Noise σ = 1.4826·MAD of the
baseline residuals (floor 10 m). The observed change is the median of the post-burn residuals against the
extrapolated trend; z = change / σ. A change counts when |z| ≥ 5 and |Δa| ≥ 50 m. "consistent" when it counts, the
sign matches and the size is within ±50% of the expected 2·Δv/n; "mismatch" when it counts but sign or size
disagree; otherwise "awaiting_data" (fewer than 8 sets, too few on either side, or no change above noise yet —
absence of a jump is not a mismatch, VER-4).
"""

import json
import re
from pathlib import Path

import numpy as np
from scipy.stats import theilslopes

from .catalog import MU
from .timeutil import iso, parse_utc

THRESHOLDS = {"z": 5, "minDeltaAKm": 0.05, "sizeTolerance": 0.5, "minSets": 8}
MIN_SIDE = 4  # sets needed before and after the burn
EXCLUDE_S = 3600.0  # element sets within ±1 h of the burn straddle it and are ignored
SIGMA_FLOOR_KM = 0.01  # 10 m: below real element-set noise, so a degenerate MAD cannot inflate z


def sma_from_mean_motion(rev_per_day: float) -> float:
    if not rev_per_day > 0:
        raise ValueError(f"mean motion must be positive, got {rev_per_day}")
    n = rev_per_day * 2 * np.pi / 86400.0
    return (MU / n**2) ** (1 / 3)


def load_replay(data_dir: Path, name: str) -> dict | None:
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        return None  # a replay name is a file stem, never a path
    p = data_dir / "replay" / f"{name}.json"
    try:
        return json.loads(p.read_text()) if p.exists() else None
    except (OSError, ValueError):
        return None  # an unreadable replay is "not available" (404), never a 500


def verify(body: dict, replay: dict | None) -> dict:
    exp = body["expected"]
    burn = parse_utc(exp["burnTimeUtc"])
    if exp.get("direction", "prograde") not in ("prograde", "retrograde"):
        raise ValueError("expected.direction must be prograde or retrograde")
    if body.get("kind", "live") not in ("live", "replay"):
        raise ValueError("kind must be live or replay")
    sign = 1 if exp.get("direction", "prograde") == "prograde" else -1
    if body.get("series") and replay is not None:
        raise ValueError("give either series or replay, not both")
    if "deltaAKm" in exp:
        expected_da = float(exp["deltaAKm"])
        if expected_da == 0:
            raise ValueError("expected deltaAKm must be non-zero")
        sign = 1 if expected_da >= 0 else -1
    else:
        expected_da = None  # computed below from Δv and the baseline mean motion

    if body.get("kind") and body["kind"] != ("replay" if replay is not None else "live"):
        raise ValueError(f"kind {body['kind']} contradicts the evidence given")
    raw = body.get("series") or (replay or {}).get("series") or []
    series, dropped = [], []
    for s in raw:
        try:
            sma = float(s["smaKm"]) if "smaKm" in s else sma_from_mean_motion(float(s["meanMotionRevPerDay"]))
            if not 6378 < sma < 100000:
                raise ValueError(f"implausible semi-major axis {sma} km")
            series.append((parse_utc(s["epochUtc"]), sma))
        except (KeyError, TypeError, ValueError) as exc:  # one bad set is missing evidence, not a failed request
            dropped.append(f"element set {s.get('epochUtc') if isinstance(s, dict) else s!r} ignored: {exc}")
    series.sort()
    kind = "replay" if replay is not None else "live"
    sources = (replay or {}).get("sources", body.get("sources", []))
    base = [(t, a) for t, a in series if t < burn - EXCLUDE_S]
    post = [(t, a) for t, a in series if t > burn + EXCLUDE_S]

    if expected_da is None:
        dv = float(exp["deltaVMs"]) / 1000.0
        if dv <= 0:
            raise ValueError("expected deltaVMs must be positive")
        a0 = np.median([a for _, a in base]) if base else None
        expected_da = float(sign * 2 * dv / np.sqrt(MU / a0**3)) if a0 else sign * 2 * dv / 0.00113
    result = {
        "kind": kind, "expected": {"deltaAKm": round(expected_da, 4), "sign": sign},
        "observed": None, "elementSetCount": len(series),
        "series": [{"epochUtc": iso(t), "smaKm": round(a, 4)} for t, a in series],
        "thresholds": THRESHOLDS, "sources": sources, "simulated": bool(replay.get("simulated")) if replay is not None else bool(body.get("objectSimulated", False)),
        "method": "SMA from mean motion; Theil–Sen trend on pre-burn sets; robust z (median/MAD) of the post-burn "
                  "median residual; thresholds of functionality §20 Q11.",
        "limitations": ["Mean elements from public element sets; not proof of the exact Δv or execution time.",
                        *(replay or {}).get("limitations", []), *dropped],
        "missing": [],
    }
    missing = []
    if len(series) < THRESHOLDS["minSets"]:
        missing.append(f"{THRESHOLDS['minSets']} element sets (have {len(series)})")
    if len(base) < MIN_SIDE:
        missing.append(f"{MIN_SIDE} element sets before the burn (have {len(base)})")
    if len(post) < MIN_SIDE:
        missing.append(f"{MIN_SIDE} element sets after the burn (have {len(post)})")
    if missing:
        return {**result, "result": "awaiting_data", "label": "awaiting verification data", "missing": missing}

    tb = np.array([t for t, _ in base]) - burn
    ab = np.array([a for _, a in base])
    slope, intercept, *_ = theilslopes(ab, tb)
    resid = ab - (intercept + slope * tb)
    sigma = max(1.4826 * float(np.median(np.abs(resid - np.median(resid)))), SIGMA_FLOOR_KM)
    tp = np.array([t for t, _ in post]) - burn
    ap = np.array([a for _, a in post])
    change = float(np.median(ap - (intercept + slope * tp)))
    z = change / sigma
    observed = {"deltaAKm": round(change, 4), "z": round(z, 2), "epochUtc": iso(float(np.median(tp)) + burn)}
    counts = abs(z) >= THRESHOLDS["z"] and abs(change) >= THRESHOLDS["minDeltaAKm"]
    if not counts:
        return {**result, "observed": observed, "result": "awaiting_data", "label": "awaiting verification data",
                "missing": ["a semi-major-axis change above the noise (|z| ≥ 5 and |Δa| ≥ 50 m)"]}
    same_sign = (change > 0) == (expected_da > 0)
    size_ok = abs(abs(change) - abs(expected_da)) <= THRESHOLDS["sizeTolerance"] * abs(expected_da)
    ok = same_sign and size_ok
    return {**result, "observed": observed, "result": "consistent" if ok else "mismatch",
            "label": "evidence consistent with plan" if ok else "mismatch"}
