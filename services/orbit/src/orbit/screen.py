"""POST /screen: assigned-fleet Run Scan (SCR-1, SCAN-1, user-flow §3).

Each primary against every other usable object of the pinned snapshot (debris and the other primaries included)
over [fromUtc, toUtc] (72 h by default), threshold 5 km (the SOCRATES threshold, so validation compares like with
like). Same engine as the re-screen: radius-band prefilter, 60 s coarse steps with a linear closest-approach
estimate, SGP4 refinement. Self-pairs are skipped, unordered pairs deduplicated, refinements of one pass
within 60 s of its fixed anchor are one event (roadmap §8, no chaining); later passes are separate events. Pairs that stay close at under 0.1 km/s relative speed (docked or formation
flying) are not conjunction events: they are listed in `coLocated`. Exclusions are disclosed in `coverage`;
`complete` is true only when every primary was screened, every flagged encounter was refined and the deadline was
not hit. A/B is canonical (catalog number order), so the same pair gets the same sides in every user's scan; each
event lists which of its objects were primaries. Identical requests on an unchanged catalog are served from a
small in-memory cache.
"""

import os
import threading
import time
from collections import OrderedDict

from .catalog import Catalog, epoch_unix
from .conjunction import DeadlineExceeded, PropagationError, attached_to, band_overlaps, collapse_same_body, screen_one
from .objects import classify
from .timeutil import iso, parse_utc
from .track import Track

THRESHOLD_KM = 5.0
WINDOW_H = 72
MAX_WINDOW_H = 168
MAX_PRIMARIES = 50
MIN_REL_SPEED_KM_S = 0.1
BAND_MARGIN_KM = 30.0
DEADLINE_S = float(os.environ.get("ORBIT_SCREEN_DEADLINE_S", "480"))  # under Convex's 10 min action limit
CACHE_SIZE = 8
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def id_key(oid: str) -> tuple:
    """Canonical A/B order: catalog numbers numerically, then other ids ("SIM-0001") as text."""
    return (0, int(oid), "") if oid.isdigit() else (1, 0, oid)


class SnapshotMismatch(Exception):
    """The caller pinned a snapshot this process does not hold (SCAN-1: results must not be labeled current)."""


def check_snapshot(cat: Catalog, body: dict) -> None:
    want = body.get("snapshotId")
    if want is not None and want != cat.snapshot_id:
        raise SnapshotMismatch(f"snapshotId {want} is not the loaded snapshot {cat.snapshot_id}")


def window(body: dict) -> tuple[float, float]:
    if not body.get("fromUtc"):
        raise ValueError("fromUtc is required")
    t0 = parse_utc(body["fromUtc"])
    t1 = parse_utc(body["toUtc"]) if body.get("toUtc") else t0 + WINDOW_H * 3600
    if not 0 < t1 - t0 <= MAX_WINDOW_H * 3600:
        raise ValueError(f"toUtc must be after fromUtc, at most {MAX_WINDOW_H} h")
    return t0, t1


def screen_primary(cat: Catalog, oid: str, t0: float, t1: float, threshold_km: float, exclude_simulated: bool = False,
                   objects: dict | None = None, deadline: float | None = None, unpropagated: set | None = None):
    """One primary against the catalog (`objects`: a fixed view of it, default the current one).
    Returns (hits, objects checked, uncovered, colocated); objects SGP4 cannot propagate go to `unpropagated`."""
    objects = cat.objects if objects is None else objects
    obj = objects[oid]
    lo, hi = obj.perigee_apogee_km
    docked = set(attached_to(obj, list(objects.values())))  # same element set: the primary itself, never an encounter
    others = [o for o in objects.values() if o.object_id != oid and o.object_id not in docked
              and band_overlaps(o, lo, hi, BAND_MARGIN_KM) and not (exclude_simulated and o.simulated)]
    uncovered: list[dict] = []
    colocated: dict[str, float] = {}
    hits, checked = screen_one(Track(obj.sat), others, t0, t1, threshold_km, uncovered=uncovered,
                               min_rel_speed_km_s=MIN_REL_SPEED_KM_S, colocated=colocated, deadline=deadline,
                               unpropagated=unpropagated)
    return hits, checked, uncovered, colocated, sorted(docked, key=id_key)


