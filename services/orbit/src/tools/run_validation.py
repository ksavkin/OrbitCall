"""Runs the SOCRATES validation (GET /validation) once and writes the cache file the service serves.

Usage: python tools/run_validation.py [max_primaries]   (default: the full eligible scope)
"""
import json
import os
import sys
from pathlib import Path

if len(sys.argv) > 1:
    os.environ["ORBIT_VALIDATION_MAX_PRIMARIES"] = sys.argv[1]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orbit import validation  # noqa: E402
from orbit.catalog import load_snapshot  # noqa: E402

data = Path(os.environ.get("ORBIT_DATA", Path(__file__).resolve().parents[2] / "data"))
cache = validation.ValidationCache(lambda: load_snapshot(data, "tle"), data)
res = validation.run_validation(cache.cat, data, progress=lambda *a, **k: print(".", end="", flush=True) if not a else None)
cache.path.parent.mkdir(parents=True, exist_ok=True)
cache.path.write_text(json.dumps(res, indent=1))
print()
print(json.dumps({x: res[x] for x in ("eligible", "matched", "unmatched", "notScreened", "recall", "dataDiffers",
                                      "tcaErrorS", "missErrorKm", "detectionErrors", "primaries", "scopeComplete", "runtimeS")}))
print("oursNotInReference", {k: v for k, v in res["oursNotInReference"].items() if k != "sameDataSample"})
print("written", cache.path.name)
