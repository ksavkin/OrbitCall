"""STT session lifecycle (W3), TTS request shapes (W4) and the Convex sink, against fakes / httpx MockTransport."""

import asyncio
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import websockets

from orbit_voice.config import Config
from orbit_voice.convex import ConvexSink
from orbit_voice.stt import Assembler, STTError, run_session, session_url
from orbit_voice.tts import TTS, TTSError


# ---- STT -------------------------------------------------------------------------------------------------------

def test_session_url_params():
    q = parse_qs(urlparse(session_url("ru", "grok-voice-transcribe-2.0", 400, ("burn", "TCA"))).query)
    assert q["language"] == ["ru"] and q["format"] == ["true"] and q["encoding"] == ["pcm"]
    assert q["sample_rate"] == ["16000"] and q["endpointing"] == ["400"] and q["keyterm"] == ["burn", "TCA"]
    assert q["model"] == ["grok-voice-transcribe-2.0"] and q["interim_results"] == ["false"]


def test_assembler_joins_locked_chunks_until_speech_final():
    a = Assembler()
    assert a.feed({"type": "transcript.partial", "is_final": False, "text": "we can"}) is None
    assert a.feed({"type": "transcript.partial", "is_final": True, "speech_final": False, "text": "We can burn",
                   "start": 1.2, "duration": 0.7}) is None
    u = a.feed({"type": "transcript.partial", "is_final": True, "speech_final": True, "text": "0.2 m/s.",
                "start": 2.0, "duration": 0.4})
    assert u.text == "We can burn 0.2 m/s." and u.started_s == 1.2 and abs(u.ended_s - 2.4) < 1e-9
    assert a.feed({"type": "transcript.done", "duration": 3.0}) is None  # nothing pending


def test_assembler_speech_final_repeating_the_chunk_is_not_doubled():
    # the live service sends the locked chunk again as the utterance final, with the same start
    a = Assembler()
    text = "Understood, we will burn 0.2 m/s, 6 h before closest approach."
    assert a.feed({"type": "transcript.partial", "text": text, "is_final": True, "speech_final": False,
                   "start": 0.001, "duration": 6.238}) is None
    u = a.feed({"type": "transcript.partial", "text": text, "is_final": True, "speech_final": True,
                "start": 0.001, "duration": 6.838})
    assert u.text == text


def test_assembler_final_covering_several_chunks_replaces_them():
    a = Assembler()
    a.feed({"type": "transcript.partial", "is_final": True, "text": "one", "start": 0.0, "duration": 1.0})
    a.feed({"type": "transcript.partial", "is_final": True, "text": "two", "start": 1.0, "duration": 1.0})
    u = a.feed({"type": "transcript.partial", "is_final": True, "speech_final": True, "text": "one two three",
                "start": 0.0, "duration": 3.0})
    assert u.text == "one two three"


def test_assembler_start_jitter_and_startless_final():
    a = Assembler()
    a.feed({"type": "transcript.partial", "is_final": True, "text": "same", "start": 0.0010, "duration": 1.0})
    u = a.feed({"type": "transcript.partial", "is_final": True, "speech_final": True, "text": "same",
                "start": 0.0012, "duration": 1.1})  # jitter below 1 ms: the same chunk
    assert u.text == "same"
    a.feed({"type": "transcript.partial", "is_final": True, "text": "draft one"})
    u = a.feed({"type": "transcript.partial", "is_final": True, "speech_final": True, "text": "final one"})
    assert u.text == "final one"  # a start-less final replaces what was pending


def test_assembler_words_only_events():
    a = Assembler()
    u = a.feed({"type": "transcript.partial", "is_final": True, "speech_final": True,
                "words": [{"text": "Hello", "start": 0.5, "end": 0.9}, {"text": "there", "start": 1.0, "end": 1.3}]})
    assert u.text == "Hello there" and u.started_s == 0.5 and u.ended_s == 1.3


