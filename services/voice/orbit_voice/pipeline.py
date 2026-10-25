"""One recognized utterance -> protected values -> translation per listener language -> Convex rows -> voice.

Failures are visible, never silence (W5): a language whose translation failed the value check or whose provider was
down is posted as `original_only` with `errors[lang] = { code, message }`; a voice failure keeps the text `ok` and
adds `TTS_FAILED`. Rows: rev 1 pending, rev 2 final, rev 3 only when a voice failed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from .health import report
from .normalize import normalize
from .segments import Segment
from .tts import TTSError
from .values import protect

log = logging.getLogger("orbit_voice.pipeline")
MAX_TEXT = 2000


def prefetch(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Starts synthesis now and buffers it, so the audio is ready when the phrase's turn on the track comes."""
    q: asyncio.Queue = asyncio.Queue()

    async def fill() -> None:
        try:
            async for c in chunks:
                await q.put(c)
        except Exception as e:  # handed to the player, which fails the phrase's future with it
            await q.put(e)
        finally:
            await q.put(None)
    task = asyncio.create_task(fill())

    async def gen() -> AsyncIterator[bytes]:
        try:
            while (item := await q.get()) is not None:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            task.cancel()
    return gen()


class Sink(Protocol):
    async def post(self, phrase: dict) -> bool: ...


class Voice(Protocol):
    def available(self, lang: str) -> bool: ...
    def stream(self, text: str, lang: str) -> AsyncIterator[bytes]: ...


# play(lang, speaker_identity, chunks) -> enqueues on that track and returns a future that resolves when the phrase has
# played (or raises what the chunk iterator raised). Translation never waits for playout (phrases keep their order).
Play = Callable[[str, str, AsyncIterator[bytes]], Awaitable[Awaitable[None]]]
MAX_VALUES = 64


@dataclass
class Result:
    seg_id: str
    translations: dict[str, str] = field(default_factory=dict)
    errors: dict[str, dict] = field(default_factory=dict)
    timings_ms: dict[str, int] = field(default_factory=dict)


def split_long(text: str, limit: int = MAX_TEXT - 200) -> list[str]:
    """No silent truncation (lesson R16): a very long utterance becomes several phrases, cut at sentence ends,
    else at spaces, else hard."""
    parts: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind(c) for c in ".!?;\u3002\uff01\uff1f")
        if cut < limit // 2:
            cut = max(window.rfind(c) for c in " ,\uff0c\u3001")
        cut = cut + 1 if cut >= limit // 2 else limit
        while 0 < cut < len(rest) and _joins(rest[cut - 1], rest[cut]):  # never split a value or a word
            cut -= 1
        if cut == 0:
            cut = limit
        parts.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        parts.append(rest)
    return parts


def _joins(a: str, b: str) -> bool:
    """True when a cut between `a` and `b` could split a number, a designator or a Latin word."""
    def part(c: str) -> bool:
        return c.isascii() and (c.isalnum() or c in ".,:-+/^%")
    return part(a) and part(b)


