"""LiveKit translation worker for coordination rooms (spec section 5; LiveKit Agents for media only).

Joins `coordination-<roomId>` by explicit dispatch as identity `translator`; one job per room (a second request for a
room that already has a translator is rejected, lesson R5). Subscribes only to human microphones (`user-*`, lesson
R1), runs one Grok STT session per speaker track, and for every utterance protects values, translates into the
other languages present, posts the phrase to Convex and voices it on `tr:<lang>:<speaker>` in the speaker's voice
gender (`voice` attribute, `TTS_DEFAULT_VOICE` otherwise). Host speech from Convex arrives as a server data packet and
is voiced on `host:<lang>` by a second connection with identity `host` (host.py); its tracks are never subscribed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator

from livekit import api, rtc
from livekit.agents import AutoSubscribe, JobContext, JobRequest, WorkerOptions, WorkerPermissions, cli

from .config import GENDERS, LANGS, Config
from .convex import ConvexSink
from .health import report
from .host import HostPublisher, HostSpeech
from .pipeline import Pipeline, split_long
from .player import TrackPlayer
from .scripts import plausible
from .segments import SegmentIds
from .stt import Utterance, run_session, session_url
from .translate import GLOSSARY, Translator
from .tts import TTS

log = logging.getLogger("orbit_voice.agent")
IDENTITY = "translator"
ROOM_PREFIX = "coordination-"
HUMAN_PREFIX = "user-"
END = b""  # end of a speaker's audio for the current STT session (mute, unpublish, leave)
MAX_ROOMS = max(1, int(os.environ.get("MAX_ROOMS", "20") or 20))  # rooms one worker process serves (R5 load)


def http_url(ws_url: str) -> str:
    return ws_url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)


def is_human_mic(publication: rtc.TrackPublication, participant: rtc.Participant) -> bool:
    return (participant.identity.startswith(HUMAN_PREFIX) and publication.kind == rtc.TrackKind.KIND_AUDIO
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE)


def speaker_lang(participant: rtc.Participant) -> str | None:
    lang = participant.attributes.get("lang", "")
    return lang if lang in LANGS else None


def listener_langs(participants) -> list[str]:
    """The supported `lang` attributes of the human participants (`user-*`), sorted; never the host or translator."""
    langs = {speaker_lang(p) for p in participants if p.identity.startswith(HUMAN_PREFIX)}
    return sorted(lang for lang in langs if lang)


def speaker_voice(participant: rtc.Participant, default: str) -> str:
    """The speaker's voice gender from the signed `voice` attribute (Convex sets it in the join token); anything
    else is the configured default."""
    voice = participant.attributes.get("voice", "")
    return voice if voice in GENDERS else default


class Speaker:
    """One human microphone: audio frames -> STT sessions (reconnect with a new epoch) -> ordered phrase handling."""

    def __init__(self, room: "RoomTranslator", participant: rtc.RemoteParticipant, track: rtc.Track, lang: str) -> None:
        self.room, self.participant, self.track = room, participant, track
        self.identity, self.lang = participant.identity, lang
        self.ids = SegmentIds(room.room_id, self.identity)
        self.audio: asyncio.Queue[bytes] = asyncio.Queue(maxsize=500)  # ~10 s of 20 ms frames
        self.phrases: asyncio.Queue[tuple[Utterance, float, str] | None] = asyncio.Queue()
        self.closed = False
        self.tasks = [asyncio.create_task(self._frames()), asyncio.create_task(self._sessions()),
                      asyncio.create_task(self._handle())]

    def _put(self, chunk: bytes) -> None:
        if self.audio.full():  # STT is behind: drop the oldest frame rather than block the media loop or fail
            self.audio.get_nowait()
        self.audio.put_nowait(chunk)

    async def _frames(self) -> None:
        stream = rtc.AudioStream(self.track, sample_rate=16000, num_channels=1)
        try:
            async for ev in stream:
                if self.closed:
                    break
                self._put(bytes(ev.frame.data))
        finally:
            self._put(END)  # the stream ended on its own: finish the STT session instead of blocking on it
            await stream.aclose()

    def end_session(self) -> None:
        """Mute or unpublish: the current STT session sends audio.done and finishes its last utterance."""
        self._put(END)

    async def _chunks(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self.audio.get()
            if chunk == END:
                return
            yield chunk

    async def _sessions(self) -> None:
        cfg, backoff = self.room.cfg, 1.0
        keyterms = cfg.stt_keyterms or tuple(t["term"] for t in GLOSSARY["terms"])
        while not self.closed:
            first = await self.audio.get()  # wait for speech (or a new unmute) before opening a session
            if first == END:
                continue
            self.lang = speaker_lang(self.participant) or self.lang  # the attribute may change between sessions
            self.ids.new_epoch()
            started = time.time()
            url = session_url(self.lang, cfg.stt_model, cfg.stt_endpointing_ms, keyterms)
            log.info("stt session %s lang=%s epoch=%s", self.identity, self.lang, self.ids.epoch)

            async def audio() -> AsyncIterator[bytes]:
                yield first
                async for c in self._chunks():
                    yield c

            async def on_utterance(u: Utterance, start: float = started, lang: str = self.lang) -> None:
                if not plausible(u.text, lang):  # R9: foreign-script hallucination on noise
                    log.info("dropped implausible utterance from %s", self.identity)
                    return
                await self.phrases.put((u, start, lang))  # the session's language travels with its phrases
            try:
                await run_session(url, cfg.xai_api_key, audio(), on_utterance)
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # STTError or anything unexpected: reconnect, never go deaf silently (W3, W5)
                log.warning("stt %s: %s; reconnecting with a new epoch", self.identity, e)
                report("stt", f"{type(e).__name__}: {e}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 8.0)

    async def _handle(self) -> None:
        while True:
            item = await self.phrases.get()
            if item is None:
                return
            u, session_start, lang = item
            # wall-clock epoch ms of the utterance start (contract)
            started = int((session_start + u.started_s) * 1000) if u.started_s is not None else int(time.time() * 1000)
            gender = speaker_voice(self.participant, self.room.cfg.tts_default_voice)  # re-read per phrase, like lang
            # the raw recognized text is split and stored; each part is normalized for protection in the pipeline
            for part in split_long(u.text):
                try:
                    await self.room.pipeline.handle(room_id=self.room.room_id, identity=self.identity, src=lang,
                                                    gender=gender, text=part, started_at_ms=started,
                                                    segment=self.ids.next_segment(), targets=self.room.targets(lang))
                except Exception as e:
                    log.exception("phrase from %s failed", self.identity)
                    report("pipeline", type(e).__name__)

    async def close(self) -> None:
        """Ends the STT session (audio.done), lets queued phrases finish, then stops every task."""
        if self.closed:
            return
        self.closed = True
        self.end_session()
        await self.phrases.put(None)
        handle = self.tasks[2]
        try:
            await asyncio.wait_for(asyncio.shield(handle), 30)
        except (asyncio.TimeoutError, Exception):
            pass
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


class RoomTranslator:
    def __init__(self, ctx: JobContext, cfg: Config) -> None:
        self.ctx, self.cfg, self.room = ctx, cfg, ctx.room
        self.room_id = self.room.name.removeprefix(ROOM_PREFIX)
        self.speakers: dict[str, Speaker] = {}
        self.players: dict[str, TrackPlayer] = {}
        self._starting: dict[str, asyncio.Task] = {}
        self.translator = Translator(cfg.anthropic_api_key, cfg.translation_model)
        self.tts = TTS(cfg)
        self.sink = ConvexSink(cfg.convex_site_url, cfg.call_service_token)
        self.pipeline = Pipeline(self.translator, self.tts, self.sink, self.play)
        self.host_voice = HostPublisher(cfg, self.room.name, self.humans)
        self.host = HostSpeech(self.room_id, self.translator, self.tts, self.host_voice.play, self.listener_langs,
                               cfg.tts_default_voice)

    def humans(self) -> list[str]:
        return [p.identity for p in self.room.remote_participants.values() if p.identity.startswith(HUMAN_PREFIX)]

    def listener_langs(self) -> list[str]:
        return listener_langs(self.room.remote_participants.values())

    def targets(self, src: str) -> list[str]:
        return [lang for lang in self.listener_langs() if lang != src]

    async def play(self, lang: str, identity: str, chunks: AsyncIterator[bytes]) -> asyncio.Future:
        """Enqueues on `tr:<lang>:<speaker>`; a player is registered only after its track was published."""
        key = f"{lang}:{identity}"
        player = self.players.get(key)
        if player is None:
            starting = self._starting.get(key)
            if starting is None:
                starting = self._starting[key] = asyncio.create_task(self._start_player(key, lang, identity))
            try:
                player = await asyncio.shield(starting)
            finally:
                if starting.done():
                    self._starting.pop(key, None)
        return player.enqueue(chunks)

    async def _start_player(self, key: str, lang: str, identity: str) -> TrackPlayer:
        player = TrackPlayer(self.room, lang, identity)
        try:
            await player.start()
        except Exception:
            await player.close()
            raise
        self.players[key] = player
        return player

    def on_published(self, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if is_human_mic(publication, participant):
            publication.set_subscribed(True)

    def on_subscribed(self, track: rtc.Track, publication: rtc.RemoteTrackPublication,
                      participant: rtc.RemoteParticipant) -> None:
        if not is_human_mic(publication, participant):
            return
        lang = speaker_lang(participant)
        if lang is None:  # never guess a language: no session, visible in /health
            log.warning("%s has no supported lang attribute; not translated", participant.identity)
            report("speaker", f"{participant.identity}: unsupported lang attribute")
            return
        old = self.speakers.pop(participant.identity, None)  # one audio owner per identity (R10)
        if old:
            asyncio.create_task(old.close())
        self.speakers[participant.identity] = Speaker(self, participant, track, lang)

    async def _leave(self, identity: str) -> None:
        sp = self.speakers.pop(identity, None)
        if sp:
            await sp.close()  # finishes its queued phrases first
        for key in [k for k in self.players if k.endswith(":" + identity)]:
            await self.players.pop(key).close()

    def on_gone(self, participant: rtc.Participant) -> None:
        asyncio.create_task(self._leave(participant.identity))
        if participant.identity.startswith(HUMAN_PREFIX):
            # a lingering `host` would keep the empty room open; idle() decides on the humans present when it runs
            asyncio.create_task(self.host_voice.idle())

    def on_unsubscribed(self, track: rtc.Track, publication: rtc.TrackPublication, participant: rtc.Participant) -> None:
        self.on_unpublished(publication, participant)

    def on_unpublished(self, publication: rtc.TrackPublication, participant: rtc.Participant) -> None:
        if is_human_mic(publication, participant):
            sp = self.speakers.pop(participant.identity, None)
            if sp:
                asyncio.create_task(sp.close())

    def on_muted(self, participant: rtc.Participant, publication: rtc.TrackPublication) -> None:
        sp = self.speakers.get(participant.identity)
        if sp and is_human_mic(publication, participant):
            sp.end_session()

    def wire(self) -> None:
        r = self.room
        r.on("track_published", self.on_published)
        r.on("track_subscribed", self.on_subscribed)
        r.on("track_unpublished", self.on_unpublished)
        r.on("track_unsubscribed", self.on_unsubscribed)
        r.on("track_muted", self.on_muted)
        r.on("participant_disconnected", self.on_gone)
        r.on("data_received", self.host.on_data)
        for p in r.remote_participants.values():
            for pub in p.track_publications.values():
                self.on_published(pub, p)  # type: ignore[arg-type]

    async def close(self) -> None:
        await self.host_voice.close()  # releases queued host lines with an error (never a hang)
        await self.host.drain()
        for identity in list(self.speakers):
            await self._leave(identity)
        for pl in list(self.players.values()):
            await pl.close()
        await self.pipeline.drain()
        await self.sink.http.aclose()
        await self.tts.http.aclose()
        await self.translator.client.close()


async def request(req: JobRequest) -> None:
    """Accept one translator per room (R5): a room that already has `translator` rejects a second job."""
    cfg = Config()
    if not req.room.name.startswith(ROOM_PREFIX):
        await req.reject()
        return
    checked = False
    for attempt in (1, 2, 3):  # a short API hiccup should not let a second translator in
        try:
            lk = api.LiveKitAPI(http_url(cfg.livekit_url), cfg.livekit_api_key, cfg.livekit_api_secret)
            try:
                res = await lk.room.list_participants(api.ListParticipantsRequest(room=req.room.name))
            finally:
                await lk.aclose()
            if any(p.identity == IDENTITY for p in res.participants):
                log.info("room %s already has a translator; rejecting a second job", req.room.name)
                await req.reject()
                return
            checked = True
            break
        except Exception as e:
            log.warning("participant check failed (%d/3): %s", attempt, type(e).__name__)
            await asyncio.sleep(0.5 * attempt)
    if not checked:  # fail closed: never risk a second translator; LiveKit re-offers the job
        report("dispatch", "participant check failed; job rejected")
        await req.reject()
        return
    await req.accept(identity=IDENTITY, name="Translator", attributes={"role": "translator"})


async def entrypoint(ctx: JobContext) -> None:
    cfg = Config()
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    rt = RoomTranslator(ctx, cfg)
    from .normalize import normalize
    await asyncio.to_thread(normalize, "\u516d", "zh")  # load cn2an's data once, off the audio loop
    rt.wire()
    log.info("translator joined %s; config %s", ctx.room.name, cfg.describe())
    done = asyncio.Event()
    ctx.room.on("disconnected", lambda *_: done.set())

    async def shutdown(*_args) -> None:
        await rt.close()
    ctx.add_shutdown_callback(shutdown)
    await done.wait()


def load(server) -> float:
    """R5: report load as active rooms / MAX_ROOMS, so a lightly used worker never reports itself full."""
    return min(1.0, len(getattr(server, "active_jobs", []) or []) / MAX_ROOMS)


def options() -> WorkerOptions:
    cfg = Config()
    return WorkerOptions(entrypoint_fnc=entrypoint, request_fnc=request, agent_name=cfg.agent_name,
                         load_fnc=load, load_threshold=0.95, port=cfg.worker_port,
                         permissions=WorkerPermissions(can_publish=True, can_subscribe=True, can_publish_data=False,
                                                       can_update_metadata=False, hidden=False))


def main() -> None:
    cli.run_app(options())
