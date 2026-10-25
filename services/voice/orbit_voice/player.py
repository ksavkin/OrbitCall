"""One published audio track per (listener language, speaker): `tr:<lang>:<speakerIdentity>` (spec section 5), and
per listener language for the Coordination Host: `host:<lang>` (published by the `host` connection, host.py).
Phrases on one track play in order; different tracks play in parallel."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from livekit import rtc

from .tts import SAMPLE_RATE

log = logging.getLogger("orbit_voice.player")
FRAME_SAMPLES = SAMPLE_RATE // 50  # 20 ms
FRAME_BYTES = FRAME_SAMPLES * 2


def track_name(lang: str, identity: str) -> str:
    return f"tr:{lang}:{identity}"


def host_track_name(lang: str) -> str:
    return f"host:{lang}"


class TrackPlayer:
    def __init__(self, room: rtc.Room, lang: str, identity: str, name: str | None = None) -> None:
        """`name` overrides the translation track name (`host:<lang>` for the host connection)."""
        self.room, self.name = room, name or track_name(lang, identity)
        self.source = rtc.AudioSource(SAMPLE_RATE, 1)
        self.track = rtc.LocalAudioTrack.create_audio_track(self.name, self.source)
        self.publication: rtc.LocalTrackPublication | None = None
        self._queue: asyncio.Queue[tuple[AsyncIterator[bytes], asyncio.Future]] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._current: asyncio.Future | None = None
        self._closed = False

    async def start(self) -> None:
        opts = rtc.TrackPublishOptions()
        opts.source = rtc.TrackSource.SOURCE_MICROPHONE
        self.publication = await self.room.local_participant.publish_track(self.track, opts)
        self._task = asyncio.create_task(self._run())

    def enqueue(self, chunks: AsyncIterator[bytes]) -> asyncio.Future:
        """Queues a phrase and returns at once; the future resolves when it has played (or fails). Fails fast when the
        track never started or was closed, so nothing waits on a dead player."""
        if self._closed or self._task is None or self._task.done():
            raise ConnectionError("track not playing")
        done: asyncio.Future = asyncio.get_running_loop().create_future()
        self._queue.put_nowait((chunks, done))
        return done

    async def _run(self) -> None:
        while True:
            chunks, done = await self._queue.get()
            self._current = done
            try:
                buf = b""
                async for chunk in chunks:
                    buf += chunk
                    while len(buf) >= FRAME_BYTES:
                        await self._frame(buf[:FRAME_BYTES])
                        buf = buf[FRAME_BYTES:]
                if buf:
                    await self._frame(buf + b"\0" * (FRAME_BYTES - len(buf)))
                await self.source.wait_for_playout()
                done.set_result(None)
            except Exception as e:  # the TTS stream failed: report to the phrase, keep the track alive
                if not done.done():
                    done.set_exception(e)
            finally:
                self._current = None

    async def _frame(self, pcm: bytes) -> None:
        await self.source.capture_frame(rtc.AudioFrame(data=pcm, sample_rate=SAMPLE_RATE, num_channels=1,
                                                       samples_per_channel=len(pcm) // 2))

    async def close(self) -> None:
        """Stops playback; every phrase still waiting on this track is released with an error (never a hang)."""
        self._closed = True
        current = self._current  # read before cancelling: the task's finally clears it
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        gone = ConnectionError("track closed")
        pending = [current] if current else []
        while not self._queue.empty():
            pending.append(self._queue.get_nowait()[1])
        for done in pending:
            if done is not None and not done.done():
                done.set_exception(gone)
        if self.publication:
            try:
                await self.room.local_participant.unpublish_track(self.publication.sid)
            except Exception:  # the room may already be gone
                pass
        await self.source.aclose()