class Pipeline:
    def __init__(self, translator, voice: Voice, sink: Sink, play: Play, clock=time.monotonic) -> None:
        self.translator, self.voice, self.sink, self.play, self.clock = translator, voice, sink, play, clock
        self._background: set[asyncio.Task] = set()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    async def drain(self) -> None:
        """Waits for queued playback and the rows it may still post (tests, shutdown)."""
        while self._background:
            await asyncio.gather(*list(self._background), return_exceptions=True)

    async def handle(self, *, room_id: str, identity: str, src: str, text: str, started_at_ms: int,
                     segment: Segment, targets: list[str]) -> Result:
        t0 = self.clock()
        if len(text) > MAX_TEXT:
            raise ValueError("utterance longer than MAX_TEXT: split it first (split_long)")
        # The stored original is what the recognizer heard (audit); the zh-normalized form is used only to protect
        # values and translate. cn2an is synchronous: off the event loop.
        prepared, normalized = await asyncio.to_thread(normalize, text, src)
        masked, values = protect(prepared)
        res = Result(segment.seg_id)
        base = {"roomId": room_id, "eventId": None, "segId": segment.seg_id, "speakerIdentity": identity,
                "originalLang": src, "original": text, "values": [v.as_json() for v in values[:MAX_VALUES]],
                "startedAtMs": started_at_ms}
        if normalized:
            log.info("%s: zh numerals normalized before protection", segment.seg_id)
        # Rows go out in the background: the translation does not wait for a network round trip. Safe because revs are
        # allocated here in handler order (Segment.next_rev) and Convex keeps the highest rev of a segment.
        posts = [asyncio.create_task(self.sink.post({**base, "rev": segment.next_rev(), "translations": {},
                                                     "translationStatus": {t: "pending" for t in targets}}))]
        try:
            return await self._finish(base, segment, src, masked, values, targets, res, t0, posts)
        except Exception as e:  # never leave a pending row behind (W5): the original with a visible failure
            log.exception("%s failed", segment.seg_id)
            report("pipeline", type(e).__name__)
            err = {"code": "PIPELINE_FAILED", "message": type(e).__name__}
            posts.append(asyncio.create_task(self.sink.post({
                **base, "rev": segment.next_rev(), "translations": {}, "translationStatus": {t: "original_only" for t in targets},
                **({"errors": {t: err for t in targets}} if targets else {})})))
            await asyncio.gather(*posts, return_exceptions=True)
            res.translations, res.errors = {}, {t: err for t in targets}
            return res

    async def _finish(self, base, segment, src, masked, values, targets, res, t0, posts) -> Result:
        if len(values) > MAX_VALUES:  # beyond the ingest limit: the original only, visibly (never a voiced phrase)
            err = {"code": "TOO_MANY_VALUES", "message": f"{len(values)} values (limit {MAX_VALUES})"}
            res.errors = {t: err for t in targets}
            posts.append(asyncio.create_task(self.sink.post({
                **base, "rev": segment.next_rev(), "translations": {}, "translationStatus": {t: "original_only" for t in targets},
                **({"errors": res.errors} if targets else {})})))
            await asyncio.gather(*posts, return_exceptions=True)
            return res
        if targets:
            tr = await self.translator.translate(masked, values, src, targets)
            res.translations, res.errors = dict(tr.texts), dict(tr.errors)
        res.timings_ms["translate"] = int((self.clock() - t0) * 1000)
        status = {t: ("ok" if t in res.translations else "original_only") for t in targets}
        spoken = []
        for lang in res.translations:  # text is correct either way; a missing voice is stated, not silent
            if self.voice.available(lang):
                spoken.append(lang)
            else:
                res.errors[lang] = {"code": "VOICE_UNAVAILABLE", "message": f"no voice configured for {lang}"}
        posts.append(asyncio.create_task(self.sink.post({
            **base, "rev": segment.next_rev(), "translations": dict(res.translations), "translationStatus": status,
            **({"errors": dict(res.errors)} if res.errors else {})})))

        async def watch(lang: str, done: Awaitable[None]) -> None:
            """Playback finishes later; a voice failure becomes a new row (the text stays ok)."""
            try:
                await done
            except TTSError as e:
                res.errors[lang] = {"code": "TTS_FAILED", "message": str(e)[:200]}
            except Exception as e:  # the track went away (speaker left) or the player failed
                res.errors[lang] = {"code": "TTS_FAILED", "message": f"playback: {type(e).__name__}"}
            else:
                return
            report("tts", res.errors[lang]["code"])
            await self.sink.post({**base, "rev": segment.next_rev(), "translations": dict(res.translations),
                                  "translationStatus": status, "errors": dict(res.errors)})

        for lang in spoken:
            try:
                done = await self.play(lang, base["speakerIdentity"], prefetch(self.voice.stream(res.translations[lang], lang)))
            except Exception as e:  # no track to play on: visible
                res.errors[lang] = {"code": "TTS_FAILED", "message": f"playback: {type(e).__name__}"}
                self._spawn(self.sink.post({**base, "rev": segment.next_rev(), "translations": dict(res.translations),
                                            "translationStatus": status, "errors": dict(res.errors)}))
                continue
            self._spawn(watch(lang, done))
        await asyncio.gather(*posts, return_exceptions=True)
        res.timings_ms["total"] = int((self.clock() - t0) * 1000)
        if any(e["code"] == "UPSTREAM_UNAVAILABLE" for e in res.errors.values()):
            report("translation", "UPSTREAM_UNAVAILABLE")  # visible in /health
        log.info("%s %s->%s timings %s errors %s", segment.seg_id, src, ",".join(targets) or "-", res.timings_ms,
                 {k: v["code"] for k, v in res.errors.items()})
        return res
