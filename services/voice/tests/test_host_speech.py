"""Host speech (issue #6): a server packet on `orbit.host-speech` -> translation per listener language -> `host:<lang>`
tracks from a second connection with identity `host`. Packet authenticity, validation, dedupe, listener languages,
a failed language, track names and that the host participant is never subscribed. Providers and LiveKit are faked."""

import asyncio
import json
from types import SimpleNamespace

import jwt  # PyJWT, a livekit-api dependency
import pytest
from livekit import rtc

from orbit_voice.agent import RoomTranslator, listener_langs
from orbit_voice.config import Config
from orbit_voice.host import (IDENTITY, NAME, TOPIC, HostPublisher, HostSpeech, host_token, parse)
from orbit_voice.player import TrackPlayer, host_track_name, track_name
from orbit_voice.translate import Translation
from orbit_voice.tts import TTSError

ROOM_ID = "k57abc"
TEXT = "Both operators accept the plan: a 0.2 m/s burn at 03:14 UTC."


def body(**over):
    b = {"v": 1, "id": "run1:0123456789abcdef", "roomId": ROOM_ID, "hostRunId": "run1", "lang": "en", "text": TEXT}
    b.update(over)
    return b


def packet(data=None, topic=TOPIC, participant=None, raw=None):
    payload = raw if raw is not None else json.dumps(data if data is not None else body()).encode()
    return SimpleNamespace(data=payload, topic=topic, participant=participant, kind=rtc.DataPacketKind.KIND_RELIABLE)


class FakeTranslator:
    def __init__(self, texts=None, errors=None, explode=False):
        self.texts, self.errors, self.explode, self.calls = texts or {}, errors or {}, explode, []

    async def translate(self, masked, values, src, targets):
        self.calls.append((masked, [v.text for v in values], src, list(targets)))
        if self.explode:
            raise RuntimeError("boom")
        return Translation({t: s for t, s in self.texts.items() if t in targets},
                           {t: e for t, e in self.errors.items() if t in targets})


class FakeVoice:
    def __init__(self, fail=(), langs=("en", "ru", "zh")):
        self.fail, self.langs, self.spoken = set(fail), set(langs), []

    def available(self, lang, gender):
        return lang in self.langs

    async def stream(self, text, lang, gender):
        self.spoken.append((lang, gender, text))
        if lang in self.fail:
            raise TTSError(f"{lang}: HTTP 503")
        yield b"\1\0" * 240


class FakePlay:
    def __init__(self):
        self.played = []

    async def __call__(self, lang, chunks):
        async def consume():
            n = 0
            async for c in chunks:
                n += len(c)
            self.played.append((lang, n))
        return asyncio.create_task(consume())


def speech(langs=("en", "ru", "zh"), translator=None, voice=None, gender="female"):
    play = FakePlay()
    tr = translator or FakeTranslator({"ru": "ru 0.2 m/s 03:14 UTC", "zh": "zh 0.2 m/s 03:14 UTC"})
    v = voice or FakeVoice()
    hs = HostSpeech(ROOM_ID, tr, v, play, lambda: list(langs), gender)
    return hs, tr, v, play


# ---- packet authenticity and validation --------------------------------------------------------------------------

def test_parse_accepts_a_server_packet_on_the_topic():
    line, why = parse(packet(), ROOM_ID)
    assert why == "ok" and line.id == "run1:0123456789abcdef" and line.host_run_id == "run1" and line.text == TEXT


def test_a_packet_from_a_participant_is_never_host_speech():
    human = SimpleNamespace(identity="user-u1")
    line, why = parse(packet(participant=human), ROOM_ID)
    assert line is None and "participant" in why


@pytest.mark.parametrize("topic", [None, "", "orbit.host-speech2", "lk.chat"])
def test_another_topic_is_ignored(topic):
    assert parse(packet(topic=topic), ROOM_ID)[0] is None


