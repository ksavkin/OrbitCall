"""Grok streaming speech-to-text (`wss://api.x.ai/v1/stt`), one session per speaker track (W3).

Audio goes in as raw 16 kHz s16le mono binary frames; the server answers `transcript.created`, then
`transcript.partial` events (`is_final` locks a chunk, `speech_final` ends an utterance after `endpointing` ms of
silence) and `transcript.done` after `audio.done`. An utterance is the concatenation of its locked chunks.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlencode

import websockets

log = logging.getLogger("orbit_voice.stt")
STT_URL = "wss://api.x.ai/v1/stt"
SAMPLE_RATE = 16000
DONE_TIMEOUT_S = 15.0  # after audio.done the server must answer transcript.done; else the session counts as dropped
SAME_START_S = 1e-3


@dataclass
class Utterance:
    text: str
    started_s: float | None  # seconds from the session start (first word), when the server reports words
    ended_s: float | None


def session_url(lang: str, model: str, endpointing_ms: int, keyterms: tuple[str, ...] = ()) -> str:
    params: list[tuple[str, str]] = [("model", model), ("encoding", "pcm"), ("sample_rate", str(SAMPLE_RATE)),
                                     ("language", lang), ("format", "true"), ("interim_results", "false"),
                                     ("endpointing", str(endpointing_ms))]
    params += [("keyterm", k[:50]) for k in keyterms[:100]]
    return f"{STT_URL}?{urlencode(params)}"


def _text(ev: dict) -> str:
    for key in ("text", "transcript"):
        if isinstance(ev.get(key), str):
            return ev[key]
    words = ev.get("words") or []
    return " ".join(w.get("text", "") for w in words if isinstance(w, dict)).strip()


def _span(ev: dict) -> tuple[float | None, float | None]:
    words = [w for w in ev.get("words") or [] if isinstance(w, dict)]
    if not words:
        return None, None
    return words[0].get("start"), words[-1].get("end")


class Assembler:
    """Turns server events into utterances. Measured on the live service: a locked chunk (`is_final`) is sent again
    in the `speech_final` event with the same `start`, so a chunk is keyed by its start time and a later event that
    starts at or before a kept chunk replaces it (no duplicates, nothing lost when one final covers several chunks)."""

    def __init__(self) -> None:
        self.parts: list[tuple[float | None, float | None, str]] = []  # (start, end, text)

    def feed(self, ev: dict) -> Utterance | None:
        kind = ev.get("type")
        if kind == "transcript.partial" and ev.get("is_final"):
            text = _text(ev).strip()
            start = ev.get("start") if isinstance(ev.get("start"), (int, float)) else _span(ev)[0]
            end = start + ev["duration"] if start is not None and isinstance(ev.get("duration"), (int, float)) \
                else _span(ev)[1]
            if start is not None:  # same chunk (start within 1 ms) or a final covering later chunks: replace
                self.parts = [p for p in self.parts if p[0] is None or p[0] < start - SAME_START_S]
            elif ev.get("speech_final") or (self.parts and self.parts[-1][2] == text):
                self.parts = [] if ev.get("speech_final") else self.parts[:-1]
            if text:
                self.parts.append((start, end, text))
            if ev.get("speech_final"):
                return self.flush()
        elif kind == "transcript.done":
            return self.flush()
        return None

    def flush(self) -> Utterance | None:
        text = " ".join(p[2] for p in self.parts).strip()
        u = Utterance(text, self.parts[0][0], self.parts[-1][1]) if text else None
        self.parts = []
        return u


class STTError(Exception):
    pass


async def run_session(url: str, api_key: str, audio: AsyncIterator[bytes],
                      on_utterance: Callable[[Utterance], Awaitable[None]],
                      connect=websockets.connect, done_timeout: float = DONE_TIMEOUT_S) -> None:
    """One STT session: streams `audio` until it ends (mute, unpublish, leave), then `audio.done` and drain.
    Raises STTError on a dropped or stalled connection, a server error or a malformed frame, after handing over any
    locked text, so the caller can reconnect with a new epoch."""
    asm = Assembler()
    sent_done = asyncio.Event()
    try:
        async with connect(url, additional_headers={"Authorization": f"Bearer {api_key}"}, max_size=2**22,
                           open_timeout=10) as ws:
            first = _event(await asyncio.wait_for(ws.recv(), 10))
            if first.get("type") == "error":
                raise STTError(f"stt: {first.get('code') or first.get('message') or 'error'}")

            async def pump() -> None:
                async for chunk in audio:
                    await ws.send(chunk)
                await ws.send(json.dumps({"type": "audio.done"}))
                sent_done.set()

            sender = asyncio.create_task(pump())
            done = False
            recv: asyncio.Future | None = None  # one pending recv at a time (websockets forbids concurrent recv)
            try:
                while True:
                    if recv is None:
                        recv = asyncio.ensure_future(ws.recv())
                    if sent_done.is_set():  # after audio.done the server must finish promptly
                        finished, _ = await asyncio.wait({recv}, timeout=done_timeout)
                        if not finished:
                            raise STTError("stt: no transcript.done after audio.done")
                    else:  # while audio flows the server may be silent for long: wake up when audio.done is sent
                        flag = asyncio.ensure_future(sent_done.wait())
                        finished, _ = await asyncio.wait({recv, flag}, return_when=asyncio.FIRST_COMPLETED)
                        flag.cancel()
                        if recv not in finished:
                            continue  # keep the same pending recv, now with the bounded wait
                    fut, recv = recv, None
                    try:
                        raw = fut.result()
                    except websockets.ConnectionClosedOK:
                        break
                    if isinstance(raw, bytes):
                        continue
                    ev = _event(raw)
                    if ev.get("type") == "error":
                        raise STTError(f"stt: {ev.get('code') or ev.get('message') or 'error'}")
                    u = asm.feed(ev)
                    if u:
                        await on_utterance(u)
                    if ev.get("type") == "transcript.done":
                        done = True
                        break
            finally:
                if recv is not None:
                    recv.cancel()
                if not sender.done():
                    sender.cancel()
            if not done:
                raise STTError("stt: connection closed before transcript.done")
    except STTError:
        await _hand_over(asm, on_utterance)
        raise
    except (websockets.WebSocketException, OSError, asyncio.TimeoutError) as e:
        await _hand_over(asm, on_utterance)  # a real drop: the locked chunks are not lost
        raise STTError(f"stt connection: {type(e).__name__}") from e


def _event(raw) -> dict:
    try:
        ev = json.loads(raw)
    except (TypeError, ValueError) as e:
        raise STTError("stt: malformed frame") from e
    if not isinstance(ev, dict):
        raise STTError("stt: malformed frame")
    return ev


async def _hand_over(asm: Assembler, on_utterance) -> None:
    pending = asm.flush()
    if pending:
        await on_utterance(pending)
