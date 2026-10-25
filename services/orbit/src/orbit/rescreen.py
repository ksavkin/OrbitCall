"""POST /rescreen: the moved satellite against the whole catalog (SCR-7, EXE-2, EXE-3, §20 Q11).

Pass when the original pair's post-maneuver miss is ≥ 1 km and no other catalog object comes within 1 km of the
moved satellite over the horizon (72 h from the burn). Appendix A's input lacks the partner and TCA that
`originalMissAfterKm` needs, so the contract adds `partnerObjectId` and `tcaUtc` (docs/contract.md).
"""

from .candidates import NotFound, _obj
from .catalog import Catalog
from .conjunction import PropagationError, attached_to, band_overlaps, closest, collapse_same_body, screen_one
from .objects import classify
from .screen import check_snapshot
from .timeutil import iso, parse_utc
from .track import Track

THRESHOLD_KM = 1.0
HORIZON_H = 72
BAND_MARGIN_KM = 30.0  # radius-band prefilter margin: SGP4 short-period terms and 3 days of drag


def parse(cat: Catalog, body: dict) -> dict:
    """Validates a /rescreen request (before a job is reserved); returns the parsed inputs."""
    check_snapshot(cat, body)
    oid, obj = _obj(cat, body["objectId"])
    info = classify(cat, obj)
    if info["maneuverability"] == "non_maneuverable":
        raise ValueError(f"object {oid} cannot be the moving object: {info['kind']} ({info['classificationBasis']})")
    m = body["maneuver"]
    burn = parse_utc(m["burnTimeUtc"])
    if m.get("direction") not in ("prograde", "retrograde"):
        raise ValueError("maneuver.direction must be prograde or retrograde")
    if not 0 < float(m["deltaVMs"]) <= 1.0:
        raise ValueError("maneuver.deltaVMs must be in (0, 1] m/s (the grid offers up to 0.2)")
    horizon_h = float(body.get("horizonH", HORIZON_H))
    if bool(body.get("fromUtc")) != bool(body.get("toUtc")):
        raise ValueError("give both fromUtc and toUtc, or neither (then horizonH from the burn)")
    if body.get("toUtc"):
        # v2 window: before the burn the orbit is unchanged (that was the fleet screen), so the screen starts at the
        # burn and ends at toUtc; fromUtc, if given, must not be after the burn.
        if body.get("fromUtc") and parse_utc(body["fromUtc"]) > burn:
            raise ValueError("fromUtc is after the burn")
        horizon_h = (parse_utc(body["toUtc"]) - burn) / 3600
    if not 0 < horizon_h <= 168:
        raise ValueError("the window after the burn (horizonH or toUtc) must be in (0, 168] h")
    end = burn + horizon_h * 3600
    if body.get("tcaUtc") and parse_utc(body["tcaUtc"]) <= burn:
        raise ValueError("tcaUtc must be after the burn (the maneuver acts on the encounter that follows it)")
    partner_id = body.get("partnerObjectId")
    partner = _obj(cat, partner_id)[1] if partner_id else None
    if partner_id == oid:
        raise ValueError("partnerObjectId is the moved object")
    if partner is not None and partner_id in attached_to(obj, [partner]):
        raise ValueError("partnerObjectId shares the moved object's element set (one docked body)")
    return {"oid": oid, "obj": obj, "m": m, "burn": burn, "horizon_h": horizon_h, "end": end,
            "partner_id": partner_id, "partner": partner}


