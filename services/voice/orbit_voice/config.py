"""Worker configuration from the environment. Keys are read here and never logged; `describe()` reports only
which settings are present."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

LANGS = ("en", "ru", "zh")
GENDERS = ("male", "female")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _gender(value: str) -> str:
    """A voice gender from the environment: `male` or `female`; anything else means `female`."""
    value = value.lower()
    return value if value in GENDERS else "female"


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
    # legacy per-language ids: the fallback for both genders of their language
    cartesia_voice_en: str = field(default_factory=lambda: _env("CARTESIA_VOICE_EN"))
    cartesia_voice_zh: str = field(default_factory=lambda: _env("CARTESIA_VOICE_ZH"))
    xai_tts_voice: str = field(default_factory=lambda: _env("XAI_TTS_VOICE_ID"))
    # one voice id per language and speaker gender; a missing id means text-only for that gender
    cartesia_voice_en_male: str = field(default_factory=lambda: _env("CARTESIA_VOICE_EN_MALE"))
    cartesia_voice_en_female: str = field(default_factory=lambda: _env("CARTESIA_VOICE_EN_FEMALE"))
    cartesia_voice_zh_male: str = field(default_factory=lambda: _env("CARTESIA_VOICE_ZH_MALE"))
    cartesia_voice_zh_female: str = field(default_factory=lambda: _env("CARTESIA_VOICE_ZH_FEMALE"))
    xai_tts_voice_ru_male: str = field(default_factory=lambda: _env("XAI_TTS_VOICE_RU_MALE"))
    xai_tts_voice_ru_female: str = field(default_factory=lambda: _env("XAI_TTS_VOICE_RU_FEMALE"))
    tts_default_voice: str = field(default_factory=lambda: _gender(_env("TTS_DEFAULT_VOICE", "female")))
    convex_site_url: str = field(default_factory=lambda: _env("CONVEX_SITE_URL").rstrip("/"))
    call_service_token: str = field(default_factory=lambda: _env("CALL_SERVICE_TOKEN"))
    health_port: int = field(default_factory=lambda: int(_env("HEALTH_PORT", "8090") or 8090))
    worker_port: int = field(default_factory=lambda: int(_env("WORKER_PORT", "8081") or 8081))  # agents' own health

    def _voice_id(self, lang: str, gender: str) -> str:
        """The gendered id for the language when set, else the legacy per-language id, else empty."""
        gendered = {("en", "male"): self.cartesia_voice_en_male, ("en", "female"): self.cartesia_voice_en_female,
                    ("zh", "male"): self.cartesia_voice_zh_male, ("zh", "female"): self.cartesia_voice_zh_female,
                    ("ru", "male"): self.xai_tts_voice_ru_male, ("ru", "female"): self.xai_tts_voice_ru_female}
        legacy = {"en": self.cartesia_voice_en, "zh": self.cartesia_voice_zh, "ru": self.xai_tts_voice}
        return gendered.get((lang, gender), "") or legacy.get(lang, "")

    def tts_provider(self, lang: str, gender: str) -> tuple[str, str] | None:
        """(provider, voice id) for a listener language and the speaker's voice gender; None = text only.

        The gendered id (`CARTESIA_VOICE_{EN,ZH}_{MALE,FEMALE}`, `XAI_TTS_VOICE_RU_{MALE,FEMALE}`) wins; without one
        the legacy per-language id (`CARTESIA_VOICE_EN`, `CARTESIA_VOICE_ZH`, `XAI_TTS_VOICE_ID`) voices both genders.
        A gender outside GENDERS means the default voice (`TTS_DEFAULT_VOICE`). Never another provider and never the
        other gender's id (R13): a language and gender without an id is text-only for that gender."""
        if gender not in GENDERS:
            gender = self.tts_default_voice
        voice = self._voice_id(lang, gender)
        if lang == "ru":
            return ("grok", voice) if self.xai_api_key and voice else None
        return ("cartesia", voice) if self.cartesia_api_key and voice else None

    def voices(self) -> dict[str, dict[str, str]]:
        """Per language and gender: the provider name or `text-only` (presence only, never ids)."""
        return {lang: {g: (self.tts_provider(lang, g) or ("text-only",))[0] for g in GENDERS} for lang in LANGS}

    def describe(self) -> dict:
        return {
            "livekit": bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret),
            "stt": bool(self.xai_api_key), "sttModel": self.stt_model,
            "llm": bool(self.anthropic_api_key), "translationModel": self.translation_model,
            "tts": self.voices(), "ttsDefaultVoice": self.tts_default_voice,
            "convex": bool(self.convex_site_url and self.call_service_token),
        }
