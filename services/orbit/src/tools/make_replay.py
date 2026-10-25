"""Builds data/replay/iss-simulated-reboost.json: the labeled verification replay (decision O6, VER-3).

No public, account-free source has element sets around a real recent maneuver (Space-Track gp_history needs an
account; NASA's current ISS OEM, 2026-10-21..11-05, contains no reboost: data/replay/ISS.OEM_J2K_EPH.txt). So the
replay is SIMULATED and labeled as such: the semi-major-axis trend is real (orbit-averaged from NASA's published
ISS ephemeris, i.e. real drag decay), element-set noise is TLE-like (σ = 40 m, seeded), and a simulated prograde
burn of 0.5 m/s is inserted at 2026-10-22T18:00Z. Epochs every 8 h from 2026-10-21T14:00Z to 2026-10-24T14:00Z.
Run: python tools/make_replay.py   (deterministic: same OEM file, same output)
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parents[2] / "data" / "replay"
MU = 398600.4418
BURN = datetime(2026, 10, 22, 18, tzinfo=timezone.utc).timestamp()
DV_MS, NOISE_KM, SEED = 0.5, 0.040, 20261024


def oem_mean_sma(path: Path):
    t, a = [], []
    for line in path.read_text().splitlines():
        p = line.split()
        if len(p) == 7 and p[0][:2] == "20":
            r, v = np.array(p[1:4], float), np.array(p[4:7], float)
            t.append(datetime.fromisoformat(p[0]).replace(tzinfo=timezone.utc).timestamp())
            a.append(1 / (2 / np.linalg.norm(r) - v @ v / MU))
    t, a = np.array(t), np.array(a)
    k = int(round(5560 / np.median(np.diff(t))))  # one orbit of samples: removes the twice-per-orbit oscillation
    return t[k // 2: k // 2 + len(a) - k + 1], np.convolve(a, np.ones(k) / k, "valid")


if __name__ == "__main__":
    meta = dict(line.split("=", 1) for line in (DATA / "ISS.OEM_J2K_EPH.meta.txt").read_text().split())
    tm, am = oem_mean_sma(DATA / "ISS.OEM_J2K_EPH.txt")
    rng = np.random.default_rng(SEED)
    start = datetime(2026, 10, 21, 14, tzinfo=timezone.utc).timestamp()
    epochs = start + np.arange(10) * 8 * 3600
    trend = np.interp(epochs, tm, am)
    n = np.sqrt(MU / trend[0] ** 3)
    step = np.where(epochs > BURN, 2 * DV_MS / 1000 / n, 0.0)
    sma = trend + step + rng.normal(0, NOISE_KM, epochs.size)
    out = {
        "name": "iss-simulated-reboost", "objectId": "25544", "simulated": True,
        "label": "SIMULATED replay: real ISS drag trend (NASA OEM) + simulated 0.5 m/s reboost; not a real maneuver",
        "burnTimeUtc": "2026-10-22T18:00:00Z", "deltaVMs": DV_MS, "direction": "prograde",
        "series": [{"epochUtc": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "smaKm": round(float(a), 4)}
                   for t, a in zip(epochs, sma)],
        "sources": [{"name": "simulated", "url": meta["url"], "epochUtc": None, "fetchedAt": meta["fetchedAt"],
                     "note": f"trend from NASA ISS OEM sha256 {meta['sha256'][:16]}…; noise σ {NOISE_KM * 1000:.0f} m seed {SEED}; burn simulated"}],
        "limitations": ["SIMULATED: the burn and the noise are generated; only the drag trend comes from NASA's ephemeris.",
                        "NASA's OEM is a predicted ephemeris, not observations."],
    }
    (DATA / "iss-simulated-reboost.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out["series"][:3]), "...", len(out["series"]), "sets")