def rescreen(cat: Catalog, body: dict, progress=None) -> dict:
    p = parse(cat, body)
    oid, obj, m, burn, horizon_h, end = p["oid"], p["obj"], p["m"], p["burn"], p["horizon_h"], p["end"]
    partner_id, partner = p["partner_id"], p["partner"]
    if progress:
        progress("screening")
    simulated = obj.simulated or bool(partner and partner.simulated)
    try:
        moved = Track.with_burn(obj.sat, burn, float(m["deltaVMs"]), m["direction"])
        original = None
        if partner:
            # The original encounter: around tcaUtc when given, else the closest approach over the whole horizon.
            if body.get("tcaUtc"):
                original = closest(moved, Track(partner.sat), parse_utc(body["tcaUtc"]), 600.0, 2.0)
            else:
                original = closest(moved, Track(partner.sat), burn + horizon_h * 1800, horizon_h * 1800, 2.0)
    except ValueError as exc:  # the burn or the pair cannot be propagated: refuse, never pass
        return _refused(cat, obj, horizon_h, simulated, body.get("evidenceVersion"), f"cannot model the maneuver: {exc}")

    lo, hi = obj.perigee_apogee_km
    widen = 2 * float(m["deltaVMs"]) / 1000 / max(obj.sat.no_kozai / 60, 1e-6)  # Δa = 2Δv/n, both ways
    lo, hi = lo - widen, hi + widen
    # The partner stays in the screen: a later re-encounter within the horizon is a new conjunction too.
    others = [o for o in cat.objects.values() if o.object_id != oid and band_overlaps(o, lo, hi, BAND_MARGIN_KM)]
    if partner and all(o.object_id != partner_id for o in others):
        others.append(partner)
    # Bodies docked to the moved object (they share its element set) move with it: not encounters, disclosed. The
    # partner is never one of them (that is refused in parse). Bodies docked to the partner are the partner.
    attached = set(attached_to(obj, others)) - {partner_id}
    others = [o for o in others if o.object_id not in attached]
    partner_group = ({partner_id} | set(attached_to(partner, others))) if partner else set()
    uncovered: list[dict] = []
    try:
        hits, checked = screen_one(moved, others, burn, end, THRESHOLD_KM, uncovered=uncovered)
    except PropagationError as exc:
        return _refused(cat, obj, horizon_h, simulated, body.get("evidenceVersion"), str(exc))
    orig_miss = original.miss_km if original else None
    if original:  # the original encounter is reported as originalMissAfterKm, not again as a new one
        near = [h for h in hits if h.object_id in partner_group and abs(h.approach.tca_ts - original.tca_ts) < 600]
        orig_miss = min([orig_miss, *(h.approach.miss_km for h in near)])  # the closest body of the partner group
        hits = [h for h in hits if h not in near]

    # Same encounter on the unmoved orbit: tells the room whether the burn caused it or it was already there.
    plain = Track(obj.sat)

    def without(h) -> float | None:
        try:
            return round(closest(plain, Track(cat.objects[h.object_id].sat), h.approach.tca_ts, 300.0, 1.0).miss_km, 3)
        except PropagationError:
            return None  # informational only; the verdict does not depend on it

    new = [{"objectId": h.object_id, "name": cat.objects[h.object_id].name, "tcaUtc": iso(h.approach.tca_ts),
            "missKm": round(h.approach.miss_km, 3), "withoutManeuverKm": without(h), "attachedObjectIds": also}
           for h, also in collapse_same_body(hits, cat.objects, prefer=partner_group)]
    orig_km = round(orig_miss, 3) if original else None
    reasons = []
    if orig_km is not None and orig_km < THRESHOLD_KM:
        reasons.append(f"original pair still {orig_km} km apart (< {THRESHOLD_KM} km)")
    if new:
        reasons.append(f"new conjunction with {new[0]['name']} ({new[0]['objectId']}) at {new[0]['missKm']} km, {new[0]['tcaUtc']}")
    if orig_km is None:
        reasons.append("partner not given: original pair not checked")
    return {
        "passed": not reasons, "objectsChecked": checked, "objectsInCatalog": len(cat.objects) - 1,
        "horizonH": horizon_h, "originalMissAfterKm": orig_km, "newConjunctions": new,
        "refusalReason": "; ".join(reasons) or None,
        "attachedObjectIds": sorted(attached), "partnerAttachedObjectIds": sorted(partner_group - {partner_id}),
        "snapshotId": cat.snapshot_id, "evidenceVersion": body.get("evidenceVersion"), "simulated": simulated,
        "fromUtc": body.get("fromUtc") or iso(burn), "toUtc": body.get("toUtc") or iso(end),
        "screenedFromUtc": iso(burn), "screenedToUtc": iso(end),
        "method": f"SGP4, differential along-track burn; radius-band prefilter ±{BAND_MARGIN_KM} km; 60 s coarse "
                  f"steps with a linear closest-approach estimate; bounded refinement under {THRESHOLD_KM} km + 10 km.",
        "limitations": ["Public mean elements (SGP4/TLE): kilometre-level uncertainty, not flight-safety screening.",
                        *([f"{len(attached)} bodies share the moved object's element set (docked modules and vehicles, as "
                           f"CelesTrak publishes them): moved with it, not screened as encounters."] if attached else []),
                        *[f"{u['objectId']} could not be refined (linear estimate {u['linearEstimateKm']} km, beyond "
                          f"{THRESHOLD_KM} km + 2 km): {u['reason']}" for u in uncovered]],
    }


def _refused(cat: Catalog, obj, horizon_h: float, simulated: bool, evidence, reason: str) -> dict:
    return {"passed": False, "objectsChecked": 0, "objectsInCatalog": len(cat.objects) - 1, "horizonH": horizon_h,
            "originalMissAfterKm": None, "newConjunctions": [], "refusalReason": reason,
            "snapshotId": cat.snapshot_id, "evidenceVersion": evidence, "simulated": simulated, "method": "not run",
            "limitations": ["The maneuver could not be propagated with SGP4; nothing was screened."]}