def parse(cat: Catalog, body: dict) -> tuple[list[str], float, float]:
    """Validates a /screen request (before a job is reserved): pinned snapshot, window, primaries."""
    check_snapshot(cat, body)
    t0, t1 = window(body)
    ids = body.get("primaryObjectIds")
    if not isinstance(ids, list) or not ids:
        raise ValueError("primaryObjectIds must be a non-empty list")
    primaries = list(dict.fromkeys(str(i) for i in ids))  # duplicates dropped
    if len(primaries) > MAX_PRIMARIES:
        raise ValueError(f"at most {MAX_PRIMARIES} primary objects per scan")
    return primaries, t0, t1


def screen(cat: Catalog, body: dict, progress=None) -> dict:
    primaries, t0, t1 = parse(cat, body)
    # One fixed view of the catalog for the whole scan (copy-on-write: a concurrent /simulate rebinds cat.objects and
    # never changes this dict), and the cache key names exactly that view.
    objects = cat.objects
    key = (cat.snapshot_id, id(objects), tuple(sorted(primaries, key=id_key)), t0, t1)
    with _cache_lock:
        hit = _cache.get(key)
        hit = hit[1] if hit is not None and hit[0] is objects else None  # id() reuse after GC is not a match
    if hit is not None:
        return {**hit, "scanId": body.get("scanId"), "evidenceVersion": body.get("evidenceVersion"), "cached": True,
                "runtimeS": 0.0, "computedRuntimeS": hit["runtimeS"]}
    out = _screen(cat, objects, sorted(primaries, key=id_key), t0, t1, progress or (lambda *a, **k: None))
    if not out["coverage"]["timedOut"]:
        with _cache_lock:
            _cache[key] = (objects, out)
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    return {**out, "scanId": body.get("scanId"), "evidenceVersion": body.get("evidenceVersion"), "cached": False}



def _spread(objects: dict, a: str, b: str, miss: float) -> dict:
    """SourceSpread (SCR-4) with one source: GP only, no SupGP here, so no min–max spread."""
    older = min(epoch_unix(objects[a].sat), epoch_unix(objects[b].sat))
    return {"gpMissKm": miss, "supgpMissKm": None, "minKm": None, "maxKm": None, "gpEpochUtc": iso(older), "supgpEpochUtc": None}


