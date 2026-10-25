"""POST /candidates: the deterministic maneuver grid of functionality §20 Q11 with indicative geometry.

Grid: moving side A or B × burn at T−12 h, T−6 h, T−3 h × along-track Δv 0.02, 0.05, 0.1, 0.2 m/s × prograde or
retrograde, plus one wait candidate. For each maneuver the moved trajectory is the differential SGP4 burn of
impulse.py; missAfterKm is the refined minimum distance to the partner around TCA. No fuel mass and no ranking by
fuel: masses, Isp and thrust are private to each company (POL-2); the service returns Δv inputs only and a
policy-free order (Convex/Advocates choose the 2–3 shown).
"""

from .catalog import Catalog
from .conjunction import PropagationError, closest
from .impulse import delta_a_km
from .objects import classify
from .screen import check_snapshot
from .timeutil import iso, parse_utc
from .track import Track

LEADS_H = (12, 6, 3)
DELTA_V_MS = (0.02, 0.05, 0.1, 0.2)
DIRECTIONS = ("prograde", "retrograde")
MIN_MISS_KM = 1.0  # same threshold as the re-screen (§20 Q11)
TCA_SEARCH_S = 600.0  # the given TCA (SOCRATES or the queue) is refined with our SGP4 within ±10 min

ASSUMPTIONS = [
    "Indicative geometry: SGP4 on public mean elements, impulsive along-track burn, no covariance.",
    "Miss distance is to the partner only; the whole-catalog re-screen runs before scheduling (EXE-2).",
    "No fuel estimate: mass, Isp and thrust are private to each company.",
]


class NotFound(Exception):
    pass


def _obj(cat: Catalog, ref) -> tuple[str, object]:
    oid = ref["objectId"] if isinstance(ref, dict) else str(ref)
    obj = cat.get(oid)
    if obj is None:
        raise NotFound(oid)
    return oid, obj


def candidates(cat: Catalog, body: dict) -> dict:
    check_snapshot(cat, body)
    a_id, a = _obj(cat, body["objectA"])
    b_id, b = _obj(cat, body["objectB"])
    if a_id == b_id:
        raise ValueError("objectA and objectB are the same object")
    tca_in = parse_utc(body["tcaUtc"])
    not_before = parse_utc(body["notBeforeUtc"]) if body.get("notBeforeUtc") else None
    ta, tb = Track(a.sat), Track(b.sat)
    before = closest(ta, tb, tca_in, TCA_SEARCH_S)
    simulated = a.simulated or b.simulated
    allowed = body.get("allowedMovingObjectIds")
    if allowed is not None and not isinstance(allowed, list):
        raise ValueError("allowedMovingObjectIds must be a list")
    allowed = None if allowed is None else {str(i) for i in allowed}  # absent: both sides (v1); empty: nobody moves
    out, failed, skipped, not_movable, unconfirmed = [], [], 0, [], []
    for side, mover, partner in (("A", a, tb), ("B", b, ta)):
        # ROOM-14: only an allowed, possibly maneuverable object moves; debris and rocket bodies never do.
        info = classify(cat, mover)
        if info["maneuverability"] == "non_maneuverable":
            not_movable.append({"side": side, "objectId": mover.object_id, "reason": f"{info['kind']}: {info['classificationBasis']}"})
            continue
        if allowed is not None and mover.object_id not in allowed:
            not_movable.append({"side": side, "objectId": mover.object_id, "reason": "not in allowedMovingObjectIds"})
            continue
        if info["maneuverability"] == "unknown":
            unconfirmed.append(f"Side {side} ({mover.object_id}): maneuverability is not confirmed by any source; "
                               f"the operator's own policy decides whether it can burn.")
        for lead in LEADS_H:
            burn = before.tca_ts - lead * 3600
            if not_before is not None and burn < not_before:
                skipped += 1
                continue  # a burn in the past is never offered
            for dv in DELTA_V_MS:
                for direction in DIRECTIONS:
                    try:
                        moved = Track.with_burn(mover.sat, burn, dv, direction)
                        # ±600 s holds the new TCA for relative speeds ≥ ~50 m/s (drift ≤ 26 km); slower, nearly
                        # co-located pairs are not SOCRATES events and may need a wider window
                        after = closest(moved, partner, before.tca_ts, 600.0, 1.0)
                    except ValueError as exc:  # incl. PropagationError: this burn cannot be modeled, the grid goes on
                        failed.append({"candidateId": f"{side}:T-{lead}h:{'+' if direction == 'prograde' else '-'}{dv}",
                                       "reason": str(exc)})
                        continue
                    out.append({
                        "candidateId": f"{side}:T-{lead}h:{'+' if direction == 'prograde' else '-'}{dv}",
                        "kind": "maneuver", "movingSide": side, "movingObjectId": mover.object_id,
                        "burnTimeUtc": iso(burn), "leadH": lead, "deltaVMs": dv, "direction": direction,
                        "deltaAKm": round(delta_a_km(mover.sat, dv, direction), 4),
                        "missBeforeKm": round(before.miss_km, 3), "missAfterKm": round(after.miss_km, 3),
                        "tcaAfterUtc": iso(after.tca_ts), "relSpeedKmS": round(after.rel_speed_km_s, 3),
                        "passesPairThreshold": after.miss_km >= MIN_MISS_KM,
                        "estimatedFuelKg": None, "indicative": True, "simulated": simulated,
                    })
    # Policy-free order: pass the pair threshold first, then least Δv, then largest miss, then latest burn.
    out.sort(key=lambda c: (not c["passesPairThreshold"], c["deltaVMs"], -c["missAfterKm"], c["leadH"], c["candidateId"]))
    for i, c in enumerate(out, 1):
        c["rank"] = i
    wait = {
        "candidateId": "wait", "kind": "wait", "movingSide": None, "movingObjectId": None, "burnTimeUtc": None,
        "leadH": None, "deltaVMs": None, "direction": None, "deltaAKm": None,
        "missBeforeKm": round(before.miss_km, 3), "missAfterKm": None, "tcaAfterUtc": None, "relSpeedKmS": None,
        "passesPairThreshold": before.miss_km >= MIN_MISS_KM, "estimatedFuelKg": None, "indicative": True,
        "simulated": simulated, "rank": None,
    }
    return {
        "snapshotId": cat.snapshot_id, "evidenceVersion": body.get("evidenceVersion"), "objectA": a_id, "objectB": b_id,
        "objects": {a_id: classify(cat, a), b_id: classify(cat, b)}, "notMovable": not_movable,
        "tcaUtc": iso(before.tca_ts), "tcaInputUtc": iso(tca_in),
        "missBeforeKm": round(before.miss_km, 3), "relSpeedKmS": round(before.rel_speed_km_s, 3),
        "simulated": simulated, "candidates": out, "wait": wait, "failed": failed,
        "assumptions": ASSUMPTIONS + ([f"{skipped} grid burns fall before notBeforeUtc and are not offered."] if skipped else [])
                       + [f"Side {n['side']} ({n['objectId']}) does not move: {n['reason']}." for n in not_movable] + unconfirmed,
        "method": "SGP4 (python-sgp4, WGS-72) with a differential impulsive along-track burn; "
                  "Δa ≈ 2·Δv/n reported for reference; closest approach refined by bounded minimization.",
    }