@pytest.mark.parametrize("data, raw", [
    (body(v=2), None), (body(v=True), None), (body(v="1"), None),
    (body(lang="ru"), None), (body(roomId="other"), None), (body(text=""), None), (body(text="   "), None),
    (body(text="x" * 2001), None), (body(text=7), None), (body(id=""), None), (body(id="x" * 201), None),
    (body(hostRunId=None), None), (None, b"not json"), (None, b"[1, 2]"), (None, b"\xff\xfe"),
    (None, json.dumps(body(text="x" * 1900, pad="y" * 20000)).encode()),
])
def test_invalid_packets_are_rejected(data, raw):
    assert parse(packet(data, raw=raw), ROOM_ID)[0] is None


async def test_on_data_ignores_participant_and_topic_and_bad_packets():
    hs, tr, voice, play = speech()
    hs.on_data(packet(participant=SimpleNamespace(identity="user-u1")))
    hs.on_data(packet(topic="other"))
    hs.on_data(packet(body(lang="zh")))
    await hs.drain()
    assert not tr.calls and not voice.spoken and not play.played


async def test_repeated_id_is_spoken_once_and_memory_is_bounded():
    hs, tr, voice, play = speech(langs=("en",))
    hs.on_data(packet())
    hs.on_data(packet())
    await hs.drain()
    assert play.played == [("en", 480)]
    for i in range(hs.max_seen + 5):
        hs.on_data(packet(body(id=f"run1:{i:016x}")))
    await hs.drain()
    assert len(hs.seen) == hs.max_seen


# ---- listener languages, translation, voice ----------------------------------------------------------------------

async def test_each_listener_language_is_voiced_english_without_translation():
    hs, tr, voice, play = speech()
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert tr.calls == [(tr.calls[0][0], ["0.2 m/s", "03:14 UTC"], "en", ["ru", "zh"])]  # one call, values protected
    assert "\u27e6v1\u27e7" in tr.calls[0][0] and "0.2" not in tr.calls[0][0]
    assert sorted(lang for lang, _ in play.played) == ["en", "ru", "zh"]
    spoken = {lang: text for lang, _, text in voice.spoken}
    assert spoken["en"] == TEXT  # the canonical text itself
    assert spoken["ru"] == "ru 0.2 m/s 03:14 UTC" and spoken["zh"] == "zh 0.2 m/s 03:14 UTC"  # Translator.translate returns restored text
    assert {g for _, g, _ in voice.spoken} == {"female"}  # TTS_DEFAULT_VOICE: the host has no member gender
    assert out == {"en": "queued", "ru": "queued", "zh": "queued"}


async def test_english_only_room_makes_no_translation_call():
    hs, tr, voice, play = speech(langs=("en",))
    await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert not tr.calls and play.played == [("en", 480)]


async def test_no_listeners_no_work():
    hs, tr, voice, play = speech(langs=())
    assert await hs.speak(parse(packet(), ROOM_ID)[0]) == {}
    assert not tr.calls and not play.played


async def test_a_language_whose_translation_failed_is_not_voiced():
    tr = FakeTranslator({"ru": "ru 0.2 m/s 03:14 UTC"}, {"zh": {"code": "VALUE_CHECK_FAILED", "message": "x"}})
    hs, _, voice, play = speech(translator=tr)
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert sorted(lang for lang, _ in play.played) == ["en", "ru"]  # no substitution for zh
    assert out["zh"] == "VALUE_CHECK_FAILED"


async def test_translator_crash_still_voices_english():
    hs, _, voice, play = speech(translator=FakeTranslator(explode=True))
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert [lang for lang, _ in play.played] == ["en"] and out["ru"] == out["zh"] == "PIPELINE_FAILED"


async def test_missing_voice_and_failed_tts_are_reported_not_substituted():
    hs, _, voice, play = speech(voice=FakeVoice(fail=("ru",), langs=("en", "ru")))
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert out["zh"] == "VOICE_UNAVAILABLE"
    assert [lang for lang, _ in play.played] == ["en"]  # the ru stream failed: nothing played, nothing substituted
    assert ("ru", "female", "ru 0.2 m/s 03:14 UTC") in voice.spoken and list(hs.failures) == [("run1:0123456789abcdef", "ru", "TTS_FAILED")]


