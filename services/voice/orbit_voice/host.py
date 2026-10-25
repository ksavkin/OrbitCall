"""Host speech (issue #6, roadmap: "Generate canonical host text, then use Claude translation and the selected
Cartesia/Grok TTS routes for each listener. Host speech cannot create an approval.").

Convex (`convex/call/hostSpeech.ts`) sends one checked host text of a succeeded Coordination Host run as a reliable
LiveKit data packet through the server API (`RoomService/SendData`), addressed to `translator`, topic
`orbit.host-speech`. A packet counts only when it has no sending participant (`DataPacket.participant is None`: sent by
a server SDK; a human's packet always has one) and carries that topic. The text is canonical English: an English
listener hears it as is, every other listener language gets one Claude translation call with protected values and the
per-language check of phrases; a language whose translation fails is not voiced (no substitution, lesson R13). Voice
goes through the TTS routes of phrases in the default voice gender (`TTS_DEFAULT_VOICE`: the host has no member gender)
and plays on `host:<lang>` tracks published by a second connection with identity `host`, because clients accept
`host:<lang>` only from `host` / `host-*` (web/src/call/tracks.ts). That connection publishes and subscribes to
nothing, so the host's own voice is never transcribed. Host speech writes no phrase rows: its captions are the host's
messages in the room.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from livekit import api, rtc

from .config import Config
from .health import report
from .pipeline import MAX_VALUES, prefetch
from .player import TrackPlayer, host_track_name
from .translate import MAX_TEXT
from .values import protect

log = logging.getLogger("orbit_voice.host")
TOPIC = "orbit.host-speech"
VERSION = 1
IDENTITY = "host"
NAME = "Coordination Host"
SOURCE_LANG = "en"  # host text is canonical English (convex/lib/host.ts)
MAX_PACKET = 16_384  # bytes: a 2000-character text in JSON with escapes stays well below
MAX_ID = 200
MAX_SEEN = 256  # recent ids kept for dedupe
# Outcomes that mark /health degraded, as in the phrase pipeline; a missing voice id or a rejected translation is a
# logged, visible outcome of configuration or content, not a fault of the worker.
HEALTH_CODES = {"UPSTREAM_UNAVAILABLE", "PIPELINE_FAILED", "TTS_FAILED"}
TOKEN_TTL = datetime.timedelta(hours=6)

# play(lang, chunks) -> enqueues on `host:<lang>` and returns a future that resolves when the line has played
Play = Callable[[str, AsyncIterator[bytes]], Awaitable[Awaitable[None]]]


@dataclass(frozen=True)
class HostLine:
    id: str
    host_run_id: str
    text: str


def _short_str(value: object, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit


def parse(packet: rtc.DataPacket, room_id: str) -> tuple[HostLine | None, str]:
    """(line, "ok") for an authentic, valid host speech packet of this room; else (None, the reason)."""
    if packet.participant is not None:
        return None, f"sent by participant {packet.participant.identity}, not by the server"
    if packet.topic != TOPIC:
        return None, f"topic {packet.topic!r}"
    if len(packet.data) > MAX_PACKET:
        return None, f"packet of {len(packet.data)} bytes"
    try:
        body = json.loads(bytes(packet.data).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "not UTF-8 JSON"
    if not isinstance(body, dict):
        return None, "not a JSON object"
    v = body.get("v")
    if type(v) is not int or v != VERSION:
        return None, f"version {v!r}"
    if body.get("lang") != SOURCE_LANG:
        return None, f"lang {body.get('lang')!r}"
    if body.get("roomId") != room_id:
        return None, "another room"
    if not _short_str(body.get("id"), MAX_ID) or not _short_str(body.get("hostRunId"), MAX_ID):
        return None, "missing id or hostRunId"
    text = body.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        return None, f"text must be 1..{MAX_TEXT} characters"
    return HostLine(body["id"], body["hostRunId"], text.strip()), "ok"


class HostSpeech:
    """Accepts host speech packets of one room and voices each line for the current listener languages. Lines are
    handled one at a time, so their order is kept on every `host:<lang>` track; playback never blocks the next line."""

    max_seen = MAX_SEEN

    def __init__(self, room_id: str, translator, voice, play: Play, listeners: Callable[[], list[str]],
                 gender: str) -> None:
        self.room_id, self.translator, self.voice, self.play = room_id, translator, voice, play
        self.listeners, self.gender = listeners, gender
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.failures: deque[tuple[str, str, str]] = deque(maxlen=64)  # (line id, lang, code): voices failed in playback
        self._lock = asyncio.Lock()
        self._background: set[asyncio.Task] = set()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    def on_data(self, packet: rtc.DataPacket) -> None:
        """Room `data_received` handler: everything that is not host speech is ignored with a log line."""
        line, why = parse(packet, self.room_id)
        if line is None:
            if packet.participant is not None or packet.topic != TOPIC:
                log.info("data packet ignored: %s", why)
            else:
                log.warning("host speech packet rejected: %s", why)
                report("host", f"packet rejected: {why}")
            return
        if line.id in self.seen:
            log.info("host speech %s repeated; dropped", line.id)
            return
        self.seen[line.id] = None
        while len(self.seen) > self.max_seen:
            self.seen.popitem(last=False)
        self._spawn(self.speak(line))

    async def speak(self, line: HostLine) -> dict[str, str]:
        """Translates and enqueues one line; returns per listener language `queued` or the reason it is not voiced."""
        async with self._lock:
            try:
                return await self._speak(line)
            except Exception as e:  # never kill the room job over one line
                log.exception("host speech %s failed", line.id)
                report("host", type(e).__name__)
                return {}

    async def _speak(self, line: HostLine) -> dict[str, str]:
        langs = self.listeners()
        if not langs:
            log.info("host speech %s: no listeners", line.id)
            return {}
        out: dict[str, str] = {}
        if SOURCE_LANG in langs:  # English listeners hear the canonical text at once, not after the translation
            await self._voice(line, SOURCE_LANG, line.text, out)
        present = set(self.listeners())
        others = [lang for lang in langs if lang != SOURCE_LANG and lang in present]
        out.update({lang: "NO_LISTENERS" if not present else "LISTENER_LEFT"
                    for lang in langs if lang != SOURCE_LANG and lang not in present})
        if others:
            texts: dict[str, str] = {}
            masked, values = protect(line.text)
            if len(values) > MAX_VALUES:  # like phrases: beyond the value limit nothing is translated
                out.update({lang: "TOO_MANY_VALUES" for lang in others})
            else:
                try:
                    tr = await self.translator.translate(masked, values, SOURCE_LANG, others)
                    texts.update(tr.texts)
                    out.update({lang: err["code"] for lang, err in tr.errors.items()})
                except Exception as e:
                    log.warning("host speech %s: translation failed: %s", line.id, type(e).__name__)
                    out.update({lang: "PIPELINE_FAILED" for lang in others})
            for lang in others:
                if lang in texts:
                    await self._voice(line, lang, texts[lang], out)
        failed = {lang: code for lang, code in out.items() if code != "queued"}
        faults = sorted({code for code in failed.values() if code in HEALTH_CODES})
        if faults:
            report("host", ",".join(faults))
        log.info("host speech %s run=%s langs=%s not voiced=%s", line.id, line.host_run_id, ",".join(langs), failed)
        return out

    async def _voice(self, line: HostLine, lang: str, text: str, out: dict[str, str]) -> None:
        """Enqueues one language of a line, unless its listeners are gone: a line never reconnects the `host` connection
        for a room the last human has left."""
        present = self.listeners()
        if not present:
            out[lang] = "NO_LISTENERS"
            return
        if lang not in present:
            out[lang] = "LISTENER_LEFT"
            return
        if not self.voice.available(lang, self.gender):
            out[lang] = "VOICE_UNAVAILABLE"
            return
        try:
            done = await self.play(lang, prefetch(self.voice.stream(text, lang, self.gender)))
        except Exception as e:  # no host track to play on
            log.warning("host speech %s: no %s track: %s", line.id, host_track_name(lang), type(e).__name__)
            out[lang] = "TTS_FAILED"
            return
        out[lang] = "queued"
        self._spawn(self._watch(line, lang, done))

    async def _watch(self, line: HostLine, lang: str, done: Awaitable[None]) -> None:
        try:
            await done
        except Exception as e:
            log.warning("host speech %s on %s failed: %s", line.id, host_track_name(lang), type(e).__name__)
            self.failures.append((line.id, lang, "TTS_FAILED"))
            report("host", "TTS_FAILED")

    async def drain(self) -> None:
        """Waits for queued lines and their playback (tests, shutdown)."""
        while self._background:
            await asyncio.gather(*list(self._background), return_exceptions=True)


def host_token(cfg: Config, room_name: str) -> str:
    """Join token of the `host` connection: publish the microphone source only, subscribe to nothing, no data, no
    room configuration (it dispatches no agent), not hidden (clients must see its tracks)."""
    return (api.AccessToken(cfg.livekit_api_key, cfg.livekit_api_secret).with_identity(IDENTITY).with_name(NAME)
            .with_attributes({"role": "host"}).with_ttl(TOKEN_TTL)
            .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish=True,
                                         can_publish_sources=["microphone"], can_subscribe=False,
                                         can_publish_data=False, can_update_own_metadata=False)).to_jwt())


class HostPublisher:
    """The second connection of the room job, identity `host`: connected on the first host line, reused, left when the
    last human leaves (so the room can close) and closed with the job. One `host:<lang>` track per language."""

    def __init__(self, cfg: Config, room_name: str, room_factory: Callable[[], rtc.Room] = rtc.Room) -> None:
        self.cfg, self.room_name, self._room_factory = cfg, room_name, room_factory
        self.room: rtc.Room | None = None
        self.players: dict[str, TrackPlayer] = {}
        self._lock = asyncio.Lock()
        self._closed = False
        self.generation = 0  # one per connection; an idle() decided for an older one is ignored

    async def play(self, lang: str, chunks: AsyncIterator[bytes]) -> asyncio.Future:
        async with self._lock:
            if self._closed:
                raise ConnectionError("host voice closed")
            if self.room is None or not self.room.isconnected():
                await self._leave()  # players of a dropped connection are dead
                room = self._room_factory()
                await room.connect(self.cfg.livekit_url, host_token(self.cfg, self.room_name),
                                   rtc.RoomOptions(auto_subscribe=False))
                self.room = room
                self.generation += 1
                log.info("host connected to %s", self.room_name)
            player = self.players.get(lang)
            if player is None:
                player = TrackPlayer(self.room, lang, IDENTITY, name=host_track_name(lang))
                try:
                    await player.start()
                except Exception:
                    await player.close()
                    raise
                self.players[lang] = player
        return player.enqueue(chunks)

    async def _leave(self) -> None:
        players, self.players = list(self.players.values()), {}
        for player in players:
            await player.close()
        room, self.room = self.room, None
        if room is not None:
            try:
                await room.disconnect()
            except Exception:  # already gone
                pass

    async def idle(self, generation: int | None = None) -> None:
        """Leaves the room; a later host line connects again. With `generation`, only the connection current when the
        caller decided (the last human left) is left: a line may have connected again since."""
        async with self._lock:
            if generation is not None and generation != self.generation:
                return
            if self.room is not None:
                log.info("host leaves %s: no humans left", self.room_name)
            await self._leave()

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            await self._leave()