class FakeWS:
    """recv()-driven fake: transcript.created, then the scripted events, then (unless it closes early or hangs)
    transcript.done once audio.done was sent."""

    def __init__(self, events, close_early=False, hang=False, drop=False):
        self.events, self.sent = list(events), []
        self.close_early, self.hang, self.drop = close_early, hang, drop
        self.audio_done = asyncio.Event()
        self.created = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def recv(self):
        if not self.created:
            self.created = True
            return json.dumps({"type": "transcript.created"})
        if self.events:
            ev = self.events.pop(0)
            return ev if isinstance(ev, str) else json.dumps(ev)
        if self.drop:
            raise websockets.ConnectionClosedError(None, None)
        if self.close_early:
            raise websockets.ConnectionClosedOK(None, None)
        await self.audio_done.wait()
        if self.hang:
            await asyncio.sleep(3600)
        return json.dumps({"type": "transcript.done", "duration": 1.0})

    async def send(self, data):
        self.sent.append(data)
        if isinstance(data, str) and json.loads(data).get("type") == "audio.done":
            self.audio_done.set()


async def audio(n=3):
    for _ in range(n):
        yield b"\0\0" * 320
        await asyncio.sleep(0)


async def endless():
    while True:
        yield b"\0\0"
        await asyncio.sleep(0.01)


def collector():
    got = []

    async def on_u(u):
        got.append(u.text)
    return got, on_u


async def test_session_streams_audio_then_audio_done_and_emits_utterances():
    ws = FakeWS([{"type": "transcript.partial", "is_final": True, "speech_final": True, "text": "Hello."}])
    got, on_u = collector()
    await run_session("wss://x", "key", audio(), on_u, connect=lambda *a, **k: ws)
    assert got == ["Hello."]
    assert sum(isinstance(s, bytes) for s in ws.sent) == 3 and json.loads(ws.sent[-1]) == {"type": "audio.done"}


async def test_clean_close_before_done_flushes_and_raises_for_reconnect():
    ws = FakeWS([{"type": "transcript.partial", "is_final": True, "speech_final": False, "text": "half a"}], close_early=True)
    got, on_u = collector()
    with pytest.raises(STTError):
        await run_session("wss://x", "key", endless(), on_u, connect=lambda *a, **k: ws)
    assert got == ["half a"]  # the locked chunk is not lost


async def test_real_drop_also_hands_over_the_locked_chunk():
    ws = FakeWS([{"type": "transcript.partial", "is_final": True, "speech_final": False, "text": "locked"}], drop=True)
    got, on_u = collector()
    with pytest.raises(STTError, match="connection"):
        await run_session("wss://x", "key", endless(), on_u, connect=lambda *a, **k: ws)
    assert got == ["locked"]


async def test_stall_after_audio_done_times_out_instead_of_hanging():
    ws = FakeWS([], hang=True)
    got, on_u = collector()
    with pytest.raises(STTError):
        await asyncio.wait_for(run_session("wss://x", "key", audio(), on_u, connect=lambda *a, **k: ws,
                                           done_timeout=0.2), 5)


@pytest.mark.parametrize("frame", ["not json", "null", "[1, 2]", ""])
async def test_malformed_frame_is_an_stt_error(frame):
    ws = FakeWS([frame])
    with pytest.raises(STTError, match="malformed"):
        await run_session("wss://x", "key", endless(), collector()[1], connect=lambda *a, **k: ws)


async def test_server_error_event_raises():
    ws = FakeWS([{"type": "error", "code": "invalid_audio"}])
    with pytest.raises(STTError, match="invalid_audio"):
        await run_session("wss://x", "key", audio(), collector()[1], connect=lambda *a, **k: ws)


# ---- TTS -------------------------------------------------------------------------------------------------------

def cfg(monkeypatch, **env):
    base = {"CARTESIA_API_KEY": "ck", "CARTESIA_VOICE_EN": "ven", "XAI_API_KEY": "xk", "XAI_TTS_VOICE_ID": "eve"}
    for k in ("CARTESIA_VOICE_ZH", "CARTESIA_MODEL_ID", "CARTESIA_VOICE_EN_MALE", "CARTESIA_VOICE_EN_FEMALE",
              "CARTESIA_VOICE_ZH_MALE", "CARTESIA_VOICE_ZH_FEMALE", "XAI_TTS_VOICE_RU_MALE", "XAI_TTS_VOICE_RU_FEMALE",
              "TTS_DEFAULT_VOICE"):
        monkeypatch.delenv(k, raising=False)
    for k, v in {**base, **env}.items():
        monkeypatch.setenv(k, v)
    return Config()