async def test_health_is_degraded_only_by_faults_like_phrases(monkeypatch):
    reports = []
    monkeypatch.setattr("orbit_voice.host.report", lambda component, message: reports.append((component, message)))
    tr = FakeTranslator({"ru": "ru 0.2 m/s 03:14 UTC"}, {"zh": {"code": "VALUE_CHECK_FAILED", "message": "x"}})
    hs, _, _, _ = speech(translator=tr, voice=FakeVoice(langs=("en", "zh")))  # ru: no voice id (text-only setup)
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert out == {"en": "queued", "ru": "VOICE_UNAVAILABLE", "zh": "VALUE_CHECK_FAILED"} and reports == []
    hs2, _, _, _ = speech(translator=FakeTranslator(explode=True), voice=FakeVoice(fail=("en",)))
    await hs2.speak(parse(packet(), ROOM_ID)[0])
    await hs2.drain()
    assert ("host", "PIPELINE_FAILED") in reports and ("host", "TTS_FAILED") in reports


async def test_too_many_values_voices_english_only():
    text = " ".join(str(i) for i in range(70))
    hs, tr, voice, play = speech()
    out = await hs.speak(parse(packet(body(text=text)), ROOM_ID)[0])
    await hs.drain()
    assert not tr.calls and [lang for lang, _ in play.played] == ["en"] and out["ru"] == "TOO_MANY_VALUES"


async def test_english_plays_before_the_translation_returns():
    seen = {}

    class Slow(FakeTranslator):
        async def translate(self, masked, values, src, targets):
            await asyncio.sleep(0.05)  # the English line is already playing meanwhile
            seen["en_played"] = [lang for lang, _ in play.played]
            return await super().translate(masked, values, src, targets)
    hs, _, voice, play = speech(translator=Slow({"ru": "ru 0.2 m/s 03:14 UTC", "zh": "zh 0.2 m/s 03:14 UTC"}))
    await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert seen["en_played"] == ["en"]
    assert [lang for lang, _ in play.played] == ["en", "ru", "zh"]


async def test_last_human_leaving_mid_line_stops_it_without_reconnecting():
    langs = ["en", "ru"]
    play = FakePlay()

    async def leaving_play(lang, chunks):
        langs.clear()  # the last human left right after the English line was queued
        return await play(lang, chunks)
    tr = FakeTranslator({"ru": "ru 0.2 m/s 03:14 UTC"})
    hs = HostSpeech(ROOM_ID, tr, FakeVoice(), leaving_play, lambda: list(langs), "female")
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert [lang for lang, _ in play.played] == ["en"] and not tr.calls  # no translation, no play() for ru
    assert out == {"en": "queued", "ru": "NO_LISTENERS"}


async def test_a_language_whose_listener_left_during_translation_is_not_played():
    langs = ["en", "ru", "zh"]

    class Leaves(FakeTranslator):
        async def translate(self, masked, values, src, targets):
            langs.remove("zh")
            return await super().translate(masked, values, src, targets)
    play = FakePlay()
    hs = HostSpeech(ROOM_ID, Leaves({"ru": "ru 1", "zh": "zh 1"}), FakeVoice(), play, lambda: list(langs), "female")
    out = await hs.speak(parse(packet(), ROOM_ID)[0])
    await hs.drain()
    assert [lang for lang, _ in play.played] == ["en", "ru"] and out["zh"] == "LISTENER_LEFT"


async def test_lines_keep_their_order():
    order = []

    class SlowFirst(FakeTranslator):
        async def translate(self, masked, values, src, targets):
            if "first" in masked:
                await asyncio.sleep(0.05)
            order.append(masked)
            return Translation({t: masked for t in targets}, {})
    hs, _, _, play = speech(langs=("ru",), translator=SlowFirst())
    hs.on_data(packet(body(id="a", text="first line")))
    hs.on_data(packet(body(id="b", text="second line")))
    await hs.drain()
    assert order == ["first line", "second line"]


