"""GET /health on HEALTH_PORT (lesson R14): provider readiness without revealing keys. Checks run at start and every
5 minutes: an authenticated metadata request per provider (no audio, no tokens spent)."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

from .config import LANGS, Config

log = logging.getLogger("orbit_voice.health")
INTERVAL_S = 300
RECENT_S = 300  # errors shown in /health
DEGRADED_S = 60  # an error this recent makes ok false
# Job processes (one per room) and the supervisor share the container's filesystem: runtime failures are reported
# through small files, never through the network, and carry codes / exception names only (no keys, no bodies).
RUNTIME_DIR = Path(os.environ.get("ORBIT_VOICE_RUNTIME", "/tmp/orbit_voice_runtime"))


def report(component: str, message: str) -> None:
    """Called from a job process when a provider step fails at run time (STT drop, TTS failure, ...)."""
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        (RUNTIME_DIR / f"{component}-{os.getpid()}.json").write_text(
            json.dumps({"component": component, "at": time.time(), "message": message[:200]}))
    except OSError:
        pass


def recent_errors(now: float | None = None) -> dict:
    now = now or time.time()
    out: dict = {}
    for f in RUNTIME_DIR.glob("*.json") if RUNTIME_DIR.exists() else []:
        try:
            e = json.loads(f.read_text())
            if now - e.get("at", 0) > RECENT_S:  # job processes come and go: old reports are removed
                f.unlink(missing_ok=True)
                continue
        except (OSError, ValueError):
            continue
        if not isinstance(e, dict) or "component" not in e:
            continue
        if now - e.get("at", 0) <= RECENT_S and e.get("at", 0) > out.get(e["component"], {}).get("at", 0):
            out[e["component"]] = {"at": int(e["at"]), "message": e.get("message", "")}
    return out


class Health:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.state: dict = {"ready": False, "checkedAt": None, "providers": {}, "config": cfg.describe()}
        self._lock = threading.Lock()

    def _probe(self, name: str, url: str, headers: dict) -> dict:
        try:
            r = httpx.get(url, headers=headers, timeout=8.0)
            return {"ready": r.status_code == 200, "status": r.status_code}
        except httpx.HTTPError as e:
            return {"ready": False, "status": type(e).__name__}

    def _registered(self) -> dict:
        """The agents worker's own endpoint: `/` is 503 when it cannot reach LiveKit; `/worker` names the worker."""
        try:
            base = f"http://127.0.0.1:{self.cfg.worker_port}"
            if httpx.get(base + "/", timeout=3.0).status_code != 200:
                return {"ready": False, "status": "not connected to LiveKit"}
            info = httpx.get(base + "/worker", timeout=3.0).json()
            return {"ready": True, "status": "registered", "activeJobs": info.get("active_jobs", 0)}
        except (httpx.HTTPError, ValueError) as e:
            return {"ready": False, "status": type(e).__name__}

    def check(self) -> dict:
        c = self.cfg
        providers: dict = {}
        providers["xai"] = self._probe("xai", "https://api.x.ai/v1/models", {"Authorization": f"Bearer {c.xai_api_key}"}) \
            if c.xai_api_key else {"ready": False, "status": "XAI_API_KEY missing"}
        providers["anthropic"] = self._probe("anthropic", "https://api.anthropic.com/v1/models",
                                             {"x-api-key": c.anthropic_api_key, "anthropic-version": "2023-06-01"}) \
            if c.anthropic_api_key else {"ready": False, "status": "ANTHROPIC_API_KEY missing"}
        providers["cartesia"] = self._probe("cartesia", "https://api.cartesia.ai/voices?limit=1",
                                            {"Authorization": f"Bearer {c.cartesia_api_key}", "Cartesia-Version": "2026-08-14"}) \
            if c.cartesia_api_key else {"ready": False, "status": "CARTESIA_API_KEY missing"}
        voice = {lang: (c.tts_provider(lang) or ("text-only",))[0] for lang in LANGS}
        providers["livekit"] = self._registered()
        # ready = STT + translation + every TTS provider a configured voice uses + Convex settings + registered in LiveKit
        tts_ok = all(providers["cartesia" if v == "cartesia" else "xai"]["ready"] for v in voice.values() if v != "text-only")
        ready = (providers["xai"]["ready"] and providers["anthropic"]["ready"] and tts_ok and providers["livekit"]["ready"]
                 and bool(c.convex_site_url and c.call_service_token))
        with self._lock:
            self.state = {"ready": ready, "checkedAt": int(time.time()), "providers": providers, "voice": voice,
                          "config": c.describe()}
        return self.snapshot()

    def snapshot(self) -> dict:
        """Readiness from the last probe plus run-time failures reported by the job processes."""
        errors = recent_errors()
        with self._lock:
            state = dict(self.state)
        degraded = any(time.time() - e["at"] <= DEGRADED_S for e in errors.values())
        return {**state, "ok": bool(state.get("ready")) and not degraded, "degraded": degraded, "recentErrors": errors}

    def serve(self) -> None:
        health = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path.rstrip("/") not in ("/health", ""):
                    self.send_response(404)
                    self.end_headers()
                    return
                state = health.snapshot()
                body = json.dumps(state).encode()
                self.send_response(200 if state.get("ok") else 503)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args) -> None:
                pass

        server = ThreadingHTTPServer(("0.0.0.0", self.cfg.health_port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def loop() -> None:
            while True:
                try:
                    s = self.check()
                    log.info("health ok=%s %s errors=%s", s["ok"], {k: v["ready"] for k, v in s["providers"].items()},
                             sorted(s["recentErrors"]))
                except Exception as e:  # never kill the worker over a health probe
                    log.warning("health check failed: %s", type(e).__name__)
                time.sleep(INTERVAL_S)
        threading.Thread(target=loop, daemon=True).start()
