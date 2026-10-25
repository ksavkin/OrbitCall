"""Time handling: ISO 8601 UTC strings at the edges, Unix seconds inside, Julian dates for SGP4."""

from datetime import datetime, timezone

import numpy as np

JD_UNIX = 2440587.5  # Julian date of 1970-01-01T00:00:00Z
DAY = 86400.0


def parse_utc(text: str) -> float:
    """ISO 8601 → Unix seconds. A string without an offset is UTC."""
    t = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    if not 1957 <= t.year <= 2100:
        raise ValueError(f"time {text} is outside 1957..2100")
    return t.timestamp()


def iso(ts: float) -> str:
    """Unix seconds → "2026-10-25T03:14:07Z" (whole seconds, spec §0)."""
    return datetime.fromtimestamp(round(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def jd_split(ts):
    """Unix seconds (scalar or array) → (jd, fr) as SGP4 expects: integer-and-a-half day plus fraction."""
    days = np.asarray(ts, dtype=float) / DAY + JD_UNIX
    jd = np.floor(days - 0.5) + 0.5
    return jd, days - jd


def jd_to_unix(jd: float, fr: float = 0.0) -> float:
    return (jd - JD_UNIX + fr) * DAY