def test_listener_langs_are_human_participants_only():
    ps = [SimpleNamespace(identity="user-1", attributes={"lang": "ru"}),
          SimpleNamespace(identity="user-2", attributes={"lang": "en"}),
          SimpleNamespace(identity="user-3", attributes={"lang": "fr"}),
          SimpleNamespace(identity="host", attributes={"lang": "zh"}),
          SimpleNamespace(identity="translator", attributes={"lang": "zh"})]
    assert listener_langs(ps) == ["en", "ru"]


# ---- the `host` connection ---------------------------------------------------------------------------------------

def test_track_names():
    assert host_track_name("ru") == "host:ru"
    assert track_name("ru", "user-a") == "tr:ru:user-a"  # unchanged


def test_host_token_identity_and_grants():
    cfg = Config(livekit_url="ws://lk", livekit_api_key="devkey", livekit_api_secret="secret-0123456789abcdef0123456789")
    claims = jwt.decode(host_token(cfg, "coordination-r1"), "secret-0123456789abcdef0123456789", algorithms=["HS256"],
                        options={"verify_aud": False})
    assert claims["sub"] == IDENTITY == "host" and claims["name"] == NAME
    video = claims["video"]
    assert video["room"] == "coordination-r1" and video["roomJoin"] and video["canPublish"]
    assert video["canPublishSources"] == ["microphone"]
    assert video.get("canSubscribe") is False and video.get("canPublishData") is False
    assert not video.get("hidden") and "roomConfig" not in claims  # visible to clients; dispatches nothing


class FakeLocal:
    def __init__(self):
        self.published, self.unpublished = [], []

    async def publish_track(self, track, opts):
        self.published.append((track.name, opts.source))
        return SimpleNamespace(sid=f"TR_{len(self.published)}")

    async def unpublish_track(self, sid):
        self.unpublished.append(sid)


class FakeRoom:
    made = []

    def __init__(self):
        self.local_participant, self.connected, self.connects = FakeLocal(), False, []
        FakeRoom.made.append(self)

    async def connect(self, url, token, options):
        self.connects.append((url, token, options.auto_subscribe))
        self.connected = True

    def isconnected(self):
        return self.connected

    async def disconnect(self):
        self.connected = False


def cfg():
    return Config(livekit_url="ws://lk", livekit_api_key="devkey", livekit_api_secret="secret-0123456789abcdef0123456789")


async def tone():
    yield b"\0\0" * 480


async def test_publisher_connects_lazily_once_and_names_tracks_host_lang():
    FakeRoom.made = []
    pub = HostPublisher(cfg(), "coordination-r1", room_factory=FakeRoom)
    assert not FakeRoom.made  # nothing until the first host speech
    await asyncio.wait_for(await pub.play("ru", tone()), 5)
    await asyncio.wait_for(await pub.play("ru", tone()), 5)
    await asyncio.wait_for(await pub.play("en", tone()), 5)
    assert len(FakeRoom.made) == 1
    room = FakeRoom.made[0]
    assert room.connects[0][0] == "ws://lk" and room.connects[0][2] is False  # publish only, subscribes nothing
    assert room.local_participant.published == [("host:ru", rtc.TrackSource.SOURCE_MICROPHONE),
                                                ("host:en", rtc.TrackSource.SOURCE_MICROPHONE)]
    await pub.close()
    assert not room.connected and len(room.local_participant.unpublished) == 2
    with pytest.raises(ConnectionError):
        await pub.play("ru", tone())