async def collect(it):
    return [c async for c in it]


async def test_cartesia_request_shape_and_odd_chunks(monkeypatch):
    seen = {}

    def handler(req):
        seen["url"], seen["body"], seen["auth"] = str(req.url), json.loads(req.content), req.headers["authorization"]
        return httpx.Response(200, content=b"\x01\x02\x03\x04\x05", headers={"content-type": "application/octet-stream"})
    tts = TTS(cfg(monkeypatch), httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    chunks = await collect(tts.stream("hello", "en", "female"))
    assert b"".join(chunks) == b"\x01\x02\x03\x04" and all(len(c) % 2 == 0 for c in chunks)  # whole samples only
    assert seen["url"] == "https://api.cartesia.ai/tts/bytes" and seen["auth"] == "Bearer ck"
    assert seen["body"]["output_format"] == {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000}
    assert seen["body"]["voice"] == {"mode": "id", "id": "ven"} and seen["body"]["model_id"] == "sonic-3.6-2026-08-27"


async def test_grok_ru_request_shape(monkeypatch):
    seen = {}

    def handler(req):
        seen["url"], seen["body"] = str(req.url), json.loads(req.content)
        return httpx.Response(200, content=b"\0\0" * 10, headers={"content-type": "audio/pcm"})
    tts = TTS(cfg(monkeypatch), httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert len(b"".join(await collect(tts.stream("privet", "ru", "female")))) == 20
    assert seen["url"] == "https://api.x.ai/v1/tts"
    assert seen["body"]["output_format"] == {"codec": "pcm", "sample_rate": 24000}
    assert seen["body"]["voice_id"] == "eve" and seen["body"]["language"] == "ru"


async def test_tts_failure_has_no_provider_body(monkeypatch):
    def handler(req):
        return httpx.Response(401, content=b'{"error": "secret echo"}')
    tts = TTS(cfg(monkeypatch), httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(TTSError) as e:
        await collect(tts.stream("hello", "en", "female"))
    assert "401" in str(e.value) and "secret" not in str(e.value)


async def test_tts_without_voice_is_an_error_not_a_substitute(monkeypatch):
    tts = TTS(cfg(monkeypatch), httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    assert not tts.available("zh", "female")
    with pytest.raises(TTSError, match="no female voice"):
        await collect(tts.stream("ni hao", "zh", "female"))


async def test_gendered_voice_id_wins_over_the_legacy_one(monkeypatch):
    seen = []

    def handler(req):
        seen.append(json.loads(req.content)["voice_id"])
        return httpx.Response(200, content=b"\0\0", headers={"content-type": "audio/pcm"})
    tts = TTS(cfg(monkeypatch, XAI_TTS_VOICE_RU_MALE="adam"), httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await collect(tts.stream("privet", "ru", "male"))
    await collect(tts.stream("privet", "ru", "female"))  # no female id: the legacy XAI_TTS_VOICE_ID voices her
    assert seen == ["adam", "eve"]


# ---- Convex ----------------------------------------------------------------------------------------------------

async def test_convex_sink_header_and_retry():
    calls = []

    def handler(req):
        calls.append((req.headers["x-call-service-token"], json.loads(req.content)["segId"]))
        return httpx.Response(503 if len(calls) == 1 else 200, json={"ok": True})
    sink = ConvexSink("http://c", "tok", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await sink.post({"segId": "s", "rev": 1})
    assert calls == [("tok", "s"), ("tok", "s")]


async def test_convex_sink_does_not_retry_a_4xx():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(400)
    sink = ConvexSink("http://c", "tok", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert not await sink.post({"segId": "s", "rev": 1}) and calls == [1]