def _screen(cat: Catalog, objects: dict, primaries: list[str], t0: float, t1: float, progress) -> dict:
    started = time.monotonic()
    progress("screening", 0.0, primaryObjects=len(primaries), catalogObjects=len(objects), primariesCompleted=0,
             pairsChecked=0, eventsFound=0)
    deadline = started + DEADLINE_S
    events: list[dict] = []
    colocated: list[dict] = []
    reasons: dict[str, int] = {}
    uncovered_all: list[dict] = []
    missing: list[str] = []
    completed = pairs = 0
    timed_out = False
    done: set[str] = set()  # primaries already screened: their pairs with later primaries are not listed twice
    pset = set(primaries)
    unpropagated: set[str] = set()  # catalog objects SGP4 could not propagate over part of the window
    failed_primaries: list[str] = []
    docked_bodies: dict[str, list[str]] = {}  # primary → bodies sharing its element set (not screened against it)

    def note(reason: str, n: int = 1) -> None:
        reasons[reason] = reasons.get(reason, 0) + n

    def pair(x: str, y: str) -> tuple[str, str]:
        return (x, y) if id_key(x) <= id_key(y) else (y, x)

    for i, oid in enumerate(primaries):
        if time.monotonic() - started > DEADLINE_S:
            timed_out = True
            note("primaries not screened before the deadline", len(primaries) - i)
            break
        if oid not in objects:
            missing.append(oid)
            note("primary not in the snapshot")
            continue
        try:
            hits, checked, uncovered, near, docked = screen_primary(cat, oid, t0, t1, THRESHOLD_KM, objects=objects,
                                                                    deadline=deadline, unpropagated=unpropagated)
        except DeadlineExceeded:
            timed_out = True
            note("primaries not screened before the deadline", len(primaries) - i)
            break
        except PropagationError as exc:
            note("primary cannot be propagated over the window")
            failed_primaries.append(oid)
            uncovered_all.append({"objectId": oid, "reason": str(exc)})
            continue
        completed += 1
        pairs += checked
        if docked:
            docked_bodies[oid] = docked
        if uncovered:
            note("possible encounters that SGP4 could not refine", len(uncovered))
            uncovered_all += [{"primaryObjectId": oid, **u} for u in uncovered]
        for other, d in near.items():
            if other in done:
                continue  # already listed from the other primary
            a, b = pair(oid, other)
            colocated.append({"objectA": a, "objectB": b, "minDistanceKm": d})
        for h, also in collapse_same_body([h for h in hits if h.object_id not in done], objects):
            # (pairs with an already screened primary were listed from that primary; one pass of a docked cluster
            # is one event with the other bodies in attachedObjectIds)
            a, b = pair(oid, h.object_id)
            miss = round(h.approach.miss_km, 3)
            events.append({"objectA": a, "objectB": b, "tcaUtc": iso(h.approach.tca_ts), "missKm": miss,
                           "relSpeedKmS": round(h.approach.rel_speed_km_s, 3), "spread": _spread(objects, a, b, miss),
                           "primaries": [x for x in (a, b) if x in pset], "attachedObjectIds": also,
                           "_t": h.approach.tca_ts})
        done.add(oid)
        done.update(docked)  # its docked bodies: their encounters are the primary's
        progress(None, (i + 1) / len(primaries), primariesCompleted=completed, pairsChecked=pairs, eventsFound=len(events))
    progress("publishing")
    events.sort(key=lambda e: (e["_t"], id_key(e["objectA"]), id_key(e["objectB"])))
    for e in events:
        del e["_t"]
    if unpropagated:
        note("catalog objects SGP4 cannot propagate over part of the window (unscreened there)", len(unpropagated))
    if colocated:
        note("co-located pairs (relative speed < 0.1 km/s) listed in coLocated, not as events (informational)", len(colocated))
    ids_seen = ({i for e in events for i in (e["objectA"], e["objectB"])} | {i for c in colocated for i in (c["objectA"], c["objectB"])}
                | {u.get("objectId") for u in uncovered_all} | {u.get("primaryObjectId") for u in uncovered_all}) - {None}
    info = {i: classify(cat, objects[i]) for i in sorted(ids_seen, key=id_key) if i in objects}
    for e in events:
        e["simulated"] = info[e["objectA"]]["simulated"] or info[e["objectB"]]["simulated"]
    excluded = len(set(missing) | set(failed_primaries) | unpropagated)  # distinct objects, not encounters
    return {
        "snapshotId": cat.snapshot_id, "fromUtc": iso(t0), "toUtc": iso(t1), "thresholdKm": THRESHOLD_KM,
        "coverage": {
            "complete": completed == len(primaries) and not uncovered_all and not timed_out and not unpropagated,
            "timedOut": timed_out,
            "catalogScope": f"pinned CelesTrak GP snapshot {cat.snapshot_id}: {len(objects)} objects "
                            f"(groups: {', '.join(sorted({o.group for o in objects.values()}))}); "
                            f"{len(cat.skipped)} records skipped at load. Not every object in space.",
            "excludedObjects": excluded + len(cat.skipped),
            "reasons": [{"reason": r, "count": n} for r, n in sorted(reasons.items())]
                       + ([{"reason": "records skipped at load (parse or SGP4 error at epoch)", "count": len(cat.skipped)}]
                          if cat.skipped else []),
        },
        "counts": {"primaryObjects": len(primaries), "catalogObjects": len(objects), "primariesCompleted": completed,
                   "pairsChecked": pairs, "eventsFound": len(events)},
        "missingPrimaryIds": missing, "unpropagatedObjectIds": sorted(unpropagated, key=id_key), "dockedBodies": docked_bodies,
        "events": events, "coLocated": colocated, "objects": info,
        "uncovered": uncovered_all, "runtimeS": round(time.monotonic() - started, 1),
        "method": f"SGP4 (python-sgp4, WGS-72) on public mean elements; radius-band prefilter ±{BAND_MARGIN_KM:.0f} km; "
                  f"60 s coarse steps with a linear closest-approach estimate; SGP4 refinement under {THRESHOLD_KM} km + 10 km.",
        "limitations": ["Public mean elements: kilometre-level uncertainty; a close approach is not a collision claim.",
                        "No probability of collision is computed; supplied Pc is attached by Convex from its sources.",
                        "spread has one source (CelesTrak GP): no SupGP, so no min-max spread (SCR-4)."],
    }