async def test_publisher_reconnects_after_a_drop_and_goes_idle_when_asked():
    FakeRoom.made = []
    pub = HostPublisher(cfg(), "coordination-r1", room_factory=FakeRoom)
    await asyncio.wait_for(await pub.play("en", tone()), 5)
    FakeRoom.made[0].connected = False  # the connection dropped
    await asyncio.wait_for(await pub.play("en", tone()), 5)
    assert len(FakeRoom.made) == 2 and FakeRoom.made[1].local_participant.published == [
        ("host:en", rtc.TrackSource.SOURCE_MICROPHONE)]
    stale = pub.generation - 1  # an idle() decided before the reconnect must not close the new connection
    await pub.idle(stale)
    assert FakeRoom.made[1].connected
    await pub.idle(pub.generation)  # the last human left: leave the room so it can close
    assert not FakeRoom.made[1].connected
    await asyncio.wait_for(await pub.play("en", tone()), 5)  # a later line connects again
    assert len(FakeRoom.made) == 3
    await pub.close()


def test_track_player_keeps_tr_names_and_accepts_a_host_name():
    async def run():
        room = SimpleNamespace(local_participant=FakeLocal())
        a = TrackPlayer(room, "ru", "user-a")
        b = TrackPlayer(room, "ru", IDENTITY, name=host_track_name("ru"))
        names = (a.name, a.track.name, b.name, b.track.name)
        await a.close()
        await b.close()
        return names
    assert asyncio.run(run()) == ("tr:ru:user-a", "tr:ru:user-a", "host:ru", "host:ru")


# ---- the room job ------------------------------------------------------------------------------------------------

def mic(identity):
    calls = []
    pub = SimpleNamespace(kind=rtc.TrackKind.KIND_AUDIO, source=rtc.TrackSource.SOURCE_MICROPHONE, name="host:en",
                          set_subscribed=lambda v: calls.append(v))
    return pub, SimpleNamespace(identity=identity, attributes={"lang": "en"}), calls


def fake_ctx():
    handlers = {}
    room = SimpleNamespace(name=f"coordination-{ROOM_ID}", remote_participants={},
                           on=lambda ev, fn: handlers.setdefault(ev, fn))
    return SimpleNamespace(room=room), handlers


async def test_host_tracks_are_never_subscribed_or_transcribed():
    ctx, _ = fake_ctx()
    rt = RoomTranslator(ctx, Config())
    for identity in ("host", "host-2", "translator"):
        pub, participant, calls = mic(identity)
        rt.on_published(pub, participant)
        rt.on_subscribed(SimpleNamespace(), pub, participant)
        assert calls == [] and not rt.speakers
    pub, participant, calls = mic("user-u1")
    rt.on_published(pub, participant)
    assert calls == [True]  # humans still are
    await rt.host_voice.close()


async def test_room_job_wires_host_speech_and_targets_ignore_the_host():
    ctx, handlers = fake_ctx()
    ctx.room.remote_participants = {
        "user-1": SimpleNamespace(identity="user-1", attributes={"lang": "ru"}, track_publications={}),
        "host": SimpleNamespace(identity="host", attributes={"lang": "zh"}, track_publications={}),
    }
    rt = RoomTranslator(ctx, Config())
    rt.wire()
    assert handlers["data_received"] == rt.host.on_data
    assert rt.host.room_id == ROOM_ID and rt.host.gender == Config().tts_default_voice
    assert rt.listener_langs() == ["ru"] and rt.targets("en") == ["ru"]
    await rt.host_voice.close()


async def test_last_human_leaving_releases_the_host_connection():
    ctx, _ = fake_ctx()
    rt = RoomTranslator(ctx, Config())
    idle = []

    async def fake_idle(generation=None):
        idle.append(generation)
    rt.host_voice.idle = fake_idle
    ctx.room.remote_participants = {"user-2": SimpleNamespace(identity="user-2", attributes={"lang": "en"})}
    rt.on_gone(SimpleNamespace(identity="user-1"))
    await asyncio.sleep(0.01)
    assert idle == []  # someone is still there
    ctx.room.remote_participants = {}
    rt.on_gone(SimpleNamespace(identity="user-2"))
    await asyncio.sleep(0.01)
    assert idle == [rt.host_voice.generation]  # the generation seen when the human left
    await rt.host_voice.close()
