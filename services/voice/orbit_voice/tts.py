"""Voice for a listener language (W4): Cartesia for en/zh, Grok TTS for ru; both 24 kHz mono 16-bit PCM, streamed
in chunks so the first audio reaches the track before synthesis ends. A language without a provider or voice id is
text-only: there is no provider substitution (lesson R13)."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator

import httpx

from .config import Config

SAMPLE_RATE = 24000
CARTESIA_VERSION = "2026-08-14"
TIMEOUT = httpx.Timeout(10.0, read=15.0)


class TTSError(Exception):
    pass


class TTS:
    def __init__(self, cfg: Config, http: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self.http = http or httpx.AsyncClient(timeout=TIMEOUT)

    def available(self, lang: str) -> bool:
        return self.cfg.tts_provider(lang) is not None

    async def stream(self, text: str, lang: str) -> AsyncIterator[bytes]:
        """PCM s16le chunks for the text; raises TTSError on a provider failure (the caller marks the language)."""
        provider = self.cfg.tts_provider(lang)
        if provider is None:
            raise TTSError(f"no voice configured for {lang}")
        name, voice = provider
        if name == "cartesia":
            req = self.http.build_request("POST", "https://api.cartesia.ai/tts/bytes", headers={
                "Authorization": f"Bearer {self.cfg.cartesia_api_key}", "Cartesia-Version": CARTESIA_VERSION,
                "Content-Type": "application/json"}, json={
                "model_id": self.cfg.cartesia_model, "transcript": text, "voice": {"mode": "id", "id": voice},
                "language": lang, "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": SAMPLE_RATE}})
        else:
            req = self.http.build_request("POST", "https://api.x.ai/v1/tts", headers={
                "Authorization": f"Bearer {self.cfg.xai_api_key}", "Content-Type": "application/json"}, json={
                "text": text, "voice_id": voice, "language": lang, "text_normalization": True,
                "output_format": {"codec": "pcm", "sample_rate": SAMPLE_RATE}})
        try:
            res = await self.http.send(req, stream=True)
        except httpx.HTTPError as e:
            raise TTSError(f"{name}: {type(e).__name__}") from e
        try:
            if res.status_code != 200:
                raise TTSError(f"{name}: HTTP {res.status_code}")  # no response body: it may echo request data
            if "json" in res.headers.get("content-type", ""):  # Grok with timestamps answers base64 in JSON
                body = json.loads(await res.aread())
                yield base64.b64decode(body["audio"])
                return
            carry = b""
            async for chunk in res.aiter_bytes():
                chunk = carry + chunk
                cut = len(chunk) - (len(chunk) % 2)  # whole 16-bit samples only
                carry = chunk[cut:]
                if cut:
                    yield chunk[:cut]
        except httpx.HTTPError as e:
            raise TTSError(f"{name}: {type(e).__name__}") from e
        finally:
            await res.aclose()
