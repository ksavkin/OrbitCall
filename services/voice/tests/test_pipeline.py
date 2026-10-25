"""Pipeline rows and failure paths (W5, P2): pending then final rev; original_only languages are never voiced;
a voice failure keeps the text and adds TTS_FAILED in a third rev; same-language rooms post the original only."""

import asyncio

import pytest

from orbit_voice.pipeline import MAX_TEXT, Pipeline
from orbit_voice.segments import Segment
from orbit_voice.translate import Translation
from orbit_voice.tts import TTSError


class Sink:
    def __init__(self):
        self.rows = []

    async def post(self, phrase):
        self.rows.append(phrase)
        return True


class FakeTranslator:
    def __init__(self, texts=None, errors=None):
        self.texts, self.errors, self.calls = texts or {}, errors or {}, []

    async def translate(self, masked, values, src, targets):
        self.calls.append((masked, src, targets))
        return Translation({t: s for t, s in self.texts.items() if t in targets},
                           {t: e for t, e in self.errors.items() if t in targets})


class FakeVoice:
    def __init__(self, fail=(), langs=("en", "ru", "zh")):
        self.fail, self.langs, self.spoken = set(fail), set(langs), []

    def available(self, lang):
        return lang in self.langs

    async def stream(self, text, lang):
        self.spoken.append((lang, text))
        if lang in self.fail:
            raise TTSError(f"{lang}: HTTP 503")
        yield b"\0\0" * 240


class Player:
    """Enqueue-style player: returns at once with a task that resolves when the phrase has played."""

    def __init__(self):
        self.played = []

    async def __call__(self, lang, identity, chunks):
        async def consume():
            async for c in chunks:
                self.played.append((lang, identity, len(c)))
        return asyncio.create_task(consume())


def make(translator, voice=None):
    sink, player = Sink(), Player()
    return Pipeline(translator, voice or FakeVoice(), sink, player), sink, player


async def run(p, text="burn 0.2 m/s at T-6h", src="en", targets=("ru", "zh")):
    res = await p.handle(room_id="r1", identity="user-a", src=src, text=text, started_at_ms=1_700_000_000_000,
                         segment=Segment("r1:user-a:e:1"), targets=list(targets))
    await p.drain()
    return res


async def test_pending_then_final_and_voice():
    p, sink, player = make(FakeTranslator({"ru": "ru 0.2 m/s T-6h", "zh": "zh T-6h 0.2 m/s"}))
    res = await run(p)
    assert [r["rev"] for r in sink.rows] == [1, 2]
    pending, final = sink.rows
    assert pending["translationStatus"] == {"ru": "pending", "zh": "pending"} and pending["translations"] == {}
    assert final["translationStatus"] == {"ru": "ok", "zh": "ok"} and "errors" not in final
    assert final["values"] == [{"placeholder": "\u27e6v1\u27e7", "kind": "unit", "text": "0.2 m/s"},
                               {"placeholder": "\u27e6v2\u27e7", "kind": "datetime", "text": "T-6h"}]
    assert final["speakerIdentity"] == "user-a" and final["roomId"] == "r1" and final["eventId"] is None
    assert final["original"] == "burn 0.2 m/s at T-6h" and final["originalLang"] == "en"
    assert {lang for lang, _, _ in player.played} == {"ru", "zh"}
    assert "translate" in res.timings_ms and "total" in res.timings_ms
    assert "errors" not in final


async def test_value_check_failure_is_original_only_and_never_voiced():
    voice = FakeVoice()
    p, sink, player = make(FakeTranslator({"ru": "ru ok"}, {"zh": {"code": "VALUE_CHECK_FAILED", "message": "x"}}), voice)
    await run(p)
    final = sink.rows[-1]
    assert final["translationStatus"] == {"ru": "ok", "zh": "original_only"}
    assert final["errors"] == {"zh": {"code": "VALUE_CHECK_FAILED", "message": "x"}} and "zh" not in final["translations"]
    assert [lang for lang, _ in voice.spoken] == ["ru"]  # no TTS call for the failed language
    assert {lang for lang, _, _ in player.played} == {"ru"}


async def test_voice_failure_keeps_text_and_posts_rev3():
    p, sink, _ = make(FakeTranslator({"ru": "ru ok", "zh": "zh ok"}), FakeVoice(fail={"zh"}))
    res = await run(p)
    assert [r["rev"] for r in sink.rows] == [1, 2, 3]
    last = sink.rows[-1]
    assert last["translationStatus"] == {"ru": "ok", "zh": "ok"} and last["translations"]["zh"] == "zh ok"
    assert last["errors"]["zh"]["code"] == "TTS_FAILED" and "503" in last["errors"]["zh"]["message"]
    assert res.errors["zh"]["code"] == "TTS_FAILED"


