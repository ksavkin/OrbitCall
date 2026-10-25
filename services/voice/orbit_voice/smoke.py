"""Live provider smoke without LiveKit or Convex: `python -m orbit_voice.smoke <clip.wav> <lang> <targets>`.

Streams a 16 kHz mono 16-bit WAV to Grok STT in real time, protects values, translates, synthesizes each target, and
prints the text, the check result and per-stage latencies. Reads keys from the environment; never prints them."""

from __future__ import annotations

import asyncio
import sys
import time
import wave

from .config import Config
from .normalize import normalize
from .stt import run_session, session_url
from .translate import GLOSSARY, Translator
from .tts import SAMPLE_RATE, TTS
from .values import protect


async def main(path: str, lang: str, targets: list[str]) -> None:
    cfg = Config()
    w = wave.open(path)
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono s16 WAV"
    pcm = w.readframes(w.getnframes())
    t0 = time.monotonic()
    marks: dict[str, float] = {}

    async def audio():
        step = 320 * 2  # 20 ms
        for i in range(0, len(pcm), step):
            yield pcm[i:i + step]
            await asyncio.sleep(0.02)
        marks["audio_end"] = time.monotonic()
        for _ in range(50):  # 1 s of silence so endpointing can fire before audio.done
            yield b"\0" * step
            await asyncio.sleep(0.02)

    utterances: list[tuple[float, str]] = []

    async def on_u(u):
        utterances.append((time.monotonic(), u.text))
    url = session_url(lang, cfg.stt_model, cfg.stt_endpointing_ms, tuple(t["term"] for t in GLOSSARY["terms"]))
    await run_session(url, cfg.xai_api_key, audio(), on_u)
    print(f"audio {len(pcm) / 32000:.1f} s; utterances {len(utterances)}")
    tr = Translator(cfg.anthropic_api_key, cfg.translation_model)
    tts = TTS(cfg)
    for at, text in utterances:
        print(f"\nSTT  +{(at - marks.get('audio_end', at)) * 1000:.0f} ms after audio end: {text.encode('unicode_escape').decode()}")
        norm, changed = normalize(text, lang)
        masked, values = protect(norm)
        print(f"     values {[(v.kind, v.text) for v in values]}{' (zh numerals normalized)' if changed else ''}")
        t1 = time.monotonic()
        out = await tr.translate(masked, values, lang, targets)
        print(f"LLM  {(time.monotonic() - t1) * 1000:.0f} ms ({cfg.translation_model}); errors {out.errors}")
        for t, s in out.texts.items():
            print(f"     {t}: {s.encode('unicode_escape').decode()}")
            if not tts.available(t):
                print(f"TTS  {t}: text-only (no voice configured)")
                continue
            t2, first, n = time.monotonic(), None, 0
            async for chunk in tts.stream(s, t):
                first = first or time.monotonic()
                n += len(chunk)
            print(f"TTS  {t}: first byte {((first or t2) - t2) * 1000:.0f} ms, {n / 2 / SAMPLE_RATE:.1f} s of audio, "
                  f"total {(time.monotonic() - t2) * 1000:.0f} ms")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], [t for t in sys.argv[3].split(",") if t]))
