"""Times one-primary-against-the-catalog screening at the SCR-1 threshold (5 km, 72 h) for a few primaries."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orbit.catalog import epoch_unix, load_snapshot  # noqa: E402
from orbit.conjunction import band_overlaps, screen_one  # noqa: E402
from orbit.track import Track  # noqa: E402

cat = load_snapshot(Path(__file__).resolve().parents[2] / "data")
t0 = max(epoch_unix(o.sat) for o in cat.objects.values() if not o.simulated)
for oid in sys.argv[1:] or ["25544", "63855", "56201", "48274"]:
    o = cat.get(oid)
    lo, hi = o.perigee_apogee_km
    others = [x for x in cat.objects.values() if x.object_id != oid and band_overlaps(x, lo, hi, 30)]
    s = time.time()
    hits, n = screen_one(Track(o.sat), others, t0, t0 + 72 * 3600, 5.0)
    print(oid, o.name, "others", n, "hits", len(hits), f"{time.time() - s:.1f}s", flush=True)
