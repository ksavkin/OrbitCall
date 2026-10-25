"""Segments, script guard, zh numeral normalization, config, long-text split."""

import pytest

from orbit_voice.config import Config
from orbit_voice.normalize import normalize
from orbit_voice.pipeline import MAX_TEXT, split_long
from orbit_voice.scripts import plausible
from orbit_voice.segments import SegmentIds


def test_segment_ids_epoch_and_rev():
    ids = SegmentIds("r1", "user-a", clock=lambda: 1000.0)
    a = ids.next_segment()
    b = ids.next_segment()
    assert a.seg_id.startswith(f"r1:user-a:{ids.epoch}:") and a.seg_id.endswith(":1") and b.seg_id.endswith(":2")
    assert [a.next_rev(), a.next_rev(), b.next_rev()] == [1, 2, 1]
    old = ids.epoch
    ids.new_epoch()  # a reconnect never reuses an id even at the same millisecond (random nonce)
    c = ids.next_segment()
    assert ids.epoch != old and c.seg_id.endswith(":1") and c.seg_id != a.seg_id


@pytest.mark.parametrize("text, lang, ok", [
    ("We burn at six", "en", True),
    ("\u041c\u044b \u043c\u0430\u043d\u0435\u0432\u0440\u0438\u0440\u0443\u0435\u043c STARLINK", "ru", True),
    ("\u8fd9\u662f\u3002", "ru", False),  # Han hallucination for a Russian speaker
    ("\u8fd9\u662f\u3002", "en", False),
    ("\u6211\u4eec\u70b9\u706b TCA", "zh", True),
    ("\u0631\u0643\u0648\u062a", "zh", False),  # Arabic on noise
    ("   ", "en", False),
    ("0.2 / 6", "ru", True),  # no letters: nothing foreign
])
def test_script_guard(text, lang, ok):
    assert plausible(text, lang) is ok


@pytest.mark.parametrize("text, out, changed", [
    ("\u96f6\u70b9\u4e8c\u7c73\u6bcf\u79d2", "0.2\u7c73\u6bcf\u79d2", True),
    ("\u516d\u5c0f\u65f6\u540e", "6\u5c0f\u65f6\u540e", True),
    ("\u4e09\u5341\u4e94\u516c\u91cc", "35\u516c\u91cc", True),
    ("\u4e00\u4e9b\u536b\u661f", "\u4e00\u4e9b\u536b\u661f", False),  # "some satellites": idiom kept
    ("\u4e00\u8d77\u534f\u8c03", "\u4e00\u8d77\u534f\u8c03", False),  # "coordinate together"
    ("\u4e00\u5b9a\u8981\u6ce8\u610f", "\u4e00\u5b9a\u8981\u6ce8\u610f", False),  # "must pay attention"
])
def test_zh_normalization(text, out, changed):
    assert normalize(text, "zh") == (out, changed)


def test_only_zh_is_normalized():
    assert normalize("six hours", "en") == ("six hours", False)


def test_tts_provider_is_text_only_without_voice(monkeypatch):
    for k in ("CARTESIA_API_KEY", "CARTESIA_VOICE_EN", "CARTESIA_VOICE_ZH", "XAI_API_KEY", "XAI_TTS_VOICE_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CARTESIA_API_KEY", "sk-cartesia-secret")
    monkeypatch.setenv("CARTESIA_VOICE_EN", "voice-en")
    monkeypatch.setenv("XAI_API_KEY", "xai-secret")
    c = Config()
    assert c.tts_provider("en") == ("cartesia", "voice-en")
    assert c.tts_provider("zh") is None  # no voice id: text only, never another provider
    assert c.tts_provider("ru") is None  # no XAI_TTS_VOICE_ID: text only
    d = c.describe()
    assert d["tts"] == {"en": "cartesia", "ru": "text-only", "zh": "text-only"}
    assert "secret" not in str(d)  # presence only, never values


def test_split_long_never_drops_text():
    text = ("This is a sentence about a burn. " * 120).strip()
    parts = split_long(text)
    assert len(parts) > 1 and all(len(p) <= MAX_TEXT for p in parts)
    assert " ".join(parts).split() == text.split()
    assert split_long("short") == ["short"]
    blob = "x" * (MAX_TEXT * 2)
    assert "".join(split_long(blob)) == blob


def test_split_long_never_cuts_inside_a_value():
    from orbit_voice.values import protect
    text = "a" * 1790 + " 0.25 m/s " + "b" * 400  # no sentence end; the limit falls inside the number
    parts = split_long(text, limit=1793)
    assert "".join(protect(p)[1][0].text for p in parts if protect(p)[1]) == "0.25 m/s"
    assert " ".join(parts).replace(" ", "") == text.replace(" ", "")


def test_runtime_errors_reach_health(tmp_path, monkeypatch):
    import orbit_voice.health as h
    monkeypatch.setattr(h, "RUNTIME_DIR", tmp_path)
    health = h.Health(Config())
    health.state = {"ready": True}
    assert health.snapshot()["ok"] is True
    h.report("stt", "STTError: stt connection: ConnectionClosedError")
    snap = health.snapshot()
    assert snap["ok"] is False and snap["degraded"] is True and "stt" in snap["recentErrors"]


def test_health_ignores_malformed_report_files(tmp_path, monkeypatch):
    import orbit_voice.health as h
    monkeypatch.setattr(h, "RUNTIME_DIR", tmp_path)
    (tmp_path / "x.json").write_text('{"at": 9999999999}')
    (tmp_path / "y.json").write_text("not json")
    assert h.recent_errors() == {}
