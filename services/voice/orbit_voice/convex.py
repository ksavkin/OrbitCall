"""Posts phrases to Convex (`POST {CONVEX_SITE_URL}/call/phrase`, header `x-call-service-token`). Convex is the
source of truth for captions (lesson R6); the worker posts a pending row, then the final row with a higher rev."""

from __future__ import annotations

import asyncio
import logging

import httpx

log = logging.getLogger("orbit_voice.convex")


class ConvexSink:
    def __init__(self, site_url: str, token: str, http: httpx.AsyncClient | None = None) -> None:
        self.url = f"{site_url}/call/phrase"
        self.token = token
        self.http = http or httpx.AsyncClient(timeout=httpx.Timeout(8.0))

    async def post(self, phrase: dict) -> bool:
        """True when Convex accepted it. One retry on a network error or 5xx; a 4xx is a contract error (logged)."""
        for attempt in (1, 2):
            try:
                res = await self.http.post(self.url, json=phrase, headers={"x-call-service-token": self.token})
            except httpx.HTTPError as e:
                log.warning("convex post %s rev %s: %s (attempt %d)", phrase.get("segId"), phrase.get("rev"),
                            type(e).__name__, attempt)
            else:
                if res.status_code < 300:
                    return True
                if res.status_code < 500:  # our own backend's validation message, never a key
                    log.error("convex rejected %s rev %s: HTTP %d %s", phrase.get("segId"), phrase.get("rev"),
                              res.status_code, res.text[:200])
                    return False
                log.warning("convex %s rev %s: HTTP %d (attempt %d)", phrase.get("segId"), phrase.get("rev"),
                            res.status_code, attempt)
            if attempt == 1:
                await asyncio.sleep(0.5)
        return False
