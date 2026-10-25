"""Settles decision O5 by measurement: median step (both reviewers) vs drag-trend-corrected step (ours).

ISS-like series: drag decay 55 m/day (measured from NASA's ISS OEM of 2026-10-21..11-05, data/replay), element-set
noise σ = 40 m, 3 sets a day, 4 days before and 3 days after the burn, seeded. Reports the error of the observed
Δa against the true step for both estimators. Run: python tools/compare_verify.py
"""

import numpy as np
from scipy.stats import theilslopes

rng = np.random.default_rng(7)
DECAY_KM_DAY, NOISE_KM = 0.055, 0.040
for true_da in (0.354, 0.885):  # Δv 0.2 and 0.5 m/s at ISS altitude
    errs_med, errs_trend = [], []
    for _ in range(500):
        t = np.arange(-4, 3, 1 / 3) + rng.uniform(-0.05, 0.05, 21)
        a = 6798.0 - DECAY_KM_DAY * t + np.where(t > 0, true_da, 0) + rng.normal(0, NOISE_KM, t.size)
        pre, post = t < -1 / 24, t > 1 / 24
        errs_med.append(np.median(a[post]) - np.median(a[pre]) - true_da)
        s, i, *_ = theilslopes(a[pre], t[pre])
        errs_trend.append(np.median(a[post] - (i + s * t[post])) - true_da)
    for name, e in (("median step", errs_med), ("trend-corrected", errs_trend)):
        e = np.array(e)
        print(f"true Δa {true_da * 1000:.0f} m  {name:<16} bias {e.mean() * 1000:+7.1f} m  "
              f"rel {e.mean() / true_da * 100:+6.1f}%  p95 |err| {np.percentile(abs(e), 95) * 1000:6.1f} m")