async def test_text_only_language_is_stated_not_silent():
    voice = FakeVoice(langs=("en", "ru"))  # no zh voice configured
    p, sink, player = make(FakeTranslator({"ru": "ru ok", "zh": "zh ok"}), voice)
    await run(p)
    assert [r["rev"] for r in sink.rows] == [1, 2]
    assert sink.rows[-1]["translationStatus"] == {"ru": "ok", "zh": "ok"}
    assert sink.rows[-1]["errors"] == {"zh": {"code": "VOICE_UNAVAILABLE", "message": "no voice configured for zh"}}
    assert {lang for lang, _, _ in player.played} == {"ru"}


async def test_same_language_room_posts_original_without_translation():
    tr = FakeTranslator()
    p, sink, player = make(tr)
    await run(p, targets=())
    assert not tr.calls and not player.played
    assert sink.rows[-1]["translationStatus"] == {} and sink.rows[-1]["translations"] == {}


async def test_provider_down_every_language_original_only():
    errors = {t: {"code": "UPSTREAM_UNAVAILABLE", "message": "translation: APIConnectionError"} for t in ("ru", "zh")}
    p, sink, player = make(FakeTranslator(errors=errors))
    await run(p)
    assert sink.rows[-1]["translationStatus"] == {"ru": "original_only", "zh": "original_only"}
    assert not player.played


async def test_zh_numerals_are_protected_after_normalization():
    tr = FakeTranslator({"en": "x"})
    p, sink, _ = make(tr)
    raw = "\u516d\u5c0f\u65f6\u540e\u70b9\u706b\u96f6\u70b9\u4e8c\u7c73\u6bcf\u79d2"
    await run(p, text=raw, src="zh", targets=("en",))
    assert [v["text"] for v in sink.rows[0]["values"]] == ["6", "0.2"]
    assert sink.rows[0]["original"] == raw  # the recognizer's text is stored; the normalized form only protects
    assert "6" not in tr.calls[0][0] and "\u27e6v1\u27e7" in tr.calls[0][0]


async def test_long_text_must_be_split_first():
    p, _, _ = make(FakeTranslator())
    with pytest.raises(ValueError):
        await run(p, text="x" * (MAX_TEXT + 1))


class ExplodingTranslator:
    async def translate(self, masked, values, src, targets):
        raise RuntimeError("unexpected")


async def test_unexpected_failure_never_leaves_a_pending_row():
    p, sink, player = make(ExplodingTranslator())
    res = await run(p)
    assert [r["rev"] for r in sink.rows] == [1, 2]
    last = sink.rows[-1]
    assert last["translationStatus"] == {"ru": "original_only", "zh": "original_only"}
    assert {e["code"] for e in last["errors"].values()} == {"PIPELINE_FAILED"} and not player.played
    assert res.errors["ru"]["code"] == "PIPELINE_FAILED"


async def test_playback_failure_is_visible_not_fatal():
    sink = Sink()

    async def broken_player(lang, identity, chunks):
        raise ConnectionError("track closed")
    p = Pipeline(FakeTranslator({"ru": "ru ok"}), FakeVoice(), sink, broken_player)
    await run(p, targets=("ru",))
    assert sink.rows[-1]["errors"]["ru"] == {"code": "TTS_FAILED", "message": "playback: ConnectionError"}
    assert sink.rows[-1]["translationStatus"] == {"ru": "ok"}


async def test_translation_does_not_wait_for_playout():
    gate = asyncio.Event()

    async def slow_player(lang, identity, chunks):
        async def consume():
            await gate.wait()  # the previous phrase is still playing
            async for _ in chunks:
                pass
        return asyncio.create_task(consume())
    sink = Sink()
    p = Pipeline(FakeTranslator({"ru": "ru ok"}), FakeVoice(), sink, slow_player)
    await asyncio.wait_for(p.handle(room_id="r1", identity="user-a", src="en", text="burn 1", started_at_ms=1,
                                    segment=Segment("r1:user-a:e:1"), targets=["ru"]), 2)
    await asyncio.wait_for(p.handle(room_id="r1", identity="user-a", src="en", text="burn 2", started_at_ms=2,
                                    segment=Segment("r1:user-a:e:2"), targets=["ru"]), 2)
    assert sum(1 for r in sink.rows if r["rev"] == 2) == 2  # both translated while nothing has played yet
    gate.set()
    await p.drain()


async def test_too_many_values_is_a_visible_original_only():
    p, sink, player = make(FakeTranslator({"ru": "x"}))
    await run(p, text=" ".join(str(i) for i in range(70)), targets=("ru",))
    last = sink.rows[-1]
    assert last["translationStatus"] == {"ru": "original_only"} and last["errors"]["ru"]["code"] == "TOO_MANY_VALUES"
    assert len(last["values"]) == 64 and not player.played
