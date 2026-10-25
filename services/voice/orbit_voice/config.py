"""Worker configuration from the environment. Keys are read here and never logged; `describe()` reports only
which settings are present."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

LANGS = ("en", "ru", "zh")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Config:
    livekit_url: str = field(default_factory=lambda: _env("LIVEKIT_URL"))
    livekit_api_key: str = field(default_factory=lambda: _env("LIVEKIT_API_KEY"))
    livekit_api_secret: str = field(default_factory=lambda: _env("LIVEKIT_API_SECRET"))
    agent_name: str = field(default_factory=lambda: _env("LIVEKIT_AGENT_NAME", "orbit-translator"))
    xai_api_key: str = field(default_factory=lambda: _env("XAI_API_KEY"))
    stt_model: str = field(default_factory=lambda: _env("XAI_STT_MODEL", "grok-voice-transcribe-2.0"))
    stt_endpointing_ms: int = field(default_factory=lambda: int(_env("STT_ENDPOINTING_MS", "400") or 400))
    stt_keyterms: tuple[str, ...] = field(
        default_factory=lambda: tuple(t.strip() for t in _env("STT_KEYTERMS").split(",") if t.strip())[:100])
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    translation_model: str = field(default_factory=lambda: _env("TRANSLATION_MODEL", "claude-sonnet-5-5"))
    cartesia_api_key: str = field(default_factory=lambda: _env("CARTESIA_API_KEY"))
    cartesia_model: str = field(default_factory=lambda: _env("CARTESIA_MODEL_ID", "sonic-3.6-2026-08-27"))
    cartesia_voice_en: str = field(default_factory=lambda: _env("CARTESIA_VOICE_EN"))
    cartesia_voice_zh: str = field(default_factory=lambda: _env("CARTESIA_VOICE_ZH"))
    xai_tts_voice: str = field(default_factory=lambda: _env("XAI_TTS_VOICE_ID"))
    convex_site_url: str = field(default_factory=lambda: _env("CONVEX_SITE_URL").rstrip("/"))
    call_service_token: str = field(default_factory=lambda: _env("CALL_SERVICE_TOKEN"))
    health_port: int = field(default_factory=lambda: int(_env("HEALTH_PORT", "8090") or 8090))
    worker_port: int = field(default_factory=lambda: int(_env("WORKER_PORT", "8081") or 8081))  # agents' own health

    def tts_provider(self, lang: str) -> tuple[str, str] | None:
        """(provider, voice id) for a listener language; None = text only (no provider substitution, R13)."""
        if lang == "ru":
            return ("grok", self.xai_tts_voice) if self.xai_api_key and self.xai_tts_voice else None
        voice = {"en": self.cartesia_voice_en, "zh": self.cartesia_voice_zh}.get(lang, "")
        return ("cartesia", voice) if self.cartesia_api_key and voice else None

    def describe(self) -> dict:
        return {
            "livekit": bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret),
            "stt": bool(self.xai_api_key), "sttModel": self.stt_model,
            "llm": bool(self.anthropic_api_key), "translationModel": self.translation_model,
            "tts": {lang: (self.tts_provider(lang) or ("text-only",))[0] for lang in LANGS},
            "convex": bool(self.convex_site_url and self.call_service_token),
        }
